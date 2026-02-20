/**
 * Extended Outcome Store (24h)
 * 
 * This module provides a separate evaluation flow for extended period outcomes (24h max).
 * It evaluates whether each signal eventually hits Stop Loss / TP1 / TP2 within 24 hours.
 * 
 * Key behaviors:
 * - STOP hit completes the signal immediately (final outcome = LOSS_STOP)
 * - TP1 hit marks intermediate state ACHIEVED_TP1, continues tracking
 * - If TP2 hits later (before 24h), final outcome becomes WIN_TP2
 * - If TP2 never hits by 24h, final outcome remains WIN_TP1
 * - If neither stop nor TP1 is hit by 24h, final outcome = FLAT_TIMEOUT_24H
 * - Same-candle ambiguity: STOP wins if both touched in same candle (conservative)
 */

import type { Signal, OHLCV } from './types.js';
import { klinesFrom, klinesRange } from './binance.js';
import { getDb } from './db/db.js';

// Constants
const EXTENDED_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const EVALUATION_INTERVAL_MIN = 5; // Use 5m candles for evaluation
const EVALUATION_INTERVAL_MS = EVALUATION_INTERVAL_MIN * 60 * 1000;

// Status enum for extended outcomes
export type ExtendedOutcomeStatus =
  | 'PENDING'
  | 'ACHIEVED_TP1'
  | 'LOSS_STOP'
  | 'WIN_TP1'
  | 'WIN_TP2'
  | 'FLAT_TIMEOUT_24H';

// Direction type
export type SignalDirection = 'LONG' | 'SHORT';

// Extended outcome record interface
export interface ExtendedOutcome {
  id: number;
  signalId: number;
  symbol: string;
  category: string;
  direction: SignalDirection;
  
  // Time tracking
  signalTime: number;
  startedAt: number;
  expiresAt: number;
  completedAt: number | null;
  
  // Trade plan levels
  entryPrice: number;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  
  // Status
  status: ExtendedOutcomeStatus;
  
  // Hit tracking
  firstTp1At: number | null;
  tp2At: number | null;
  stopAt: number | null;
  
  // Timing metrics
  timeToFirstHitSeconds: number | null;
  timeToTp1Seconds: number | null;
  timeToTp2Seconds: number | null;
  timeToStopSeconds: number | null;
  
  // Performance metrics
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  coveragePct: number;
  
  // Metadata
  nCandlesEvaluated: number;
  nCandlesExpected: number;
  lastEvaluatedAt: number;
  resolveVersion: string;
  
  // Debug info (stored as JSON)
  debugJson: string | null;
}

// Input for creating/updating extended outcome
export interface ExtendedOutcomeInput {
  signalId: number;
  symbol: string;
  category: string;
  direction: SignalDirection;
  signalTime: number;
  entryPrice: number;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
}

// Evaluation result
interface EvaluationResult {
  status: ExtendedOutcomeStatus;
  completed: boolean;
  firstTp1At: number | null;
  tp2At: number | null;
  stopAt: number | null;
  timeToFirstHitSeconds: number | null;
  timeToTp1Seconds: number | null;
  timeToTp2Seconds: number | null;
  timeToStopSeconds: number | null;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  coveragePct: number;
  nCandlesEvaluated: number;
  nCandlesExpected: number;
  debug: EvaluationDebug;
}

interface EvaluationDebug {
  candlesProcessed: number;
  stopHitCandleIndex: number | null;
  tp1HitCandleIndex: number | null;
  tp2HitCandleIndex: number | null;
  sameCandleConflicts: Array<{
    candleIndex: number;
    candleTime: number;
    stopHit: boolean;
    tp1Hit: boolean;
    tp2Hit: boolean;
    resolution: 'STOP_WINS' | 'TP2_WINS' | 'TP1_WINS';
  }>;
}

const RESOLVE_VERSION = 'v1.0.0';

let schemaReady = false;

/**
 * Ensure extended outcomes table exists
 * Supports both SQLite and PostgreSQL
 */
