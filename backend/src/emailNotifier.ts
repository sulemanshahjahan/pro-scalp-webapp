// src/emailNotifier.ts
import DatabaseCtor from 'better-sqlite3';
import { sendMail, isEmailEnabled } from './mailer.js';
import { subjectFor, htmlFor, textFor } from './emailTemplates.js';
import { ensureEmailGuardTables, canSendEmail, markEmailSent } from './db/emailGuards.js';

// DB is optional now
type DB = InstanceType<typeof DatabaseCtor> | undefined | null;

// ── Config ─────────────────────────────────────────────────────────────
const COOLDOWN_MIN = Number(process.env.EMAIL_COOLDOWN_MIN || 15);
const recipients = (process.env.ALERT_EMAILS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedCats = new Set(
  (process.env.EMAIL_CATEGORIES || 'BEST_ENTRY')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);

// Fallback in-memory cooldown: key = `${symbol}|${CAT}` -> lastSentMs
const memCooldown = new Map<string, number>();

console.log('[email] boot', {
  enabled: isEmailEnabled(),
  recipients,
  allowedCats: Array.from(allowedCats),
  cooldownMin: COOLDOWN_MIN,
});

// ── Helpers ────────────────────────────────────────────────────────────
function checkCooldown(key: string, now: number, cooldownMin: number) {
  if (cooldownMin <= 0) return true;
  const last = memCooldown.get(key) ?? 0;
  if (now - last >= cooldownMin * 60_000) return true;
  return false;
}
function markCooldown(key: string, when: number) {
  memCooldown.set(key, when);
}

// ── Public API ─────────────────────────────────────────────────────────
export async function emailNotify(db: DB, signal: any) {
  const cat = String(signal?.category || '').toUpperCase();
  const sym = String(signal?.symbol || 'UNKNOWN');

  console.log('[email] candidate', { symbol: sym, category: cat, price: signal?.price });

  if (!isEmailEnabled()) {
    console.log('[email] skip: EMAIL_ENABLED=false');
    return;
  }
  if (recipients.length === 0) {
    console.log('[email] skip: no recipients in ALERT_EMAILS');
    return;
  }
  if (!allowedCats.has(cat)) {
    console.log('[email] skip: category not allowed', { cat, allowedCats: Array.from(allowedCats) });
    return;
  }
  console.log('[email] gate ok (category)');

  const key = `${sym}|${cat}`;
  const now = Date.now();

  // If we have a real DB, use DB-based cooldown; otherwise use memory map
  if (db) {
    try {
      ensureEmailGuardTables(db);
      const gate = canSendEmail(db as any, key, COOLDOWN_MIN);
      console.log('[email] cooldown (db)', { key, allowed: gate.allowed, cooldownMin: COOLDOWN_MIN });
      if (!gate.allowed) {
        console.log('[email] skip: cooldown active (db)');
        return;
      }
      const subject = subjectFor(signal);
      console.log('[email] sending', { to: recipients, subject });
      await sendMail({ to: recipients, subject, html: htmlFor(signal), text: textFor(signal) });
      markEmailSent(db as any, key, gate.now);
      console.log('[email] sent + marked (db)', { key });
      return;
    } catch (e) {
      console.error('[email] db path error; falling back to memory cooldown', e);
      // fall through to memory path
    }
  }

  // Memory cooldown path (no DB)
  const allowed = checkCooldown(key, now, COOLDOWN_MIN);
  console.log('[email] cooldown (mem)', { key, allowed, cooldownMin: COOLDOWN_MIN });
  if (!allowed) {
    console.log('[email] skip: cooldown active (mem)');
    return;
  }

  try {
    const subject = subjectFor(signal);
    console.log('[email] sending', { to: recipients, subject });
    await sendMail({ to: recipients, subject, html: htmlFor(signal), text: textFor(signal) });
    markCooldown(key, now);
    console.log('[email] sent + marked (mem)', { key });
  } catch (e) {
    console.error('[email] sendMail error', e);
  }
}
