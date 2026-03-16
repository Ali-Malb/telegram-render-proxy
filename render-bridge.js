"use strict";

var https  = require("https");
var http   = require("http");
var url    = require("url");

var TOKEN           = process.env.TELEGRAM_BOT_TOKEN || "";
var HF_URL          = (process.env.HF_SPACE_URL || "").replace(/\/$/, "");
var HF_TOKEN        = process.env.HF_TOKEN || "";
var ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID || "";
var PORT            = process.env.PORT || 3000;

if (!TOKEN)  { console.error("FATAL: TELEGRAM_BOT_TOKEN not set"); process.exit(1); }
if (!HF_URL) { console.error("FATAL: HF_SPACE_URL not set"); process.exit(1); }
if (!HF_TOKEN) { console.warn("WARNING: HF_TOKEN not set. Private spaces will reject requests."); }
if (!ALLOWED_CHAT_ID) { console.warn("WARNING: ALLOWED_CHAT_ID not set. Bot is open to the public!"); }

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
      try { cb(null, JSON.parse(d)); } catch(e) { cb(e); }
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

  var headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  };
  
  if (HF_TOKEN) {
    headers["Authorization"] = "Bearer " + HF_TOKEN;
  }

  var req = mod.request({
    hostname: parsed.hostname,
    port:     parsed.port || (isHttps ? 443 : 80),
    path:     "/bot-relay",
    method:   "POST",
    headers:  headers,
  }, function(res) {
    var d = "";
    res.on("data", function(c) { d += c; });
    res.on("end",  function() {
      if (res.statusCode !== 200) {
        console.error("[relay] HTTP " + res.statusCode + " from HF.");
        return cb(new Error("HF Gatekeeper Blocked Request"));
      }
      try {
        var parsed = JSON.parse(d);
        cb(null, parsed.reply || "...");
      } catch(e) {
        cb(new Error("Invalid JSON response from HF Space"));
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
var processing   = new Set(); 
var pollFailures = 0;

function poll() {
  tgRequest("getUpdates", { offset: offset, timeout: 30, allowed_updates: ["message"] }, function(err, data) {
    if (err || !data || !data.ok) {
      pollFailures++;
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

      // --- THE BOUNCER ---
      if (ALLOWED_CHAT_ID && String(chatId) !== String(ALLOWED_CHAT_ID)) {
        console.warn("[security] Blocked unauthorized message from ID: " + chatId);
        return; // Silently drop the message
      }
      // -------------------

      if (processing.has(msgKey)) return;
      processing.add(msgKey);

      console.log("[poll] " + chatId + ": " + text.substring(0, 60));
      tgRequest("sendChatAction", { chat_id: chatId, action: "typing" }, function() {});

      askHF(chatId, text, function(err, reply) {
        processing.delete(msgKey);
        if (err) {
          console.error("[relay] error:", err.message);
          sendMessage(chatId, "System check: I am online, but the Hugging Face engine is unreachable right now.");
          return;
        }
        console.log("[relay] reply to " + chatId + ": " + String(reply).substring(0, 60));
        sendMessage(chatId, reply);
      });
    });
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
  
  tgRequest("deleteWebhook", {}, function(err, data) {
    poll();
  });
});
