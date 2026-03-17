const express = require('express');
const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HF_URL = process.env.HF_SPACE_URL; 
const HF_TOKEN = process.env.HF_TOKEN; // 👈 We added this!

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
                // 👈 This unlocks the Hugging Face front door!
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
    
    try {
        const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await tgRes.json();
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
