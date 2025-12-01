require('dotenv').config();
console.log('🔧 Environment loaded - Discord webhook:', process.env.DISCORD_CONTROL_WEBHOOK ? 'CONFIGURED ✅' : 'NOT SET ❌');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// If MODEL_URL or CLASS_URL are provided in the environment, download them at startup
const MODEL_URL = process.env.MODEL_URL || null;
const CLASS_URL = process.env.CLASS_URL || null;
// Default model filename set to 'trained_model.h5' per user request
const MODEL_FILENAME = process.env.MODEL_FILE || 'trained_model.h5';
const CLASS_FILENAME = process.env.CLASS_FILE || 'class_names.txt';
const MODEL_LOCAL_PATH = path.join(__dirname, MODEL_FILENAME);
const CLASS_LOCAL_PATH = path.join(__dirname, CLASS_FILENAME);

const http = require('http');
const https = require('https');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Global error handlers to surface uncaught exceptions/rejections (helps debugging crashes)
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION - crashing? ->', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, p) => {
    console.error('UNHANDLED REJECTION at Promise', p, 'reason:', reason);
});

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        const req = client.get(url, (res) => {
            if (res.statusCode >= 400) {
                return reject(new Error('Failed to download file: ' + res.statusCode));
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        });
        req.on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
        file.on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
    });
}

async function ensureModelFiles() {
    try {
        if (MODEL_URL) {
            console.log('MODEL_URL provided, downloading model from', MODEL_URL);
            await downloadFile(MODEL_URL, MODEL_LOCAL_PATH);
            console.log('Model downloaded to', MODEL_LOCAL_PATH);
        } else if (!fs.existsSync(MODEL_LOCAL_PATH)) {
            console.warn('No MODEL_URL provided and local model not found at', MODEL_LOCAL_PATH);
        }

        if (CLASS_URL) {
            console.log('CLASS_URL provided, downloading class names from', CLASS_URL);
            await downloadFile(CLASS_URL, CLASS_LOCAL_PATH);
            console.log('Class names downloaded to', CLASS_LOCAL_PATH);
        } else if (!fs.existsSync(CLASS_LOCAL_PATH)) {
            console.warn('No CLASS_URL provided and local class_names.txt not found at', CLASS_LOCAL_PATH);
        }
    } catch (e) {
        console.error('Failed to ensure model files:', e);
        // Do not crash the server here; let predict.py handle missing model gracefully later.
    }
}

// Debug: keep uploaded files for inspection when true
const KEEP_UPLOADS = true;

// Middleware
app.use(cors());
app.use(express.json()); // Built-in body parser

// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// In-memory state (simulating database/hardware)
let sensorData = {
    soilHumidity: {
        value: 45,
        timestamp: new Date(),
        status: 'normal'
    },
    dht22: {
        temperature: 24,
        humidity: 60,
        timestamp: new Date(),
        status: 'normal'
    }
};

let pumpStatus = {
    isRunning: false,
    lastStarted: null,
    lastStopped: null,
    totalRuntime: 0 // in minutes
};

// Notifications history (person-detection events etc.)
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
let notifications = []; // newest last
// SSE clients (res objects)
let sseClients = [];

// Simple user store (file-backed). Passwords are hashed with bcryptjs.
const USERS_FILE = path.join(__dirname, 'users.json');
let users = []; // { id, name, email, passwordHash }

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const raw = fs.readFileSync(USERS_FILE, 'utf8');
            users = JSON.parse(raw) || [];
        }
    } catch (e) {
        console.error('Failed to load users:', e);
        users = [];
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('Failed to save users:', e);
    }
}

loadUsers();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function generateToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authMiddleware(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Missing token' });
    const token = auth.slice('Bearer '.length).trim();
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'Invalid token' });
    }
}

function loadNotifications() {
    try {
        if (fs.existsSync(NOTIFICATIONS_FILE)) {
            const raw = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
            notifications = JSON.parse(raw) || [];
        }
    } catch (e) {
        console.error('Failed to load notifications:', e);
        notifications = [];
    }
}

function saveNotifications() {
    try {
        fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2));
    } catch (e) {
        console.error('Failed to save notifications:', e);
    }
}

loadNotifications();

// Helper: send push notifications via Expo Push API (no extra dependency)
async function sendPushNotificationsForNote(note) {
    try {
        // collect all saved device tokens from users
        const tokens = [];
        for (const u of users) {
            if (u.deviceTokens && Array.isArray(u.deviceTokens)) {
                for (const t of u.deviceTokens) {
                    if (t && typeof t === 'string') tokens.push(t);
                }
            }
        }
        if (!tokens.length) return;

        // construct messages for Expo
        const messages = tokens.map((t) => ({
            to: t,
            title: note.event || 'Notification',
            body: note.camera ? `Camera: ${note.camera}` : 'New notification',
            data: { note }
        }));

        // Expo expects an array of messages
        const postData = JSON.stringify(messages);

        const options = {
            hostname: 'exp.host',
            port: 443,
            path: '/--/api/v2/push/send',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data || '{}');
                    console.log('Expo push response:', parsed);
                } catch (e) {
                    console.log('Expo push raw response:', data);
                }
            });
        });

        req.on('error', (err) => {
            console.error('Failed to send Expo push:', err && err.stack ? err.stack : err);
        });

        req.write(postData);
        req.end();
    } catch (e) {
        console.error('sendPushNotificationsForNote error', e && e.stack ? e.stack : e);
    }
}

