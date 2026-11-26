"use strict";

const { Readable } = require("stream");
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "50mb" }));

// Preserve all existing environment variable names verbatim
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HF_URL = String(process.env.HF_SPACE_URL || "").trim().replace(/\/+$/, "");
const HF_TOKEN = process.env.HF_TOKEN;

// Optional tuning env vars (safe defaults)
const INBOUND_DEDUP_TTL_MS = Number(process.env.BRIDGE_INBOUND_DEDUP_TTL_MS || 15 * 60 * 1000);
const OUTBOUND_DEDUP_TTL_MS = Number(process.env.BRIDGE_OUTBOUND_DEDUP_TTL_MS || 5000);
const HF_FORWARD_TIMEOUT_MS = Number(process.env.BRIDGE_HF_TIMEOUT_MS || 15000);
const HF_FORWARD_MAX_RETRIES = Math.min(5, Math.max(1, Number(process.env.BRIDGE_HF_MAX_RETRIES || 3)));
const TG_REQUEST_TIMEOUT_MS = Number(process.env.BRIDGE_TG_TIMEOUT_MS || 20000);
const TG_MAX_MESSAGE_CHARS = Math.min(4096, Math.max(1000, Number(process.env.BRIDGE_TG_MAX_CHARS || 4000)));
const TG_MAX_CAPTION_CHARS = 1024;
const HF_KEEPALIVE_MS = Math.max(60_000, Number(process.env.BRIDGE_HF_KEEPALIVE_MS || 10 * 60 * 1000));

// ─── TTL DEDUPLICATION MAPS ──────────────────────────────────────────────────
const seenInboundUpdates = new Map();
const seenOutboundMessages = new Map();

function pruneMap(map, ttlMs, maxEntries = 2000) {
  const now = Date.now();
  for (const [k, ts] of map.entries()) {
    if (now - ts > ttlMs) map.delete(k);
  }
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function isDuplicateInbound(updateKey) {
  pruneMap(seenInboundUpdates, INBOUND_DEDUP_TTL_MS);
  if (seenInboundUpdates.has(updateKey)) return true;
  seenInboundUpdates.set(updateKey, Date.now());
  return false;
}

function isDuplicateOutbound(method, payload) {
  if (method !== "sendMessage" || !payload?.chat_id || !payload?.text) return false;
  pruneMap(seenOutboundMessages, OUTBOUND_DEDUP_TTL_MS, 500);
  const hash = crypto
    .createHash("sha256")
    .update(`${payload.chat_id}|${payload.text}`)
    .digest("hex")
    .slice(0, 16);
  if (seenOutboundMessages.has(hash)) return true;
  seenOutboundMessages.set(hash, Date.now());
  return false;
}

// ─── TELEGRAM MESSAGE CHUNKING (4096-CHAR SAFE) ──────────────────────────────
function chunkTelegramText(text, maxLen = TG_MAX_MESSAGE_CHARS) {
  const input = String(text || "");
  if (input.length <= maxLen) return [input];

  const chunks = [];
  let remaining = input;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.2) splitAt = maxLen;

    let piece = remaining.slice(0, splitAt).trimEnd();
    remaining = remaining.slice(splitAt).trimStart();

    // Balance unclosed triple-backtick code fences across chunk boundaries
    const fenceCount = (piece.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      piece += "\n```";
      remaining = "```\n" + remaining;
    }

    if (piece) chunks.push(piece);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    seenInbound: seenInboundUpdates.size,
    uptimeSec: Math.floor(process.uptime())
  });
});
// ─── TELEGRAM MINI APP (/call) & LIVEKIT TOKEN PROXY TO PRIVATE HF SPACE ────
const _HF_URL = String(process.env.HF_SPACE_URL || "https://ali-m01-openclaw.hf.space")
  .trim()
  .replace(/\/+$/, "");
const _HF_TOKEN = String(process.env.HF_TOKEN || "").trim();

app.get("/call", async (_req, res) => {
  try {
    const r = await fetch(`${_HF_URL}/call`, {
      headers: _HF_TOKEN ? { Authorization: `Bearer ${_HF_TOKEN}` } : {},
      signal: AbortSignal.timeout(15000)
    });
    res.status(r.status).type("html").send(await r.text());
  } catch (e) {
    res.status(502).type("text").send(`HF /call proxy error: ${e.message}`);
  }
});

