/**
 * Delayed Entry System - Confirmation-Based Trading (Production Ready)
 * 
 * Instead of entering immediately when signal appears, we:
 * 1. Mark signal as WATCH
 * 2. Wait for price to move confirmMovePct% in our favor
 * 3. Only THEN enter the trade
 * 4. If no confirmation within maxWaitMinutes, expire the signal
 * 
 * This solves the "MFE30m = 0" problem - we only enter AFTER movement is proven.
 */

import { getDb } from './db/db.js';
import { klinesRange } from './binance.js';
import type { Signal } from './types.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface DelayedEntryConfig {
  enabled: boolean;
  confirmMovePct: number;        // % move required (base or fallback)
  maxWaitMinutes: number;        // How long to wait for confirmation
  pollIntervalSeconds: number;   // How often to check price
  maxExtraMovePct: number;       // Spike protection
  maxSpreadPct: number;          // Max spread to allow entry
  
  // ATR-based confirmation
  useAtrBasedConfirm: boolean;   // Use ATR% instead of fixed confirmMovePct
  atrConfirmMultiplier: number;  // Multiplier for ATR% (e.g., 0.45 * ATR5m%)
  minConfirmMovePct: number;     // Floor for confirmation %
  maxConfirmMovePct: number;     // Cap for confirmation %
}

export const DEFAULT_DELAYED_ENTRY_CONFIG: DelayedEntryConfig = {
  enabled: true,
  confirmMovePct: 0.50,          // Base % move required (used if ATR-based is disabled)
  maxWaitMinutes: 45,            // Wait up to 45 minutes
  pollIntervalSeconds: 30,       // Check every 30 seconds
  maxExtraMovePct: 0.10,         // Skip if moved beyond (confirm + extra)
  maxSpreadPct: 0.15,            // 0.15% max spread
  
  // ATR-based confirmation (GPT recommendation)
  useAtrBasedConfirm: true,      // Use ATR% instead of fixed confirmMovePct
  atrConfirmMultiplier: 0.45,    // confirm = ATR5m% * 0.45
  minConfirmMovePct: 0.12,       // Floor: minimum 0.12% confirmation
  maxConfirmMovePct: 0.35,       // Cap: maximum 0.35% confirmation
};

export function getDelayedEntryConfig(): DelayedEntryConfig {
  return {
    enabled: (process.env.DELAYED_ENTRY_ENABLED || 'true').toLowerCase() === 'true',
    confirmMovePct: parseFloat(process.env.DELAYED_ENTRY_CONFIRM_MOVE_PCT || '0.50'),
    maxWaitMinutes: parseInt(process.env.DELAYED_ENTRY_MAX_WAIT_MINUTES || '45', 10),
    pollIntervalSeconds: parseInt(process.env.DELAYED_ENTRY_POLL_SECONDS || '30', 10),
    maxExtraMovePct: parseFloat(process.env.DELAYED_ENTRY_MAX_EXTRA_MOVE_PCT || '0.10'),
    maxSpreadPct: parseFloat(process.env.DELAYED_ENTRY_MAX_SPREAD_PCT || '0.15'),
    
    // ATR-based confirmation
    useAtrBasedConfirm: (process.env.DELAYED_ENTRY_USE_ATR || 'true').toLowerCase() === 'true',
    atrConfirmMultiplier: parseFloat(process.env.DELAYED_ENTRY_ATR_MULT || '0.45'),
    minConfirmMovePct: parseFloat(process.env.DELAYED_ENTRY_MIN_CONFIRM_PCT || '0.12'),
    maxConfirmMovePct: parseFloat(process.env.DELAYED_ENTRY_MAX_CONFIRM_PCT || '0.35'),
  };
}

// ============================================================================
// TYPES
// ============================================================================

export type DelayedEntryStatus = 
  | 'WATCH'              // Signal created, waiting for confirmation
  | 'ENTERED'            // Confirmed and entered
  | 'EXPIRED_NO_ENTRY'   // Never confirmed within window
  | 'CANCELLED'          // Cancelled for other reasons
  | 'SKIPPED_SPIKE';     // Moved too far (spike protection)

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
  reason?: string;             // Why expired/cancelled/skipped
  
  // Recalculated TP/SL from confirmed entry
  confirmedStopPrice?: number;
  confirmedTp1Price?: number;
  confirmedTp2Price?: number;
}

