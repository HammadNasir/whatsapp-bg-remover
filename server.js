require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const FormData = require('form-data');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

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

// Validation
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.error('❌ Missing required Twilio environment variables!');
  process.exit(1);
}

console.log('✅ Twilio configured');
if (!REMOVEBG_API_KEY) console.warn('⚠️  REMOVEBG_API_KEY not set');
if (!process.env.CLOUDINARY_CLOUD_NAME) console.warn('⚠️  Cloudinary not set');
if (!MONGODB_URI) console.warn('⚠️  MONGODB_URI not set - data will not persist');

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
      // Check if month reset needed
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
        `⭐ *Premium Plan*\n\n✅ 100 images/month\n✅ Priority processing\n✅ HD quality\n\n💰 $9.99/month\n\nFeature coming soon!`,
        botNumber
      );
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