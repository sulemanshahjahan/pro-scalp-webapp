/**
 * Symbol Tier Store
 * 
 * Manages symbol tier assignments (GREEN/YELLOW/RED) based on historical performance.
 * Tiers are computed from extended outcomes and can be overridden manually.
 */

import { getDb } from './db/db.js';

export type SymbolTier = 'GREEN' | 'YELLOW' | 'RED';

export interface SymbolTierRecord {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  tier: SymbolTier;
  winRate: number;
  totalSignals: number;
  avgRealizedR: number | null;
  computedAt: number;
  updatedAt: number;
  manualOverride: boolean;
  reason?: string;
}

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const d = getDb();
  const isSQLite = d.driver === 'sqlite';

  try {
    if (isSQLite) {
      await d.exec(`
        CREATE TABLE IF NOT EXISTS symbol_tiers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          direction TEXT NOT NULL,
          tier TEXT NOT NULL DEFAULT 'YELLOW',
          win_rate REAL NOT NULL DEFAULT 0,
          total_signals INTEGER NOT NULL DEFAULT 0,
          avg_realized_r REAL,
          computed_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0,
          manual_override INTEGER NOT NULL DEFAULT 0,
          reason TEXT,
          UNIQUE(symbol, direction)
        );
        CREATE INDEX IF NOT EXISTS idx_symbol_tiers_symbol ON symbol_tiers(symbol);
        CREATE INDEX IF NOT EXISTS idx_symbol_tiers_tier ON symbol_tiers(tier);
      `);
    } else {
      await d.exec(`
        CREATE TABLE IF NOT EXISTS symbol_tiers (
          id SERIAL PRIMARY KEY,
          symbol TEXT NOT NULL,
          direction TEXT NOT NULL,
          tier TEXT NOT NULL DEFAULT 'YELLOW',
          win_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
          total_signals INTEGER NOT NULL DEFAULT 0,
          avg_realized_r DOUBLE PRECISION,
          computed_at BIGINT NOT NULL DEFAULT 0,
          updated_at BIGINT NOT NULL DEFAULT 0,
          manual_override INTEGER NOT NULL DEFAULT 0,
          reason TEXT,
          UNIQUE(symbol, direction)
        );
        CREATE INDEX IF NOT EXISTS idx_symbol_tiers_symbol ON symbol_tiers(symbol);
        CREATE INDEX IF NOT EXISTS idx_symbol_tiers_tier ON symbol_tiers(tier);
      `);
    }
    schemaReady = true;
  } catch (e) {
    console.error('[symbol-tier-store] Schema creation failed:', e);
    throw e;
  }
}

const TIER_THRESHOLDS = {
  GREEN: 0.30,
  YELLOW: 0.15,
};

const MIN_SIGNALS_FOR_TIER = Math.max(1, parseInt(process.env.MIN_SIGNALS_FOR_TIER || '20', 10));

export function computeSymbolTier(winRate: number, totalSignals: number): { tier: SymbolTier; lowConfidence: boolean } {
  if (totalSignals < MIN_SIGNALS_FOR_TIER) {
    return { tier: 'YELLOW', lowConfidence: true }; // Not enough data, be cautious
  }
  if (winRate >= TIER_THRESHOLDS.GREEN) return { tier: 'GREEN', lowConfidence: false };
  if (winRate >= TIER_THRESHOLDS.YELLOW) return { tier: 'YELLOW', lowConfidence: false };
  return { tier: 'RED', lowConfidence: false };
}

/**
 * Get tier for a symbol+direction
 */