export interface DelayedEntryStats {
  watchCreated: number;
  entered: number;
  expired: number;
  skippedSpike: number;
  confirmRate: number;         // entered / watchCreated
  avgMoveToConfirm?: number;   // Average % move when confirmed
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
  originalStop: number | null,
  originalTp1: number | null,
  originalTp2: number | null,
  config?: Partial<DelayedEntryConfig>
): Promise<{ shouldProceed: boolean; record?: DelayedEntryRecord }> {
  const cfg = { ...getDelayedEntryConfig(), ...config };
  
  if (!cfg.enabled) {
    return { shouldProceed: true }; // Skip delay, enter immediately
  }
  
  const direction = getDirectionFromCategory(signal.category);
  const referencePrice = signal.price;
  
  // Calculate confirmation threshold
  // ATR-based: clamp(min, ATR% * multiplier, max)
  // Fallback to fixed confirmMovePct if ATR not available or disabled
  let confirmMovePct = cfg.confirmMovePct;
  let usedAtrBased = false;
  
  if (cfg.useAtrBasedConfirm && signal.atrPct && signal.atrPct > 0) {
    const atrBasedConfirm = signal.atrPct * cfg.atrConfirmMultiplier;
    confirmMovePct = Math.max(
      cfg.minConfirmMovePct,
      Math.min(cfg.maxConfirmMovePct, atrBasedConfirm)
    );
    usedAtrBased = true;
  }
  
  // Calculate target confirmation price
  const moveMult = confirmMovePct / 100;
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
  
  // Store calculated confirm % for reference
  (record as any).confirmMovePctUsed = confirmMovePct;
  (record as any).usedAtrBased = usedAtrBased;
  (record as any).atrPctAtSignal = signal.atrPct;
  
  // Store original TP/SL for later recalculation
  if (originalStop) {
    (record as any).originalStop = originalStop;
    (record as any).originalTp1 = originalTp1;
    (record as any).originalTp2 = originalTp2;
  }
  
  // Store in database
  await storeDelayedEntryRecord(record, originalStop, originalTp1, originalTp2);
  
  const atrInfo = usedAtrBased ? ` (ATR-based: ${confirmMovePct.toFixed(2)}%, ATR5m=${signal.atrPct?.toFixed(3)}%)` : '';
  console.log(`[delayed-entry] WATCH: ${signal.symbol} ${signal.category} - waiting for ${direction === 'LONG' ? '+' : '-'}${confirmMovePct.toFixed(2)}% move${atrInfo} (target: ${targetConfirmPrice.toFixed(6)})`);
  
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
): Promise<{ confirmed: boolean; skipped?: boolean; reason?: string }> {
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
  
  if (!confirmed) {
    return { confirmed: false };
  }
  
  // CONFIRMED - Now apply spike protection
  const actualMovePct = Math.abs((currentPrice - record.referencePrice) / record.referencePrice) * 100;
  // Use stored confirm % if available (ATR-based), otherwise use config
  const confirmMovePctUsed = (record as any).confirmMovePctUsed || cfg.confirmMovePct;
  const maxAllowedMove = confirmMovePctUsed + cfg.maxExtraMovePct;
  
  if (actualMovePct > maxAllowedMove) {
    // Spike too big - skip this entry
    await updateDelayedEntryStatus(
      record.signalId, 
      'SKIPPED_SPIKE', 
      `MOVE_TOO_LARGE: ${actualMovePct.toFixed(2)}% > ${maxAllowedMove.toFixed(2)}% allowed`
    );
    console.log(`[delayed-entry] SKIPPED_SPIKE: ${record.symbol} moved ${actualMovePct.toFixed(2)}% (max ${maxAllowedMove.toFixed(2)}%, confirm=${confirmMovePctUsed.toFixed(2)}%)`);
    return { confirmed: false, skipped: true, reason: 'SPIKE_TOO_LARGE' };
  }
  
  // PASSED all checks - Enter
  await updateDelayedEntryStatus(record.signalId, 'ENTERED', undefined, now, currentPrice);
  console.log(`[delayed-entry] ENTERED: ${record.symbol} at ${currentPrice.toFixed(4)} (moved ${actualMovePct.toFixed(2)}%)`);
  return { confirmed: true };
}

