"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureEmailGuardTables = ensureEmailGuardTables;
exports.canSendEmail = canSendEmail;
exports.markEmailSent = markEmailSent;
function ensureEmailGuardTables(db) {
    db.prepare("\n    CREATE TABLE IF NOT EXISTS email_guard (\n      key TEXT PRIMARY KEY,          -- symbol|category\n      last_sent_ms INTEGER NOT NULL  -- epoch ms\n    )\n  ").run();
}
function canSendEmail(db, key, cooldownMin) {
    var row = db.prepare('SELECT last_sent_ms FROM email_guard WHERE key = ?').get(key);
    var now = Date.now();
    var cooldownMs = Math.max(1, cooldownMin) * 60 * 1000;
    if (!row)
        return { allowed: true, now: now };
    var allowed = (now - row.last_sent_ms) >= cooldownMs;
    return { allowed: allowed, now: now };
}
function markEmailSent(db, key, when) {
    db.prepare("\n    INSERT INTO email_guard (key, last_sent_ms) VALUES (?, ?)\n    ON CONFLICT(key) DO UPDATE SET last_sent_ms=excluded.last_sent_ms\n  ").run(key, when);
}