async function ensureSchema(): Promise<void> {
  const d = getDb();
  if (schemaReady) return;

  const isSQLite = d.driver === 'sqlite';

  try {
    if (isSQLite) {
      await d.exec(`
        CREATE TABLE IF NOT EXISTS extended_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          signal_id INTEGER NOT NULL UNIQUE,
          symbol TEXT NOT NULL,
          category TEXT NOT NULL,
          direction TEXT NOT NULL DEFAULT 'LONG',
          
          signal_time INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          completed_at INTEGER,
          
          entry_price REAL NOT NULL,
          stop_price REAL,
          tp1_price REAL,
          tp2_price REAL,
          
          status TEXT NOT NULL DEFAULT 'PENDING',
          
          first_tp1_at INTEGER,
          tp2_at INTEGER,
          stop_at INTEGER,
          
          time_to_first_hit_seconds INTEGER,
          time_to_tp1_seconds INTEGER,
          time_to_tp2_seconds INTEGER,
          time_to_stop_seconds INTEGER,
          
          max_favorable_excursion_pct REAL,
          max_adverse_excursion_pct REAL,
          coverage_pct REAL NOT NULL DEFAULT 0,
          
          n_candles_evaluated INTEGER NOT NULL DEFAULT 0,
          n_candles_expected INTEGER NOT NULL DEFAULT 0,
          last_evaluated_at INTEGER NOT NULL DEFAULT 0,
          resolve_version TEXT,
          
          debug_json TEXT,
          
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
          
          FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_signal_id ON extended_outcomes(signal_id);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_status ON extended_outcomes(status);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_symbol ON extended_outcomes(symbol);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_category ON extended_outcomes(category);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_signal_time ON extended_outcomes(signal_time);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_completed_at ON extended_outcomes(completed_at);
      `);
    } else {
      // PostgreSQL
      await d.exec(`
        CREATE TABLE IF NOT EXISTS extended_outcomes (
          id SERIAL PRIMARY KEY,
          signal_id BIGINT NOT NULL UNIQUE,
          symbol TEXT NOT NULL,
          category TEXT NOT NULL,
          direction TEXT NOT NULL DEFAULT 'LONG',
          
          signal_time BIGINT NOT NULL,
          started_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          completed_at BIGINT,
          
          entry_price DOUBLE PRECISION NOT NULL,
          stop_price DOUBLE PRECISION,
          tp1_price DOUBLE PRECISION,
          tp2_price DOUBLE PRECISION,
          
          status TEXT NOT NULL DEFAULT 'PENDING',
          
          first_tp1_at BIGINT,
          tp2_at BIGINT,
          stop_at BIGINT,
          
          time_to_first_hit_seconds INTEGER,
          time_to_tp1_seconds INTEGER,
          time_to_tp2_seconds INTEGER,
          time_to_stop_seconds INTEGER,
          
          max_favorable_excursion_pct DOUBLE PRECISION,
          max_adverse_excursion_pct DOUBLE PRECISION,
          coverage_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
          
          n_candles_evaluated INTEGER NOT NULL DEFAULT 0,
          n_candles_expected INTEGER NOT NULL DEFAULT 0,
          last_evaluated_at BIGINT NOT NULL DEFAULT 0,
          resolve_version TEXT,
          
          debug_json TEXT,
          
          created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
          updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
          
          FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_signal_id ON extended_outcomes(signal_id);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_status ON extended_outcomes(status);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_symbol ON extended_outcomes(symbol);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_category ON extended_outcomes(category);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_signal_time ON extended_outcomes(signal_time);
        CREATE INDEX IF NOT EXISTS idx_extended_outcomes_completed_at ON extended_outcomes(completed_at);
      `);
    }

    schemaReady = true;
    console.log('[extended-outcomes] Schema ensured successfully');
  } catch (e) {
    console.error('[extended-outcomes] Schema creation failed:', e);
    throw e;
  }
}

/**
 * Determine signal direction from category
 */
export function getSignalDirection(category: string): SignalDirection {
  const shortCategories = ['READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT'];
  return shortCategories.includes(category.toUpperCase()) ? 'SHORT' : 'LONG';
}

/**
 * Check if stop is hit for a candle (direction-aware)
 */
function isStopHit(
  direction: SignalDirection,
  candle: OHLCV,
  stopPrice: number
): boolean {
  if (direction === 'LONG') {
    return candle.low <= stopPrice;
  } else {
    return candle.high >= stopPrice;
  }
}

/**
 * Check if TP1 is hit for a candle (direction-aware)
 */
function isTp1Hit(
  direction: SignalDirection,
  candle: OHLCV,
  tp1Price: number
): boolean {
  if (direction === 'LONG') {
    return candle.high >= tp1Price;
  } else {
    return candle.low <= tp1Price;
  }
}

/**
 * Check if TP2 is hit for a candle (direction-aware)
 */
function isTp2Hit(
  direction: SignalDirection,
  candle: OHLCV,
  tp2Price: number
): boolean {
  if (direction === 'LONG') {
    return candle.high >= tp2Price;
  } else {
    return candle.low <= tp2Price;
  }
}

/**
 * Calculate MFE/MAE percentages (direction-aware)
 */