/**
 * Get all WATCH signals that need checking
 */
export async function getActiveWatches(limit: number = 200): Promise<DelayedEntryRecord[]> {
  const d = getDb();
  
  const rows = await d.prepare(`
    SELECT 
      signal_id,
      symbol,
      direction,
      reference_price,
      target_confirm_price,
      watch_started_at,
      watch_expires_at,
      status,
      confirmed_at,
      confirmed_price,
      reason,
      original_stop,
      original_tp1,
      original_tp2,
      confirm_move_pct_used,
      used_atr_based,
      atr_pct_at_signal
    FROM delayed_entry_records
    WHERE status = 'WATCH'
    ORDER BY watch_started_at ASC
    LIMIT ?
  `).all(limit) as any[];
  
  // Helper to safely get number
  const getNum = (val: any) => {
    if (val == null) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };
  
  return rows.map(row => {
    const record: DelayedEntryRecord = {
      signalId: getNum(row.signal_id ?? row.signalId) ?? 0,
      symbol: String(row.symbol ?? ''),
      direction: String(row.direction ?? 'LONG') as 'LONG' | 'SHORT',
      referencePrice: getNum(row.reference_price ?? row.referencePrice) ?? 0,
      targetConfirmPrice: getNum(row.target_confirm_price ?? row.targetConfirmPrice) ?? 0,
      watchStartedAt: getNum(row.watch_started_at ?? row.watchStartedAt) ?? 0,
      watchExpiresAt: getNum(row.watch_expires_at ?? row.watchExpiresAt) ?? 0,
      status: String(row.status ?? 'WATCH') as DelayedEntryStatus,
      confirmedAt: getNum(row.confirmed_at ?? row.confirmedAt) || undefined,
      confirmedPrice: getNum(row.confirmed_price ?? row.confirmedPrice) || undefined,
      reason: row.reason ? String(row.reason) : undefined,
    };
    // Store original TP/SL for recalculation
    (record as any).originalStop = getNum(row.original_stop ?? row.originalStop);
    (record as any).originalTp1 = getNum(row.original_tp1 ?? row.originalTp1);
    (record as any).originalTp2 = getNum(row.original_tp2 ?? row.originalTp2);
    // Store ATR-based confirmation info
    (record as any).confirmMovePctUsed = getNum(row.confirm_move_pct_used ?? row.confirmMovePctUsed);
    (record as any).usedAtrBased = Boolean(row.used_atr_based ?? row.usedAtrBased);
    (record as any).atrPctAtSignal = getNum(row.atr_pct_at_signal ?? row.atrPctAtSignal);
    return record;
  });
}

/**
 * Get delayed entry record by signal ID
 * Used by extended outcome evaluation to determine if signal confirmed
 */
