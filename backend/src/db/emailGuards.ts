import DatabaseCtor from 'better-sqlite3';

// Use instance type of the constructor as the DB type.
type DB = InstanceType<typeof DatabaseCtor>;

export function ensureEmailGuardTables(db: DB) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS email_guard (
      key TEXT PRIMARY KEY,
      last_sent_ms INTEGER NOT NULL
    )
  `).run();
}

export function canSendEmail(db: DB, key: string, cooldownMin: number) {
  const row = db
    .prepare('SELECT last_sent_ms FROM email_guard WHERE key = ?')
    .get(key) as { last_sent_ms: number } | undefined;

  const now = Date.now();
  const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;

  if (!row) return { allowed: true, now };
  return { allowed: now - row.last_sent_ms >= cooldownMs, now };
}

export function markEmailSent(db: DB, key: string, when: number) {
  db.prepare(
    `INSERT INTO email_guard (key, last_sent_ms) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET last_sent_ms=excluded.last_sent_ms`
  ).run(key, when);
}
