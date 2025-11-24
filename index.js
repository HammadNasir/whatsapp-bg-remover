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

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Razorpay Configuration
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Validation
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error('❌ Missing required Twilio environment variables!');
  process.exit(1);
}

console.log('✅ Twilio configured');
if (!REMOVEBG_API_KEY) console.warn('⚠️  REMOVEBG_API_KEY not set');
if (!process.env.CLOUDINARY_CLOUD_NAME) console.warn('⚠️  Cloudinary not set');
if (!MONGODB_URI) console.warn('⚠️  MONGODB_URI not set');
if (process.env.RAZORPAY_KEY_ID) console.log('✅ Razorpay configured');

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// MongoDB Connection
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB error:', err.message));
}

// User Schema
const userSchema = new mongoose.Schema({
  phoneNumber: { type: String, unique: true, required: true },
  tier: { type: String, enum: ['free', 'premium'], default: 'free' },
  imagesProcessed: { type: Number, default: 0 },
  subscriptionId: { type: String, default: null },
  resetDate: { type: Date, default: () => new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1) },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Get or create user
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

// Remove background from image
async function removeBackground(imageUrl) {
  try {
    if (!REMOVEBG_API_KEY) throw new Error('remove.bg API key not set');
    
    console.log('🔄 Fetching image...');
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN }
    });
    
    console.log('📸 Sending to remove.bg...');
    const formData = new FormData();
    formData.append('image_file', Buffer.from(imageResponse.data), 'image.png');
    formData.append('size', 'auto');
    formData.append('type', 'auto');
    
    const response = await axios.post('https://api.remove.bg/v1.0/removebg', formData, {
      headers: { ...formData.getHeaders(), 'X-Api-Key': REMOVEBG_API_KEY },
      responseType: 'arraybuffer'
    });
    
    console.log('✅ Background removed');
    return Buffer.from(response.data, 'binary');
  } catch (error) {
    console.error('❌ removeBackground error:', error.message);
    throw error;
  }
}

// Upload image to Cloudinary
async function uploadToCloudinary(imageBuffer, phoneNumber) {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME) throw new Error('Cloudinary not configured');
    
    console.log('☁️  Uploading to Cloudinary...');
    const tempPath = path.join(__dirname, `temp_${Date.now()}.png`);
    fs.writeFileSync(tempPath, imageBuffer);
    
    const result = await cloudinary.uploader.upload(tempPath, {
      folder: 'whatsapp-bg-remover',
      public_id: `bg_${phoneNumber}_${Date.now()}`,
      format: 'png'
    });
    
    fs.unlinkSync(tempPath);
    console.log('✅ Uploaded to Cloudinary');
    return result.secure_url;
  } catch (error) {
    console.error('❌ uploadToCloudinary error:', error.message);
    throw error;
  }
}

// Send WhatsApp message
async function sendWhatsAppMessage(to, body, botNumber) {
  try {
    await client.messages.create({
      body,
      from: `whatsapp:${botNumber}`,
      to: `whatsapp:${to}`
    });
    console.log(`✅ Message sent to ${to}`);
  } catch (error) {
    console.error('❌ Send message error:', error.message);
  }
}