// Simple schedule store (persisted to schedules.json)
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
let schedules = [];
let scheduleTimers = {}; // id -> timeout ids

// Simple settings store (persisted)
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = {};

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
            settings = JSON.parse(raw) || {};
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
        settings = {};
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

loadSettings();

function loadSchedules() {
    try {
        if (fs.existsSync(SCHEDULES_FILE)) {
            const raw = fs.readFileSync(SCHEDULES_FILE, 'utf8');
            schedules = JSON.parse(raw) || [];
        }
    } catch (e) {
        console.error('Failed to load schedules:', e);
        schedules = [];
    }
}

function saveSchedules() {
    try {
        fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
    } catch (e) {
        console.error('Failed to save schedules:', e);
    }
}

// Utility: compute next Date from a time string 'HH:MM' (today or tomorrow if time passed)
function nextDateFromTimeString(timeStr) {
    const [hh, mm] = timeStr.split(':').map((v) => parseInt(v, 10));
    const now = new Date();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
        // schedule for tomorrow
        candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
}

// Schedule a single job: start at startTime (HH:MM or ISO), run for durationMinutes, repeat repeatCount times
function scheduleJob(job) {
    const id = job.id;
    // clear previous timers
    if (scheduleTimers[id]) {
        clearTimeout(scheduleTimers[id]);
    }

    let startAt;
    // Accept full ISO or HH:MM
    if (job.startTime.includes('T')) {
        startAt = new Date(job.startTime);
        if (isNaN(startAt.getTime())) startAt = nextDateFromTimeString(job.startTime);
    } else {
        startAt = nextDateFromTimeString(job.startTime);
    }

    const delay = Math.max(0, startAt.getTime() - Date.now());
    console.log(`Scheduling job ${id} to run at ${startAt.toISOString()} (in ${Math.round(delay / 1000)}s)`);

    const timer = setTimeout(async () => {
        // Execute cycle(s)
        const cycles = job.repeatCount && job.repeatCount > 0 ? job.repeatCount : 1;
        for (let i = 0; i < cycles; i++) {
            console.log(`Executing scheduled job ${id} cycle ${i + 1}/${cycles}`);
            // start pump
            if (!pumpStatus.isRunning) {
                pumpStatus.isRunning = true;
                pumpStatus.lastStarted = new Date();
            }

            // wait duration
            await new Promise((r) => setTimeout(r, (job.durationMinutes || 1) * 60 * 1000));

            // stop pump
            if (pumpStatus.isRunning) {
                pumpStatus.isRunning = false;
                pumpStatus.lastStopped = new Date();
                const runtime = (pumpStatus.lastStopped - pumpStatus.lastStarted) / 1000 / 60; // minutes
                pumpStatus.totalRuntime += runtime;
            }

            // small gap (1 minute) between cycles if multiple
            if (i < cycles - 1) await new Promise((r) => setTimeout(r, 60 * 1000));
        }

        // If the job is recurring (not implemented), you'd re-schedule here. For now, we keep one-shot jobs as saved.
        delete scheduleTimers[id];
    }, delay);

    scheduleTimers[id] = timer;
}

// Initialize schedules on startup
loadSchedules();
for (const job of schedules) {
    try { scheduleJob(job); } catch (e) { console.error('Failed scheduling job on startup', e); }
}

// Helper to determine status based on thresholds
const getStatus = (value, type) => {
    if (type === 'soil') {
        if (value < 20) return 'low';
        if (value > 80) return 'high';
        return 'normal';
    }
    if (type === 'temp') {
        if (value < 10 || value > 35) return 'warning';
        return 'normal';
    }
    return 'normal';
};

// --- API Endpoints ---

// --- Auth: register / login / profile ---
// POST /api/auth/register { name, email, password }
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
        if (!email.includes('@') || password.length < 4) return res.status(400).json({ success: false, error: 'Invalid email or password' });
        const exists = users.find(u => u.email === email.toLowerCase());
        if (exists) return res.status(409).json({ success: false, error: 'User already exists' });
        const passwordHash = await bcrypt.hash(password, 10);
        const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const user = { id, name: name || undefined, email: email.toLowerCase(), passwordHash };
        users.push(user);
        saveUsers();
        const token = generateToken({ id: user.id, email: user.email });
        return res.json({ success: true, data: { token, user: { id: user.id, name: user.name, email: user.email } } });
    } catch (e) {
        console.error('Register failed', e);
        res.status(500).json({ success: false, error: 'Register failed' });
    }
});

