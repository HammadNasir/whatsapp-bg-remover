require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const FormData = require('form-data');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const streamifier = require('streamifier');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const REMOVEBG_API_KEY = process.env.REMOVEBG_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error('❌ Missing Twilio credentials');
  process.exit(1);
}

console.log('✅ Twilio configured');
if (process.env.RAZORPAY_KEY_ID) console.log('✅ Razorpay configured');
if (process.env.CLOUDINARY_CLOUD_NAME) console.log('✅ Cloudinary configured');

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// MongoDB
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));
}

const userSchema = new mongoose.Schema({
  phoneNumber: { type: String, unique: true, required: true },
  tier: { type: String, enum: ['free', 'premium'], default: 'free' },
  imagesProcessed: { type: Number, default: 0 },
  subscriptionId: { type: String, default: null },
  resetDate: { type: Date, default: () => new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1) },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

async function getUserData(phoneNumber) {
  try {
    if (!User) return null;
    let user = await User.findOne({ phoneNumber });
    if (!user) {
      const now = new Date();
      user = new User({
        phoneNumber,
        tier: 'free',
        imagesProcessed: 0,
        resetDate: new Date(now.getFullYear(), now.getMonth() + 1, 1)
      });
      await user.save();
      console.log(`👤 New user: ${phoneNumber}`);
    } else {
      const now = new Date();
      if (now >= user.resetDate) {
        user.imagesProcessed = 0;
        user.resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        await user.save();
      }
    }
    return user;
  } catch (error) {
    console.error('❌ getUserData error:', error.message);
    return null;
  }
}

async function removeBackground(imageUrl) {
  try {
    if (!REMOVEBG_API_KEY) throw new Error('remove.bg key not set (REMOVEBG_API_KEY)');

    console.log('🔄 Fetching image from Twilio (removeBackground)...');
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
      timeout: 30000
    });

    const originalBuffer = Buffer.from(imageResponse.data);
    console.log(`📸 Downloaded original: ${originalBuffer.length} bytes`);

    if (originalBuffer.length > 25 * 1024 * 1024) {
      throw new Error('Image too large (max 25MB)');
    }

    // Build form data for remove.bg - DO NOT set fake content-type or filename that contradicts actual bytes.
    const formData = new FormData();
    formData.append('image_file', originalBuffer); // let remove.bg detect type
    formData.append('size', 'auto');
    formData.append('format', 'png'); // request PNG output (transparent)

    console.log('📤 Sending to remove.bg (requesting PNG output)...');
    const resp = await axios.post('https://api.remove.bg/v1.0/removebg', formData, {
      headers: {
        ...formData.getHeaders(),
        'X-Api-Key': REMOVEBG_API_KEY
      },
      responseType: 'arraybuffer',
      timeout: 60000
    });

    const outBuffer = Buffer.from(resp.data);
    console.log(`✅ remove.bg returned: ${outBuffer.length} bytes`);
    console.log('   Response headers content-type:', resp.headers['content-type']);

    // quick magic-bytes check for PNG:
    const signature = outBuffer.slice(0, 8).toString('hex');
    console.log('   Output signature (hex):', signature);
    const pngSignature = '89504e470d0a1a0a';
    if (resp.headers['content-type'] && resp.headers['content-type'].includes('png') && signature === pngSignature) {
      console.log('   ✅ remove.bg output is PNG (has PNG magic header).');
    } else {
      // save temp for inspection and throw explicit error
      const tmpFile = path.join(os.tmpdir(), `removebg_out_${Date.now()}`);
      // pick extension based on content-type if present
      const ext = resp.headers['content-type'] && resp.headers['content-type'].includes('png') ? '.png' : (resp.headers['content-type'] && resp.headers['content-type'].includes('jpeg') ? '.jpg' : '.bin');
      const tmpPath = tmpFile + ext;
      try { fs.writeFileSync(tmpPath, outBuffer); console.log('   ❗ Saved remove.bg output for inspection at', tmpPath); } catch (e) { console.warn('   ❗ Failed to save tmp file:', e.message); }
      throw new Error(`remove.bg did not return a PNG. content-type=${resp.headers['content-type'] || 'unknown'}, signature=${signature}. Saved tmp: ${tmpPath}`);
    }

    return outBuffer;
  } catch (error) {
    // Try to give more detail if possible
    console.error('❌ removeBackground error:', error.message);
    if (error.response) {
      try {
        const txt = error.response.data?.toString?.();
        if (txt) console.error('   remove.bg error body (truncated):', txt.substring(0, 800));
      } catch (_) {}
    }
    throw error;
  }
}