export async function getSymbolTier(
  symbol: string,
  direction: 'LONG' | 'SHORT'
): Promise<SymbolTierRecord | null> {
  await ensureSchema();
  const d = getDb();

  const row = await d.prepare(`
    SELECT * FROM symbol_tiers 
    WHERE symbol = ? AND direction = ?
  `).get(symbol.toUpperCase(), direction) as any;

  if (!row) return null;

  return {
    symbol: String(row.symbol),
    direction: String(row.direction) as 'LONG' | 'SHORT',
    tier: String(row.tier) as SymbolTier,
    winRate: Number(row.win_rate) || 0,
    totalSignals: Number(row.total_signals) || 0,
    avgRealizedR: row.avg_realized_r != null ? Number(row.avg_realized_r) : null,
    computedAt: Number(row.computed_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    manualOverride: Boolean(row.manual_override),
    reason: row.reason ? String(row.reason) : undefined,
  };
}

/**
 * Get all symbol tiers
 */
export async function getAllSymbolTiers(
  direction?: 'LONG' | 'SHORT',
  tier?: SymbolTier
): Promise<SymbolTierRecord[]> {
  await ensureSchema();
  const d = getDb();

  const conditions: string[] = [];
  const values: any[] = [];

  if (direction) {
    conditions.push('direction = ?');
    values.push(direction);
  }
  if (tier) {
    conditions.push('tier = ?');
    values.push(tier);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await d.prepare(`
    SELECT * FROM symbol_tiers ${whereClause}
    ORDER BY total_signals DESC, win_rate DESC
  `).all(...values) as any[];

  return rows.map(row => ({
    symbol: String(row.symbol),
    direction: String(row.direction) as 'LONG' | 'SHORT',
    tier: String(row.tier) as SymbolTier,
    winRate: Number(row.win_rate) || 0,
    totalSignals: Number(row.total_signals) || 0,
    avgRealizedR: row.avg_realized_r != null ? Number(row.avg_realized_r) : null,
    computedAt: Number(row.computed_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    manualOverride: Boolean(row.manual_override),
    reason: row.reason ? String(row.reason) : undefined,
  }));
}

/**
 * Set tier for a symbol (manual override)
 */
export async function setSymbolTier(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  tier: SymbolTier,
  reason?: string
): Promise<void> {
  await ensureSchema();
  const d = getDb();
  const now = Date.now();

  await d.prepare(`
    INSERT INTO symbol_tiers (
      symbol, direction, tier, win_rate, total_signals, avg_realized_r,
      computed_at, updated_at, manual_override, reason
    ) VALUES (?, ?, ?, 0, 0, NULL, 0, ?, 1, ?)
    ON CONFLICT(symbol, direction) DO UPDATE SET
      tier = EXCLUDED.tier,
      updated_at = EXCLUDED.updated_at,
      manual_override = 1,
      reason = EXCLUDED.reason
  `).run(symbol.toUpperCase(), direction, tier, now, reason || null);
}

/**
 * Compute and update tiers from historical outcomes
 */
export async function computeAndUpdateTiers(
  startMs?: number,
  endMs?: number,
  minSignals: number = MIN_SIGNALS_FOR_TIER
): Promise<{ updated: number; errors: number }> {
  await ensureSchema();
  const d = getDb();

  const now = Date.now();
  const start = startMs ?? now - 30 * 24 * 60 * 60 * 1000; // Default 30 days
  const end = endMs ?? now;

  // Fetch stats grouped by symbol+direction
  const rows = await d.prepare(`
    SELECT 
      s.symbol,
      COALESCE(eo.direction, CASE 
        WHEN s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT'
        ELSE 'LONG'
      END) as direction,
      COUNT(*) as total_signals,
      SUM(CASE WHEN eo.status IN ('WIN_TP1', 'WIN_TP2') THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN eo.status = 'LOSS_STOP' THEN 1 ELSE 0 END) as losses,
      AVG(eo.ext24_realized_r) as avg_realized_r
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    WHERE eo.signal_time >= @start AND eo.signal_time <= @end
      AND eo.completed_at IS NOT NULL
    GROUP BY s.symbol, direction
    HAVING COUNT(*) >= @minSignals
  `).all({ start, end, minSignals }) as any[];

  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const symbol = String(row.symbol);
      const direction = String(row.direction) as 'LONG' | 'SHORT';
      const total = Number(row.total_signals) || 0;
      const wins = Number(row.wins) || 0;
      const winRate = total > 0 ? wins / total : 0;
      const avgRealizedR = row.avg_realized_r != null ? Number(row.avg_realized_r) : null;

      // Check if this is a manual override - if so, skip
      const existing = await d.prepare(`
        SELECT manual_override FROM symbol_tiers 
        WHERE symbol = ? AND direction = ?
      `).get(symbol, direction) as any;

      if (existing?.manual_override) {
        continue; // Don't overwrite manual overrides
      }

      const { tier, lowConfidence } = computeSymbolTier(winRate, total);
      const reason = lowConfidence
        ? `auto-computed (low confidence: N=${total} < ${MIN_SIGNALS_FOR_TIER})`
        : 'auto-computed';

      await d.prepare(`
        INSERT INTO symbol_tiers (
          symbol, direction, tier, win_rate, total_signals, avg_realized_r,
          computed_at, updated_at, manual_override, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(symbol, direction) DO UPDATE SET
          tier = EXCLUDED.tier,
          win_rate = EXCLUDED.win_rate,
          total_signals = EXCLUDED.total_signals,
          avg_realized_r = EXCLUDED.avg_realized_r,
          computed_at = EXCLUDED.computed_at,
          updated_at = EXCLUDED.updated_at,
          manual_override = 0,
          reason = EXCLUDED.reason
      `).run(symbol, direction, tier, winRate, total, avgRealizedR, now, now, reason);

      updated++;
    } catch (e) {
      console.error('[symbol-tier-store] Error updating tier:', e);
      errors++;
    }
  }

  return { updated, errors };
}

/**
 * Clear manual override for a symbol
 */
export async function clearManualOverride(
  symbol: string,
  direction: 'LONG' | 'SHORT'
): Promise<void> {
  await ensureSchema();
  const d = getDb();

  await d.prepare(`
    UPDATE symbol_tiers 
    SET manual_override = 0, reason = 'auto-computed'
    WHERE symbol = ? AND direction = ?
  `).run(symbol.toUpperCase(), direction);
}

/**
 * Delete a tier record
 */
export async function deleteSymbolTier(
  symbol: string,
  direction: 'LONG' | 'SHORT'
): Promise<void> {
  await ensureSchema();
  const d = getDb();

  await d.prepare(`
    DELETE FROM symbol_tiers 
    WHERE symbol = ? AND direction = ?
  `).run(symbol.toUpperCase(), direction);
}
