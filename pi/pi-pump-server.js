// Minimal Pi control server example
// Usage:
//   npm install express body-parser
//   PI_AUTH_TOKEN=your_token node pi-pump-server.js

const express = require('express');
const bodyParser = require('body-parser');
const SECRET = process.env.PI_AUTH_TOKEN || 'change-me-secret';
const PORT = process.env.PORT || 5000;

const app = express();
app.use(bodyParser.json());

// In real deployment, replace console.log with actual GPIO control (e.g., onoff library)
app.post('/pump-control', (req, res) => {
    const token = req.header('X-Auth-Token') || '';
    if (!token || token !== SECRET) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { command } = req.body || {};
    console.log('Received pump command:', command);

    // Example pseudo-actions
    if (command === 'PUMP_ON') {
        console.log('Turning pump ON (simulate)');
        // TODO: integrate with GPIO library here
    } else if (command === 'PUMP_OFF') {
        console.log('Turning pump OFF (simulate)');
        // TODO: integrate with GPIO library here
    } else {
        console.log('Unknown command');
    }

    res.json({ success: true, received: command });
});

app.listen(PORT, () => console.log(`Pi pump control server listening on http://0.0.0.0:${PORT}`));