function calculateExcursions(
  direction: SignalDirection,
  entryPrice: number,
  candles: OHLCV[]
): { mfePct: number; maePct: number } {
  if (!candles.length || !Number.isFinite(entryPrice) || entryPrice === 0) {
    return { mfePct: 0, maePct: 0 };
  }

  let maxHigh = -Infinity;
  let minLow = Infinity;

  for (const candle of candles) {
    if (Number.isFinite(candle.high)) maxHigh = Math.max(maxHigh, candle.high);
    if (Number.isFinite(candle.low)) minLow = Math.min(minLow, candle.low);
  }

  if (direction === 'LONG') {
    const mfe = ((maxHigh - entryPrice) / entryPrice) * 100;
    const mae = ((entryPrice - minLow) / entryPrice) * 100;
    return { mfePct: mfe, maePct: mae };
  } else {
    const mfe = ((entryPrice - minLow) / entryPrice) * 100;
    const mae = ((maxHigh - entryPrice) / entryPrice) * 100;
    return { mfePct: mfe, maePct: mae };
  }
}

/**
 * Evaluate extended 24h outcome for a signal
 * 
 * Core logic:
 * 1. Load candles from signal_time to signal_time + 24h
 * 2. Iterate candle-by-candle
 * 3. Check for STOP hit (completes immediately)
 * 4. Check for TP1 hit (intermediate state, continue tracking)
 * 5. Check for TP2 hit after TP1 (completes as WIN_TP2)
 * 6. Handle same-candle ambiguity (STOP wins)
 * 7. If 24h expires without hits, mark FLAT_TIMEOUT_24H
 */
export async function evaluateExtended24hOutcome(
  signal: ExtendedOutcomeInput,
  candles?: OHLCV[]
): Promise<EvaluationResult> {
  const {
    signalId,
    signalTime,
    entryPrice,
    stopPrice,
    tp1Price,
    tp2Price,
    direction,
  } = signal;

  const expiresAt = signalTime + EXTENDED_WINDOW_MS;
  const now = Date.now();

  // Load candles if not provided
  let evaluationCandles: OHLCV[];
  if (candles && candles.length > 0) {
    evaluationCandles = candles.filter(c => c.time >= signalTime && c.time <= expiresAt);
  } else {
    evaluationCandles = await klinesRange(
      signal.symbol,
      `${EVALUATION_INTERVAL_MIN}m`,
      signalTime,
      Math.min(expiresAt, now),
      1000
    );
  }

  // Expected candle count
  const expectedCandles = Math.floor(EXTENDED_WINDOW_MS / EVALUATION_INTERVAL_MS);
  const actualCandles = evaluationCandles.length;
  const coveragePct = expectedCandles > 0 ? (actualCandles / expectedCandles) * 100 : 0;

  // Sort candles by time
  evaluationCandles.sort((a, b) => a.time - b.time);

  // Initialize tracking
  let status: ExtendedOutcomeStatus = 'PENDING';
  let completed = false;
  let firstTp1At: number | null = null;
  let tp2At: number | null = null;
  let stopAt: number | null = null;
  let tp1HitIndex: number | null = null;
  let tp2HitIndex: number | null = null;
  let stopHitIndex: number | null = null;

  const debug: EvaluationDebug = {
    candlesProcessed: actualCandles,
    stopHitCandleIndex: null,
    tp1HitCandleIndex: null,
    tp2HitCandleIndex: null,
    sameCandleConflicts: [],
  };

  // Need at least stop and tp1 to evaluate
  const hasStop = Number.isFinite(stopPrice) && stopPrice !== null && stopPrice > 0;
  const hasTp1 = Number.isFinite(tp1Price) && tp1Price !== null && tp1Price > 0;
  const hasTp2 = Number.isFinite(tp2Price) && tp2Price !== null && tp2Price > 0;

  // Iterate through candles
  for (let i = 0; i < evaluationCandles.length; i++) {
    const candle = evaluationCandles[i];

    // Skip candles before signal time
    if (candle.time < signalTime) continue;

    // Check for hits
    const stopHit = hasStop ? isStopHit(direction, candle, stopPrice!) : false;
    const tp1Hit = hasTp1 ? isTp1Hit(direction, candle, tp1Price!) : false;
    const tp2Hit = hasTp2 ? isTp2Hit(direction, candle, tp2Price!) : false;

    // Same-candle ambiguity detection
    const multipleHits = [stopHit, tp1Hit, tp2Hit].filter(Boolean).length > 1;
    if (multipleHits) {
      // CONSERVATIVE RULE: STOP wins if both touched in same candle
      // This is the safest approach when we don't have higher-resolution data
      const resolution = stopHit ? 'STOP_WINS' : tp2Hit ? 'TP2_WINS' : 'TP1_WINS';
      debug.sameCandleConflicts.push({
        candleIndex: i,
        candleTime: candle.time,
        stopHit,
        tp1Hit,
        tp2Hit,
        resolution,
      });

      if (stopHit) {
        // STOP wins - complete as loss
        stopAt = candle.time;
        stopHitIndex = i;
        status = 'LOSS_STOP';
        completed = true;
        break;
      } else if (tp2Hit && firstTp1At !== null) {
        // TP2 hit after TP1 - complete as win
        tp2At = candle.time;
        tp2HitIndex = i;
        status = 'WIN_TP2';
        completed = true;
        break;
      } else if (tp1Hit) {
        // TP1 hit (TP2 not hit or not valid)
        if (firstTp1At === null) {
          firstTp1At = candle.time;
          tp1HitIndex = i;
          status = 'ACHIEVED_TP1';
        }
      }
    } else {
      // No ambiguity - handle single hit
      if (stopHit) {
        stopAt = candle.time;
        stopHitIndex = i;
        status = 'LOSS_STOP';
        completed = true;
        break;
      }

      if (tp2Hit && firstTp1At !== null) {
        tp2At = candle.time;
        tp2HitIndex = i;
        status = 'WIN_TP2';
        completed = true;
        break;
      }

      if (tp1Hit) {
        if (firstTp1At === null) {
          firstTp1At = candle.time;
          tp1HitIndex = i;
          status = 'ACHIEVED_TP1';
        }
      }
    }
  }

  // Handle timeout (24h expired)
  const windowExpired = now >= expiresAt;
  const noMoreCandles = evaluationCandles.length > 0 && 
    evaluationCandles[evaluationCandles.length - 1].time >= expiresAt;

  if (!completed && (windowExpired || noMoreCandles)) {
    completed = true;
    if (firstTp1At !== null) {
      // TP1 hit but TP2 not hit within 24h
      status = 'WIN_TP1';
    } else {
      // No hits within 24h
      status = 'FLAT_TIMEOUT_24H';
    }
  }

  // Update debug info
  debug.stopHitCandleIndex = stopHitIndex;
  debug.tp1HitCandleIndex = tp1HitIndex;
  debug.tp2HitCandleIndex = tp2HitIndex;

  // Calculate timing metrics
  const timeToTp1Seconds = firstTp1At !== null && firstTp1At >= signalTime
    ? Math.floor((firstTp1At - signalTime) / 1000)
    : null;
  const timeToTp2Seconds = tp2At !== null && tp2At >= signalTime
    ? Math.floor((tp2At - signalTime) / 1000)
    : null;
  const timeToStopSeconds = stopAt !== null && stopAt >= signalTime
    ? Math.floor((stopAt - signalTime) / 1000)
    : null;

  // Time to first hit (any hit)
  const hitTimes = [firstTp1At, tp2At, stopAt].filter((t): t is number => t !== null);
  const firstHitTime = hitTimes.length > 0 ? Math.min(...hitTimes) : null;
  const timeToFirstHitSeconds = firstHitTime !== null
    ? Math.floor((firstHitTime - signalTime) / 1000)
    : null;

  // Calculate excursions
  const { mfePct, maePct } = calculateExcursions(direction, entryPrice, evaluationCandles);

  return {
    status,
    completed,
    firstTp1At,
    tp2At,
    stopAt,
    timeToTp1Seconds,
    timeToTp2Seconds,
    timeToStopSeconds,
    timeToFirstHitSeconds,
    maxFavorableExcursionPct: mfePct,
    maxAdverseExcursionPct: maePct,
    coveragePct,
    nCandlesEvaluated: actualCandles,
    nCandlesExpected: expectedCandles,
    debug,
  };
}

