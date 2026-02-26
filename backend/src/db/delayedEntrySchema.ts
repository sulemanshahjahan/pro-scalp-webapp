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
        status VARCHAR(20) NOT NULL DEFAULT 'WATCH' CHECK (status IN ('WATCH', 'ENTERED', 'EXPIRED_NO_ENTRY', 'CANCELLED', 'SKIPPED_SPIKE')),
        confirmed_at BIGINT,
        confirmed_price DOUBLE PRECISION,
        confirmed_stop_price DOUBLE PRECISION,
        confirmed_tp1_price DOUBLE PRECISION,
        confirmed_tp2_price DOUBLE PRECISION,
        reason VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    
    // Add columns if they don't exist (migration for existing tables)
    await addColumnIfNotExists(d, 'delayed_entry_records', 'original_stop', 'DOUBLE PRECISION');
    await addColumnIfNotExists(d, 'delayed_entry_records', 'original_tp1', 'DOUBLE PRECISION');
    await addColumnIfNotExists(d, 'delayed_entry_records', 'original_tp2', 'DOUBLE PRECISION');
    
    // Index for efficient WATCH queries
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_status ON delayed_entry_records(status)
    `).run();
    
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_expires ON delayed_entry_records(watch_expires_at)
    `).run();
    
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_symbol ON delayed_entry_records(symbol)
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
        status TEXT NOT NULL DEFAULT 'WATCH' CHECK (status IN ('WATCH', 'ENTERED', 'EXPIRED_NO_ENTRY', 'CANCELLED', 'SKIPPED_SPIKE')),
        confirmed_at INTEGER,
        confirmed_price REAL,
        confirmed_stop_price REAL,
        confirmed_tp1_price REAL,
        confirmed_tp2_price REAL,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    
    // Add columns if they don't exist (SQLite)
    await addColumnIfNotExistsSQLite(d, 'delayed_entry_records', 'original_stop', 'REAL');
    await addColumnIfNotExistsSQLite(d, 'delayed_entry_records', 'original_tp1', 'REAL');
    await addColumnIfNotExistsSQLite(d, 'delayed_entry_records', 'original_tp2', 'REAL');
    
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_status ON delayed_entry_records(status)
    `).run();
    
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_expires ON delayed_entry_records(watch_expires_at)
    `).run();
    
    await d.prepare(`
      CREATE INDEX IF NOT EXISTS idx_delayed_entry_symbol ON delayed_entry_records(symbol)
    `).run();
  }
  
  console.log('[delayed-entry] Schema ensured');
}

// PostgreSQL: Add column if not exists
async function addColumnIfNotExists(
  d: any,
  table: string,
  column: string,
  type: string
): Promise<void> {
  try {
    await d.prepare(`
      ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}
    `).run();
  } catch (e) {
    console.log(`[schema] Column ${column} may already exist:`, e);
  }
}

// SQLite: Add column if not exists (SQLite doesn't support IF NOT EXISTS for columns)
async function addColumnIfNotExistsSQLite(
  d: any,
  table: string,
  column: string,
  type: string
): Promise<void> {
  try {
    // Check if column exists
    const info = await d.prepare(`PRAGMA table_info(${table})`).all();
    const exists = info.some((col: any) => col.name === column);
    
    if (!exists) {
      await d.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
      console.log(`[schema] Added column ${column} to ${table}`);
    }
  } catch (e) {
    console.log(`[schema] Column ${column} may already exist:`, e);
  }
}