async function uploadToCloudinary(imageBuffer, phoneNumber) {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME) throw new Error('Cloudinary not set');

    const safePhone = (phoneNumber || '').replace(/\D/g, '') || 'unknown';

    return await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'whatsapp-bg-remover',
          public_id: `bg_${safePhone}_${Date.now()}`,
          resource_type: 'image',
          format: 'png',
          transformation: [
            {
              fetch_format: 'png',
              // keep quality conservative but avoid automatic flattening
              // removing quality: 'auto' to avoid unexpected flattening
              flags: 'preserve_transparency'
            }
          ]
        },
        (error, result) => {
          if (error) {
            console.error('❌ Cloudinary upload error:', error);
            return reject(error);
          }
          console.log('☁️  Cloudinary FULL RESULT:', result);
          // confirm Cloudinary reports png
          if (result.format !== 'png') {
            console.warn('   ⚠️ Cloudinary returned non-png format:', result.format);
          }
          resolve(result.secure_url);
        }
      );

      // log first few bytes for inspection
      console.log('   Uploading to Cloudinary, buffer head (hex):', imageBuffer.slice(0, 8).toString('hex'));
      streamifier.createReadStream(imageBuffer).pipe(uploadStream);
    });
  } catch (error) {
    console.error('❌ uploadToCloudinary error:', error.message);
    throw error;
  }
}

async function sendMessage(to, body, botNumber) {
  try {
    await client.messages.create({
      body,
      from: `whatsapp:${botNumber}`,
      to: `whatsapp:${to}`
    });
    console.log(`✅ Message sent to ${to}`);
  } catch (error) {
    console.error('❌ Send error:', error.message);
  }
}

async function sendImage(to, imageUrl, caption, botNumber) {
  try {
    await client.messages.create({
      body: caption,
      mediaUrl: [imageUrl],
      from: `whatsapp:${botNumber}`,
      to: `whatsapp:${to}`
    });
    console.log(`✅ Image sent to ${to}`);
  } catch (error) {
    console.error('❌ Send image error:', error.message);
  }
}

async function sendDocument(to, fileUrl, caption, botNumber) {
  try {
    await client.messages.create({
      from: `whatsapp:${botNumber}`,
      to: `whatsapp:${to}`,
      body: caption,
      mediaUrl: [fileUrl],
      mediaContentType: ['application/octet-stream']  // 👈 forces document mode
    });
    console.log(`📄 Document sent to ${to}`);
  } catch (error) {
    console.error('❌ Send document error:', error.message);
  }
}