// POST /api/auth/login { email, password }
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ success: false, error: 'email and password required' });
        const user = users.find(u => u.email === email.toLowerCase());
        if (!user) return res.status(401).json({ success: false, error: 'Invalid credentials' });
        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return res.status(401).json({ success: false, error: 'Invalid credentials' });
        const token = generateToken({ id: user.id, email: user.email });
        return res.json({ success: true, data: { token, user: { id: user.id, name: user.name, email: user.email } } });
    } catch (e) {
        console.error('Login failed', e);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

// GET /api/profile -> requires Bearer token
app.get('/api/profile', authMiddleware, (req, res) => {
    try {
        const user = users.find(u => u.id === req.user.id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        return res.json({ success: true, data: { id: user.id, name: user.name, email: user.email, hasPin: !!user.pinHash } });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to fetch profile' });
    }
});

// POST /api/auth/set-pin { pin }
app.post('/api/auth/set-pin', authMiddleware, async (req, res) => {
    try {
        const { pin } = req.body || {};
        if (!pin || typeof pin !== 'string' || pin.length < 4 || pin.length > 6) return res.status(400).json({ success: false, error: 'PIN must be 4-6 digits' });
        const user = users.find(u => u.id === req.user.id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        const hash = await bcrypt.hash(pin, 10);
        user.pinHash = hash;
        user.pinFailedAttempts = 0;
        user.pinLockedUntil = null;
        saveUsers();
        return res.json({ success: true });
    } catch (e) {
        console.error('set-pin failed', e);
        res.status(500).json({ success: false, error: 'Failed to set PIN' });
    }
});

// POST /api/auth/verify-pin { pin }
app.post('/api/auth/verify-pin', authMiddleware, async (req, res) => {
    try {
        const { pin } = req.body || {};
        if (!pin || typeof pin !== 'string') return res.status(400).json({ success: false, error: 'PIN required' });
        const user = users.find(u => u.id === req.user.id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        // Check lockout
        if (user.pinLockedUntil && new Date(user.pinLockedUntil) > new Date()) {
            return res.status(423).json({ success: false, error: 'PIN locked. Try later.' });
        }

        if (!user.pinHash) return res.status(400).json({ success: false, error: 'No PIN set' });

        const ok = await bcrypt.compare(pin, user.pinHash);
        if (ok) {
            user.pinFailedAttempts = 0;
            user.pinLockedUntil = null;
            saveUsers();
            return res.json({ success: true });
        }

        user.pinFailedAttempts = (user.pinFailedAttempts || 0) + 1;
        // lock for 5 minutes after 5 failed attempts
        if (user.pinFailedAttempts >= 5) {
            user.pinLockedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
            saveUsers();
            return res.status(423).json({ success: false, error: 'Too many attempts. PIN locked for 5 minutes.' });
        }
        saveUsers();
        return res.status(401).json({ success: false, error: 'Invalid PIN' });
    } catch (e) {
        console.error('verify-pin failed', e);
        res.status(500).json({ success: false, error: 'Failed to verify PIN' });
    }
});

// POST /api/auth/remove-pin -> clears stored pin
app.post('/api/auth/remove-pin', authMiddleware, (req, res) => {
    try {
        const user = users.find(u => u.id === req.user.id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        user.pinHash = null;
        user.pinFailedAttempts = 0;
        user.pinLockedUntil = null;
        saveUsers();
        return res.json({ success: true });
    } catch (e) {
        console.error('remove-pin failed', e);
        res.status(500).json({ success: false, error: 'Failed to remove PIN' });
    }
});

// POST /api/auth/change-password { currentPassword, newPassword }
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || !newPassword) return res.status(400).json({ success: false, error: 'currentPassword and newPassword required' });
        if (typeof newPassword !== 'string' || newPassword.length < 4) return res.status(400).json({ success: false, error: 'newPassword must be at least 4 characters' });

        const user = users.find(u => u.id === req.user.id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const ok = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!ok) return res.status(401).json({ success: false, error: 'Current password is incorrect' });

        const hash = await bcrypt.hash(newPassword, 10);
        user.passwordHash = hash;
        saveUsers();
        return res.json({ success: true });
    } catch (e) {
        console.error('change-password failed', e);
        res.status(500).json({ success: false, error: 'Failed to change password' });
    }
});

// POST /api/device-token { token }
// Save a device push token (Expo push token) for the authenticated user
app.post('/api/device-token', authMiddleware, (req, res) => {
    try {
        const { token } = req.body || {};
        if (!token || typeof token !== 'string') return res.status(400).json({ success: false, error: 'token required' });
        const user = users.find(u => u.id === req.user.id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if (!user.deviceTokens) user.deviceTokens = [];
        if (!user.deviceTokens.includes(token)) {
            user.deviceTokens.push(token);
            saveUsers();
        }
        return res.json({ success: true });
    } catch (e) {
        console.error('device-token save failed', e);
        res.status(500).json({ success: false, error: 'Failed to save device token' });
    }
});


// 1. Get Sensor Data (Frontend -> Backend)
app.get('/api/sensors', (req, res) => {
    res.json({
        success: true,
        data: sensorData
    });

});

// POST /api/sensors -> accept sensor-only updates from devices (e.g., Raspberry Pi)
// Accepts JSON with fields: soilMoisture / soilHumidity / moisture, temperature / temp, humidity / h
app.post('/api/sensors', (req, res) => {
    try {
        const payload = req.body || {};

        // Normalize soil value
        const soil = payload.soilMoisture !== undefined ? payload.soilMoisture : (payload.soilHumidity !== undefined ? payload.soilHumidity : (payload.moisture !== undefined ? payload.moisture : undefined));

        // Normalize temperature/humidity
        const temperature = payload.temperature !== undefined ? payload.temperature : (payload.temp !== undefined ? payload.temp : undefined);
        const humidity = payload.humidity !== undefined ? payload.humidity : (payload.h !== undefined ? payload.h : undefined);

        // Update sensorData if provided (treat 0 as valid)
        if (soil !== undefined && soil !== null) {
            const v = Number(soil);
            sensorData.soilHumidity = {
                value: isNaN(v) ? sensorData.soilHumidity.value : v,
                timestamp: new Date(),
                status: getStatus(isNaN(v) ? sensorData.soilHumidity.value : v, 'soil')
            };
        }

        if (temperature !== undefined && temperature !== null && humidity !== undefined && humidity !== null) {
            const t = Number(temperature);
            const h = Number(humidity);
            sensorData.dht22 = {
                temperature: isNaN(t) ? sensorData.dht22.temperature : t,
                humidity: isNaN(h) ? sensorData.dht22.humidity : h,
                timestamp: new Date(),
                status: getStatus(isNaN(t) ? sensorData.dht22.temperature : t, 'temp')
            };
        } else {
            // If only one of temperature/humidity provided, update that value
            if (temperature !== undefined && temperature !== null) {
                const t = Number(temperature);
                sensorData.dht22.temperature = isNaN(t) ? sensorData.dht22.temperature : t;
                sensorData.dht22.timestamp = new Date();
                sensorData.dht22.status = getStatus(sensorData.dht22.temperature, 'temp');
            }
            if (humidity !== undefined && humidity !== null) {
                const h = Number(humidity);
                sensorData.dht22.humidity = isNaN(h) ? sensorData.dht22.humidity : h;
                sensorData.dht22.timestamp = new Date();
            }
        }

        console.log('Received sensors POST:', payload);
        return res.json({ success: true, data: sensorData });
    } catch (e) {
        console.error('Failed handling POST /api/sensors', e);
        return res.status(500).json({ success: false, error: String(e) });
    }
});

// 2. Get Pump Status (Frontend -> Backend)
app.get('/api/pump/status', (req, res) => {
    res.json({
        success: true,
        data: pumpStatus
    });
});

// 3. Control Pump (Frontend -> Backend)
app.post('/api/pump', (req, res) => {
    console.log('Received pump control request:', req.body);
    const { action, manual } = req.body;

    if (action === 'start') {
        if (!pumpStatus.isRunning) {
            pumpStatus.isRunning = true;
            pumpStatus.lastStarted = new Date();
            console.log('Pump started manually');
            // notify configured Discord webhook about pump start
            try { sendDiscordControl('PUMP_ON'); } catch (e) { console.error(e); }
        }
    } else if (action === 'stop') {
        if (pumpStatus.isRunning) {
            pumpStatus.isRunning = false;
            pumpStatus.lastStopped = new Date();
            // Calculate runtime
            const runtime = (pumpStatus.lastStopped - pumpStatus.lastStarted) / 1000 / 60; // minutes
            pumpStatus.totalRuntime += runtime;
            console.log('Pump stopped manually');
            // notify configured Discord webhook about pump stop
            try { sendDiscordControl('PUMP_OFF'); } catch (e) { console.error(e); }
        }
    } else {
        return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    res.json({
        success: true,
        data: pumpStatus
    });
});

// Helper: send a simple control message to a configured Discord webhook (if present)
async function sendDiscordControl(command) {
    try {
        const webhook = settings.discordControlWebhook || process.env.DISCORD_CONTROL_WEBHOOK;
        console.log('🔍 Discord webhook URL:', webhook ? 'Found' : 'NOT FOUND');
        console.log('🔍 Attempting to send command:', command);
        if (!webhook) {
            console.log('❌ No Discord webhook configured - skipping');
            return;
        }

        const payload = JSON.stringify({ content: `BOT_COMMAND: ${command}` });

        const u = new URL(webhook);
        const client = u.protocol === 'https:' ? https : http;

        const options = {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + (u.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };

        const req = client.request(options, (resp) => {
            let data = '';
            resp.on('data', (chunk) => (data += chunk));
            resp.on('end', () => {
                // Discord returns 204 No Content on success for webhooks
                console.log('Discord webhook response', resp.statusCode);
            });
        });
        req.on('error', (err) => {
            console.error('Failed to send Discord control webhook:', err && err.stack ? err.stack : err);
        });
        req.write(payload);
        req.end();
    } catch (e) {
        console.error('sendDiscordControl error', e && e.stack ? e.stack : e);
    }
}

// Authenticated endpoint to set the Discord control webhook URL (stores in settings.json)
app.post('/api/settings/discord-webhook', authMiddleware, (req, res) => {
    try {
        const { webhook } = req.body || {};
        if (!webhook || typeof webhook !== 'string') return res.status(400).json({ success: false, error: 'webhook (string) required' });
        settings.discordControlWebhook = webhook;
        saveSettings();
        return res.json({ success: true, data: { webhook } });
    } catch (e) {
        console.error('Failed to save discord webhook setting', e);
        res.status(500).json({ success: false, error: 'Failed to save setting' });
    }
});

// GET /api/settings -> return persisted settings (authenticated)
app.get('/api/settings', authMiddleware, (req, res) => {
    try {
        return res.json({ success: true, data: settings });
    } catch (e) {
        console.error('Failed to read settings', e);
        res.status(500).json({ success: false, error: 'Failed to read settings' });
    }
});

// --- IoT Device Endpoints (ESP32 -> Backend) ---

// 4. Receive Sensor Data from ESP32
app.post('/api/iot/sensors', (req, res) => {
    const { soilMoisture, temperature, humidity } = req.body;

    if (soilMoisture !== undefined) {
        sensorData.soilHumidity = {
            value: soilMoisture,
            timestamp: new Date(),
            status: getStatus(soilMoisture, 'soil')
        };
    }

    if (temperature !== undefined && humidity !== undefined) {
        sensorData.dht22 = {
            temperature,
            humidity,
            timestamp: new Date(),
            status: getStatus(temperature, 'temp')
        };
    }

    console.log('Received IoT Data:', req.body);
    res.json({ success: true, message: 'Data received' });
});

// 5. ESP32 Polls for Pump Command
// The ESP32 should periodically check this to know if it should turn the pump ON/OFF
app.get('/api/iot/pump', (req, res) => {
    res.json({
        command: pumpStatus.isRunning ? 'ON' : 'OFF'
    });
});

// --- Notifications from devices (e.g., Raspberry Pi person detection) ---
// POST /api/notifications  { event, timestamp, camera, image_url }
app.post('/api/notifications', (req, res) => {
    try {
        const payload = req.body || {};
        const event = payload.event || 'notification';
        const timestamp = payload.timestamp || new Date().toISOString();
        const camera = payload.camera || 'unknown';
        const image_url = payload.image_url || payload.imageUrl || payload.image || null;

        // Extract sensor values if provided by sender (e.g., Raspberry Pi)
        const temperature = payload.temperature !== undefined ? payload.temperature : (payload.temp !== undefined ? payload.temp : null);
        const humidity = payload.humidity !== undefined ? payload.humidity : (payload.h !== undefined ? payload.h : null);
        // accept several possible soil moisture keys
        const soil = payload.soilMoisture !== undefined ? payload.soilMoisture : (payload.soilHumidity !== undefined ? payload.soilHumidity : (payload.moisture !== undefined ? payload.moisture : null));

        // If notification carries sensor readings, update the global sensor snapshot
        try {
            if (soil !== null && soil !== undefined) {
                const v = Number(soil);
                sensorData.soilHumidity = {
                    value: isNaN(v) ? sensorData.soilHumidity.value : v,
                    timestamp: new Date(),
                    status: getStatus(isNaN(v) ? sensorData.soilHumidity.value : v, 'soil')
                };
            }
            if (temperature !== null && temperature !== undefined && humidity !== null && humidity !== undefined) {
                const t = Number(temperature);
                const h = Number(humidity);
                sensorData.dht22 = {
                    temperature: isNaN(t) ? sensorData.dht22.temperature : t,
                    humidity: isNaN(h) ? sensorData.dht22.humidity : h,
                    timestamp: new Date(),
                    status: getStatus(isNaN(t) ? sensorData.dht22.temperature : t, 'temp')
                };
            }
        } catch (e) {
            console.warn('Failed to update sensorData from notification payload', e);
        }

        const note = {
            id: `n-${Date.now()}`,
            event,
            timestamp,
            camera,
            image_url,
            // top-level sensor fields for easier frontend display/search
            temperature: temperature !== null ? temperature : undefined,
            humidity: humidity !== null ? humidity : undefined,
            raw: payload
        };

        // If this payload is sensor-only (no image and not a person_detected event),
        // update sensors (already done above) and return without creating a notification.
        const isSensorOnly = (!image_url) && (String(event).toLowerCase() !== 'person_detected');
        if (isSensorOnly) {
            console.log('Received sensor-only POST to /api/notifications; not saving as a notification.');
            return res.json({ success: true, message: 'Sensor update only', data: note });
        }

        // keep history bounded
        notifications.push(note);
        const MAX_HISTORY = 200;
        if (notifications.length > MAX_HISTORY) notifications = notifications.slice(-MAX_HISTORY);
        saveNotifications();

        // Broadcast to SSE clients (clean broken/closed clients first)
        try {
            const msg = JSON.stringify(note);
            sseClients = sseClients.filter((client) => !client.finished && !client.destroyed && client.writable);
            sseClients.forEach((client) => {
                try {
                    client.write(`data: ${msg}\n\n`);
                } catch (e) {
                    console.error('Failed writing SSE to a client:', e && e.stack ? e.stack : e);
                }
            });
        } catch (e) {
            console.error('Error broadcasting SSE notification:', e && e.stack ? e.stack : e);
        }

        console.log('Received notification:', note.event, note.timestamp, note.camera);
        // Fire-and-forget push notifications to registered devices
        try {
            sendPushNotificationsForNote(note);
        } catch (e) {
            console.error('Error firing push notifications:', e);
        }

        res.json({ success: true, data: note });
    } catch (e) {
        console.error('Failed handling notification POST:', e);
        res.status(500).json({ success: false, error: String(e) });
    }
});

// GET /api/notifications -> list
app.get('/api/notifications', (req, res) => {
    res.json({ success: true, data: notifications });
});

// GET /api/notifications/stream -> Server-Sent Events for real-time updates
app.get('/api/notifications/stream', (req, res) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    // Send a comment to establish the connection
    res.write(`: connected\n\n`);

    // Register client
    sseClients.push(res);

    // Remove client on close
    req.on('close', () => {
        sseClients = sseClients.filter((c) => c !== res);
    });
});

// 6. Schedule Pump (Frontend -> Backend)
app.post('/api/pump/schedule', (req, res) => {
    const { startTime, durationMinutes, repeatCount } = req.body || {};

    if (!startTime || !durationMinutes) {
        return res.status(400).json({ success: false, error: 'startTime and durationMinutes are required' });
    }

    const id = `job-${Date.now()}`;
    const job = { id, startTime, durationMinutes: Number(durationMinutes), repeatCount: repeatCount ? Number(repeatCount) : undefined };

    schedules.push(job);
    saveSchedules();

    try {
        scheduleJob(job);
    } catch (e) {
        console.error('Failed to schedule job:', e);
        return res.status(500).json({ success: false, error: 'Failed to schedule job' });
    }

    res.json({ success: true, data: { scheduled: true, job } });
});

app.get('/api/pump/schedule', (req, res) => {
    res.json({ success: true, data: schedules });
});

// Configure Multer for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// ... (existing code)

// 6. Analyze Image (Frontend -> Backend -> Python)
// Helpful GET handler so a browser visiting the route sees instructions
app.get('/api/analyze', (req, res) => {
    console.log('Handling GET /api/analyze - returning usage JSON');
    res.status(200).json({
        success: false,
        error: 'This endpoint accepts POST requests with multipart/form-data. Use POST /api/analyze with field "image" (file).'
    });
});

// Model status endpoint: reports whether model/class files exist and optionally attempts a quick TensorFlow import check
app.get('/api/model/status', async (req, res) => {
    try {
        const modelExists = fs.existsSync(MODEL_LOCAL_PATH);
        const classExists = fs.existsSync(CLASS_LOCAL_PATH);
        const modelStat = modelExists ? fs.statSync(MODEL_LOCAL_PATH) : null;

        // Try a quick Python/TensorFlow import check (fast diagnostic)
        let pyCheck = { ok: false, output: null, error: null };
        const pythonCandidates = ['python', 'python3', 'py'];
        function findPythonCmd() {
            for (const cmd of pythonCandidates) {
                try {
                    const result = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
                    if (result.status === 0) return cmd;
                } catch (e) { }
            }
            return null;
        }

        const pythonCmd = findPythonCmd();
        if (pythonCmd) {
            try {
                const check = spawnSync(pythonCmd, ['-c', "import tensorflow as tf; print('TF_OK', tf.__version__)"], { encoding: 'utf8', timeout: 20 * 1000 });
                pyCheck.output = (check.stdout || '').trim();
                pyCheck.error = (check.stderr || '').trim();
                pyCheck.ok = check.status === 0;
            } catch (e) {
                pyCheck.error = String(e);
            }
        } else {
            pyCheck.error = 'No python executable found in PATH';
        }

        res.json({
            success: true,
            data: {
                modelFile: MODEL_LOCAL_PATH,
                modelExists,
                modelStat: modelStat ? { size: modelStat.size, mtime: modelStat.mtime } : null,
                classFile: CLASS_LOCAL_PATH,
                classExists,
                pythonCheck: pyCheck,
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: String(e) });
    }
});

// Analyze a bundled sample image (useful for quick web testing)
// Place a file named `sample.jpg` in the backend folder to use this.
app.get('/api/analyze/sample', (req, res) => {
    const samplePath = path.join(__dirname, 'sample.jpg');
    if (!fs.existsSync(samplePath)) {
        return res.status(404).json({ success: false, error: 'Sample image not found. Place sample.jpg in the backend folder.' });
    }

    const scriptPath = path.join(__dirname, 'predict.py');

    // Find Python as before
    const pythonCandidates = ['python', 'python3', 'py'];
    function findPythonCmd() {
        for (const cmd of pythonCandidates) {
            try {
                const result = spawnSync(cmd, ['--version']);
                if (result.status === 0) return cmd;
            } catch (e) { }
        }
        return null;
    }

    const pythonCmd = findPythonCmd();
    if (!pythonCmd) {
        return res.status(500).json({ success: false, error: 'No Python executable found in PATH.' });
    }

    const pythonProcess = spawn(pythonCmd, [scriptPath, samplePath]);

    let resultData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
        resultData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        console.error('Python Error (sample):', data.toString());
    });

    pythonProcess.on('close', (code) => {
        if (code !== 0) {
            return res.status(500).json({ success: false, error: 'Analysis failed', details: errorData });
        }
        try {
            const result = JSON.parse(resultData);
            res.json({ success: true, data: result });
        } catch (e) {
            res.status(500).json({ success: false, error: 'Failed to parse analysis result', raw: resultData });
        }
    });
});

// Simple HTML test form to exercise the /api/analyze POST endpoint from a browser
app.get('/analyze/test', (req, res) => {
    const html = `<!doctype html>
<html>
    <head><meta charset="utf-8"><title>Analyze Test</title></head>
    <body>
        <h1>Upload image to /api/analyze</h1>
        <form method="post" action="/api/analyze" enctype="multipart/form-data">
            <input type="file" name="image" accept="image/*" required />
            <button type="submit">Upload & Analyze</button>
        </form>
        <p>Response will appear as JSON in the browser or download prompt.</p>
    </body>
</html>`;
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
});

// Simple notifications UI for local testing
app.get('/notifications/ui', (req, res) => {
    const filePath = path.join(__dirname, 'notifications_ui.html');
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('notifications_ui.html not found.');
    }
    res.sendFile(filePath);
});

app.post('/api/analyze', upload.single('image'), (req, res) => {
    console.log('Handling POST /api/analyze');
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No image uploaded' });
    }

    console.log('Received image for analysis:', req.file.path);

    // Path to your Python script and Model
    const scriptPath = path.join(__dirname, 'predict.py');
    const imagePath = req.file.path;

    // Find a Python executable in PATH: try 'python', 'python3', then 'py'
    const pythonCandidates = ['python', 'python3', 'py'];

    function findPythonCmd() {
        for (const cmd of pythonCandidates) {
            try {
                const result = spawnSync(cmd, ['--version']);
                if (result.status === 0) return cmd;
            } catch (e) {
                // ignore and try next
            }
        }
        return null;
    }

    const pythonCmd = findPythonCmd();
    if (!pythonCmd) {
        // Optionally clean up uploaded file
        if (!KEEP_UPLOADS) {
            try { fs.unlinkSync(imagePath); } catch (e) { }
        } else {
            console.log('Keeping uploaded file for debugging:', imagePath);
        }
        return res.status(500).json({
            success: false,
            error: 'No Python executable found in PATH. Please install Python and ensure `python` or `py` is available.'
        });
    }

    // Spawn Python process
    const pythonProcess = spawn(pythonCmd, [scriptPath, imagePath]);

    let resultData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
        resultData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        console.error('Python Error:', data.toString());
    });

    pythonProcess.on('close', (code) => {
        // Optionally clean up uploaded file
        if (!KEEP_UPLOADS) {
            try { fs.unlinkSync(imagePath); } catch (e) { }
        } else {
            console.log('Keeping uploaded file for debugging:', imagePath);
        }

        if (code !== 0) {
            return res.status(500).json({
                success: false,
                error: 'Analysis failed',
                details: errorData
            });
        }

        try {
            const result = JSON.parse(resultData);
            res.json({ success: true, data: result });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: 'Failed to parse analysis result',
                raw: resultData
            });
        }
    });
});