app.post("/api/livekit-token", async (_req, res) => {
  try {
    const r = await fetch(`${_HF_URL}/api/livekit-token`, {
      method: "POST",
      headers: _HF_TOKEN ? { Authorization: `Bearer ${_HF_TOKEN}` } : {},
      signal: AbortSignal.timeout(15000)
    });
    res.status(r.status).type("application/json").send(await r.text());
  } catch (e) {
    res.status(502).json({ error: `HF token proxy error: ${e.message}` });
  }
});

// ─── ASYNC FORWARD TO HUGGING FACE WITH BACKOFF ──────────────────────────────
async function forwardToHuggingFace(relayBody) {
  if (!HF_URL) {
    console.error("[Render] ❌ HF_SPACE_URL is not configured.");
    return false;
  }

  const delays = [1000, 3000, 8000, 15000];
  for (let attempt = 1; attempt <= HF_FORWARD_MAX_RETRIES; attempt++) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (HF_TOKEN) headers["Authorization"] = `Bearer ${HF_TOKEN}`;

      const hfResponse = await fetch(`${HF_URL}/bot-relay`, {
        method: "POST",
        headers,
        body: JSON.stringify(relayBody),
        signal: AbortSignal.timeout(HF_FORWARD_TIMEOUT_MS)
      });

      if (hfResponse.ok) {
        return true;
      }

      const retryable = [408, 429, 500, 502, 503, 504].includes(hfResponse.status);
      console.error(
        `[Render] ❌ HF Rejected Request (attempt ${attempt}/${HF_FORWARD_MAX_RETRIES}): ${hfResponse.status} ${hfResponse.statusText}`
      );
      if (!retryable || attempt === HF_FORWARD_MAX_RETRIES) return false;
    } catch (e) {
      console.error(
        `[Render] ❌ HF Delivery Failed (attempt ${attempt}/${HF_FORWARD_MAX_RETRIES}):`,
        e.message
      );
      if (attempt === HF_FORWARD_MAX_RETRIES) return false;
    }

    const waitMs = delays[Math.min(attempt - 1, delays.length - 1)];
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return false;
}

// ─── 1. INCOMING: Real Telegram -> Hugging Face (Immediate ACK + Async) ──────
app.post("/", (req, res) => {
  // Acknowledge Telegram webhook immediately so Telegram never times out or replays
  res.sendStatus(200);

  const body = req.body || {};
  const message = body.message || body.edited_message;
  if (!message || !message.chat || !message.chat.id) return;

  const text = typeof message.text === "string"
    ? message.text
    : typeof message.caption === "string"
    ? message.caption
    : "";

  if (!text.trim()) return;

  const updateKey =
    body.update_id !== undefined
      ? `upd:${body.update_id}`
      : `msg:${message.chat.id}:${message.message_id || Date.now()}`;

  if (isDuplicateInbound(updateKey)) {
    console.log(`[Render] 🛡️ Dropped duplicate Telegram webhook (${updateKey})`);
    return;
  }

  console.log(
    `[Render] 📥 Forwarding ${updateKey} from chat ${message.chat.id} to Hugging Face...`
  );

  const relayBody = {
    chatId: message.chat.id,
    text,
    updateId: body.update_id,
    messageId: message.message_id,
    from: message.from
      ? {
          id: message.from.id,
          first_name: message.from.first_name || "User",
          username: message.from.username || "user"
        }
      : undefined
  };

  setImmediate(async () => {
    const delivered = await forwardToHuggingFace(relayBody);
    if (!delivered && TELEGRAM_TOKEN) {
      // Best-effort notice if HF Space is unreachable after all retries
      try {
        await sendToTelegram("sendMessage", {
          chat_id: message.chat.id,
          text: "⚠️ The agent container is temporarily waking up or unreachable. Please resend in a moment."
        });
      } catch {}
    }
  });
});

