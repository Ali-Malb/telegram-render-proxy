"use strict";

/**
 * Render Bridge — replaces render-proxy.js entirely.
 *
 * Does three things:
 *  1. Polls Telegram for updates (long polling, offset-tracked)
 *  2. POSTs each message to HF Space /bot-relay and gets the AI reply
 *  3. Sends the reply back to Telegram
 *
 * Deploy on Render:
 *   Build command : npm install
 *   Start command : node render-bridge.js
 *
 * Environment variables (set in Render dashboard):
 *   TELEGRAM_BOT_TOKEN  — your bot token
 *   HF_SPACE_URL        — e.g. https://ali-m01-openclaw.hf.space
 */

var https  = require("https");
var http   = require("http");
var url    = require("url");

var TOKEN    = process.env.TELEGRAM_BOT_TOKEN || "";
var HF_URL   = (process.env.HF_SPACE_URL || "").replace(/\/$/, "");
var PORT     = process.env.PORT || 3000;

if (!TOKEN)  { console.error("FATAL: TELEGRAM_BOT_TOKEN not set"); process.exit(1); }
if (!HF_URL) { console.error("FATAL: HF_SPACE_URL not set"); process.exit(1); }

// ─── Telegram helpers ─────────────────────────────────────────────────────────
function tgRequest(method, params, cb) {
  var body = JSON.stringify(params);
  var req  = https.request({
    hostname: "api.telegram.org",
    path:     "/bot" + TOKEN + "/" + method,
    method:   "POST",
    headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, function(res) {
    var d = "";
    res.on("data", function(c) { d += c; });
    res.on("end",  function()  {
      try { cb(null, JSON.parse(d)); }
      catch(e) { cb(e); }
    });
  });
  req.on("error", cb);
  req.write(body);
  req.end();
}

function sendMessage(chatId, text, cb) {
  tgRequest("sendMessage", { chat_id: chatId, text: text }, cb || function() {});
}

// ─── HF relay ─────────────────────────────────────────────────────────────────
function askHF(chatId, text, cb) {
  var parsed  = url.parse(HF_URL);
  var isHttps = parsed.protocol === "https:";
  var mod     = isHttps ? https : http;
  var body    = JSON.stringify({ chatId: chatId, text: text, session: "tg-" + chatId });

  var req = mod.request({
    hostname: parsed.hostname,
    port:     parsed.port || (isHttps ? 443 : 80),
    path:     "/bot-relay",
    method:   "POST",
    headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  }, function(res) {
    var d = "";
    res.on("data", function(c) { d += c; });
    res.on("end",  function() {
      try {
        var parsed = JSON.parse(d);
        cb(null, parsed.reply || "...");
      } catch(e) {
        cb(null, d || "...");
      }
    });
  });

  req.setTimeout(90000, function() {
    req.destroy();
    cb(new Error("HF relay timeout"));
  });

  req.on("error", cb);
  req.write(body);
  req.end();
}

// ─── Long polling loop ────────────────────────────────────────────────────────
var offset       = 0;
var processing   = new Set(); // prevent duplicate processing
var pollFailures = 0;

function poll() {
  tgRequest("getUpdates", { offset: offset, timeout: 30, allowed_updates: ["message"] }, function(err, data) {
    if (err || !data || !data.ok) {
      pollFailures++;
      console.error("[poll] error:", err ? err.message : JSON.stringify(data));
      // Back off on repeated failures
      setTimeout(poll, Math.min(pollFailures * 2000, 30000));
      return;
    }

    pollFailures = 0;
    var updates  = data.result || [];

    updates.forEach(function(update) {
      offset = Math.max(offset, update.update_id + 1);

      var msg    = update.message;
      if (!msg || !msg.text) return;

      var chatId = msg.chat.id;
      var text   = msg.text;
      var msgKey = update.update_id;

      if (processing.has(msgKey)) return;
      processing.add(msgKey);

      console.log("[poll] " + chatId + ": " + text.substring(0, 60));

      // Send typing indicator
      tgRequest("sendChatAction", { chat_id: chatId, action: "typing" }, function() {});

      askHF(chatId, text, function(err, reply) {
        processing.delete(msgKey);
        if (err) {
          console.error("[relay] error:", err.message);
          sendMessage(chatId, "Sorry, something went wrong. Please try again.");
          return;
        }
        console.log("[relay] reply to " + chatId + ": " + String(reply).substring(0, 60));
        sendMessage(chatId, reply);
      });
    });

    // Continue polling immediately
    poll();
  });
}

// ─── Health server ────────────────────────────────────────────────────────────
http.createServer(function(req, res) {
  res.writeHead(200);
  res.end("OK");
}).listen(PORT, function() {
  console.log("Bridge live on port " + PORT);
  console.log("HF Space: " + HF_URL);

  // Delete any existing webhook so long polling works
  tgRequest("deleteWebhook", {}, function(err, data) {
    if (err) console.warn("deleteWebhook error:", err.message);
    else console.log("deleteWebhook:", data.ok ? "OK" : JSON.stringify(data));
    poll();
  });
});