/**
 * Get or create extended outcome record for a signal
 */
export async function getOrCreateExtendedOutcome(
  signal: ExtendedOutcomeInput
): Promise<{ outcome: ExtendedOutcome | null; created: boolean }> {
  await ensureSchema();
  const d = getDb();

  // Check if exists
  const existing = await d.prepare(
    `SELECT * FROM extended_outcomes WHERE signal_id = ?`
  ).get(signal.signalId) as ExtendedOutcome | undefined;

  if (existing) {
    return { outcome: existing, created: false };
  }

  // Create new record
  const direction = getSignalDirection(signal.category);
  const expiresAt = signal.signalTime + EXTENDED_WINDOW_MS;

  const result = await d.prepare(`
    INSERT INTO extended_outcomes (
      signal_id, symbol, category, direction,
      signal_time, started_at, expires_at,
      entry_price, stop_price, tp1_price, tp2_price,
      status, coverage_pct, n_candles_expected,
      resolve_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)
  `).run(
    signal.signalId,
    signal.symbol,
    signal.category,
    direction,
    signal.signalTime,
    signal.signalTime,
    expiresAt,
    signal.entryPrice,
    signal.stopPrice,
    signal.tp1Price,
    signal.tp2Price,
    Math.floor(EXTENDED_WINDOW_MS / EVALUATION_INTERVAL_MS),
    RESOLVE_VERSION
  );

  const newOutcome = await d.prepare(
    `SELECT * FROM extended_outcomes WHERE id = ?`
  ).get((result as any).lastID) as ExtendedOutcome;

  return { outcome: newOutcome, created: true };
}

/**
 * Update extended outcome with evaluation result
 */