export async function getDelayedEntryRecordBySignalId(
  signalId: number
): Promise<DelayedEntryRecord | null> {
  const d = getDb();
  
  const row = await d.prepare(`
    SELECT 
      signal_id,
      symbol,
      direction,
      reference_price,
      target_confirm_price,
      watch_started_at,
      watch_expires_at,
      status,
      confirmed_at,
      confirmed_price,
      confirmed_stop_price,
      confirmed_tp1_price,
      confirmed_tp2_price,
      reason,
      original_stop,
      original_tp1,
      original_tp2,
      confirm_move_pct_used,
      used_atr_based,
      atr_pct_at_signal
    FROM delayed_entry_records
    WHERE signal_id = ?
  `).get(signalId) as any | null;
  
  if (!row) return null;
  
  // Handle both snake_case (PostgreSQL) and camelCase mappings
  const getNum = (val: any) => {
    if (val == null) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };
  
  const record: DelayedEntryRecord = {
    signalId: getNum(row.signal_id ?? row.signalId) || 0,
    symbol: String(row.symbol ?? ''),
    direction: String(row.direction ?? 'LONG') as 'LONG' | 'SHORT',
    referencePrice: getNum(row.reference_price ?? row.referencePrice) ?? 0,
    targetConfirmPrice: getNum(row.target_confirm_price ?? row.targetConfirmPrice) ?? 0,
    watchStartedAt: getNum(row.watch_started_at ?? row.watchStartedAt) ?? 0,
    watchExpiresAt: getNum(row.watch_expires_at ?? row.watchExpiresAt) ?? 0,
    status: String(row.status ?? 'WATCH') as DelayedEntryStatus,
    confirmedAt: getNum(row.confirmed_at ?? row.confirmedAt) || undefined,
    confirmedPrice: getNum(row.confirmed_price ?? row.confirmedPrice) || undefined,
    confirmedStopPrice: getNum(row.confirmed_stop_price ?? row.confirmedStopPrice) || undefined,
    confirmedTp1Price: getNum(row.confirmed_tp1_price ?? row.confirmedTp1Price) || undefined,
    confirmedTp2Price: getNum(row.confirmed_tp2_price ?? row.confirmedTp2Price) || undefined,
    reason: row.reason ? String(row.reason) : undefined,
  };
  // Store original TP/SL for recalculation
  (record as any).originalStop = getNum(row.original_stop ?? row.originalStop);
  (record as any).originalTp1 = getNum(row.original_tp1 ?? row.originalTp1);
  (record as any).originalTp2 = getNum(row.original_tp2 ?? row.originalTp2);
  // Store ATR-based confirmation info
  (record as any).confirmMovePctUsed = getNum(row.confirm_move_pct_used ?? row.confirmMovePctUsed);
  (record as any).usedAtrBased = Boolean(row.used_atr_based ?? row.usedAtrBased);
  (record as any).atrPctAtSignal = getNum(row.atr_pct_at_signal ?? row.atrPctAtSignal);
  
  return record;
}

/**
 * Main watcher loop - check all active watches
 */
export async function runDelayedEntryWatcher(): Promise<{
  checked: number;
  entered: number;
  expired: number;
  skipped: number;
}> {
  const cfg = getDelayedEntryConfig();
  
  if (!cfg.enabled) {
    return { checked: 0, entered: 0, expired: 0, skipped: 0 };
  }
  
  const watches = await getActiveWatches();
  let entered = 0;
  let expired = 0;
  let skipped = 0;
  
  for (const watch of watches) {
    try {
      // Get current price (use latest 1m candle)
      const now = Date.now();
      const candles = await klinesRange(watch.symbol, '1m', now - 60000, now, 1);
      if (!candles || candles.length === 0) continue;
      
      const currentPrice = candles[candles.length - 1].close;
      
      const result = await checkDelayedEntryConfirmation(watch, currentPrice);
      
      if (result.confirmed) {
        // Trigger actual entry with recalculated TP/SL
        await executeDelayedEntry(watch, currentPrice);
        entered++;
      } else if (result.skipped) {
        skipped++;
      } else if (result.reason === 'EXPIRED') {
        expired++;
      }
    } catch (e) {
      console.error(`[delayed-entry] Error checking ${watch.symbol}:`, e);
    }
  }
  
  if (watches.length > 0) {
    console.log(`[delayed-entry] Watcher: checked ${watches.length}, entered ${entered}, expired ${expired}, skipped ${skipped}`);
  }
  
  return { checked: watches.length, entered, expired, skipped };
}

// ============================================================================
// DATABASE FUNCTIONS
// ============================================================================