// ─── HELPER: JSON OR MULTIPART TO REAL TELEGRAM API ──────────────────────────
async function sendToTelegram(method, payload) {
  const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;
  const hasFiles = Array.isArray(payload._files) && payload._files.length > 0;

  if (hasFiles) {
    const form = new FormData();

    for (const [key, val] of Object.entries(payload)) {
      if (
        key === "_files" ||
        key.endsWith("_base64") ||
        key.endsWith("_filename") ||
        key.endsWith("_mime") ||
        val === undefined ||
        val === null
      ) {
        continue;
      }
      form.append(key, typeof val === "object" ? JSON.stringify(val) : String(val));
    }

    for (const file of payload._files) {
      const buffer = Buffer.from(file.base64, "base64");
      const blob = new Blob([buffer], {
        type: file.contentType || "application/octet-stream"
      });
      form.append(file.field, blob, file.filename || "upload.bin");
    }

    return fetch(tgUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TG_REQUEST_TIMEOUT_MS)
    });
  }

  return fetch(tgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TG_REQUEST_TIMEOUT_MS)
  });
}

async function deliverSingleTelegramCall(method, payload) {
  let tgRes = await sendToTelegram(method, payload);
  let data = await tgRes.json().catch(() => ({ ok: false, description: `HTTP ${tgRes.status}` }));

  // Handle Telegram 429 rate limits cleanly (single bounded wait)
  if (tgRes.status === 429 && data?.parameters?.retry_after) {
    const waitSec = Math.min(10, Math.max(1, Number(data.parameters.retry_after)));
    console.warn(`[Render] ⏳ Telegram 429 on ${method}; retrying after ${waitSec}s...`);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    tgRes = await sendToTelegram(method, payload);
    data = await tgRes.json().catch(() => ({ ok: false, description: `HTTP ${tgRes.status}` }));
  }

  // Fallback for broken Markdown/HTML entities from LLM
  if (!tgRes.ok && typeof data?.description === "string" && data.description.includes("can't parse entities")) {
    console.warn(`[Render] ⚠️ Markdown/HTML parse error on ${method}. Retrying as plain text...`);
    const plainPayload = { ...payload };
    delete plainPayload.parse_mode;
    tgRes = await sendToTelegram(method, plainPayload);
    data = await tgRes.json().catch(() => ({ ok: false, description: `HTTP ${tgRes.status}` }));
  }

  // Treat "message is not modified" on editMessageText as benign success to stop retry loops
  if (
    !tgRes.ok &&
    method === "editMessageText" &&
    typeof data?.description === "string" &&
    data.description.toLowerCase().includes("message is not modified")
  ) {
    return {
      ok: true,
      result: {
        message_id: payload.message_id || 0,
        not_modified: true
      }
    };
  }

  return data;
}

// ─── 2. OUTGOING: Hugging Face -> Real Telegram ──────────────────────────────
app.post("/outbound-relay", async (req, res) => {
  const { method, payload } = req.body || {};
  if (!method || !payload) return res.status(400).json({ ok: false, description: "Missing data" });

  console.log(`[Render] 📤 Relaying ${method} to Telegram...`);

  // Scrub OpenClaw plugin log lines from text or media captions
  for (const field of ["text", "caption"]) {
    if (payload[field] && typeof payload[field] === "string") {
      payload[field] = payload[field].replace(/^\[plugins\].*\n?/gm, "").trim();
    }
  }

  // Enforce Telegram caption length limit
  if (typeof payload.caption === "string" && payload.caption.length > TG_MAX_CAPTION_CHARS) {
    payload.caption = `${payload.caption.slice(0, TG_MAX_CAPTION_CHARS - 14)}\n…[truncated]`;
  }

  // Drop accidental duplicate sendMessage within 5s window
  if (isDuplicateOutbound(method, payload)) {
    console.log(`[Render] 🛡️ Suppressed duplicate outbound sendMessage for chat ${payload.chat_id}`);
    return res.json({ ok: true, result: { message_id: Math.floor(Date.now() / 1000), deduplicated: true } });
  }

  try {
    // Chunk oversized sendMessage payloads to avoid 400 "message is too long"
    if (method === "sendMessage" && typeof payload.text === "string" && payload.text.length > TG_MAX_MESSAGE_CHARS) {
      const chunks = chunkTelegramText(payload.text, TG_MAX_MESSAGE_CHARS);
      console.log(`[Render] ✂️ Splitting ${payload.text.length}-char message into ${chunks.length} Telegram chunks`);
      let lastData = { ok: true, result: { message_id: 0 } };
      for (let i = 0; i < chunks.length; i++) {
        const chunkPayload = {
          ...payload,
          text: chunks[i]
        };
        if (i > 0) delete chunkPayload.reply_to_message_id;
        lastData = await deliverSingleTelegramCall("sendMessage", chunkPayload);
        if (!lastData.ok) break;
      }
      return res.json(lastData);
    }

    // Clamp oversized editMessageText payloads to Telegram's 4096-char ceiling
    if (method === "editMessageText" && typeof payload.text === "string" && payload.text.length > TG_MAX_MESSAGE_CHARS) {
      payload.text = `${payload.text.slice(0, TG_MAX_MESSAGE_CHARS - 20)}\n…[truncated]`;
    }

    const data = await deliverSingleTelegramCall(method, payload);

    if (!data.ok) {
      console.error(`[Render] ❌ Telegram API Rejected ${method}:`, data);
    } else {
      console.log(`[Render] ✅ Successfully delivered ${method} to Telegram!`);
    }

    return res.json(data);
  } catch (e) {
    console.error("[Render] ❌ Telegram Delivery Failed:", e.message);
    return res.status(500).json({ ok: false, description: e.message });
  }
});
const _HF_URL = String(process.env.HF_SPACE_URL || "https://ali-m01-openclaw.hf.space")
  .trim()
  .replace(/\/+$/, "");
