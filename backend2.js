const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/privatediary';
const PRIMARY_URL = process.env.PRIMARY_URL || 'http://localhost:3000';

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('Connected to MongoDB Atlas (Backup)');
}).catch(err => {
    console.error('MongoDB connection error:', err);
});

const diaryEntrySchema = new mongoose.Schema({
    userId: String,
    title: String,
    content: String,
    date: { type: Date, default: Date.now },
    tags: [String],
    location: {
        lat: Number,
        lon: Number,
        accuracy: Number
    },
    deviceInfo: {
        deviceId: String,
        ip: String,
        userAgent: String
    }
});

const loginActivitySchema = new mongoose.Schema({
    userId: String,
    deviceId: String,
    deviceName: String,
    ip: String,
    location: {
        lat: Number,
        lon: Number,
        accuracy: Number
    },
    loginTime: { type: Date, default: Date.now },
    logoutTime: Date,
    isActive: { type: Boolean, default: true },
    isSuspicious: { type: Boolean, default: false }
});

const DiaryEntry = mongoose.model('DiaryEntry', diaryEntrySchema);
const LoginActivity = mongoose.model('LoginActivity', loginActivitySchema);

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        service: 'secondary',
        timestamp: new Date().toISOString(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

app.post('/api/sync-diary', async (req, res) => {
    try {
        const { entries } = req.body;
        
        for (const entry of entries) {
            await DiaryEntry.findOneAndUpdate(
                { _id: entry._id },
                entry,
                { upsert: true, new: true }
            );
        }
        
        res.json({ success: true, synced: entries.length });
    } catch (error) {
        console.error('Sync diary error:', error);
        res.status(500).json({ error: 'Failed to sync diary' });
    }
});

app.post('/api/sync-activity', async (req, res) => {
    try {
        const { activities } = req.body;
        
        for (const activity of activities) {
            await LoginActivity.findOneAndUpdate(
                { deviceId: activity.deviceId, loginTime: activity.loginTime },
                activity,
                { upsert: true, new: true }
            );
        }
        
        res.json({ success: true, synced: activities.length });
    } catch (error) {
        console.error('Sync activity error:', error);
        res.status(500).json({ error: 'Failed to sync activity' });
    }
});

app.get('/api/backup-data', async (req, res) => {
    try {
        const diaryEntries = await DiaryEntry.find().limit(100);
        const loginActivities = await LoginActivity.find().limit(100);
        
        res.json({ diaryEntries, loginActivities });
    } catch (error) {
        console.error('Backup data error:', error);
        res.status(500).json({ error: 'Failed to get backup data' });
    }
});

async function checkPrimaryService() {
    try {
        const response = await fetch(`${PRIMARY_URL}/api/health`);
        if (!response.ok) {
            console.log('Primary service is down, activating backup mode');
        }
    } catch (error) {
        console.log('Cannot reach primary service, backup is active:', error.message);
    }
}

async function syncWithPrimary() {
    try {
        const response = await fetch(`${PRIMARY_URL}/api/health`);
        if (response.ok) {
            const diaryEntries = await DiaryEntry.find().limit(50);
            const loginActivities = await LoginActivity.find().limit(50);
            
            await fetch(`${PRIMARY_URL}/api/sync-diary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: diaryEntries })
            });
            
            await fetch(`${PRIMARY_URL}/api/sync-activity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ activities: loginActivities })
            });
            
            console.log('Synced data with primary service');
        }
    } catch (error) {
        console.log('Sync with primary failed:', error.message);
    }
}

setInterval(checkPrimaryService, 30000);
setInterval(syncWithPrimary, 60000);

app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const { message } = req.body;
        
        if (message && message.text) {
            const text = message.text.toLowerCase();
            const chatId = message.chat.id;
            
            if (text.startsWith('/')) {
                const command = text.split(' ')[0];
                
                switch(command) {
                    case '/start':
                        await sendTelegramMessage(chatId, '🤖 Private Diary Bot\n\nCommands:\n/entries - View recent diary entries\n/activity - Check login activity\n/blockip [ip] - Block an IP address\n/logoutall - Logout all devices\n/status - Check service status');
                        break;
                    
                    case '/entries':
                        const entries = await DiaryEntry.find().sort({ date: -1 }).limit(5);
                        if (entries.length > 0) {
                            let responseText = '📝 Recent Diary Entries:\n\n';
                            entries.forEach(entry => {
                                const date = new Date(entry.date).toLocaleDateString();
                                responseText += `• ${entry.title} (${date})\n`;
                            });
                            await sendTelegramMessage(chatId, responseText);
                        } else {
                            await sendTelegramMessage(chatId, 'No diary entries found.');
                        }
                        break;
                    
                    case '/activity':
                        const activities = await LoginActivity.find().sort({ loginTime: -1 }).limit(5);
                        if (activities.length > 0) {
                            let responseText = '🔐 Recent Login Activity:\n\n';
                            activities.forEach(activity => {
                                const time = new Date(activity.loginTime).toLocaleString();
                                const status = activity.isActive ? '🟢 Active' : '🔴 Inactive';
                                responseText += `• ${activity.deviceName} - ${activity.ip}\n  ${time} ${status}\n`;
                            });
                            await sendTelegramMessage(chatId, responseText);
                        } else {
                            await sendTelegramMessage(chatId, 'No login activity found.');
                        }
                        break;
                    
                    case '/status':
                        const diaryCount = await DiaryEntry.countDocuments();
                        const activityCount = await LoginActivity.countDocuments();
                        const activeDevices = await LoginActivity.countDocuments({ isActive: true });
                        
                        await sendTelegramMessage(chatId, 
                            `📊 Service Status:\n\n` +
                            `Diary Entries: ${diaryCount}\n` +
                            `Login Records: ${activityCount}\n` +
                            `Active Devices: ${activeDevices}\n` +
                            `Backend: 🟢 Running`
                        );
                        break;
                    
                    default:
                        await sendTelegramMessage(chatId, 'Unknown command. Use /start to see available commands.');
                }
            }
        }
        
        res.json({ ok: true });
    } catch (error) {
        console.error('Telegram webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

async function sendTelegramMessage(chatId, text) {
    try {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text
            })
        });
    } catch (error) {
        console.error('Send Telegram message error:', error);
    }
}

app.listen(PORT, () => {
    console.log(`Secondary backup running on port ${PORT}`);
});