export async function updateExtendedOutcome(
  signalId: number,
  result: EvaluationResult
): Promise<void> {
  await ensureSchema();
  const d = getDb();

  const now = Date.now();
  const completedAt = result.completed ? now : null;

  await d.prepare(`
    UPDATE extended_outcomes SET
      status = ?,
      completed_at = ?,
      first_tp1_at = ?,
      tp2_at = ?,
      stop_at = ?,
      time_to_first_hit_seconds = ?,
      time_to_tp1_seconds = ?,
      time_to_tp2_seconds = ?,
      time_to_stop_seconds = ?,
      max_favorable_excursion_pct = ?,
      max_adverse_excursion_pct = ?,
      coverage_pct = ?,
      n_candles_evaluated = ?,
      last_evaluated_at = ?,
      debug_json = ?,
      updated_at = ?
    WHERE signal_id = ?
  `).run(
    result.status,
    completedAt,
    result.firstTp1At,
    result.tp2At,
    result.stopAt,
    result.timeToFirstHitSeconds,
    result.timeToTp1Seconds,
    result.timeToTp2Seconds,
    result.timeToStopSeconds,
    result.maxFavorableExcursionPct,
    result.maxAdverseExcursionPct,
    result.coveragePct,
    result.nCandlesEvaluated,
    now,
    JSON.stringify(result.debug),
    now,
    signalId
  );
}

/**
 * Evaluate and update extended outcome for a signal (idempotent)
 */
export async function evaluateAndUpdateExtendedOutcome(
  signal: ExtendedOutcomeInput,
  candles?: OHLCV[]
): Promise<EvaluationResult> {
  // Get or create record
  const { outcome } = await getOrCreateExtendedOutcome(signal);
  
  if (!outcome) {
    throw new Error(`Failed to get or create extended outcome for signal ${signal.signalId}`);
  }

  // Skip if already completed
  if (outcome.completedAt !== null && outcome.completedAt > 0) {
    return {
      status: outcome.status,
      completed: true,
      firstTp1At: outcome.firstTp1At,
      tp2At: outcome.tp2At,
      stopAt: outcome.stopAt,
      timeToTp1Seconds: outcome.timeToTp1Seconds,
      timeToTp2Seconds: outcome.timeToTp2Seconds,
      timeToStopSeconds: outcome.timeToStopSeconds,
      timeToFirstHitSeconds: outcome.timeToFirstHitSeconds,
      maxFavorableExcursionPct: outcome.maxFavorableExcursionPct ?? 0,
      maxAdverseExcursionPct: outcome.maxAdverseExcursionPct ?? 0,
      coveragePct: outcome.coveragePct,
      nCandlesEvaluated: outcome.nCandlesEvaluated,
      nCandlesExpected: outcome.nCandlesExpected,
      debug: { candlesProcessed: 0, stopHitCandleIndex: null, tp1HitCandleIndex: null, tp2HitCandleIndex: null, sameCandleConflicts: [] },
    };
  }

  // Evaluate
  const result = await evaluateExtended24hOutcome(signal, candles);

  // Update record
  await updateExtendedOutcome(signal.signalId, result);

  return result;
}

/**
 * List extended outcomes with filtering
 */
