import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureVapid } from './notifier.js';
import { startLoop, scanOnce } from './scanner.js';
import { pushToAll } from './notifier.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const dbPath = process.env.DB_PATH || '../db/app.db';
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
// init schema
import fs from 'fs';
const schema = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf-8');
db.exec(schema);

// VAPID
const { publicKey } = ensureVapid();

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/vapidPublicKey', (req, res) => res.json({ publicKey }));

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  try {
    db.prepare(`INSERT INTO subscriptions(endpoint, keys_p256dh, keys_auth)
                VALUES(?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET keys_p256dh=excluded.keys_p256dh, keys_auth=excluded.keys_auth`)
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  } catch {}
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const sub = req.body;
  if (sub?.endpoint) {
    db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(sub.endpoint);
  }
  res.json({ ok: true });
});

app.get('/api/scan', async (req, res) => {
  const out = await scanOnce();
  res.json({ signals: out, at: Date.now() });
});

// --- DEBUG: send a test push to all subscribers ---
app.post('/api/debug/push', async (req, res) => {
  try {
    const { symbol = 'DEMOUSDT', category = 'BEST_ENTRY', price = 1.2345 } = req.body || {};
    const title =
      category === 'READY_TO_BUY' ? '✅ Ready to BUY' :
      category === 'BEST_ENTRY'   ? '⭐ Best Entry' :
                                    '👀 Watch';
    const body = `${symbol} @ ${Number(price).toFixed(6)} | ΔVWAP 0.20% | RSI 56.5 | Vol× 1.80`;
    await pushToAll({ title, body, data: { symbol, price, category } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// also allow GET for super quick manual test in browser:
app.get('/api/debug/push', async (req, res) => {
  const symbol = String(req.query.symbol || 'DEMOUSDT');
  const category = String(req.query.category || 'BEST_ENTRY');
  const price = Number(req.query.price || 1.2345);
  await pushToAll({
    title: category === 'READY_TO_BUY' ? '✅ Ready to BUY' : '⭐ Best Entry',
    body: `${symbol} @ ${price.toFixed(6)} | ΔVWAP 0.20% | RSI 56.5 | Vol× 1.80`,
    data: { symbol, price, category }
  });
  res.json({ ok: true });
});


// Serve frontend build
const feRoot = path.join(__dirname, '../../frontend/dist');
app.use(express.static(feRoot));
app.get('*', (req, res) => {
  res.sendFile(path.join(feRoot, 'index.html'));
});

const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, () => console.log(`Server on http://localhost:${port}`));

// Start background loop
startLoop();
