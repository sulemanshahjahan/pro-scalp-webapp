import webpush from 'web-push';
import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH || '../db/app.db';
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

function getKV(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setKV(key: string, value: string) {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

export function ensureVapid() {
  let pub = getKV('vapid_pub');
  let priv = getKV('vapid_priv');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    setKV('vapid_pub', keys.publicKey);
    setKV('vapid_priv', keys.privateKey);
    pub = keys.publicKey;
    priv = keys.privateKey;
  }
  webpush.setVapidDetails('mailto:admin@example.com', pub!, priv!);
  return { publicKey: pub! };
}

export async function pushToAll(payload: any) {
  const rows = db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM subscriptions').all();
  await Promise.all(rows.map(async (r: any) => {
    try {
      await webpush.sendNotification({
        endpoint: r.endpoint,
        keys: { p256dh: r.keys_p256dh, auth: r.keys_auth }
      } as any, JSON.stringify(payload));
    } catch (e) {
      // If gone, remove
      if (String(e).includes('410') || String(e).includes('404')) {
        db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(r.endpoint);
      }
    }
  }));
}
