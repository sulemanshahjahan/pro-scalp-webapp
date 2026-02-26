/**
 * Delayed Entry System - Confirmation-Based Trading
 * 
 * Instead of entering immediately when signal appears, we:
 * 1. Mark signal as WATCH
 * 2. Wait for price to move confirmMovePct% in our favor
 * 3. Only THEN enter the trade
 * 4. If no confirmation within maxWaitMinutes, expire the signal
 * 
 * This solves the "MFE30m = 0" problem - we only enter after movement is proven.
 */

import { getDb } from './db/db.js';
import { klines, klinesRange } from './binance.js';
import type { Signal } from './types.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface DelayedEntryConfig {
  enabled: boolean;
  confirmMovePct: number;      // % move required to confirm (e.g., 0.3 = 0.3%)
  maxWaitMinutes: number;      // How long to wait for confirmation
  pollIntervalSeconds: number; // How often to check price
  maxSpreadPct: number;        // Max spread to allow entry (optional)
}

export const DEFAULT_DELAYED_ENTRY_CONFIG: DelayedEntryConfig = {
  enabled: true,
  confirmMovePct: 0.30,        // 0.3% move required
  maxWaitMinutes: 45,          // Wait up to 45 minutes
  pollIntervalSeconds: 30,     // Check every 30 seconds
  maxSpreadPct: 0.15,          // 0.15% max spread
};

export function getDelayedEntryConfig(): DelayedEntryConfig {
  return {
    enabled: (process.env.DELAYED_ENTRY_ENABLED || 'true').toLowerCase() === 'true',
    confirmMovePct: parseFloat(process.env.DELAYED_ENTRY_CONFIRM_MOVE_PCT || '0.30'),
    maxWaitMinutes: parseInt(process.env.DELAYED_ENTRY_MAX_WAIT_MINUTES || '45', 10),
    pollIntervalSeconds: parseInt(process.env.DELAYED_ENTRY_POLL_SECONDS || '30', 10),
    maxSpreadPct: parseFloat(process.env.DELAYED_ENTRY_MAX_SPREAD_PCT || '0.15'),
  };
}

// ============================================================================
// TYPES
// ============================================================================

export type DelayedEntryStatus = 
  | 'WATCH'              // Signal created, waiting for confirmation
  | 'ENTERED'            // Confirmed and entered
  | 'EXPIRED_NO_ENTRY'   // Never confirmed within window
  | 'CANCELLED';         // Cancelled for other reasons

