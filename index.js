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
    if (!REMOVEBG_API_KEY) throw new Error('remove.bg key not set');
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN }
    });
    const formData = new FormData();
    formData.append('image_file', Buffer.from(imageResponse.data), 'image.png');
    formData.append('size', 'auto');
    const response = await axios.post('https://api.remove.bg/v1.0/removebg', formData, {
      headers: { ...formData.getHeaders(), 'X-Api-Key': REMOVEBG_API_KEY },
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data, 'binary');
  } catch (error) {
    console.error('❌ removeBackground error:', error.message);
    throw error;
  }
}

async function uploadToCloudinary(imageBuffer, phoneNumber) {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME) throw new Error('Cloudinary not set');
    const tempPath = path.join(__dirname, `temp_${Date.now()}.png`);
    fs.writeFileSync(tempPath, imageBuffer);
    const result = await cloudinary.uploader.upload(tempPath, {
      folder: 'whatsapp-bg-remover',
      public_id: `bg_${phoneNumber}_${Date.now()}`,
      format: 'png'
    });
    fs.unlinkSync(tempPath);
    return result.secure_url;
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
    const { orderId, paymentId, signature, phoneNumber } = req.body;
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    hmac.update(orderId + '|' + paymentId);
    const generated = hmac.digest('hex');
    
    if (generated !== signature) return res.status(400).json({ success: false, error: 'Invalid' });
    
    const user = await User.findOne({ phoneNumber });
    if (user) {
      user.tier = 'premium';
      user.imagesProcessed = 0;
      user.subscriptionId = paymentId;
      user.resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
      await user.save();
      console.log(`⭐ ${phoneNumber} upgraded to Premium!`);
      return res.json({ success: true, message: 'Payment verified!' });
    }
    res.status(400).json({ success: false, error: 'User not found' });
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
            new Razorpay({
              key: '${process.env.RAZORPAY_KEY_ID}',
              order_id: data.orderId,
              amount: data.amount,
              currency: data.currency,
              handler: function(response) {
                fetch('/verify-payment', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    orderId: response.razorpay_order_id,
                    paymentId: response.razorpay_payment_id,
                    signature: response.razorpay_signature,
                    phoneNumber: '${phoneNumber}'
                  })
                }).then(r => r.json()).then(d => {
                  if (d.success) {
                    alert('✅ Success! You are now Premium!');
                    window.location.href = '/success';
                  }
                });
              }
            }).open();
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
        const image = await removeBackground(req.body.MediaUrl0);
        const url = await uploadToCloudinary(image, from);
        user.imagesProcessed++;
        await user.save();
        const remaining = limit - user.imagesProcessed;
        await sendImage(from, url, `✅ Done! ${remaining} left`, botNumber);
      } catch (error) {
        await sendMessage(from, `❌ Error: ${error.message}`, botNumber);
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
      await sendMessage(from, `💳 Pay here:\nhttps://${domain}/pay/${from.replace('+', '')}\n\nAfter payment, reply VERIFY`, botNumber);
    } else if (msg === 'verify') {
      if (user.tier === 'premium') {
        await sendMessage(from, `✅ You're Premium! 100 images/month`, botNumber);
      } else {
        await sendMessage(from, `⏳ Verifying...`, botNumber);
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