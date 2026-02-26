/**
 * Database schema for Delayed Entry records
 */

import { getDb } from './db.js';

export async function ensureDelayedEntrySchema(): Promise<void> {
  const d = getDb();
  const isPg = String(process.env.DB_DRIVER).toLowerCase() === 'postgres';
  
  if (isPg) {
    // PostgreSQL
    await d.prepare(`
      CREATE TABLE IF NOT EXISTS delayed_entry_records (
        id SERIAL PRIMARY KEY,
        signal_id INTEGER NOT NULL UNIQUE REFERENCES signals(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        direction VARCHAR(10) NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
        reference_price DOUBLE PRECISION NOT NULL,
        target_confirm_price DOUBLE PRECISION NOT NULL,
        watch_started_at BIGINT NOT NULL,
        watch_expires_at BIGINT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'WATCH' CHECK (status IN ('WATCH', 'ENTERED', 'EXPIRED_NO_ENTRY', 'CANCELLED')),
        confirmed_at BIGINT,
        confirmed_price DOUBLE PRECISION,
        reason VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    
    // Index for efficient WATCH queries
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_status ON delayed_entry_records(status)
    `).run();
    
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_expires ON delayed_entry_records(watch_expires_at)
    `).run();
    
  } else {
    // SQLite
    await d.prepare(`
      CREATE TABLE IF NOT EXISTS delayed_entry_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL UNIQUE REFERENCES signals(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
        reference_price REAL NOT NULL,
        target_confirm_price REAL NOT NULL,
        watch_started_at INTEGER NOT NULL,
        watch_expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'WATCH' CHECK (status IN ('WATCH', 'ENTERED', 'EXPIRED_NO_ENTRY', 'CANCELLED')),
        confirmed_at INTEGER,
        confirmed_price REAL,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_status ON delayed_entry_records(status)
    `).run();
    
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_expires ON delayed_entry_records(watch_expires_at)
    `).run();
  }
  
  console.log('[delayed-entry] Schema ensured');
}
