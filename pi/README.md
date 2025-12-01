# Pi Pump Control Example

This folder contains a minimal Node.js example that accepts pump control commands forwarded by your Discord bot.

Usage

1. Install dependencies on the Raspberry Pi:

   ```bash
   npm install express body-parser
   ```

2. Run the server (set a secret token):

   ```bash
   PI_AUTH_TOKEN="my-secret-token" node pi-pump-server.js
   ```

3. Configure your Discord bot to forward commands to `http://<PI_IP>:5000/pump-control` and include the same `X-Auth-Token` header.

Hardware integration

Replace the console logging in `pi-pump-server.js` with actual GPIO calls (for example using the `onoff` package):

```js
const { Gpio } = require('onoff');
const pumpRelay = new Gpio(17, 'out');
// ... then write pumpRelay.writeSync(1) to turn on, 0 to turn off
```

Security

- Keep `PI_AUTH_TOKEN` secret.
- If your bot runs on a public server, expose the Pi endpoint via HTTPS or a secure tunnel (ngrok, VPN), or run the bot and Pi on the same LAN.