// Start Server after ensuring model files (if provided)
(async () => {
    await ensureModelFiles();
    app.listen(PORT, () => {
        console.log(`Backend server running on http://localhost:${PORT}`);
        console.log(`API Endpoints:`);
        console.log(` - GET  /api/sensors`);
        console.log(` - GET  /api/pump/status`);
        console.log(` - POST /api/pump`);
        console.log(`IoT Endpoints:`);
        console.log(` - POST /api/iot/sensors`);
        console.log(` - GET  /api/iot/pump`);
    });
})();

// --- Discord integration: fetch recent messages from a webhook and import attachments ---
// Helper: parse webhook URL into { id, token }
function parseDiscordWebhook(url) {
    try {
        // examples:
        // https://discord.com/api/webhooks/{webhook.id}/{webhook.token}
        // https://discordapp.com/api/webhooks/{webhook.id}/{webhook.token}
        const m = url.match(/webhooks\/([0-9]+)\/([A-Za-z0-9_-]+)/);
        if (!m) return null;
        return { id: m[1], token: m[2] };
    } catch (e) {
        return null;
    }
}

async function fetchDiscordMessages(webhookUrl, limit = 10) {
    return new Promise((resolve, reject) => {
        const parsed = parseDiscordWebhook(webhookUrl);
        if (!parsed) return reject(new Error('Invalid webhook URL'));
        const apiUrl = `https://discord.com/api/webhooks/${parsed.id}/${parsed.token}/messages?limit=${limit}`;
        const client = https;
        client.get(apiUrl, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 400) return reject(new Error(`Discord API ${res.statusCode}: ${data}`));
                    const messages = JSON.parse(data);
                    resolve(messages);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (err) => reject(err));
    });
}