export interface DelayedEntryRecord {
  signalId: number;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  referencePrice: number;      // Price when signal was created
  targetConfirmPrice: number;  // Price needed to confirm
  watchStartedAt: number;      // Timestamp
  watchExpiresAt: number;      // Max wait time
  status: DelayedEntryStatus;
  confirmedAt?: number;        // When confirmed (if entered)
  confirmedPrice?: number;     // Price at confirmation (if entered)
  reason?: string;             // Why expired/cancelled
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Initialize delayed entry for a new signal
 * Called when signal passes the gate but before recording as active trade
 */
export async function initDelayedEntry(
  signal: Signal & { id?: number },
  config?: Partial<DelayedEntryConfig>
): Promise<{ shouldProceed: boolean; record?: DelayedEntryRecord }> {
  const cfg = { ...getDelayedEntryConfig(), ...config };
  
  if (!cfg.enabled) {
    return { shouldProceed: true }; // Skip delay, enter immediately
  }
  
  const direction = getDirectionFromCategory(signal.category);
  const referencePrice = signal.price;
  
  // Calculate target confirmation price
  const moveMult = cfg.confirmMovePct / 100;
  const targetConfirmPrice = direction === 'LONG' 
    ? referencePrice * (1 + moveMult)
    : referencePrice * (1 - moveMult);
  
  const now = Date.now();
  const watchExpiresAt = now + (cfg.maxWaitMinutes * 60 * 1000);
  
  const record: DelayedEntryRecord = {
    signalId: signal.id || 0,
    symbol: signal.symbol,
    direction,
    referencePrice,
    targetConfirmPrice,
    watchStartedAt: now,
    watchExpiresAt,
    status: 'WATCH',
  };
  
  // Store in database
  await storeDelayedEntryRecord(record);
  
  console.log(`[delayed-entry] WATCH: ${signal.symbol} ${signal.category} - waiting for ${direction === 'LONG' ? '+' : '-'}${cfg.confirmMovePct}% move (target: ${targetConfirmPrice.toFixed(4)})`);
  
  return { shouldProceed: false, record };
}

/**
 * Check if a WATCH signal has been confirmed
 * Called by the watcher loop every poll interval
 */
export async function checkDelayedEntryConfirmation(
  record: DelayedEntryRecord,
  currentPrice: number,
  config?: Partial<DelayedEntryConfig>
): Promise<{ confirmed: boolean; reason?: string }> {
  const cfg = { ...getDelayedEntryConfig(), ...config };
  const now = Date.now();
  
  // Check if expired
  if (now > record.watchExpiresAt) {
    await updateDelayedEntryStatus(record.signalId, 'EXPIRED_NO_ENTRY', 'NO_CONFIRMATION_WITHIN_WINDOW');
    return { confirmed: false, reason: 'EXPIRED' };
  }
  
  // Check if confirmed
  const confirmed = record.direction === 'LONG'
    ? currentPrice >= record.targetConfirmPrice
    : currentPrice <= record.targetConfirmPrice;
  
  if (confirmed) {
    await updateDelayedEntryStatus(record.signalId, 'ENTERED', undefined, now, currentPrice);
    console.log(`[delayed-entry] ENTERED: ${record.symbol} at ${currentPrice.toFixed(4)} (moved ${calculateMovePct(record.referencePrice, currentPrice, record.direction).toFixed(2)}%)`);
    return { confirmed: true };
  }
  
  return { confirmed: false };
}

/**
 * Get all WATCH signals that need checking
 */
export async function getActiveWatches(limit: number = 200): Promise<DelayedEntryRecord[]> {
  const d = getDb();
  
  const rows = await d.prepare(`
    SELECT 
      signal_id as signalId,
      symbol,
      direction,
      reference_price as referencePrice,
      target_confirm_price as targetConfirmPrice,
      watch_started_at as watchStartedAt,
      watch_expires_at as watchExpiresAt,
      status,
      confirmed_at as confirmedAt,
      confirmed_price as confirmedPrice,
      reason
    FROM delayed_entry_records
    WHERE status = 'WATCH'
    ORDER BY watch_started_at ASC
    LIMIT @limit
  `).all({ limit }) as any[];
  
  return rows.map(row => ({
    signalId: Number(row.signalId),
    symbol: String(row.symbol),
    direction: String(row.direction) as 'LONG' | 'SHORT',
    referencePrice: Number(row.referencePrice),
    targetConfirmPrice: Number(row.targetConfirmPrice),
    watchStartedAt: Number(row.watchStartedAt),
    watchExpiresAt: Number(row.watchExpiresAt),
    status: String(row.status) as DelayedEntryStatus,
    confirmedAt: row.confirmedAt ? Number(row.confirmedAt) : undefined,
    confirmedPrice: row.confirmedPrice ? Number(row.confirmedPrice) : undefined,
    reason: row.reason ? String(row.reason) : undefined,
  }));
}

/**
 * Main watcher loop - check all active watches
 */
export async function runDelayedEntryWatcher(): Promise<{
  checked: number;
  entered: number;
  expired: number;
}> {
  const cfg = getDelayedEntryConfig();
  
  if (!cfg.enabled) {
    return { checked: 0, entered: 0, expired: 0 };
  }
  
  const watches = await getActiveWatches();
  let entered = 0;
  let expired = 0;
  
  for (const watch of watches) {
    try {
      // Get current price (use latest 1m candle close)
      const now = Date.now();
      const candles = await klinesRange(watch.symbol, '1m', now - 60000, now, 1);
      if (!candles || candles.length === 0) continue;
      
      const currentPrice = candles[candles.length - 1].close;
      
      const result = await checkDelayedEntryConfirmation(watch, currentPrice);
      
      if (result.confirmed) {
        // Trigger actual entry - create/update outcomes
        await executeDelayedEntry(watch, currentPrice);
        entered++;
      } else if (result.reason === 'EXPIRED') {
        expired++;
      }
    } catch (e) {
      console.error(`[delayed-entry] Error checking ${watch.symbol}:`, e);
    }
  }
  
  if (watches.length > 0) {
    console.log(`[delayed-entry] Watcher: checked ${watches.length}, entered ${entered}, expired ${expired}`);
  }
  
  return { checked: watches.length, entered, expired };
}

// ============================================================================
// DATABASE FUNCTIONS
// ============================================================================

async function storeDelayedEntryRecord(record: DelayedEntryRecord): Promise<void> {
  const d = getDb();
  
  await d.prepare(`
    INSERT INTO delayed_entry_records (
      signal_id, symbol, direction, reference_price, target_confirm_price,
      watch_started_at, watch_expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signal_id) DO UPDATE SET
      status = excluded.status,
      watch_started_at = excluded.watch_started_at,
      watch_expires_at = excluded.watch_expires_at
  `).run(
    record.signalId,
    record.symbol,
    record.direction,
    record.referencePrice,
    record.targetConfirmPrice,
    record.watchStartedAt,
    record.watchExpiresAt,
    record.status
  );
}

async function updateDelayedEntryStatus(
  signalId: number,
  status: DelayedEntryStatus,
  reason?: string,
  confirmedAt?: number,
  confirmedPrice?: number
): Promise<void> {
  const d = getDb();
  
  await d.prepare(`
    UPDATE delayed_entry_records
    SET status = ?, reason = ?, confirmed_at = ?, confirmed_price = ?
    WHERE signal_id = ?
  `).run(status, reason || null, confirmedAt || null, confirmedPrice || null, signalId);
}

// ============================================================================
// EXECUTION
// ============================================================================

async function executeDelayedEntry(
  record: DelayedEntryRecord,
  entryPrice: number
): Promise<void> {
  // Create extended outcome with the CONFIRMED entry price
  const d = getDb();
  
  await d.prepare(`
    INSERT INTO extended_outcomes (
      signal_id, symbol, direction, signal_time, started_at, entry_price,
      stop_price, tp1_price, tp2_price, status, risk_usd_snapshot
    )
    SELECT 
      s.id, s.symbol, ?, s.time, ?, ?, s.stop, s.tp1, s.tp2, 'ACTIVE', 15
    FROM signals s
    WHERE s.id = ?
    ON CONFLICT(signal_id) DO UPDATE SET
      started_at = excluded.started_at,
      entry_price = excluded.entry_price,
      status = 'ACTIVE'
  `).run(
    record.direction,
    Date.now(),
    entryPrice,
    record.signalId
  );
  
  console.log(`[delayed-entry] Executed entry for signal ${record.signalId} at ${entryPrice.toFixed(4)}`);
}

// ============================================================================
// HELPERS
// ============================================================================

function getDirectionFromCategory(category: string): 'LONG' | 'SHORT' {
  const shortCategories = ['READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT'];
  return shortCategories.includes(category.toUpperCase()) ? 'SHORT' : 'LONG';
}

function calculateMovePct(reference: number, current: number, direction: 'LONG' | 'SHORT'): number {
  const move = direction === 'LONG'
    ? (current - reference) / reference
    : (reference - current) / reference;
  return move * 100;
}

// ============================================================================
// BACKTEST SIMULATION
// ============================================================================

/**
 * Simulate delayed entry on historical data
 * Returns which signals would have been entered vs expired
 */
export async function simulateDelayedEntry(
  signal: Signal,
  candles: Array<{ time: number; open: number; high: number; low: number; close: number }>,
  config?: Partial<DelayedEntryConfig>
): Promise<{
  wouldEnter: boolean;
  entryPrice?: number;
  entryTime?: number;
  movePct?: number;
  reason: 'CONFIRMED' | 'EXPIRED' | 'NO_CANDLES';
}> {
  const cfg = { ...DEFAULT_DELAYED_ENTRY_CONFIG, ...config };
  const direction = getDirectionFromCategory(signal.category);
  
  const signalTime = signal.time;
  const maxWaitTime = signalTime + (cfg.maxWaitMinutes * 60 * 1000);
  const targetMove = cfg.confirmMovePct / 100;
  
  // Filter candles within the watch window
  const relevantCandles = candles.filter(c => c.time >= signalTime && c.time <= maxWaitTime);
  
  if (relevantCandles.length === 0) {
    return { wouldEnter: false, reason: 'NO_CANDLES' };
  }
  
  for (const candle of relevantCandles) {
    // For LONG: check if high reached confirmation level
    // For SHORT: check if low reached confirmation level
    const confirmPrice = direction === 'LONG'
      ? signal.price * (1 + targetMove)
      : signal.price * (1 - targetMove);
    
    const hit = direction === 'LONG'
      ? candle.high >= confirmPrice
      : candle.low <= confirmPrice;
    
    if (hit) {
      const entryPrice = confirmPrice; // Enter at confirmation level
      const movePct = Math.abs((entryPrice - signal.price) / signal.price) * 100;
      
      return {
        wouldEnter: true,
        entryPrice,
        entryTime: candle.time,
        movePct,
        reason: 'CONFIRMED',
      };
    }
  }
  
  // Never confirmed within window
  return { wouldEnter: false, reason: 'EXPIRED' };
}