export async function listExtendedOutcomes(params: {
  start?: number;
  end?: number;
  symbol?: string;
  category?: string;
  status?: ExtendedOutcomeStatus;
  direction?: SignalDirection;
  completed?: boolean;
  limit?: number;
  offset?: number;
  sort?: 'time_desc' | 'time_asc' | 'completed_desc';
}): Promise<{ rows: ExtendedOutcome[]; total: number }> {
  await ensureSchema();
  const d = getDb();

  const {
    start,
    end,
    symbol,
    category,
    status,
    direction,
    completed,
    limit = 100,
    offset = 0,
    sort = 'time_desc',
  } = params;

  // Build WHERE clause
  const conditions: string[] = [];
  const values: any[] = [];

  if (start !== undefined) {
    conditions.push('eo.signal_time >= ?');
    values.push(start);
  }
  if (end !== undefined) {
    conditions.push('eo.signal_time <= ?');
    values.push(end);
  }
  if (symbol) {
    conditions.push('eo.symbol = ?');
    values.push(symbol.toUpperCase());
  }
  if (category) {
    conditions.push('eo.category = ?');
    values.push(category);
  }
  if (status) {
    conditions.push('eo.status = ?');
    values.push(status);
  }
  if (direction) {
    conditions.push('eo.direction = ?');
    values.push(direction);
  }
  if (completed !== undefined) {
    conditions.push(completed ? 'eo.completed_at IS NOT NULL' : 'eo.completed_at IS NULL');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countRow = await d.prepare(`
    SELECT COUNT(*) as total FROM extended_outcomes eo ${whereClause}
  `).get(...values) as { total: number };

  // Sort mapping
  const sortClause = {
    time_desc: 'ORDER BY eo.signal_time DESC',
    time_asc: 'ORDER BY eo.signal_time ASC',
    completed_desc: 'ORDER BY eo.completed_at DESC NULLS LAST',
  }[sort];

  // Fetch rows
  const rows = await d.prepare(`
    SELECT 
      eo.*,
      s.price as signal_price,
      s.stop as signal_stop,
      s.tp1 as signal_tp1,
      s.tp2 as signal_tp2
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    ${whereClause}
    ${sortClause}
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset) as ExtendedOutcome[];

  return { rows, total: countRow.total };
}

/**
 * Get summary statistics for extended outcomes
 */
export async function getExtendedOutcomeStats(params: {
  start?: number;
  end?: number;
  symbol?: string;
  category?: string;
  direction?: SignalDirection;
}): Promise<{
  totalSignals: number;
  completed: number;
  pending: number;
  winTp2: number;
  winTp1: number;
  lossStop: number;
  flatTimeout: number;
  achievedTp1: number;
  winRate: number;
  avgTimeToTp1Seconds: number | null;
  avgTimeToTp2Seconds: number | null;
  avgTimeToStopSeconds: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
}> {
  await ensureSchema();
  const d = getDb();

  const { start, end, symbol, category, direction } = params;

  // Build WHERE clause
  const conditions: string[] = [];
  const values: any[] = [];

  if (start !== undefined) {
    conditions.push('eo.signal_time >= ?');
    values.push(start);
  }
  if (end !== undefined) {
    conditions.push('eo.signal_time <= ?');
    values.push(end);
  }
  if (symbol) {
    conditions.push('eo.symbol = ?');
    values.push(symbol.toUpperCase());
  }
  if (category) {
    conditions.push('eo.category = ?');
    values.push(category);
  }
  if (direction) {
    conditions.push('eo.direction = ?');
    values.push(direction);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const stats = await d.prepare(`
    SELECT
      COUNT(*) as total_signals,
      SUM(CASE WHEN eo.completed_at IS NOT NULL THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN eo.completed_at IS NULL THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN eo.status = 'WIN_TP2' THEN 1 ELSE 0 END) as win_tp2,
      SUM(CASE WHEN eo.status = 'WIN_TP1' THEN 1 ELSE 0 END) as win_tp1,
      SUM(CASE WHEN eo.status = 'LOSS_STOP' THEN 1 ELSE 0 END) as loss_stop,
      SUM(CASE WHEN eo.status = 'FLAT_TIMEOUT_24H' THEN 1 ELSE 0 END) as flat_timeout,
      SUM(CASE WHEN eo.status = 'ACHIEVED_TP1' THEN 1 ELSE 0 END) as achieved_tp1,
      AVG(eo.time_to_tp1_seconds) as avg_time_to_tp1,
      AVG(eo.time_to_tp2_seconds) as avg_time_to_tp2,
      AVG(eo.time_to_stop_seconds) as avg_time_to_stop,
      AVG(eo.max_favorable_excursion_pct) as avg_mfe_pct,
      AVG(eo.max_adverse_excursion_pct) as avg_mae_pct
    FROM extended_outcomes eo
    ${whereClause}
  `).get(...values) as {
    total_signals: number;
    completed: number;
    pending: number;
    win_tp2: number;
    win_tp1: number;
    loss_stop: number;
    flat_timeout: number;
    achieved_tp1: number;
    avg_time_to_tp1: number | null;
    avg_time_to_tp2: number | null;
    avg_time_to_stop: number | null;
    avg_mfe_pct: number | null;
    avg_mae_pct: number | null;
  };

  const completedCount = Number(stats.completed) || 0;
  const wins = (Number(stats.win_tp2) || 0) + (Number(stats.win_tp1) || 0);
  const winRate = completedCount > 0 ? wins / completedCount : 0;

  return {
    totalSignals: Number(stats.total_signals) || 0,
    completed: completedCount,
    pending: Number(stats.pending) || 0,
    winTp2: Number(stats.win_tp2) || 0,
    winTp1: Number(stats.win_tp1) || 0,
    lossStop: Number(stats.loss_stop) || 0,
    flatTimeout: Number(stats.flat_timeout) || 0,
    achievedTp1: Number(stats.achieved_tp1) || 0,
    winRate,
    avgTimeToTp1Seconds: stats.avg_time_to_tp1,
    avgTimeToTp2Seconds: stats.avg_time_to_tp2,
    avgTimeToStopSeconds: stats.avg_time_to_stop,
    avgMfePct: stats.avg_mfe_pct,
    avgMaePct: stats.avg_mae_pct,
  };
}

/**
 * Get pending signals that need evaluation
 */
export async function getPendingExtendedOutcomes(limit = 50): Promise<ExtendedOutcome[]> {
  await ensureSchema();
  const d = getDb();

  const rows = await d.prepare(`
    SELECT eo.*, s.price as signal_price, s.stop as signal_stop, s.tp1 as signal_tp1, s.tp2 as signal_tp2
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    WHERE eo.completed_at IS NULL
      AND eo.expires_at <= ?
    ORDER BY eo.signal_time ASC
    LIMIT ?
  `).all(Date.now() + EXTENDED_WINDOW_MS, limit) as ExtendedOutcome[];

  return rows;
}

/**
 * Backfill extended outcomes for existing signals without records
 */
export async function backfillExtendedOutcomes(
  sinceMs: number,
  batchSize = 50
): Promise<{ processed: number; errors: number }> {
  await ensureSchema();
  const d = getDb();

  const signals = await d.prepare(`
    SELECT s.id, s.symbol, s.category, s.time, s.price, s.stop, s.tp1, s.tp2
    FROM signals s
    LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
    WHERE s.time >= ?
      AND eo.id IS NULL
    ORDER BY s.time DESC
    LIMIT ?
  `).all(sinceMs, batchSize) as Array<{
    id: number;
    symbol: string;
    category: string;
    time: number;
    price: number;
    stop: number | null;
    tp1: number | null;
    tp2: number | null;
  }>;

  let processed = 0;
  let errors = 0;

  for (const signal of signals) {
    try {
      await getOrCreateExtendedOutcome({
        signalId: signal.id,
        symbol: signal.symbol,
        category: signal.category,
        direction: getSignalDirection(signal.category),
        signalTime: signal.time,
        entryPrice: signal.price,
        stopPrice: signal.stop,
        tp1Price: signal.tp1,
        tp2Price: signal.tp2,
      });
      processed++;
    } catch (e) {
      console.error(`[extended-outcomes] Backfill error for signal ${signal.id}:`, e);
      errors++;
    }
  }

  return { processed, errors };
}

/**
 * Re-evaluate all pending extended outcomes
 */
export async function reevaluatePendingExtendedOutcomes(
  limit = 25
): Promise<{ evaluated: number; completed: number; errors: number }> {
  await ensureSchema();
  const d = getDb();

  const pending = await d.prepare(`
    SELECT eo.*, s.price as signal_price
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    WHERE eo.completed_at IS NULL
    ORDER BY eo.last_evaluated_at ASC
    LIMIT ?
  `).all(limit) as ExtendedOutcome[];

  let evaluated = 0;
  let completed = 0;
  let errors = 0;

  for (const outcome of pending) {
    try {
      const signal: ExtendedOutcomeInput = {
        signalId: outcome.signalId,
        symbol: outcome.symbol,
        category: outcome.category,
        direction: outcome.direction as SignalDirection,
        signalTime: outcome.signalTime,
        entryPrice: outcome.entryPrice,
        stopPrice: outcome.stopPrice,
        tp1Price: outcome.tp1Price,
        tp2Price: outcome.tp2Price,
      };

      const result = await evaluateAndUpdateExtendedOutcome(signal);
      evaluated++;
      if (result.completed) completed++;
    } catch (e) {
      console.error(`[extended-outcomes] Re-evaluate error for signal ${outcome.signalId}:`, e);
      errors++;
    }
  }

  return { evaluated, completed, errors };
}

/**
 * Force re-evaluation of all extended outcomes in a date range
 */
export async function forceReevaluateRange(
  startMs: number,
  endMs: number
): Promise<{ reset: number }> {
  await ensureSchema();
  const d = getDb();

  const result = await d.prepare(`
    UPDATE extended_outcomes SET
      completed_at = NULL,
      status = 'PENDING',
      first_tp1_at = NULL,
      tp2_at = NULL,
      stop_at = NULL,
      time_to_first_hit_seconds = NULL,
      time_to_tp1_seconds = NULL,
      time_to_tp2_seconds = NULL,
      time_to_stop_seconds = NULL,
      max_favorable_excursion_pct = NULL,
      max_adverse_excursion_pct = NULL,
      coverage_pct = 0,
      n_candles_evaluated = 0,
      debug_json = NULL,
      updated_at = ?
    WHERE signal_time >= ? AND signal_time <= ?
  `).run(Date.now(), startMs, endMs);

  return { reset: result.changes || 0 };
}

/**
 * Get extended outcomes with 240m horizon comparison
 * Shows when a signal that was "no hit" at 240m actually hit later in 24h
 */
export async function listExtendedOutcomesWithComparison(params: {
  start?: number;
  end?: number;
  symbol?: string;
  category?: string;
  status?: ExtendedOutcomeStatus;
  direction?: SignalDirection;
  showImprovementsOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ rows: Array<ExtendedOutcome & { horizon240mResult: string | null; improved: boolean }>; total: number }> {
  await ensureSchema();
  const d = getDb();

  const {
    start,
    end,
    symbol,
    category,
    status,
    direction,
    showImprovementsOnly,
    limit = 100,
    offset = 0,
  } = params;

  // Build WHERE clause
  const conditions: string[] = [];
  const values: any[] = [];

  if (start !== undefined) {
    conditions.push('eo.signal_time >= ?');
    values.push(start);
  }
  if (end !== undefined) {
    conditions.push('eo.signal_time <= ?');
    values.push(end);
  }
  if (symbol) {
    conditions.push('eo.symbol = ?');
    values.push(symbol.toUpperCase());
  }
  if (category) {
    conditions.push('eo.category = ?');
    values.push(category);
  }
  if (status) {
    conditions.push('eo.status = ?');
    values.push(status);
  }
  if (direction) {
    conditions.push('eo.direction = ?');
    values.push(direction);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countRow = await d.prepare(`
    SELECT COUNT(*) as total FROM extended_outcomes eo ${whereClause}
  `).get(...values) as { total: number };

  // Fetch rows with 240m outcome joined
  const rows = await d.prepare(`
    SELECT 
      eo.*,
      o240.result as horizon_240m_result,
      o240.exit_reason as horizon_240m_exit_reason,
      CASE 
        WHEN o240.result = 'NONE' AND eo.status IN ('WIN_TP1', 'WIN_TP2') THEN 1
        WHEN o240.result = 'NONE' AND eo.status = 'LOSS_STOP' THEN 1
        WHEN o240.result = 'NONE' AND eo.status = 'ACHIEVED_TP1' THEN 1
        ELSE 0
      END as improved
    FROM extended_outcomes eo
    LEFT JOIN signal_outcomes o240 
      ON o240.signal_id = eo.signal_id 
      AND o240.horizon_min = 240
    ${whereClause}
    ${showImprovementsOnly ? 'HAVING improved = 1' : ''}
    ORDER BY eo.signal_time DESC
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset) as Array<ExtendedOutcome & { horizon_240m_result: string | null; horizon_240m_exit_reason: string | null; improved: number }>;

  const mappedRows = rows.map(r => ({
    ...r,
    horizon240mResult: r.horizon_240m_result,
    improved: Boolean(r.improved),
  }));

  return { rows: mappedRows, total: countRow.total };
}

/**
 * Get statistics about signals that improved from 240m to 24h
 */
export async function getImprovementStats(params: {
  start?: number;
  end?: number;
}): Promise<{
  totalSignals: number;
  noHitAt240m: number;
  laterHitTp1: number;
  laterHitTp2: number;
  laterHitStop: number;
  improvedWinRate: number;
}> {
  await ensureSchema();
  const d = getDb();
  const { start, end } = params;

  const conditions: string[] = [];
  const values: any[] = [];

  if (start !== undefined) {
    conditions.push('eo.signal_time >= ?');
    values.push(start);
  }
  if (end !== undefined) {
    conditions.push('eo.signal_time <= ?');
    values.push(end);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const stats = await d.prepare(`
    SELECT
      COUNT(*) as total_signals,
      SUM(CASE WHEN o240.result = 'NONE' THEN 1 ELSE 0 END) as no_hit_at_240m,
      SUM(CASE WHEN o240.result = 'NONE' AND eo.status = 'WIN_TP1' THEN 1 ELSE 0 END) as later_hit_tp1,
      SUM(CASE WHEN o240.result = 'NONE' AND eo.status = 'WIN_TP2' THEN 1 ELSE 0 END) as later_hit_tp2,
      SUM(CASE WHEN o240.result = 'NONE' AND eo.status = 'LOSS_STOP' THEN 1 ELSE 0 END) as later_hit_stop
    FROM extended_outcomes eo
    LEFT JOIN signal_outcomes o240 
      ON o240.signal_id = eo.signal_id 
      AND o240.horizon_min = 240
    ${whereClause}
  `).get(...values) as {
    total_signals: number;
    no_hit_at_240m: number;
    later_hit_tp1: number;
    later_hit_tp2: number;
    later_hit_stop: number;
  };

  const noHitAt240m = Number(stats.no_hit_at_240m) || 0;
  const laterHitTp1 = Number(stats.later_hit_tp1) || 0;
  const laterHitTp2 = Number(stats.later_hit_tp2) || 0;
  const improvedWins = laterHitTp1 + laterHitTp2;
  const improvedWinRate = noHitAt240m > 0 ? improvedWins / noHitAt240m : 0;

  return {
    totalSignals: Number(stats.total_signals) || 0,
    noHitAt240m,
    laterHitTp1,
    laterHitTp2,
    laterHitStop: Number(stats.later_hit_stop) || 0,
    improvedWinRate,
  };
}

// Export constants
export { EXTENDED_WINDOW_MS, EVALUATION_INTERVAL_MIN, RESOLVE_VERSION };
