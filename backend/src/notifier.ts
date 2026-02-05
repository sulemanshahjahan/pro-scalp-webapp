import webpush from 'web-push';
import { getDb } from './db/db.js';

const db = getDb();

console.log('[db] notifier driver:', db.driver);
console.log('[db] notifier DB_PATH:', process.env.DB_PATH || '');

// Defensive schema (so notifier never crashes if server schema didn't run yet)
let schemaReady = false;
async function ensureNotifierSchema() {
  if (schemaReady) return;
  try {
    if (db.driver === 'sqlite') {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
          endpoint TEXT PRIMARY KEY,
          keys_p256dh TEXT NOT NULL,
          keys_auth TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
        );
      `);
    }
    schemaReady = true;
  } catch (e) {
    console.warn('[db] notifier schema ensure failed:', e);
  }
}

async function getKV(key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any;
  return row ? String(row.value) : null;
}

async function setKV(key: string, value: string) {
  await db.prepare(
    'INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value);
}

export async function ensureVapid() {
  await ensureNotifierSchema();
  let pub = await getKV('vapid_pub');
  let priv = await getKV('vapid_priv');

  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    await setKV('vapid_pub', keys.publicKey);
    await setKV('vapid_priv', keys.privateKey);
    pub = keys.publicKey;
    priv = keys.privateKey;
  }

  const contact = process.env.VAPID_CONTACT || 'mailto:admin@example.com';
  webpush.setVapidDetails(contact, pub!, priv!);

  return { publicKey: pub! };
}

export async function pushToAll(payload: any) {
  await ensureNotifierSchema();
  const rows = await db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM subscriptions').all() as any[];

  await Promise.all(rows.map(async (r: any) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: r.endpoint,
          keys: { p256dh: r.keys_p256dh, auth: r.keys_auth }
        } as any,
        JSON.stringify(payload)
      );
    } catch (e: any) {
      const msg = String(e?.statusCode || '') + ' ' + String(e);
      // If gone, remove
      if (msg.includes('410') || msg.includes('404')) {
        try { await db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(r.endpoint); } catch {}
      }
    }
  }));
}
