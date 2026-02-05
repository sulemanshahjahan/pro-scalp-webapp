import type { DbConn } from './db.js';

export async function ensureEmailGuardTables(db: DbConn) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS email_guard (
      key TEXT PRIMARY KEY,
      last_sent_ms INTEGER NOT NULL
    )
  `);
}

export async function canSendEmail(db: DbConn, key: string, cooldownMin: number) {
  const row = await db
    .prepare('SELECT last_sent_ms FROM email_guard WHERE key = ?')
    .get(key) as { last_sent_ms: number } | undefined;

  const now = Date.now();
  const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;

  if (!row) return { allowed: true, now };
  return { allowed: now - row.last_sent_ms >= cooldownMs, now };
}

export async function markEmailSent(db: DbConn, key: string, when: number) {
  await db.prepare(
    `INSERT INTO email_guard (key, last_sent_ms) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET last_sent_ms=excluded.last_sent_ms`
  ).run(key, when);
}