// POST /api/discord/fetch  { webhook_url, limit }
// Fetches recent messages and imports attachments as notifications (if not already present)
app.post('/api/discord/fetch', async (req, res) => {
    const { webhook_url, limit } = req.body || {};
    if (!webhook_url) return res.status(400).json({ success: false, error: 'webhook_url required' });

    try {
        const messages = await fetchDiscordMessages(webhook_url, limit || 10);
        const imported = [];

        for (const msg of messages) {
            if (!msg || !msg.attachments || msg.attachments.length === 0) continue;
            // pick first attachment
            const att = msg.attachments[0];
            const image_url = att.url || att.proxy_url || att.filename;
            const timestamp = msg.timestamp || new Date().toISOString();
            const event = msg.content || 'discord_webhook';

            // Try to parse sensor values from the message content or embeds (e.g. "Temperature: 0°C", "Humidity: 0%")
            let parsedTemp = null;
            let parsedHum = null;
            let parsedSoil = null;
            try {
                if (msg.content && typeof msg.content === 'string') {
                    const tmatch = msg.content.match(/temperature[:\s]*([+-]?\d+(?:\.\d+)?)/i);
                    const hmatch = msg.content.match(/humidity[:\s]*([+-]?\d+(?:\.\d+)?)/i);
                    const smatch = msg.content.match(/soil(?:\s|_|-)??(?:moisture|humidity|level)[:\s]*([+-]?\d+(?:\.\d+)?)/i);
                    if (tmatch) parsedTemp = Number(tmatch[1]);
                    if (hmatch) parsedHum = Number(hmatch[1]);
                    if (smatch) parsedSoil = Number(smatch[1]);
                }

                if ((parsedTemp === null || parsedHum === null || parsedSoil === null) && Array.isArray(msg.embeds)) {
                    for (const e of msg.embeds) {
                        // check description
                        if (e && typeof e.description === 'string') {
                            const tmatch = e.description.match(/temperature[:\s]*([+-]?\d+(?:\.\d+)?)/i);
                            const hmatch = e.description.match(/humidity[:\s]*([+-]?\d+(?:\.\d+)?)/i);
                            const smatch = e.description.match(/soil(?:\s|_|-)??(?:moisture|humidity|level)[:\s]*([+-]?\d+(?:\.\d+)?)/i);
                            if (tmatch && parsedTemp === null) parsedTemp = Number(tmatch[1]);
                            if (hmatch && parsedHum === null) parsedHum = Number(hmatch[1]);
                            if (smatch && parsedSoil === null) parsedSoil = Number(smatch[1]);
                        }
                        // check fields
                        if (e && Array.isArray(e.fields)) {
                            for (const f of e.fields) {
                                if (!f || !f.name || !f.value) continue;
                                const name = String(f.name).toLowerCase();
                                const val = String(f.value);
                                if (name.includes('temp') && parsedTemp === null) {
                                    const m = val.match(/([+-]?\d+(?:\.\d+)?)/);
                                    if (m) parsedTemp = Number(m[1]);
                                }
                                if (name.includes('hum') && parsedHum === null) {
                                    const m = val.match(/([+-]?\d+(?:\.\d+)?)/);
                                    if (m) parsedHum = Number(m[1]);
                                }
                                if ((name.includes('soil') || name.includes('moist')) && parsedSoil === null) {
                                    const m = val.match(/([+-]?\d+(?:\.\d+)?)/);
                                    if (m) parsedSoil = Number(m[1]);
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // ignore parse errors
            }

            // avoid duplicate by checking image_url already exists
            const exists = notifications.find(n => n.image_url === image_url);
            if (exists) continue;

            const note = {
                id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                event,
                timestamp,
                camera: 'discord_webhook',
                image_url,
                // if we parsed sensor values, include them as top-level properties so frontend can read them
                temperature: parsedTemp !== null ? parsedTemp : undefined,
                humidity: parsedHum !== null ? parsedHum : undefined,
                soilHumidity: parsedSoil !== null ? parsedSoil : undefined,
                raw: { discord: msg }
            };
            // If we detected sensor values, also update the live sensor snapshot so /api/sensors reflects them
            try {
                if (parsedSoil !== null && parsedSoil !== undefined) {
                    sensorData.soilHumidity = {
                        value: Number(parsedSoil),
                        timestamp: new Date(),
                        status: getStatus(Number(parsedSoil), 'soil')
                    };
                }
                if ((parsedTemp !== null && parsedTemp !== undefined) || (parsedHum !== null && parsedHum !== undefined)) {
                    sensorData.dht22 = {
                        temperature: parsedTemp !== null && parsedTemp !== undefined ? Number(parsedTemp) : (sensorData.dht22 ? sensorData.dht22.temperature : undefined),
                        humidity: parsedHum !== null && parsedHum !== undefined ? Number(parsedHum) : (sensorData.dht22 ? sensorData.dht22.humidity : undefined),
                        timestamp: new Date(),
                        status: getStatus(parsedTemp !== null && parsedTemp !== undefined ? Number(parsedTemp) : (sensorData.dht22 ? sensorData.dht22.temperature : 0), 'temp')
                    };
                }
            } catch (e) {
                console.warn('Failed to update sensorData from discord import', e);
            }

            notifications.push(note);
            imported.push(note);
        }

        // enforce max history
        const MAX_HISTORY = 200;
        if (notifications.length > MAX_HISTORY) notifications = notifications.slice(-MAX_HISTORY);
        saveNotifications();

        // broadcast imported notes
        for (const note of imported) {
            try {
                const msg = JSON.stringify(note);
                sseClients.forEach((client) => client.write(`data: ${msg}\n\n`));
            } catch (e) { }
        }

        res.json({ success: true, importedCount: imported.length, imported });
    } catch (e) {
        console.error('Discord fetch failed', e);
        res.status(500).json({ success: false, error: String(e) });
    }
});
