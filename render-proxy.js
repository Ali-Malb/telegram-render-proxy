"use strict";

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/ping", function(req, res) {
  res.status(200).send("OK");
});

app.use("/", createProxyMiddleware({
  target:       "https://api.telegram.org",
  changeOrigin: true,
  secure:       true,
  on: {
    proxyReq: function(proxyReq) {
      proxyReq.removeHeader("x-forwarded-for");
    },
    error: function(err, req, res) {
      console.error("Proxy error:", err.message);
      res.status(502).send("Proxy error");
    }
  }
}));

app.listen(PORT, function() {
  console.log("Telegram proxy live on port " + PORT);
});