const _HF_TOKEN = String(process.env.HF_TOKEN || "").trim();

app.get("/call", async (_req, res) => {
  try {
    const r = await fetch(`${_HF_URL}/call`, {
      headers: _HF_TOKEN ? { Authorization: `Bearer ${_HF_TOKEN}` } : {},
      signal: AbortSignal.timeout(15000)
    });
    res.status(r.status).type("html").send(await r.text());
  } catch (e) {
    res.status(502).type("text").send(`HF /call proxy error: ${e.message}`);
  }
});

app.post("/api/livekit-token", async (_req, res) => {
  try {
    const r = await fetch(`${_HF_URL}/api/livekit-token`, {
      method: "POST",
      headers: _HF_TOKEN ? { Authorization: `Bearer ${_HF_TOKEN}` } : {},
      signal: AbortSignal.timeout(15000)
    });
    res.status(r.status).type("application/json").send(await r.text());
  } catch (e) {
    res.status(502).json({ error: `HF token proxy error: ${e.message}` });
  }
});

app.get("/api/call-health", async (_req, res) => {
  try {
    const r = await fetch(`${_HF_URL}/api/call-health`, {
      headers: _HF_TOKEN ? { Authorization: `Bearer ${_HF_TOKEN}` } : {},
      signal: AbortSignal.timeout(15000)
    });
    res.status(r.status).type("application/json").send(await r.text());
  } catch (e) {
    res.status(502).json({ ok: false, error: `HF health proxy error: ${e.message}` });
  }
});

app.use("/tokenrouter-relay", async (req, res) => {
  try {
    const upstreamPath = req.path && req.path !== "/" ? req.path : "/chat/completions";
    const upstreamRes = await fetch(`https://api.tokenrouter.com/v1${upstreamPath}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {})
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(120000)
    });

    res.status(upstreamRes.status);
    for (const [k, v] of upstreamRes.headers.entries()) {
      if (["content-encoding", "content-length", "transfer-encoding"].includes(k.toLowerCase())) continue;
      res.setHeader(k, v);
    }

    if (upstreamRes.body) Readable.fromWeb(upstreamRes.body).pipe(res);
    else res.end();
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: { message: e.message } });
  }
});
// ─── MUTUAL KEEPALIVE: Render -> Hugging Face (/ping) ────────────────────────
async function pingHuggingFace() {
  if (!HF_URL) return;
  try {
    const headers = {};
    if (HF_TOKEN) headers["Authorization"] = `Bearer ${HF_TOKEN}`;
    const res = await fetch(`${HF_URL}/ping`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000)
    });
    console.log(`[Keepalive] HF ping: ${res.status}`);
  } catch (e) {
    console.log(`[Keepalive] HF ping failed: ${e.message}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Render] 🌉 Bridge active on port ${PORT}`);
  if (HF_URL) {
    setTimeout(pingHuggingFace, 15000);
    setInterval(pingHuggingFace, HF_KEEPALIVE_MS);
  }
});
