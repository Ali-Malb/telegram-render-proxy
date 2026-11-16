const express = require('express');
const app = express();
app.use(express.json({ limit: '50mb' }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HF_URL = process.env.HF_SPACE_URL;
const HF_TOKEN = process.env.HF_TOKEN;

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (req, res) => res.sendStatus(200));

// ─── 1. INCOMING: Real Telegram -> Hugging Face ─────────────
app.post('/', async (req, res) => {
    res.sendStatus(200);

    const message = req.body.message;
    if (!message || !message.text) return;

    console.log(`[Render] 📥 Forwarding message from ${message.chat.id} to Hugging Face...`);

    try {
        const hfResponse = await fetch(`${HF_URL}/bot-relay`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${HF_TOKEN}`
            },
            body: JSON.stringify({
                chatId: message.chat.id,
                text: message.text
            })
        });

        if (!hfResponse.ok) {
            console.error(`[Render] ❌ HF Rejected Request: ${hfResponse.status} ${hfResponse.statusText}`);
        }
    } catch (e) {
        console.error('[Render] ❌ HF Delivery Failed:', e.message);
    }
});

// Helper: sends JSON for normal methods, or multipart/form-data when _files are attached
async function sendToTelegram(method, payload) {
    const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;
    const hasFiles = Array.isArray(payload._files) && payload._files.length > 0;

    if (hasFiles) {
        const form = new FormData();

        for (const [key, val] of Object.entries(payload)) {
            if (
                key === '_files' ||
                key.endsWith('_base64') ||
                key.endsWith('_filename') ||
                key.endsWith('_mime') ||
                val === undefined ||
                val === null
            ) {
                continue;
            }
            form.append(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
        }

        for (const file of payload._files) {
            const buffer = Buffer.from(file.base64, 'base64');
            const blob = new Blob([buffer], {
                type: file.contentType || 'application/octet-stream'
            });
            form.append(file.field, blob, file.filename || 'upload.bin');
        }

        return fetch(tgUrl, {
            method: 'POST',
            body: form
        });
    }

    return fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

// ─── 2. OUTGOING: Hugging Face -> Real Telegram ─────────────
app.post('/outbound-relay', async (req, res) => {
    const { method, payload } = req.body;
    if (!method || !payload) return res.status(400).send('Missing data');

    console.log(`[Render] 📤 Relaying ${method} to Telegram...`);

    // Scrub OpenClaw system logs from message text or media captions
    for (const field of ['text', 'caption']) {
        if (payload[field] && typeof payload[field] === 'string') {
            payload[field] = payload[field]
                .replace(/^\[plugins\].*\n?/gm, '')
                .trim();
        }
    }

    try {
        let tgRes = await sendToTelegram(method, payload);
        let data = await tgRes.json();

        // Fallback mechanism for broken Markdown/HTML from the LLM
        if (!tgRes.ok && data.description && data.description.includes("can't parse entities")) {
            console.warn(`[Render] ⚠️ Markdown error detected. Retrying as plain text...`);
            delete payload.parse_mode;

            tgRes = await sendToTelegram(method, payload);
            data = await tgRes.json();
        }

        if (!tgRes.ok) {
            console.error(`[Render] ❌ Telegram API Rejected Request: ${tgRes.status}`, data);
        } else {
            console.log(`[Render] ✅ Successfully delivered to Telegram!`);
        }

        res.json(data);
    } catch (e) {
        console.error('[Render] ❌ Telegram Delivery Failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Render] 🌉 Bridge active on port ${PORT}`);
});
