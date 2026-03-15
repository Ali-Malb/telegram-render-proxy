"use strict";

/**
 * Telegram API proxy for Hugging Face Spaces outbound firewall bypass.
 *
 * Handles two request types:
 *   1. HTTP CONNECT tunneling — used by Node's https_proxy/HTTPS_PROXY env var
 *   2. Plain HTTP proxy requests — fallback for any direct http:// calls
 *
 * Deploy on Render:
 *   Build command : npm install
 *   Start command : node render-proxy.js
 *
 * Then set in HF Space secrets:
 *   TELEGRAM_PROXY_URL = https://<your-service>.onrender.com
 */

var http   = require("http");
var https  = require("https");
var net    = require("net");
var url    = require("url");

var PORT = process.env.PORT || 3000;

var server = http.createServer(function(req, res) {
  // Keepalive ping from HF supervisor
  if (req.url === "/ping") {
    res.writeHead(200);
    res.end("OK");
    return;
  }

  // Plain HTTP proxy pass-through
  var parsed = url.parse(req.url);
  var options = {
    hostname: parsed.hostname,
    port:     parsed.port || 80,
    path:     parsed.path,
    method:   req.method,
    headers:  req.headers
  };

  var proxy = http.request(options, function(proxyRes) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on("error", function(err) {
    console.error("HTTP proxy error:", err.message);
    res.writeHead(502);
    res.end("Proxy error");
  });

  req.pipe(proxy, { end: true });
});

// CONNECT tunneling — this is what Node's HTTPS_PROXY env var actually uses
server.on("connect", function(req, clientSocket, head) {
  var parts    = req.url.split(":");
  var hostname = parts[0];
  var port     = parseInt(parts[1], 10) || 443;

  console.log("CONNECT tunnel: " + hostname + ":" + port);

  var serverSocket = net.connect(port, hostname, function() {
    clientSocket.write(
      "HTTP/1.1 200 Connection Established\r\n" +
      "Proxy-agent: tg-render-proxy\r\n" +
      "\r\n"
    );
    serverSocket.write(head);
    serverSocket.pipe(clientSocket, { end: true });
    clientSocket.pipe(serverSocket, { end: true });
  });

  serverSocket.on("error", function(err) {
    console.error("Tunnel error:", err.message);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  clientSocket.on("error", function() {
    serverSocket.destroy();
  });
});

server.listen(PORT, function() {
  console.log("Telegram proxy live on port " + PORT);
});
