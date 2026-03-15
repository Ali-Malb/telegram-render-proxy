‘use strict’;

/**

- Telegram API reverse proxy — deploy this as a separate Node service on Render.
- 
- It does exactly one thing: forward every request to api.telegram.org.
- This lets OpenClaw (running on HF, which blocks api.telegram.org) reach
- Telegram through Render’s unrestricted outbound networking.
- 
- Deploy steps:
- 1. Create a new Render Web Service pointed at a repo containing this file.
- 1. Build command: npm install
- 1. Start command: node render-proxy.js
- 1. Copy the Render URL (e.g. https://my-tg-proxy.onrender.com) into your
- ```
   HF Space secret: TELEGRAM_PROXY_URL=https://my-tg-proxy.onrender.com
  ```
- 
- The /ping route is hit every 10 min by server.js to prevent Render’s free
- tier from spinning down and causing a cold-start race on gateway boot.
  */

const express               = require(‘express’);
const { createProxyMiddleware } = require(‘http-proxy-middleware’);

const app  = express();
const PORT = process.env.PORT || 3000;

// Keepalive target — called by the HF supervisor every 10 min
app.get(’/ping’, (_, res) => res.status(200).send(‘OK’));

// Forward everything else verbatim to Telegram
app.use(
‘/’,
createProxyMiddleware({
target:       ‘https://api.telegram.org’,
changeOrigin: true,
secure:       true,
onProxyReq:   (proxyReq) => {
// Prevent Telegram from seeing Render’s IP as a suspicious origin
proxyReq.removeHeader(‘x-forwarded-for’);
},
onError: (err, _req, res) => {
console.error(‘Proxy error:’, err.message);
res.status(502).send(‘Proxy error’);
},
})
);

app.listen(PORT, () => console.log(`🔀 Telegram proxy live on :${PORT}`));
