const express = require('express');
const app = express();
app.use(express.json());

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

// ─── 2. OUTGOING: Hugging Face -> Real Telegram ─────────────
app.post('/outbound-relay', async (req, res) => {
    const { method, payload } = req.body;
    if (!method || !payload) return res.status(400).send('Missing data');

    console.log(`[Render] 📤 Relaying ${method} to Telegram...`);

    // Scrub OpenClaw system logs from the message text
    if (payload.text && typeof payload.text === 'string') {
        payload.text = payload.text
            .replace(/^\[plugins\].*\n?/gm, '') // Removes any line starting with [plugins]
            .trim(); // Cleans up any leftover empty lines at the top
    }
    
    try {
        // Initial attempt
        let tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        let data = await tgRes.json();

        // Fallback mechanism for broken Markdown/HTML from the LLM
        if (!tgRes.ok && data.description && data.description.includes("can't parse entities")) {
            console.warn(`[Render] ⚠️ Markdown error detected. Retrying as plain text...`);
            
            // Remove the strict formatting requirement
            delete payload.parse_mode;
            
            // Try sending it again as plain text
            tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            data = await tgRes.json();
        }

        // Final logging
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
