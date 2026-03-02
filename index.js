const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

// Render assigns a dynamic port, so we MUST use process.env.PORT
const PORT = process.env.PORT || 3000;

// Health check endpoint to keep the free Render server awake
app.get('/ping', (req, res) => {
  res.status(200).send('Proxy is awake and ready!');
});

// 1. The Hack Club Stealth Tunnel
app.use('/hackclub', createProxyMiddleware({
  target: 'https://ai.hackclub.com/proxy/v1',
  changeOrigin: true,
  pathRewrite: { '^/hackclub': '' }, // Strip /hackclub from the final URL
  onProxyReq: (proxyReq, req, res) => {
    // Annihilate OpenClaw/Stainless tracking headers
    const headers = proxyReq.getHeaders();
    for (const key in headers) {
      if (key.toLowerCase().includes('stainless') || key.toLowerCase().includes('openclaw')) {
        proxyReq.removeHeader(key);
      }
    }
    proxyReq.removeHeader('referer');
    proxyReq.removeHeader('origin');
    proxyReq.removeHeader('x-title');
    
    // Forge a standard Chrome browser fingerprint
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  }
}));

// 2. The Telegram Tunnel
app.use('/', createProxyMiddleware({
  target: 'https://api.telegram.org',
  changeOrigin: true,
  onProxyReq: (proxyReq, req, res) => {
     console.log(`[PROXY] Routing Telegram: ${req.method} ${req.url}`);
  },
  onError: (err, req, res) => {
    console.error('[ERROR] Proxy failed:', err.message);
    res.status(502).send('Bad Gateway');
  }
}));

app.listen(PORT, () => {
  console.log(`Bypass Proxy running on port ${PORT}`);
});
