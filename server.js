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
            fs.unlink(dest, () => {});
            reject(err);
        });
        file.on('error', (err) => {
            fs.unlink(dest, () => {});
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

// Simple schedule store (persisted to schedules.json)
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
let schedules = [];
let scheduleTimers = {}; // id -> timeout ids

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

// 1. Get Sensor Data (Frontend -> Backend)
app.get('/api/sensors', (req, res) => {
    res.json({
        success: true,
        data: sensorData
    });

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
        }
    } else if (action === 'stop') {
        if (pumpStatus.isRunning) {
            pumpStatus.isRunning = false;
            pumpStatus.lastStopped = new Date();
            // Calculate runtime
            const runtime = (pumpStatus.lastStopped - pumpStatus.lastStarted) / 1000 / 60; // minutes
            pumpStatus.totalRuntime += runtime;
            console.log('Pump stopped manually');
        }
    } else {
        return res.status(400).json({ success: false, error: 'Invalid action' });
    }

    res.json({
        success: true,
        data: pumpStatus
    });
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
                } catch (e) {}
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
            } catch (e) {}
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
            try { fs.unlinkSync(imagePath); } catch (e) {}
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
            try { fs.unlinkSync(imagePath); } catch (e) {}
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
