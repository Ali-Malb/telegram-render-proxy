const express = require('express');
const fetch = require('node-fetch'); // Ensure this is installed: npm install node-fetch@2
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// The Hack Club Stealth Route
app.post('/hackclub/v1/chat/completions', async (req, res) => {
    try {
        let body = req.body;

        // 1. DEEP PACKET SCRUBBING
        // We find every instance where OpenClaw identifies itself and erase it.
        if (body.messages) {
            body.messages = body.messages.map(msg => {
                if (typeof msg.content === 'string') {
                    msg.content = msg.content
                        .replace(/OpenClaw/gi, "Assistant")
                        .replace(/AI coding agent/gi, "helpful AI")
                        .replace(/SillyTavern/gi, "Chat Interface");
                }
                return msg;
            });
        }

        // 2. NETWORK SPOOFING
        const response = await fetch('https://ai.hackclub.com/proxy/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': req.headers['authorization'] || '',
                // Forge a standard Chrome Browser Identity
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify(body)
        });

        const data = await response.json();
        res.status(response.status).send(data);
    } catch (err) {
        console.error('Tunnel Error:', err);
        res.status(500).send({ error: "Stealth Tunnel Failed" });
    }
});

// Keep your existing Telegram route below this...
app.listen(PORT, () => console.log(`Stealth Tunnel Active on ${PORT}`));