async function storeDelayedEntryRecord(
  record: DelayedEntryRecord,
  originalStop?: number | null,
  originalTp1?: number | null,
  originalTp2?: number | null
): Promise<void> {
  const d = getDb();
  
  await d.prepare(`
    INSERT INTO delayed_entry_records (
      signal_id, symbol, direction, reference_price, target_confirm_price,
      watch_started_at, watch_expires_at, status, original_stop, original_tp1, original_tp2,
      confirm_move_pct_used, used_atr_based, atr_pct_at_signal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signal_id) DO UPDATE SET
      status = excluded.status,
      watch_started_at = excluded.watch_started_at,
      watch_expires_at = excluded.watch_expires_at,
      target_confirm_price = excluded.target_confirm_price,
      confirm_move_pct_used = excluded.confirm_move_pct_used,
      used_atr_based = excluded.used_atr_based,
      atr_pct_at_signal = excluded.atr_pct_at_signal
  `).run(
    record.signalId,
    record.symbol,
    record.direction,
    record.referencePrice,
    record.targetConfirmPrice,
    record.watchStartedAt,
    record.watchExpiresAt,
    record.status,
    originalStop ?? null,
    originalTp1 ?? null,
    originalTp2 ?? null,
    (record as any).confirmMovePctUsed ?? null,
    (record as any).usedAtrBased ?? false,
    (record as any).atrPctAtSignal ?? null
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
  
  // Track expired reason for analytics
  const expiredReason = status === 'EXPIRED_NO_ENTRY' ? (reason || 'UNKNOWN') : null;
  
  // Atomic update - only change if still WATCH (prevents double-entry)
  const result = await d.prepare(`
    UPDATE delayed_entry_records
    SET status = ?, 
        reason = ?, 
        confirmed_at = ?, 
        confirmed_price = ?,
        expired_reason = COALESCE(?, expired_reason)
    WHERE signal_id = ? AND status = 'WATCH'
  `).run(status, reason || null, confirmedAt || null, confirmedPrice || null, expiredReason, signalId);
  
  if (result.changes === 0) {
    console.log(`[delayed-entry] Signal ${signalId} already processed (not in WATCH state)`);
  }
}

// ============================================================================
// EXECUTION WITH RECALCULATED TP/SL
// ============================================================================

async function executeDelayedEntry(
  record: DelayedEntryRecord,
  entryPrice: number
): Promise<void> {
  const d = getDb();
  
  // Get original TP/SL from the record
  const originalStop = (record as any).originalStop as number | null;
  const originalTp1 = (record as any).originalTp1 as number | null;
  const originalTp2 = (record as any).originalTp2 as number | null;
  
  // Recalculate TP/SL maintaining the same distance percentages
  const recalculated = recalculateTpSl(
    entryPrice,
    record.referencePrice,
    originalStop,
    originalTp1,
    originalTp2,
    record.direction
  );
  
  // Update delayed entry record with confirmed prices
  await d.prepare(`
    UPDATE delayed_entry_records
    SET confirmed_stop_price = ?, confirmed_tp1_price = ?, confirmed_tp2_price = ?
    WHERE signal_id = ?
  `).run(
    recalculated.stop ?? null,
    recalculated.tp1 ?? null,
    recalculated.tp2 ?? null,
    record.signalId
  );
  
  // Create extended outcome with the CONFIRMED entry price and recalculated TP/SL
  await d.prepare(`
    INSERT INTO extended_outcomes (
      signal_id, symbol, direction, signal_time, started_at, entry_price,
      stop_price, tp1_price, tp2_price, status, risk_usd_snapshot
    )
    SELECT 
      s.id, s.symbol, ?, s.time, ?, ?, ?, ?, ?, 'ACTIVE', 15
    FROM signals s
    WHERE s.id = ?
    ON CONFLICT(signal_id) DO UPDATE SET
      started_at = excluded.started_at,
      entry_price = excluded.entry_price,
      stop_price = excluded.stop_price,
      tp1_price = excluded.tp1_price,
      tp2_price = excluded.tp2_price,
      status = 'ACTIVE'
  `).run(
    record.direction,
    Date.now(),
    entryPrice,
    recalculated.stop,
    recalculated.tp1,
    recalculated.tp2,
    record.signalId
  );
  
  console.log(`[delayed-entry] Executed entry for signal ${record.signalId} at ${entryPrice.toFixed(4)}`);
  if (recalculated.tp1) {
    console.log(`[delayed-entry] Recalculated: Stop=${recalculated.stop?.toFixed(4)}, TP1=${recalculated.tp1?.toFixed(4)}, TP2=${recalculated.tp2?.toFixed(4)}`);
  }
  
  // Trigger immediate re-evaluation with confirmed entry price
  // This ensures MFE/MAE and outcomes are calculated from the actual entry, not signal price
  try {
    const { evaluateAndUpdateExtendedOutcome } = await import('./extendedOutcomeStore.js');
    const signal = await getDb().prepare('SELECT * FROM signals WHERE id = ?').get(record.signalId) as any;
    
    if (signal) {
      // Reset the outcome and re-evaluate from confirmed entry
      await getDb().prepare(`
        UPDATE extended_outcomes 
        SET status = 'PENDING',
            completed_at = NULL,
            max_favorable_excursion_pct = NULL,
            max_adverse_excursion_pct = NULL,
            first_tp1_at = NULL,
            tp2_at = NULL,
            stop_at = NULL,
            ext24_managed_r = NULL,
            ext24_managed_status = NULL
        WHERE signal_id = ?
      `).run(record.signalId);
      
      // Re-evaluate with confirmed entry price
      await evaluateAndUpdateExtendedOutcome({
        signalId: record.signalId,
        symbol: signal.symbol,
        category: signal.category,
        direction: signal.category.includes('SHORT') ? 'SHORT' : 'LONG',
        signalTime: signal.time,
        entryPrice: entryPrice,  // Use CONFIRMED price
        stopPrice: recalculated.stop,
        tp1Price: recalculated.tp1,
        tp2Price: recalculated.tp2,
      });
      
      console.log(`[delayed-entry] Re-evaluated signal ${record.signalId} with confirmed entry ${entryPrice}`);
    }
  } catch (e) {
    console.error(`[delayed-entry] Failed to re-evaluate signal ${record.signalId}:`, e);
  }
}

// ============================================================================
// TP/SL RECALCULATION (Option B)
// ============================================================================

function recalculateTpSl(
  confirmedEntry: number,
  originalEntry: number,
  originalStop: number | null,
  originalTp1: number | null,
  originalTp2: number | null,
  direction: 'LONG' | 'SHORT'
): { stop: number | null; tp1: number | null; tp2: number | null } {
  if (!originalStop) {
    return { stop: null, tp1: null, tp2: null };
  }
  
  // Calculate percentage distances from original entry
  const stopDistancePct = Math.abs((originalStop - originalEntry) / originalEntry);
  const tp1DistancePct = originalTp1 ? Math.abs((originalTp1 - originalEntry) / originalEntry) : null;
  const tp2DistancePct = originalTp2 ? Math.abs((originalTp2 - originalEntry) / originalEntry) : null;
  
  // Apply same distances to confirmed entry
  const stop = direction === 'LONG'
    ? confirmedEntry * (1 - stopDistancePct)
    : confirmedEntry * (1 + stopDistancePct);
  
  const tp1 = tp1DistancePct
    ? (direction === 'LONG'
        ? confirmedEntry * (1 + tp1DistancePct)
        : confirmedEntry * (1 - tp1DistancePct))
    : null;
  
  const tp2 = tp2DistancePct
    ? (direction === 'LONG'
        ? confirmedEntry * (1 + tp2DistancePct)
        : confirmedEntry * (1 - tp2DistancePct))
    : null;
  
  return { stop, tp1, tp2 };
}

// ============================================================================
// STATS & METRICS
// ============================================================================

export async function getDelayedEntryStats(): Promise<DelayedEntryStats> {
  const d = getDb();
  
  const result = await d.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'WATCH' THEN 1 ELSE 0 END) as watching,
      SUM(CASE WHEN status = 'ENTERED' THEN 1 ELSE 0 END) as entered,
      SUM(CASE WHEN status = 'EXPIRED_NO_ENTRY' THEN 1 ELSE 0 END) as expired,
      SUM(CASE WHEN status = 'SKIPPED_SPIKE' THEN 1 ELSE 0 END) as skipped,
      AVG(CASE WHEN status = 'ENTERED' THEN 
        ABS((confirmed_price - reference_price) / reference_price) * 100 
      END) as avgMovePct
    FROM delayed_entry_records
  `).get() as any;
  
  const watchCreated = Number(result.total || 0);
  const entered = Number(result.entered || 0);
  const expired = Number(result.expired || 0);
  const skipped = Number(result.skipped || 0);
  
  return {
    watchCreated,
    entered,
    expired,
    skippedSpike: skipped,
    confirmRate: watchCreated > 0 ? entered / watchCreated : 0,
    avgMoveToConfirm: result.avgMovePct ? Number(result.avgMovePct) : undefined,
  };
}

// ============================================================================
// REACTIVATION & REPROCESSING (for fixing watcher bugs)
// ============================================================================

export interface ReactivationResult {
  signalId: number;
  success: boolean;
  error?: string;
  newStatus?: string;
  newExpiresAt?: number;
}

/**
 * Reactivate an expired delayed entry signal
 * Creates full audit trail for transparency
 */
export async function reactivateDelayedEntry(
  signalId: number,
  options: {
    extendMinutes?: number;
    reactivatedBy?: string;
    reactivationReason?: string;
  } = {}
): Promise<ReactivationResult> {
  const d = getDb();
  const {
    extendMinutes = 1440, // Default 24 hours
    reactivatedBy = 'SYSTEM',
    reactivationReason = 'MANUAL_REACTIVATION'
  } = options;
  
  try {
    // Get current record
    const record = await getDelayedEntryRecordBySignalId(signalId);
    
    if (!record) {
      return { signalId, success: false, error: 'Record not found' };
    }
    
    // Only allow reactivation of EXPIRED_NO_ENTRY
    if (record.status !== 'EXPIRED_NO_ENTRY') {
      return { 
        signalId, 
        success: false, 
        error: `Cannot reactivate - status is ${record.status}, expected EXPIRED_NO_ENTRY` 
      };
    }
    
    // Check if within allowed window (7 days)
    const now = Date.now();
    const expiredAt = record.watchExpiresAt;
    const daysSinceExpiry = (now - expiredAt) / (24 * 60 * 60 * 1000);
    
    if (daysSinceExpiry > 7) {
      return { 
        signalId, 
        success: false, 
        error: `Cannot reactivate - expired ${daysSinceExpiry.toFixed(1)} days ago (max 7 days)` 
      };
    }
    
    const newExpiresAt = now + (extendMinutes * 60 * 1000);
    
    // Update with audit trail
    await d.prepare(`
      UPDATE delayed_entry_records
      SET status = 'WATCH',
          watch_expires_at = ?,
          prev_status = ?,
          prev_expires_at = ?,
          reactivated_at = ?,
          reactivated_by = ?,
          reactivation_reason = ?
      WHERE signal_id = ?
    `).run(
      newExpiresAt,
      record.status,
      record.watchExpiresAt,
      now,
      reactivatedBy,
      reactivationReason,
      signalId
    );
    
    console.log(`[delayed-entry] Reactivated signal ${signalId}: ${record.symbol} - expires at ${new Date(newExpiresAt).toISOString()}`);
    
    return {
      signalId,
      success: true,
      newStatus: 'WATCH',
      newExpiresAt
    };
    
  } catch (error) {
    console.error(`[delayed-entry] Reactivation error for ${signalId}:`, error);
    return { signalId, success: false, error: String(error) };
  }
}

/**
 * Bulk reprocess expired entries from a date range
 * Reactivates and triggers immediate evaluation
 */
export async function reprocessExpiredEntries(
  fromTime: number,
  toTime: number,
  options: {
    symbol?: string;
    batchSize?: number;
    extendMinutes?: number;
    reactivationReason?: string;
  } = {}
): Promise<{
  total: number;
  reactivated: number;
  failed: number;
  results: ReactivationResult[];
}> {
  const d = getDb();
  const { symbol, batchSize = 50, extendMinutes = 1440, reactivationReason = 'BULK_REPROCESS' } = options;
  
  // Build query
  let query = `
    SELECT signal_id
    FROM delayed_entry_records
    WHERE status = 'EXPIRED_NO_ENTRY'
      AND watch_expires_at >= ?
      AND watch_expires_at <= ?
  `;
  const params: any[] = [fromTime, toTime];
  
  if (symbol) {
    query += ' AND symbol = ?';
    params.push(symbol);
  }
  
  query += ` ORDER BY watch_expires_at DESC LIMIT ?`;
  params.push(batchSize);
  
  const rows = await d.prepare(query).all(...params) as any[];
  
  const results: ReactivationResult[] = [];
  let reactivated = 0;
  let failed = 0;
  
  // Rate limit: process one every 100ms to avoid hammering
  for (const row of rows) {
    const signalId = Number(row.signal_id);
    
    const result = await reactivateDelayedEntry(signalId, {
      extendMinutes,
      reactivatedBy: 'BULK_REPROCESS',
      reactivationReason
    });
    
    results.push(result);
    
    if (result.success) {
      reactivated++;
      
      // Trigger immediate re-evaluation
      try {
        const { evaluateAndUpdateExtendedOutcome } = await import('./extendedOutcomeStore.js');
        const signal = await d.prepare('SELECT * FROM signals WHERE id = ?').get(signalId) as any;
        
        if (signal) {
          await evaluateAndUpdateExtendedOutcome({
            signalId,
            symbol: signal.symbol,
            category: signal.category,
            direction: signal.category.includes('SHORT') ? 'SHORT' : 'LONG',
            signalTime: signal.time,
            entryPrice: signal.price,
            stopPrice: signal.stop_price,
            tp1Price: signal.tp1_price,
            tp2Price: signal.tp2_price,
          });
        }
      } catch (e) {
        console.error(`[delayed-entry] Re-evaluation error for ${signalId}:`, e);
      }
    } else {
      failed++;
    }
    
    // Rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  
  return {
    total: rows.length,
    reactivated,
    failed,
    results
  };
}

/**
 * Mark expired entries as invalid for stats
 * Used when watcher bugs cause false expiries
 */
export async function markExpiredAsInvalid(
  signalIds: number[],
  reason: string = 'WATCHER_BUG'
): Promise<{ marked: number; failed: number }> {
  const d = getDb();
  let marked = 0;
  let failed = 0;
  
  for (const signalId of signalIds) {
    try {
      const result = await d.prepare(`
        UPDATE delayed_entry_records
        SET invalid_for_stats = TRUE,
            expired_reason = COALESCE(?, expired_reason)
        WHERE signal_id = ? 
          AND status = 'EXPIRED_NO_ENTRY'
      `).run(reason, signalId);
      
      if (result.changes > 0) {
        marked++;
      } else {
        failed++;
      }
    } catch (e) {
      console.error(`[delayed-entry] Mark invalid error for ${signalId}:`, e);
      failed++;
    }
  }
  
  return { marked, failed };
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
  reason: 'CONFIRMED' | 'EXPIRED' | 'SKIPPED_SPIKE' | 'NO_CANDLES';
}> {
  const cfg = { ...DEFAULT_DELAYED_ENTRY_CONFIG, ...config };
  const direction = getDirectionFromCategory(signal.category);
  
  const signalTime = signal.time;
  const maxWaitTime = signalTime + (cfg.maxWaitMinutes * 60 * 1000);
  const targetMove = cfg.confirmMovePct / 100;
  const maxMove = (cfg.confirmMovePct + cfg.maxExtraMovePct) / 100;
  
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
    
    const maxPrice = direction === 'LONG'
      ? signal.price * (1 + maxMove)
      : signal.price * (1 - maxMove);
    
    // Check if moved too far (spike protection)
    const tooFar = direction === 'LONG'
      ? candle.high > maxPrice
      : candle.low < maxPrice;
    
    if (tooFar) {
      return { 
        wouldEnter: false, 
        reason: 'SKIPPED_SPIKE',
        entryTime: candle.time,
        movePct: Math.abs((candle.close - signal.price) / signal.price) * 100
      };
    }
    
    // Check if confirmed
    const hit = direction === 'LONG'
      ? candle.high >= confirmPrice
      : candle.low <= confirmPrice;
    
    if (hit) {
      const entryPrice = confirmPrice;
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

// ============================================================================
// HELPERS
// ============================================================================

function getDirectionFromCategory(category: string): 'LONG' | 'SHORT' {
  const shortCategories = ['READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT'];
  return shortCategories.includes(category.toUpperCase()) ? 'SHORT' : 'LONG';
}
