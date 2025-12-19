const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/privatediary';
const BACKUP2_URL = process.env.BACKUP2_URL || 'http://localhost:3001';

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('Connected to MongoDB Atlas');
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

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    passwordHash: String,
    backupPasswordHash: String,
    locationPermission: { type: Boolean, default: false },
    notificationPermission: { type: Boolean, default: false },
    telegramChatId: String,
    blockedIPs: [String],
    blockedDevices: [String],
    emergencyLockUntil: Date,
    lastLogin: Date
});

const DiaryEntry = mongoose.model('DiaryEntry', diaryEntrySchema);
const LoginActivity = mongoose.model('LoginActivity', loginActivitySchema);
const User = mongoose.model('User', userSchema);

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        service: 'primary',
        timestamp: new Date().toISOString(),
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password, isBackup, deviceInfo, location } = req.body;
        
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (user.emergencyLockUntil && new Date() < user.emergencyLockUntil) {
            return res.status(403).json({ 
                error: 'Account locked until ' + user.emergencyLockUntil.toISOString() 
            });
        }
        
        const passwordToCheck = isBackup ? user.backupPasswordHash : user.passwordHash;
        const isValid = await bcrypt.compare(password, passwordToCheck);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        if (!location) {
            user.emergencyLockUntil = new Date(Date.now() + 15 * 60 * 1000);
            await user.save();
            
            await LoginActivity.create({
                userId: user._id,
                deviceId: deviceInfo.deviceId,
                deviceName: deviceInfo.deviceName,
                ip: deviceInfo.ip,
                isSuspicious: true,
                loginTime: new Date()
            });
            
            return res.status(403).json({ 
                error: 'Location permission required. Account locked for 15 minutes.' 
            });
        }
        
        user.lastLogin = new Date();
        await user.save();
        
        await LoginActivity.create({
            userId: user._id,
            deviceId: deviceInfo.deviceId,
            deviceName: deviceInfo.deviceName,
            ip: deviceInfo.ip,
            location: location,
            loginTime: new Date(),
            isActive: true
        });
        
        const token = require('crypto').randomBytes(32).toString('hex');
        
        res.json({ 
            token, 
            user: { username: user.username },
            requiresNotificationPermission: !user.notificationPermission 
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/diary', async (req, res) => {
    try {
        const { token, entry, location, deviceInfo } = req.body;
        
        const diaryEntry = await DiaryEntry.create({
            userId: 'user_from_token',
            title: entry.title,
            content: entry.content,
            tags: entry.tags || [],
            location: location,
            deviceInfo: deviceInfo
        });
        
        res.json({ 
            success: true, 
            entryId: diaryEntry._id,
            date: diaryEntry.date
        });
    } catch (error) {
        console.error('Diary entry error:', error);
        res.status(500).json({ error: 'Failed to save diary entry' });
    }
});

app.get('/api/diary', async (req, res) => {
    try {
        const { token } = req.query;
        
        const entries = await DiaryEntry.find({ userId: 'user_from_token' })
            .sort({ date: -1 })
            .limit(50);
        
        res.json({ entries });
    } catch (error) {
        console.error('Get diary error:', error);
        res.status(500).json({ error: 'Failed to fetch diary entries' });
    }
});

app.get('/api/activity', async (req, res) => {
    try {
        const { token } = req.query;
        
        const activities = await LoginActivity.find({ userId: 'user_from_token' })
            .sort({ loginTime: -1 })
            .limit(20);
        
        const activeDevices = await LoginActivity.find({ 
            userId: 'user_from_token', 
            isActive: true 
        });
        
        res.json({ activities, activeDevices });
    } catch (error) {
        console.error('Get activity error:', error);
        res.status(500).json({ error: 'Failed to fetch activity' });
    }
});

app.post('/api/logout-device', async (req, res) => {
    try {
        const { token, deviceId } = req.body;
        
        await LoginActivity.updateOne(
            { deviceId, isActive: true },
            { isActive: false, logoutTime: new Date() }
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Logout device error:', error);
        res.status(500).json({ error: 'Failed to logout device' });
    }
});

app.post('/api/block-ip', async (req, res) => {
    try {
        const { token, ip } = req.body;
        
        await User.updateOne(
            { _id: 'user_from_token' },
            { $addToSet: { blockedIPs: ip } }
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Block IP error:', error);
        res.status(500).json({ error: 'Failed to block IP' });
    }
});

async function checkBackupService() {
    try {
        const response = await fetch(`${BACKUP2_URL}/api/health`);
        if (!response.ok) {
            console.log('Backup service is down, sending notification');
        }
    } catch (error) {
        console.log('Cannot reach backup service:', error.message);
    }
}

setInterval(checkBackupService, 60000);

async function sendDailyReminder() {
    try {
        const now = new Date();
        const assamTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        
        if (assamTime.getHours() === 22 && assamTime.getMinutes() === 0) {
            const users = await User.find({ notificationPermission: true });
            
            for (const user of users) {
                if (user.telegramChatId) {
                    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: user.telegramChatId,
                            text: '⏰ 10:00 PM Assam Time - Time to write your daily diary entry!'
                        })
                    });
                }
            }
        }
    } catch (error) {
        console.error('Daily reminder error:', error);
    }
}

setInterval(sendDailyReminder, 60000);

app.listen(PORT, () => {
    console.log(`Primary backend running on port ${PORT}`);
});