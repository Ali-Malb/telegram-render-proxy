const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

const PORT = process.env.PORT || 3000;

// 1. The Routeway Stealth Tunnel
app.use('/routeway', createProxyMiddleware({
  target: 'https://api.routeway.ai/v1',
  changeOrigin: true,
  pathRewrite: { '^/routeway': '' },
  onProxyReq: (proxyReq, req, res) => {
    // Inject the Routeway Key if you want to keep it out of Hugging Face
    // proxyReq.setHeader('Authorization', 'Bearer YOUR_ROUTEWAY_API_KEY');
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  }
}));

// 2. The Telegram Tunnel
app.use('/', createProxyMiddleware({
  target: 'https://api.telegram.org',
  changeOrigin: true
}));

app.listen(PORT, () => console.log(`Proxy active on ${PORT}`));