// Payment endpoints
app.post('/create-order', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone required' });
    
    const options = {
      amount: 99900,
      currency: 'INR',
      receipt: `premium_${phoneNumber}_${Date.now()}`,
      notes: { phoneNumber }
    };
    
    const order = await razorpay.orders.create(options);
    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (error) {
    console.error('❌ Order error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/verify-payment', async (req, res) => {
  try {
    let { orderId, paymentId, signature, phoneNumber } = req.body;
    
    console.log('💳 Verify request received');
    console.log('   Phone from request:', phoneNumber);
    
    // Normalize phone number - add + if missing
    if (!phoneNumber.startsWith('+')) {
      phoneNumber = '+' + phoneNumber;
    }
    
    console.log('   Normalized phone:', phoneNumber);
    
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    hmac.update(orderId + '|' + paymentId);
    const generated = hmac.digest('hex');
    
    console.log('   Signature match:', generated === signature);
    
    if (generated !== signature) {
      console.log('❌ Signature mismatch');
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }
    
    // Find user
    console.log('   Searching for user:', phoneNumber);
    let user = await User.findOne({ phoneNumber });
    
    if (!user) {
      console.log('   User not found with format:', phoneNumber);
      console.log('   Available users in DB:');
      const allUsers = await User.find();
      allUsers.forEach(u => console.log('     -', u.phoneNumber));
      return res.status(400).json({ success: false, error: 'User not found: ' + phoneNumber });
    }
    
    // Upgrade user
    user.tier = 'premium';
    user.imagesProcessed = 0;
    user.subscriptionId = paymentId;
    user.resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
    await user.save();
    console.log(`⭐ ${user.phoneNumber} upgraded to Premium!`);
    
    // Send WhatsApp notification
    const botNumber = TWILIO_WHATSAPP_NUMBER || '+14155238886';
    await sendMessage(user.phoneNumber, 
      `✅ *Payment Successful!*\n\nYou are now Premium! 🎉\n\n100 images/month available\n\nStart removing backgrounds!`, 
      botNumber
    );
    
    return res.json({ success: true, message: 'Payment verified!' });
  } catch (error) {
    console.error('❌ Verify error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/pay/:phoneNumber', (req, res) => {
  const { phoneNumber } = req.params;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp BG Remover - Premium</title>
      <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
      <style>
        body { font-family: Arial; text-align: center; padding: 40px; background: #f5f5f5; }
        .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
        h1 { color: #25D366; }
        .price { font-size: 36px; margin: 20px 0; }
        ul { text-align: left; }
        button { background: #25D366; color: white; border: none; padding: 15px 30px; font-size: 16px; border-radius: 5px; cursor: pointer; width: 100%; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🎨 Background Remover</h1>
        <h2>Upgrade to Premium</h2>
        <div class="price">₹999/month</div>
        <ul>
          <li>✅ 100 images/month</li>
          <li>✅ Priority processing</li>
          <li>✅ HD quality</li>
        </ul>
        <button onclick="payNow()">Pay Now</button>
        <p id="status"></p>
      </div>
      <script>
        function payNow() {
          fetch('/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber: '${phoneNumber}' })
          })
          .then(r => r.json())
          .then(data => {
            const options = {
              key: '${process.env.RAZORPAY_KEY_ID}',
              order_id: data.orderId,
              amount: data.amount,
              currency: data.currency,
              handler: function(response) {
                document.getElementById('status').innerHTML = '⏳ Verifying payment...';
                fetch('/verify-payment', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    orderId: response.razorpay_order_id,
                    paymentId: response.razorpay_payment_id,
                    signature: response.razorpay_signature,
                    phoneNumber: '${phoneNumber}'
                  })
                })
                .then(r => r.json())
                .then(data => {
                  if (data.success) {
                    setTimeout(() => {
                      window.location.href = '/success';
                    }, 1000);
                  } else {
                    document.getElementById('status').innerHTML = '❌ Verification failed: ' + data.error;
                  }
                })
                .catch(e => {
                  document.getElementById('status').innerHTML = '❌ Error: ' + e.message;
                });
              },
              prefill: { contact: '${phoneNumber}' },
              theme: { color: '#25D366' }
            };
            new Razorpay(options).open();
          })
          .catch(e => {
            document.getElementById('status').innerHTML = '❌ Error: ' + e.message;
          });
        }
      </script>
    </body>
    </html>
  `);
});

app.get('/success', (req, res) => {
  res.send('<h1>✅ Payment Successful!</h1><p>You are now Premium! Go back to WhatsApp.</p>');
});

// --- Diagnostic route to test a MediaUrl manually ---
// Use: GET /debug?url=https://api.twilio.com/2010-04-01/Accounts/XXX/Media/YYY
app.get('/debug', async (req, res) => {
  try {
    const testUrl = req.query.url;
    if (!testUrl) return res.status(400).send('Provide ?url=');
    const buf = await axios.get(testUrl, { responseType: 'arraybuffer', auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN } });
    const b = Buffer.from(buf.data);
    const head = b.slice(0, 8).toString('hex');
    res.json({
      bytes: b.length,
      head_hex: head,
      likely_png: head === '89504e470d0a1a0a',
      sample_headers: buf.headers
    });
  } catch (err) {
    res.status(500).send('debug error: ' + (err.message || err));
  }
});

// Main webhook
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From?.replace('whatsapp:', '');
    const to = req.body.To?.replace('whatsapp:', '');
    const msg = req.body.Body?.toLowerCase().trim();
    const numMedia = parseInt(req.body.NumMedia) || 0;
    
    if (!from) return res.status(200).send('OK');
    
    const botNumber = TWILIO_WHATSAPP_NUMBER || to || '+14155238886';
    const user = await getUserData(from);
    
    if (!user) {
      await sendMessage(from, '❌ Error', botNumber);
      return res.status(200).send('OK');
    }
    
    // Image handling
    if (numMedia > 0) {
      if (!REMOVEBG_API_KEY) {
        await sendMessage(from, '❌ Not configured', botNumber);
        return res.status(200).send('OK');
      }
      
      const limit = user.tier === 'premium' ? 100 : 3;
      if (user.imagesProcessed >= limit) {
        await sendMessage(from, `⚠️ Limit reached (${limit}). Reply UPGRADE`, botNumber);
        return res.status(200).send('OK');
      }
      
      try {
        await sendMessage(from, '⏳ Processing...', botNumber);
        console.log('🔄 Starting image processing...');
        
        const imageUrl = req.body.MediaUrl0;
        console.log('📸 Image URL:', imageUrl);
        
        const image = await removeBackground(imageUrl);
        console.log('✅ Background removed (buffer length:', image.length, ')');
        
        const url = await uploadToCloudinary(image, from);
        console.log('☁️  Uploaded to Cloudinary');
        
        user.imagesProcessed++;
        await user.save();
        
        const remaining = limit - user.imagesProcessed;
        await sendDocument(from, url, `✅ Done! ${remaining} left`, botNumber);
        // await sendImage(from, url, `✅ Done! ${remaining} left`, botNumber);
      } catch (error) {
        console.error('❌ Image processing failed:', error);
        await sendMessage(from, `❌ Error processing image:\n\n${error.message}`, botNumber);
      }
      return res.status(200).send('OK');
    }
    
    // Commands
    if (msg === 'start' || msg === 'hello') {
      await sendMessage(from, 
        `🎨 *Background Remover*\n\n📊 Status: ${user.tier.toUpperCase()}\nUsed: ${user.imagesProcessed}/${user.tier === 'premium' ? 100 : 3}\n\nCommands: START, STATUS, HELP, UPGRADE`,
        botNumber
      );
    } else if (msg === 'status') {
      const limit = user.tier === 'premium' ? 100 : 3;
      await sendMessage(from, `📊 Plan: ${user.tier.toUpperCase()}\nUsed: ${user.imagesProcessed}/${limit}`, botNumber);
    } else if (msg === 'help') {
      await sendMessage(from, `📖 *Commands*\nSTART - Start\nSTATUS - Check usage\nUPGRADE - Go Premium\nSend image to remove background`, botNumber);
    } else if (msg === 'upgrade') {
      await sendMessage(from, `⭐ Premium: ₹999/month\n100 images/month\n\nReply CONFIRM to pay`, botNumber);
    } else if (msg === 'confirm') {
      if (!process.env.RAZORPAY_KEY_ID) {
        await sendMessage(from, '❌ Payments not configured', botNumber);
        return res.status(200).send('OK');
      }
      const domain = process.env.RAILWAY_DOMAIN || 'whatsapp-bg-remover-production.up.railway.app';
      await sendMessage(from, `💳 Pay here:\n${domain}/pay/${from.replace('+', '')}\n\nAfter payment, reply VERIFY`, botNumber);
    } else if (msg === 'verify') {
      // Refresh user data from database
      const updatedUser = await getUserData(from);
      if (updatedUser && updatedUser.tier === 'premium') {
        await sendMessage(from, `✅ *Payment Verified!*\n\nYou're now Premium! 🎉\n100 images/month available\n\nStart sending images!`, botNumber);
      } else {
        await sendMessage(from, `⏳ Payment still processing. Try again in a moment.\n\nOr send UPGRADE to try again.`, botNumber);
      }
    } else {
      await sendMessage(from, `👋 Send an image to remove background\n\nType HELP for commands`, botNumber);
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).send('OK');
  }
});

app.get('/', (req, res) => res.send('✅ Bot running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server on port ${PORT}\n`);
});