// Send WhatsApp image
async function sendWhatsAppImage(to, imageUrl, caption, botNumber) {
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

// Payment page
app.get('/pay/:phoneNumber', async (req, res) => {
  const { phoneNumber } = req.params;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp BG Remover - Premium</title>
      <style>
        body { font-family: Arial; text-align: center; padding: 40px; background: #f5f5f5; }
        .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #25D366; }
        .price { font-size: 36px; color: #333; margin: 20px 0; }
        .features { text-align: left; margin: 20px 0; }
        .features li { margin: 10px 0; }
        button { background: #25D366; color: white; border: none; padding: 15px 30px; font-size: 16px; border-radius: 5px; cursor: pointer; width: 100%; }
        button:hover { background: #1DA851; }
        .info { color: #666; margin-top: 20px; font-size: 12px; }
      </style>
      <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    </head>
    <body>
      <div class="container">
        <h1>🎨 WhatsApp Background Remover</h1>
        <h2>Upgrade to Premium</h2>
        
        <div class="price">₹999/month</div>
        
        <div class="features">
          <strong>Get Premium:</strong>
          <ul>
            <li>✅ 100 images per month</li>
            <li>✅ Priority processing</li>
            <li>✅ HD quality output</li>
            <li>✅ No watermarks</li>
          </ul>
        </div>
        
        <button onclick="payNow()">Pay Now with Razorpay</button>
        
        <div class="info">
          <p>Phone: ${phoneNumber}</p>
          <p>Secure payment powered by Razorpay</p>
        </div>
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
              amount: data.amount,
              currency: data.currency,
              order_id: data.orderId,
              handler: function(response) {
                verifyPayment(response, '${phoneNumber}');
              },
              prefill: {
                contact: '${phoneNumber}'
              },
              theme: {
                color: '#25D366'
              }
            };
            const rzp = new Razorpay(options);
            rzp.open();
          });
        }

        function verifyPayment(response, phoneNumber) {
          fetch('/verify-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
              phoneNumber: phoneNumber
            })
          })
          .then(r => r.json())
          .then(data => {
            if (data.success) {
              alert('✅ Payment successful! You are now Premium!');
              window.location.href = '/success';
            } else {
              alert('❌ Payment failed: ' + data.error);
            }
          });
        }
      </script>
    </body>
    </html>
  `;
  
  res.send(html);
});

// Success page
app.get('/success', (req, res) => {
  res.send(`
    <h1>✅ Payment Successful!</h1>
    <p>You are now a Premium member!</p>
    <p>Go back to WhatsApp and use your 100 images/month.</p>
  `);
});
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    const options = {
      amount: 99900,
      currency: 'INR',
      receipt: `premium_${phoneNumber}_${Date.now()}`,
      notes: { phoneNumber, description: 'WhatsApp BG Remover Premium' }
    };
    
    const order = await razorpay.orders.create(options);
    console.log(`💳 Payment order created for ${phoneNumber}:`, order.id);
    
    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (error) {
    console.error('❌ Order creation error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Verify payment
app.post('/verify-payment', async (req, res) => {
  try {
    const { orderId, paymentId, signature, phoneNumber } = req.body;
    
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    hmac.update(orderId + '|' + paymentId);
    const generated_signature = hmac.digest('hex');
    
    if (generated_signature !== signature) {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }
    
    const user = await User.findOne({ phoneNumber });
    if (user) {
      user.tier = 'premium';
      user.imagesProcessed = 0;
      user.subscriptionId = paymentId;
      user.resetDate = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);
      await user.save();
      
      console.log(`⭐ User ${phoneNumber} upgraded to Premium!`);
      return res.json({ success: true, message: 'Payment verified, you are now Premium!' });
    }
    
    res.status(400).json({ success: false, error: 'User not found' });
  } catch (error) {
    console.error('❌ Payment verification error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Main webhook
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From?.replace('whatsapp:', '');
    const to = req.body.To?.replace('whatsapp:', '');
    const incomingMsg = req.body.Body?.toLowerCase().trim();
    const numMedia = parseInt(req.body.NumMedia) || 0;
    
    if (!from) return res.status(200).send('OK');
    
    const botNumber = TWILIO_WHATSAPP_NUMBER || to || '+14155238886';
    const user = await getUserData(from);
    
    if (!user) {
      await sendWhatsAppMessage(from, '❌ Error loading user data', botNumber);
      return res.status(200).send('OK');
    }
    
    // Handle image
    if (numMedia > 0) {
      console.log(`\n📸 Image from ${from}`);
      
      if (!REMOVEBG_API_KEY) {
        await sendWhatsAppMessage(from, '❌ Background removal not configured', botNumber);
        return res.status(200).send('OK');
      }
      
      const FREE_LIMIT = 3;
      const PREMIUM_LIMIT = 100;
      const limit = user.tier === 'premium' ? PREMIUM_LIMIT : FREE_LIMIT;
      
      if (user.imagesProcessed >= limit) {
        await sendWhatsAppMessage(from,
          `⚠️ *Limit Reached*\n\nYou've used all ${limit} images this month.\n\n⭐ Upgrade to Premium!\nReply: UPGRADE`,
          botNumber
        );
        return res.status(200).send('OK');
      }
      
      try {
        await sendWhatsAppMessage(from, '⏳ Processing...', botNumber);
        
        const processedImage = await removeBackground(req.body.MediaUrl0);
        const uploadedUrl = await uploadToCloudinary(processedImage, from);
        
        user.imagesProcessed++;
        await user.save();
        
        const remaining = limit - user.imagesProcessed;
        
        await sendWhatsAppImage(from,
          uploadedUrl,
          `✅ *Background Removed!*\n\nRemaining: ${remaining}/${limit}\n\n${remaining === 0 && user.tier === 'free' ? '⭐ Upgrade for more!' : ''}`,
          botNumber
        );
      } catch (error) {
        await sendWhatsAppMessage(from, `❌ Error: ${error.message}`, botNumber);
      }
      
      return res.status(200).send('OK');
    }
    
    // Handle text commands
    console.log(`\n💬 Message from ${from}: ${incomingMsg}`);
    
    if (incomingMsg === 'start' || incomingMsg === 'hello') {
      await sendWhatsAppMessage(from,
        `🎨 *Background Remover Bot*\n\nWelcome! Send any image and I'll remove the background.\n\n📊 Status:\nPlan: ${user.tier.toUpperCase()}\nUsed: ${user.imagesProcessed}/${user.tier === 'premium' ? 100 : 3}\n\n💡 Commands:\n• HELP - Show commands\n• STATUS - Check usage\n• Send image - Remove background!`,
        botNumber
      );
    }
    else if (incomingMsg === 'status') {
      const limit = user.tier === 'premium' ? 100 : 3;
      await sendWhatsAppMessage(from,
        `📊 *Your Status*\n\nPlan: ${user.tier.toUpperCase()}\nImages: ${user.imagesProcessed}/${limit}\nRemaining: ${limit - user.imagesProcessed}\n\n${user.tier === 'free' ? '⭐ Send UPGRADE for Premium!' : '✨ Thanks for being Premium!'}`,
        botNumber
      );
    }
    else if (incomingMsg === 'help') {
      await sendWhatsAppMessage(from,
        `📖 *Commands*\n\n• START - Get started\n• STATUS - Check account\n• HELP - Show this\n• UPGRADE - Go Premium\n\nJust send an image to remove background!`,
        botNumber
      );
    }
    else if (incomingMsg === 'upgrade') {
      await sendWhatsAppMessage(from,
        `⭐ *Premium Plan - ₹999/month*\n\n✅ 100 images/month\n✅ Priority processing\n✅ HD quality\n\n💳 Reply CONFIRM to pay`,
        botNumber
      );
    }
    else if (incomingMsg === 'confirm') {
      if (!process.env.RAZORPAY_KEY_ID) {
        await sendWhatsAppMessage(from, '❌ Payments not configured', botNumber);
        return res.status(200).send('OK');
      }
      
      const railwayUrl = process.env.RAILWAY_DOMAIN 
        ? `https://${process.env.RAILWAY_DOMAIN}`
        : 'https://whatsapp-bg-remover-production.up.railway.app';
      
      await sendWhatsAppMessage(from,
        `💳 *Payment Link*\n\n🔗 ${railwayUrl}/pay/${from.replace('+', '')}\n\nPay ₹999 to upgrade!\n\nAfter payment, reply VERIFY`,
        botNumber
      );
    }
    else if (incomingMsg === 'verify') {
      if (user.tier === 'premium') {
        await sendWhatsAppMessage(from, `✅ You're Premium!\n\n100 images/month available 🎉`, botNumber);
      } else {
        await sendWhatsAppMessage(from, `⏳ Verifying payment...`, botNumber);
      }
    }
    else {
      await sendWhatsAppMessage(from, '👋 Send me an image to remove its background!\n\nType HELP for more.', botNumber);
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(200).send('OK');
  }
});

// Health check
app.get('/', (req, res) => res.send('✅ Bot running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`✅ Ready for messages!\n`);
});