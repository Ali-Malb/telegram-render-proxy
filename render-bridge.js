const express = require('express');
const app = express();

// Parse incoming JSON
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HF_URL = process.env.HF_SPACE_URL; 

// ─── 1. INCOMING: Real Telegram -> Hugging Face ─────────────
// (Catches messages from your phone and sends them to the Dome)
app.post('/', async (req, res) => {
    // Instantly acknowledge Telegram so it doesn't timeout and retry
    res.sendStatus(200);

    const message = req.body.message;
    if (!message || !message.text) return;

    console.log(`[Render] 📥 Forwarding message from ${message.chat.id} to Hugging Face...`);
    
    try {
        await fetch(`${HF_URL}/bot-relay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                chatId: message.chat.id, 
                text: message.text 
            })
        });
    } catch (e) {
        console.error('[Render] ❌ HF Delivery Failed:', e.message);
    }
});

// ─── 2. OUTGOING: Hugging Face -> Real Telegram ─────────────
// (Catches replies from Native OpenClaw and texts them to your phone)
app.post('/outbound-relay', async (req, res) => {
    const { method, payload } = req.body;
    if (!method || !payload) return res.status(400).send('Missing data');

    console.log(`[Render] 📤 Relaying ${method} to Telegram...`);
    
    try {
        const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await tgRes.json();
        res.json(data); // Send Telegram's success receipt back to the Dome
    } catch (e) {
        console.error('[Render] ❌ Telegram Delivery Failed:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── STARTUP ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Render] 🌉 Bridge active on port ${PORT}`);
});
