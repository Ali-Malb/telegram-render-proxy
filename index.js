const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

const PORT = process.env.PORT || 3000;

// 1. INBOUND WEBHOOK (Telegram -> Render -> Hugging Face)
// This catches Telegram's webhooks and pierces your Private Space shield
app.use('/incoming-telegram', createProxyMiddleware({
  target: 'https://ali-m01-openclaw.hf.space',
  changeOrigin: true,
  pathRewrite: { '^/incoming-telegram': '/webhooks/telegram' },
  onProxyReq: (proxyReq) => {
    // CRITICAL: This is the ONLY way into your private space. 
    // Create a Fine-Grained token in HF settings and paste it here.
    proxyReq.setHeader('Authorization', 'Bearer hf_YOUR_HUGGINGFACE_TOKEN_HERE');
  }
}));

// 2. OUTBOUND ROUTEWAY TUNNEL (Hugging Face -> Render -> Routeway)
app.use('/routeway', createProxyMiddleware({
  target: 'https://api.routeway.ai/v1',
  changeOrigin: true,
  pathRewrite: { '^/routeway': '' },
  onProxyReq: (proxyReq) => {
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  }
}));

// 3. OUTBOUND TELEGRAM TUNNEL (Hugging Face -> Render -> Telegram)
app.use('/', createProxyMiddleware({
  target: 'https://api.telegram.org',
  changeOrigin: true
}));

app.listen(PORT, () => console.log(`Proxy active on ${PORT}`));
