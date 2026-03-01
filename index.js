const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
// Render assigns a dynamic port, so we MUST use process.env.PORT
const PORT = process.env.PORT || 3000;

// 🟢 Health check endpoint to keep the free Render server awake
app.get('/ping', (req, res) => {
  res.status(200).send('Proxy is awake and ready!');
});

// 🚀 Route everything else directly to Telegram
app.use('/', createProxyMiddleware({
  target: 'https://api.telegram.org',
  changeOrigin: true,
  onProxyReq: (proxyReq, req, res) => {
    // Optional: Logs the request so you can debug in Render's dashboard
    console.log(`[PROXY] Routing: ${req.method} ${req.url}`);
  },
  onError: (err, req, res) => {
    console.error('[ERROR] Proxy failed:', err.message);
    res.status(502).send('Bad Gateway');
  }
}));

app.listen(PORT, () => {
  console.log(`✅ Telegram Bypass Proxy running on port ${PORT}`);
});
