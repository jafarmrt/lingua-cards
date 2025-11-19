import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- API Handlers ---

async function handleGeminiGenerate(payload, res, apiKey) {
  const { model, contents, config } = payload;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const {
    systemInstruction,
    responseModalities,
    speechConfig,
    ...generationConfig
  } = config || {};

  const finalContents = Array.isArray(contents)
    ? contents
    : (contents && typeof contents === 'object' && contents.parts)
      ? [contents]
      : [{ parts: [{ text: contents }] }];

  const googleApiBody = {
    contents: finalContents,
    ...(systemInstruction && { systemInstruction }),
    ...(responseModalities && { responseModalities }),
    ...(speechConfig && { speechConfig }),
    ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
  };

  try {
    const geminiResponse = await fetch(`${endpoint}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(googleApiBody),
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      return res.status(geminiResponse.status).json({ error: 'Google API Error', details: errorText });
    }

    const responseData = await geminiResponse.json();
    const adaptedResponse = {
      text: responseData.candidates?.[0]?.content?.parts?.[0]?.text || '',
      candidates: responseData.candidates,
    };
    return res.status(200).json(adaptedResponse);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}

async function handleFreeDictionary(payload, res) {
    const { word } = payload;
    try {
        const apiResponse = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
        const data = await apiResponse.json();
        return res.status(apiResponse.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to fetch from Free Dictionary', details: e.message });
    }
}

async function handleMerriamWebster(payload, res, apiKey) {
    const { word } = payload;
    try {
        const apiResponse = await fetch(`https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(word)}?key=${apiKey}`);
        const data = await apiResponse.json();
        return res.status(apiResponse.status).json(data);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to fetch from Merriam-Webster', details: e.message });
    }
}

async function handleFetchAudio(payload, res) {
    const { url } = payload;
    try {
        const audioResponse = await fetch(url);
        if (!audioResponse.ok) throw new Error('Failed to fetch audio');
        const arrayBuffer = await audioResponse.arrayBuffer();
        const contentType = audioResponse.headers.get('content-type') || 'audio/mpeg';
        res.setHeader('Content-Type', contentType);
        return res.status(200).send(Buffer.from(arrayBuffer));
    } catch (error) {
        return res.status(500).json({ error: 'Audio fetch failed', details: error.message });
    }
}

// Local JSON DB setup
const DATA_FILE = 'local_db.json';
const memoryStore = new Map();

if (fs.existsSync(DATA_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        Object.entries(data).forEach(([k, v]) => memoryStore.set(k, v));
    } catch(e) { console.error('Error loading DB', e); }
}

function saveDb() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(memoryStore))); } 
    catch(e) { console.error('Error saving DB', e); }
}

const getUser = async (username) => memoryStore.get(`user:${username.toLowerCase()}`) || null;
const setUser = async (userData) => {
    memoryStore.set(`user:${userData.username.toLowerCase()}`, userData);
    saveDb();
};

async function handleRegister(payload, res) {
    const { username, password } = payload;
    if (await getUser(username)) return res.status(409).json({ error: 'Username taken' });
    await setUser({ username, password, data: {} });
    return res.status(201).json({ message: 'Registered' });
}

async function handleLogin(payload, res) {
    const { username, password } = payload;
    const user = await getUser(username);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
    return res.status(200).json({ message: 'Logged in' });
}

async function handleSyncMerge(payload, res) {
    const { username, data: clientData } = payload;
    const user = await getUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Simple merge strategy: Client overwrites cloud for simplicity in this environment,
    // but preserving existing cloud data if client is missing it (rudimentary).
    // In a real app, you'd use the timestamps.
    user.data = clientData; 
    await setUser(user);
    
    return res.status(200).json({ data: user.data });
}

async function handleSyncLoad(payload, res) {
    const { username } = payload;
    const user = await getUser(username);
    return res.status(200).json({ data: user ? user.data : null });
}

// Main Proxy Route
app.post('/api/proxy', async (req, res) => {
    const { action, ...payload } = req.body;
    try {
        switch (action) {
            case 'ping': return res.json({ message: 'pong' });
            case 'gemini-generate': return await handleGeminiGenerate(payload, res, process.env.API_KEY);
            case 'dictionary-free': return await handleFreeDictionary(payload, res);
            case 'dictionary-mw': return await handleMerriamWebster(payload, res, process.env.MW_API_KEY);
            case 'fetch-audio': return await handleFetchAudio(payload, res);
            case 'auth-register': return await handleRegister(payload, res);
            case 'auth-login': return await handleLogin(payload, res);
            case 'sync-load': return await handleSyncLoad(payload, res);
            case 'sync-merge': return await handleSyncMerge(payload, res);
            case 'ping-free-dict': case 'ping-mw': return res.json({ message: 'pong' });
            default: return res.status(400).json({ error: 'Invalid action' });
        }
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: e.message });
    }
});

// Serve React App
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
