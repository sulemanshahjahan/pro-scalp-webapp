/**
 * Outcome Analysis Module
 * 
 * Provides canonical bucket classification, early-window metrics,
 * symbol tiering, and filter backtesting for extended 24h outcomes.
 * 
 * This module follows the strict precedence rules from the action plan:
 * Step 0: Lock the bucket rules (no ambiguity)
 * Step 1: Add early-window features
 * Step 2: Re-run analysis with proper stats
 * Step 3: Build symbol gates
 * Step 4: Turn findings into filter sets
 */

import { getDb } from './db/db.js';

// ============================================================================
// TYPES
// ============================================================================

export type OutcomeBucket = 'WIN' | 'LOSS' | 'BE' | 'EXCLUDE' | 'PENDING';
export type DirectionBucket = 'LONG_WIN' | 'LONG_LOSS' | 'LONG_BE' | 'LONG_EXCLUDE' | 'LONG_PENDING' |
                               'SHORT_WIN' | 'SHORT_LOSS' | 'SHORT_BE' | 'SHORT_EXCLUDE' | 'SHORT_PENDING';
export type SymbolTier = 'GREEN' | 'YELLOW' | 'RED';
export type FilterSetId = 'A' | 'B' | 'C';

export interface OutcomeRow {
  signalId: number;
  symbol: string;
  category: string;
  direction: 'LONG' | 'SHORT';
  status: string;
  ext24ManagedStatus: string | null;
  ext24RealizedR: number | null;
  ext24ManagedR: number | null;
  timeToTp1Seconds: number | null;
  timeToStopSeconds: number | null;
  timeToTp2Seconds: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  mfe30mPct?: number | null;
  mae30mPct?: number | null;
  mfe60mPct?: number | null;
  mae60mPct?: number | null;
  tp1HitTime: number | null;
  signalTime: number;
  completedAt: number | null;
}

export interface BucketClassification {
  bucket: OutcomeBucket;
  directionBucket: DirectionBucket;
  reason: string;
}

export interface SymbolStats {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  totalSignals: number;
  wins: number;
  losses: number;
  breakeven: number;
  pending: number;
  winRate: number;
  avgRealizedR: number | null;
  medianRealizedR: number | null;
  tier: SymbolTier;
}

export interface BucketStats {
  bucket: OutcomeBucket;
  direction: 'LONG' | 'SHORT';
  count: number;
  avgTimeToTp1Seconds: number | null;
  medianTimeToTp1Seconds: number | null;
  q1TimeToTp1Seconds: number | null;
  q3TimeToTp1Seconds: number | null;
  avgTimeToStopSeconds: number | null;
  medianTimeToStopSeconds: number | null;
  avgMfePct: number | null;
  medianMfePct: number | null;
  avgMaePct: number | null;
  medianMaePct: number | null;
  avgMfe30mPct: number | null;
  medianMfe30mPct: number | null;
  avgMae30mPct: number | null;
  medianMae30mPct: number | null;
}

export interface FilterBacktestResult {
  filterId: FilterSetId;
  filterName: string;
  totalSignals: number;
  signalsKept: number;
  signalsFiltered: number;
  keepRate: number;
  winRateBefore: number;
  winRateAfter: number;
  avgRealizedRBefore: number;
  avgRealizedRAfter: number;
  medianRealizedRBefore: number;
  medianRealizedRAfter: number;
  maxLossStreakBefore: number;
  maxLossStreakAfter: number;
}

// ============================================================================
// STEP 0: CANONICAL BUCKET MAPPING
// ============================================================================

/**
 * Classify an outcome into canonical buckets using strict precedence:
 * 
 * (A) EXCLUDE:
 *   - status == "PENDING" AND (ext24ManagedStatus is null OR ext24ManagedStatus == "PENDING")
 * 
 * (B) LOSS:
 *   - ext24ManagedStatus == "CLOSED_STOP" OR status == "LOSS_STOP"
 * 
 * (C) WIN:
 *   - status in ("WIN_TP2", "ACHIEVED_TP1") → WIN
 *   - OR ext24ManagedStatus == "CLOSED_TP2" → WIN
 *   - OR ext24ManagedStatus == "PARTIAL_TP1_OPEN" AND ext24RealizedR > 0 → WIN
 * 
 * (D) BE (Breakeven/Partial):
 *   - ext24ManagedStatus == "CLOSED_BE_AFTER_TP1" → BE
 */
export function classifyOutcome(
  status: string,
  ext24ManagedStatus: string | null,
  ext24RealizedR: number | null,
  direction: 'LONG' | 'SHORT'
): BucketClassification {
  const s = String(status || '').toUpperCase();
  const ms = ext24ManagedStatus ? String(ext24ManagedStatus).toUpperCase() : null;
  const r = ext24RealizedR ?? 0;

  // (A) EXCLUDE - Pending with no managed status
  if (s === 'PENDING' && (!ms || ms === 'PENDING')) {
    return {
      bucket: 'EXCLUDE',
      directionBucket: `${direction}_EXCLUDE` as DirectionBucket,
      reason: 'PENDING_NO_MANAGED_STATUS'
    };
  }

  // (B) LOSS - Stop hit
  if (ms === 'CLOSED_STOP' || s === 'LOSS_STOP') {
    return {
      bucket: 'LOSS',
      directionBucket: `${direction}_LOSS` as DirectionBucket,
      reason: 'STOP_HIT'
    };
  }

  // (C) WIN - TP2 hit or positive realized R
  if (s === 'WIN_TP2' || s === 'ACHIEVED_TP1') {
    return {
      bucket: 'WIN',
      directionBucket: `${direction}_WIN` as DirectionBucket,
      reason: s === 'WIN_TP2' ? 'TP2_HIT' : 'TP1_ACHIEVED'
    };
  }
  
  if (ms === 'CLOSED_TP2') {
    return {
      bucket: 'WIN',
      directionBucket: `${direction}_WIN` as DirectionBucket,
      reason: 'MANAGED_TP2'
    };
  }

  if (ms === 'PARTIAL_TP1_OPEN' && r > 0) {
    return {
      bucket: 'WIN',
      directionBucket: `${direction}_WIN` as DirectionBucket,
      reason: 'PARTIAL_POSITIVE'
    };
  }

  // (D) BE - Breakeven after TP1
  if (ms === 'CLOSED_BE_AFTER_TP1') {
    return {
      bucket: 'BE',
      directionBucket: `${direction}_BE` as DirectionBucket,
      reason: 'BE_AFTER_TP1'
    };
  }

  // Default: Check if we have a positive realized R to classify as WIN
  if (r > 0) {
    return {
      bucket: 'WIN',
      directionBucket: `${direction}_WIN` as DirectionBucket,
      reason: 'POSITIVE_REALIZED_R'
    };
  }

  // Check if we have a negative realized R to classify as LOSS
  if (r < 0) {
    return {
      bucket: 'LOSS',
      directionBucket: `${direction}_LOSS` as DirectionBucket,
      reason: 'NEGATIVE_REALIZED_R'
    };
  }

  // Everything else is pending/exclude
  return {
    bucket: 'PENDING',
    directionBucket: `${direction}_PENDING` as DirectionBucket,
    reason: 'UNKNOWN_STATUS'
  };
}

/**
 * Get signal direction from category
 */
export function getDirectionFromCategory(category: string): 'LONG' | 'SHORT' {
  const shortCategories = ['READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT'];
  return shortCategories.includes(category.toUpperCase()) ? 'SHORT' : 'LONG';
}

// ============================================================================
// STEP 1: EARLY-WINDOW FEATURES
// ============================================================================

const THIRTY_MIN_MS = 30 * 60 * 1000;
const SIXTY_MIN_MS = 60 * 60 * 1000;

export interface EarlyWindowMetrics {
  mfe30mPct: number;
  mae30mPct: number;
  mfe60mPct: number;
  mae60mPct: number;
  mfeMaeRatio30m: number;
  firstHit30m: boolean;
  firstHit60m: boolean;
  tp1Within35m: boolean;
  tp1Within45m: boolean;
  stopWithin30m: boolean;
}

/**
 * Calculate early-window metrics from candle data
 * This computes MFE/MAE over first X minutes from entry
 */
export function calculateEarlyWindowMetrics(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  candles: Array<{ time: number; high: number; low: number }>,
  entryTime: number
): EarlyWindowMetrics {
  if (!candles.length || !Number.isFinite(entryPrice) || entryPrice === 0) {
    return {
      mfe30mPct: 0,
      mae30mPct: 0,
      mfe60mPct: 0,
      mae60mPct: 0,
      mfeMaeRatio30m: 0,
      firstHit30m: false,
      firstHit60m: false,
      tp1Within35m: false,
      tp1Within45m: false,
      stopWithin30m: false,
    };
  }

  // Filter candles within time windows
  const candles30m = candles.filter(c => c.time >= entryTime && c.time <= entryTime + THIRTY_MIN_MS);
  const candles60m = candles.filter(c => c.time >= entryTime && c.time <= entryTime + SIXTY_MIN_MS);

  // Calculate MFE/MAE for 30m window
  let maxHigh30m = -Infinity;
  let minLow30m = Infinity;
  for (const c of candles30m) {
    if (Number.isFinite(c.high)) maxHigh30m = Math.max(maxHigh30m, c.high);
    if (Number.isFinite(c.low)) minLow30m = Math.min(minLow30m, c.low);
  }

  // Calculate MFE/MAE for 60m window
  let maxHigh60m = -Infinity;
  let minLow60m = Infinity;
  for (const c of candles60m) {
    if (Number.isFinite(c.high)) maxHigh60m = Math.max(maxHigh60m, c.high);
    if (Number.isFinite(c.low)) minLow60m = Math.min(minLow60m, c.low);
  }

  // Direction-aware MFE/MAE calculation
  let mfe30mPct = 0;
  let mae30mPct = 0;
  let mfe60mPct = 0;
  let mae60mPct = 0;

  if (direction === 'LONG') {
    mfe30mPct = maxHigh30m > -Infinity ? ((maxHigh30m - entryPrice) / entryPrice) * 100 : 0;
    mae30mPct = minLow30m < Infinity ? ((entryPrice - minLow30m) / entryPrice) * 100 : 0;
    mfe60mPct = maxHigh60m > -Infinity ? ((maxHigh60m - entryPrice) / entryPrice) * 100 : 0;
    mae60mPct = minLow60m < Infinity ? ((entryPrice - minLow60m) / entryPrice) * 100 : 0;
  } else {
    mfe30mPct = minLow30m < Infinity ? ((entryPrice - minLow30m) / entryPrice) * 100 : 0;
    mae30mPct = maxHigh30m > -Infinity ? ((maxHigh30m - entryPrice) / entryPrice) * 100 : 0;
    mfe60mPct = minLow60m < Infinity ? ((entryPrice - minLow60m) / entryPrice) * 100 : 0;
    mae60mPct = maxHigh60m > -Infinity ? ((maxHigh60m - entryPrice) / entryPrice) * 100 : 0;
  }

  // MFE/MAE ratio (avoid division by zero)
  const mfeMaeRatio30m = mae30mPct > 0.001 ? mfe30mPct / mae30mPct : (mfe30mPct > 0 ? 999 : 0);

  return {
    mfe30mPct,
    mae30mPct,
    mfe60mPct,
    mae60mPct,
    mfeMaeRatio30m,
    firstHit30m: mfe30mPct > 0.1 || mae30mPct > 0.1, // Price moved at least 0.1%
    firstHit60m: mfe60mPct > 0.1 || mae60mPct > 0.1,
    tp1Within35m: false, // Will be set based on actual TP1 hit time
    tp1Within45m: false,
    stopWithin30m: false,
  };
}

// ============================================================================
// STEP 2: STATS BY BUCKET
// ============================================================================

interface StatsAccumulator {
  values: number[];
  sum: number;
  count: number;
}

function createAccumulator(): StatsAccumulator {
  return { values: [], sum: 0, count: 0 };
}

function addValue(acc: StatsAccumulator, value: number | null | undefined) {
  if (value != null && Number.isFinite(value)) {
    acc.values.push(value);
    acc.sum += value;
    acc.count++;
  }
}

function computeStats(acc: StatsAccumulator): { avg: number | null; median: number | null; q1: number | null; q3: number | null } {
  if (acc.count === 0) {
    return { avg: null, median: null, q1: null, q3: null };
  }
  
  const sorted = [...acc.values].sort((a, b) => a - b);
  const avg = acc.sum / acc.count;
  
  const medianIndex = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 
    ? (sorted[medianIndex - 1] + sorted[medianIndex]) / 2 
    : sorted[medianIndex];
  
  const q1Index = Math.floor(sorted.length * 0.25);
  const q3Index = Math.floor(sorted.length * 0.75);
  const q1 = sorted[q1Index];
  const q3 = sorted[q3Index];
  
  return { avg, median, q1, q3 };
}

export interface FullBucketAnalysis {
  // By direction + bucket
  longWin: BucketStats;
  longLoss: BucketStats;
  longBe: BucketStats;
  shortWin: BucketStats;
  shortLoss: BucketStats;
  shortBe: BucketStats;
  
  // Status sanity check
  statusCounts: Record<string, number>;
  managedStatusCounts: Record<string, number>;
  
  // Rates
  rates: {
    longStopBeforeTp1Pct: number;
    longTp1AchievedPct: number;
    longTp1ToBePct: number;
    longTp1ToTp2Pct: number;
    shortStopBeforeTp1Pct: number;
    shortTp1AchievedPct: number;
    shortTp1ToBePct: number;
    shortTp1ToTp2Pct: number;
  };
}

/**
 * Compute full bucket analysis with proper stats
 */
export async function computeBucketAnalysis(
  startMs?: number,
  endMs?: number
): Promise<FullBucketAnalysis> {
  const d = getDb();
  
  const now = Date.now();
  const start = startMs ?? now - 7 * 24 * 60 * 60 * 1000; // Default 7 days
  const end = endMs ?? now;

  // Fetch all completed extended outcomes with their signals
  const rows = await d.prepare(`
    SELECT 
      eo.signal_id,
      s.symbol,
      s.category,
      eo.status,
      eo.ext24_managed_status,
      eo.ext24_realized_r,
      eo.ext24_managed_r,
      eo.time_to_tp1_seconds,
      eo.time_to_stop_seconds,
      eo.time_to_tp2_seconds,
      eo.max_favorable_excursion_pct,
      eo.max_adverse_excursion_pct,
      eo.first_tp1_at,
      eo.stop_at,
      eo.tp2_at,
      eo.signal_time,
      eo.completed_at
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    WHERE eo.signal_time >= @start AND eo.signal_time <= @end
      AND eo.completed_at IS NOT NULL
  `).all({ start, end }) as any[];

  // Accumulators for each bucket
  const acc = {
    longWin: {
      timeToTp1: createAccumulator(),
      timeToStop: createAccumulator(),
      mfe: createAccumulator(),
      mae: createAccumulator(),
      mfe30m: createAccumulator(),
      mae30m: createAccumulator(),
      realizedR: createAccumulator(),
    },
    longLoss: {
      timeToTp1: createAccumulator(),
      timeToStop: createAccumulator(),
      mfe: createAccumulator(),
      mae: createAccumulator(),
      mfe30m: createAccumulator(),
      mae30m: createAccumulator(),
      realizedR: createAccumulator(),
    },
    longBe: {
      timeToTp1: createAccumulator(),
      timeToStop: createAccumulator(),
      mfe: createAccumulator(),
      mae: createAccumulator(),
      mfe30m: createAccumulator(),
      mae30m: createAccumulator(),
      realizedR: createAccumulator(),
    },
    shortWin: {
      timeToTp1: createAccumulator(),
      timeToStop: createAccumulator(),
      mfe: createAccumulator(),
      mae: createAccumulator(),
      mfe30m: createAccumulator(),
      mae30m: createAccumulator(),
      realizedR: createAccumulator(),
    },
    shortLoss: {
      timeToTp1: createAccumulator(),
      timeToStop: createAccumulator(),
      mfe: createAccumulator(),
      mae: createAccumulator(),
      mfe30m: createAccumulator(),
      mae30m: createAccumulator(),
      realizedR: createAccumulator(),
    },
    shortBe: {
      timeToTp1: createAccumulator(),
      timeToStop: createAccumulator(),
      mfe: createAccumulator(),
      mae: createAccumulator(),
      mfe30m: createAccumulator(),
      mae30m: createAccumulator(),
      realizedR: createAccumulator(),
    },
  };

  // Status sanity check accumulators
  const statusCounts: Record<string, number> = {};
  const managedStatusCounts: Record<string, number> = {};

  // Rates accumulators
  let longTp1Hit = 0, longTp2Hit = 0, longStopHit = 0, longTotal = 0;
  let shortTp1Hit = 0, shortTp2Hit = 0, shortStopHit = 0, shortTotal = 0;
  let longTp1ThenBe = 0, longTp1ThenTp2 = 0;
  let shortTp1ThenBe = 0, shortTp1ThenTp2 = 0;

  for (const row of rows) {
    const direction = getDirectionFromCategory(row.category);
    const classification = classifyOutcome(
      row.status,
      row.ext24_managed_status,
      row.ext24_realized_r,
      direction
    );

    // Status sanity check
    const s = String(row.status || 'NULL');
    const ms = row.ext24_managed_status ? String(row.ext24_managed_status) : 'NULL';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
    managedStatusCounts[ms] = (managedStatusCounts[ms] || 0) + 1;

    // Determine bucket key
    let bucketKey: keyof typeof acc | null = null;
    if (direction === 'LONG') {
      if (classification.bucket === 'WIN') bucketKey = 'longWin';
      else if (classification.bucket === 'LOSS') bucketKey = 'longLoss';
      else if (classification.bucket === 'BE') bucketKey = 'longBe';
    } else {
      if (classification.bucket === 'WIN') bucketKey = 'shortWin';
      else if (classification.bucket === 'LOSS') bucketKey = 'shortLoss';
      else if (classification.bucket === 'BE') bucketKey = 'shortBe';
    }

    if (bucketKey) {
      const a = acc[bucketKey];
      addValue(a.timeToTp1, row.time_to_tp1_seconds);
      addValue(a.timeToStop, row.time_to_stop_seconds);
      addValue(a.mfe, row.max_favorable_excursion_pct);
      addValue(a.mae, row.max_adverse_excursion_pct);
      addValue(a.realizedR, row.ext24_realized_r);
    }

    // Rates calculation
    if (direction === 'LONG') {
      longTotal++;
      if (row.first_tp1_at) longTp1Hit++;
      if (row.tp2_at) longTp2Hit++;
      if (row.stop_at) longStopHit++;
      if (row.first_tp1_at && row.stop_at && !row.tp2_at) longTp1ThenBe++;
      if (row.first_tp1_at && row.tp2_at) longTp1ThenTp2++;
    } else {
      shortTotal++;
      if (row.first_tp1_at) shortTp1Hit++;
      if (row.tp2_at) shortTp2Hit++;
      if (row.stop_at) shortStopHit++;
      if (row.first_tp1_at && row.stop_at && !row.tp2_at) shortTp1ThenBe++;
      if (row.first_tp1_at && row.tp2_at) shortTp1ThenTp2++;
    }
  }

  // Compute stats for each bucket
  function buildBucketStats(
    bucket: 'WIN' | 'LOSS' | 'BE',
    direction: 'LONG' | 'SHORT',
    a: typeof acc.longWin
  ): BucketStats {
    const timeToTp1Stats = computeStats(a.timeToTp1);
    const timeToStopStats = computeStats(a.timeToStop);
    const mfeStats = computeStats(a.mfe);
    const maeStats = computeStats(a.mae);
    const mfe30mStats = computeStats(a.mfe30m);
    const mae30mStats = computeStats(a.mae30m);

    return {
      bucket,
      direction,
      count: a.timeToTp1.count + a.timeToStop.count,
      avgTimeToTp1Seconds: timeToTp1Stats.avg,
      medianTimeToTp1Seconds: timeToTp1Stats.median,
      q1TimeToTp1Seconds: timeToTp1Stats.q1,
      q3TimeToTp1Seconds: timeToTp1Stats.q3,
      avgTimeToStopSeconds: timeToStopStats.avg,
      medianTimeToStopSeconds: timeToStopStats.median,
      avgMfePct: mfeStats.avg,
      medianMfePct: mfeStats.median,
      avgMaePct: maeStats.avg,
      medianMaePct: maeStats.median,
      avgMfe30mPct: mfe30mStats.avg,
      medianMfe30mPct: mfe30mStats.median,
      avgMae30mPct: mae30mStats.avg,
      medianMae30mPct: mae30mStats.median,
    };
  }

  return {
    longWin: buildBucketStats('WIN', 'LONG', acc.longWin),
    longLoss: buildBucketStats('LOSS', 'LONG', acc.longLoss),
    longBe: buildBucketStats('BE', 'LONG', acc.longBe),
    shortWin: buildBucketStats('WIN', 'SHORT', acc.shortWin),
    shortLoss: buildBucketStats('LOSS', 'SHORT', acc.shortLoss),
    shortBe: buildBucketStats('BE', 'SHORT', acc.shortBe),
    statusCounts,
    managedStatusCounts,
    rates: {
      longStopBeforeTp1Pct: longTotal > 0 ? (longStopHit - longTp1ThenBe) / longTotal * 100 : 0,
      longTp1AchievedPct: longTotal > 0 ? longTp1Hit / longTotal * 100 : 0,
      longTp1ToBePct: longTp1Hit > 0 ? longTp1ThenBe / longTp1Hit * 100 : 0,
      longTp1ToTp2Pct: longTp1Hit > 0 ? longTp1ThenTp2 / longTp1Hit * 100 : 0,
      shortStopBeforeTp1Pct: shortTotal > 0 ? (shortStopHit - shortTp1ThenBe) / shortTotal * 100 : 0,
      shortTp1AchievedPct: shortTotal > 0 ? shortTp1Hit / shortTotal * 100 : 0,
      shortTp1ToBePct: shortTp1Hit > 0 ? shortTp1ThenBe / shortTp1Hit * 100 : 0,
      shortTp1ToTp2Pct: shortTp1Hit > 0 ? shortTp1ThenTp2 / shortTp1Hit * 100 : 0,
    },
  };
}

// ============================================================================
// STEP 3: SYMBOL GATES / TIERING
// ============================================================================

const MIN_SIGNALS_FOR_TIER = 10;

const TIER_THRESHOLDS = {
  GREEN: 0.30, // >= 30% win rate
  YELLOW: 0.15, // >= 15% win rate
  // RED: < 15%
};

/**
 * Compute symbol tier based on win rate
 */
export function computeSymbolTier(winRate: number, totalSignals: number): SymbolTier {
  if (totalSignals < MIN_SIGNALS_FOR_TIER) {
    return 'YELLOW'; // Not enough data, be cautious
  }
  if (winRate >= TIER_THRESHOLDS.GREEN) return 'GREEN';
  if (winRate >= TIER_THRESHOLDS.YELLOW) return 'YELLOW';
  return 'RED';
}

/**
 * Get symbol stats with tiering
 */
export async function getSymbolStats(
  startMs?: number,
  endMs?: number,
  minSignals: number = MIN_SIGNALS_FOR_TIER
): Promise<SymbolStats[]> {
  const d = getDb();
  
  const now = Date.now();
  const start = startMs ?? now - 7 * 24 * 60 * 60 * 1000;
  const end = endMs ?? now;

  const rows = await d.prepare(`
    SELECT 
      s.symbol,
      CASE 
        WHEN s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT'
        ELSE 'LONG'
      END as direction,
      COUNT(*) as total_signals,
      SUM(CASE WHEN eo.status IN ('WIN_TP1', 'WIN_TP2') THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN eo.status = 'LOSS_STOP' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN eo.ext24_managed_status = 'CLOSED_BE_AFTER_TP1' THEN 1 ELSE 0 END) as be_count,
      SUM(CASE WHEN eo.completed_at IS NULL THEN 1 ELSE 0 END) as pending,
      AVG(eo.ext24_realized_r) as avg_realized_r,
      (SELECT AVG(ext24_realized_r) FROM (
        SELECT ext24_realized_r FROM extended_outcomes eo2 
        JOIN signals s2 ON s2.id = eo2.signal_id 
        WHERE s2.symbol = s.symbol 
        AND CASE 
          WHEN s2.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT'
          ELSE 'LONG'
        END = CASE 
          WHEN s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT'
          ELSE 'LONG'
        END
        AND eo2.completed_at IS NOT NULL
        ORDER BY eo2.ext24_realized_r 
        LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM extended_outcomes eo3 JOIN signals s3 ON s3.id = eo3.signal_id WHERE s3.symbol = s.symbol AND CASE WHEN s3.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT' ELSE 'LONG' END = CASE WHEN s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT' ELSE 'LONG' END AND eo3.completed_at IS NOT NULL)
      )) as median_realized_r
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    WHERE eo.signal_time >= @start AND eo.signal_time <= @end
    GROUP BY s.symbol, direction
    HAVING COUNT(*) >= @minSignals
    ORDER BY total_signals DESC
  `).all({ start, end, minSignals }) as any[];

  return rows.map(row => {
    const total = Number(row.total_signals) || 0;
    const wins = Number(row.wins) || 0;
    const losses = Number(row.losses) || 0;
    const be = Number(row.be_count) || 0;
    const pending = Number(row.pending) || 0;
    const completed = total - pending;
    const winRate = completed > 0 ? wins / completed : 0;

    return {
      symbol: String(row.symbol),
      direction: String(row.direction) as 'LONG' | 'SHORT',
      totalSignals: total,
      wins,
      losses,
      breakeven: be,
      pending,
      winRate,
      avgRealizedR: row.avg_realized_r != null ? Number(row.avg_realized_r) : null,
      medianRealizedR: row.median_realized_r != null ? Number(row.median_realized_r) : null,
      tier: computeSymbolTier(winRate, total),
    };
  });
}

// ============================================================================
// STEP 4: FILTER SETS AND BACKTEST
// ============================================================================

export interface FilterCriteria {
  minMfe30mPct?: number;
  minMfeMaeRatio30m?: number;
  requireTp1Within35m?: boolean;
  requireTp1Within45m?: boolean;
  symbolTierOverrides?: Record<SymbolTier, { minMfe30mPct?: number }>;
}

const FILTER_SETS: Record<FilterSetId, { name: string; criteria: FilterCriteria }> = {
  A: {
    name: 'Momentum Confirmation',
    criteria: {
      minMfe30mPct: 0.30,
      minMfeMaeRatio30m: 0.20,
    },
  },
  B: {
    name: 'Speed Requirement',
    criteria: {
      requireTp1Within35m: true,
    },
  },
  C: {
    name: 'Symbol-Adaptive',
    criteria: {
      minMfe30mPct: 0.30,
      symbolTierOverrides: {
        GREEN: { minMfe30mPct: 0.25 },
        YELLOW: { minMfe30mPct: 0.30 },
        RED: { minMfe30mPct: 0.50 },
      },
    },
  },
};

/**
 * Apply filter criteria to an outcome
 */
export function applyFilter(
  outcome: OutcomeRow,
  criteria: FilterCriteria,
  symbolTier?: SymbolTier
): { keep: boolean; reason: string } {
  // Determine effective criteria (with symbol tier override if applicable)
  let effectiveCriteria = criteria;
  if (criteria.symbolTierOverrides && symbolTier) {
    const override = criteria.symbolTierOverrides[symbolTier];
    if (override) {
      effectiveCriteria = { ...criteria, ...override };
    }
  }

  // Check MFE30m
  if (effectiveCriteria.minMfe30mPct != null) {
    const mfe30m = outcome.mfe30mPct ?? outcome.maxFavorableExcursionPct ?? 0;
    if (mfe30m < effectiveCriteria.minMfe30mPct) {
      return { keep: false, reason: `mfe30m_${mfe30m.toFixed(2)}_below_${effectiveCriteria.minMfe30mPct}` };
    }
  }

  // Check MFE/MAE ratio
  if (effectiveCriteria.minMfeMaeRatio30m != null) {
    const mfe = outcome.mfe30mPct ?? outcome.maxFavorableExcursionPct ?? 0;
    const mae = outcome.mae30mPct ?? outcome.maxAdverseExcursionPct ?? 0.001;
    const ratio = mae > 0 ? mfe / mae : 999;
    if (ratio < effectiveCriteria.minMfeMaeRatio30m) {
      return { keep: false, reason: `ratio_${ratio.toFixed(2)}_below_${effectiveCriteria.minMfeMaeRatio30m}` };
    }
  }

  // Check TP1 within 35m
  if (effectiveCriteria.requireTp1Within35m) {
    const timeToTp1Min = (outcome.timeToTp1Seconds ?? 99999) / 60;
    if (timeToTp1Min > 35) {
      return { keep: false, reason: `tp1_time_${timeToTp1Min.toFixed(0)}m_above_35m` };
    }
  }

  // Check TP1 within 45m
  if (effectiveCriteria.requireTp1Within45m) {
    const timeToTp1Min = (outcome.timeToTp1Seconds ?? 99999) / 60;
    if (timeToTp1Min > 45) {
      return { keep: false, reason: `tp1_time_${timeToTp1Min.toFixed(0)}m_above_45m` };
    }
  }

  return { keep: true, reason: 'passed_all_criteria' };
}

/**
 * Calculate max loss streak
 */
function calculateMaxLossStreak(outcomes: Array<{ bucket: OutcomeBucket }>): number {
  let maxStreak = 0;
  let currentStreak = 0;
  
  for (const outcome of outcomes) {
    if (outcome.bucket === 'LOSS') {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else if (outcome.bucket === 'WIN') {
      currentStreak = 0;
    }
    // BE doesn't break streak (conservative)
  }
  
  return maxStreak;
}

/**
 * Backtest a filter set
 */
export async function backtestFilter(
  filterId: FilterSetId,
  startMs?: number,
  endMs?: number
): Promise<FilterBacktestResult> {
  const d = getDb();
  const filter = FILTER_SETS[filterId];
  
  const now = Date.now();
  const start = startMs ?? now - 7 * 24 * 60 * 60 * 1000;
  const end = endMs ?? now;

  // Fetch outcomes
  const rows = await d.prepare(`
    SELECT 
      eo.signal_id,
      s.symbol,
      s.category,
      eo.status,
      eo.ext24_managed_status,
      eo.ext24_realized_r,
      eo.time_to_tp1_seconds,
      eo.max_favorable_excursion_pct,
      eo.max_adverse_excursion_pct,
      eo.first_tp1_at,
      eo.signal_time
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    WHERE eo.signal_time >= @start AND eo.signal_time <= @end
      AND eo.completed_at IS NOT NULL
    ORDER BY eo.signal_time ASC
  `).all({ start, end }) as any[];

  // Get symbol tiers
  const symbolStats = await getSymbolStats(start, end, 5); // Lower threshold for backtest
  const tierBySymbol = new Map(symbolStats.map(s => [`${s.symbol}_${s.direction}`, s.tier]));

  // Process outcomes
  const allOutcomes: Array<{ 
    bucket: OutcomeBucket; 
    realizedR: number;
    keep: boolean;
  }> = [];

  for (const row of rows) {
    const direction = getDirectionFromCategory(row.category);
    const classification = classifyOutcome(row.status, row.ext24_managed_status, row.ext24_realized_r, direction);
    
    // Skip pending/exclude
    if (classification.bucket === 'PENDING' || classification.bucket === 'EXCLUDE') continue;

    const outcome: OutcomeRow = {
      signalId: row.signal_id,
      symbol: row.symbol,
      category: row.category,
      direction,
      status: row.status,
      ext24ManagedStatus: row.ext24_managed_status,
      ext24RealizedR: row.ext24_realized_r,
      ext24ManagedR: row.ext24_realized_r,
      timeToTp1Seconds: row.time_to_tp1_seconds,
      timeToStopSeconds: null,
      timeToTp2Seconds: null,
      maxFavorableExcursionPct: row.max_favorable_excursion_pct,
      maxAdverseExcursionPct: row.max_adverse_excursion_pct,
      tp1HitTime: row.first_tp1_at,
      signalTime: row.signal_time,
      completedAt: row.completed_at,
    };

    const tier = tierBySymbol.get(`${outcome.symbol}_${direction}`);
    const filterResult = applyFilter(outcome, filter.criteria, tier);

    allOutcomes.push({
      bucket: classification.bucket,
      realizedR: row.ext24_realized_r ?? 0,
      keep: filterResult.keep,
    });
  }

  // Calculate before stats
  const beforeOutcomes = allOutcomes;
  const beforeWins = beforeOutcomes.filter(o => o.bucket === 'WIN').length;
  const beforeCompleted = beforeOutcomes.filter(o => o.bucket !== 'PENDING' && o.bucket !== 'EXCLUDE').length;
  const beforeWinRate = beforeCompleted > 0 ? beforeWins / beforeCompleted : 0;
  const beforeRealizedRs = beforeOutcomes.map(o => o.realizedR).filter(r => Number.isFinite(r));
  const beforeAvgR = beforeRealizedRs.length > 0 ? beforeRealizedRs.reduce((a, b) => a + b, 0) / beforeRealizedRs.length : 0;
  const beforeMedianR = beforeRealizedRs.length > 0 ? beforeRealizedRs.sort((a, b) => a - b)[Math.floor(beforeRealizedRs.length / 2)] : 0;
  const beforeMaxLossStreak = calculateMaxLossStreak(beforeOutcomes);

  // Calculate after stats
  const afterOutcomes = allOutcomes.filter(o => o.keep);
  const afterWins = afterOutcomes.filter(o => o.bucket === 'WIN').length;
  const afterCompleted = afterOutcomes.length;
  const afterWinRate = afterCompleted > 0 ? afterWins / afterCompleted : 0;
  const afterRealizedRs = afterOutcomes.map(o => o.realizedR).filter(r => Number.isFinite(r));
  const afterAvgR = afterRealizedRs.length > 0 ? afterRealizedRs.reduce((a, b) => a + b, 0) / afterRealizedRs.length : 0;
  const afterMedianR = afterRealizedRs.length > 0 ? afterRealizedRs.sort((a, b) => a - b)[Math.floor(afterRealizedRs.length / 2)] : 0;
  const afterMaxLossStreak = calculateMaxLossStreak(afterOutcomes);

  return {
    filterId,
    filterName: filter.name,
    totalSignals: allOutcomes.length,
    signalsKept: afterOutcomes.length,
    signalsFiltered: allOutcomes.length - afterOutcomes.length,
    keepRate: allOutcomes.length > 0 ? afterOutcomes.length / allOutcomes.length : 0,
    winRateBefore: beforeWinRate,
    winRateAfter: afterWinRate,
    avgRealizedRBefore: beforeAvgR,
    avgRealizedRAfter: afterAvgR,
    medianRealizedRBefore: beforeMedianR,
    medianRealizedRAfter: afterMedianR,
    maxLossStreakBefore: beforeMaxLossStreak,
    maxLossStreakAfter: afterMaxLossStreak,
  };
}

// ============================================================================
// EXPORT FILTER SETS FOR API
// ============================================================================

export function getFilterSetDefinitions(): Array<{ id: FilterSetId; name: string; criteria: FilterCriteria }> {
  return Object.entries(FILTER_SETS).map(([id, def]) => ({ id: id as FilterSetId, ...def }));
}

// ============================================================================
// DIAGNOSTICS
// ============================================================================

export interface DiagnosticsResult {
  totalOutcomes: number;
  byStatus: Record<string, number>;
  byManagedStatus: Record<string, number>;
  byBucket: Record<OutcomeBucket, number>;
  byDirectionBucket: Record<DirectionBucket, number>;
  classificationReasons: Record<string, number>;
}

/**
 * Get diagnostic counts for sanity checking
 */
export async function getDiagnostics(startMs?: number, endMs?: number): Promise<DiagnosticsResult> {
  const d = getDb();
  
  const now = Date.now();
  const start = startMs ?? now - 7 * 24 * 60 * 60 * 1000;
  const end = endMs ?? now;

  const rows = await d.prepare(`
    SELECT 
      eo.signal_id,
      s.category,
      eo.status,
      eo.ext24_managed_status,
      eo.ext24_realized_r
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    WHERE eo.signal_time >= @start AND eo.signal_time <= @end
  `).all({ start, end }) as any[];

  const byStatus: Record<string, number> = {};
  const byManagedStatus: Record<string, number> = {};
  const byBucket: Record<OutcomeBucket, number> = { WIN: 0, LOSS: 0, BE: 0, EXCLUDE: 0, PENDING: 0 };
  const byDirectionBucket: Record<DirectionBucket, number> = {
    LONG_WIN: 0, LONG_LOSS: 0, LONG_BE: 0, LONG_EXCLUDE: 0, LONG_PENDING: 0,
    SHORT_WIN: 0, SHORT_LOSS: 0, SHORT_BE: 0, SHORT_EXCLUDE: 0, SHORT_PENDING: 0,
  };
  const classificationReasons: Record<string, number> = {};

  for (const row of rows) {
    const direction = getDirectionFromCategory(row.category);
    const classification = classifyOutcome(row.status, row.ext24_managed_status, row.ext24_realized_r, direction);

    const s = String(row.status || 'NULL');
    const ms = row.ext24_managed_status ? String(row.ext24_managed_status) : 'NULL';
    
    byStatus[s] = (byStatus[s] || 0) + 1;
    byManagedStatus[ms] = (byManagedStatus[ms] || 0) + 1;
    byBucket[classification.bucket]++;
    byDirectionBucket[classification.directionBucket]++;
    classificationReasons[classification.reason] = (classificationReasons[classification.reason] || 0) + 1;
  }

  return {
    totalOutcomes: rows.length,
    byStatus,
    byManagedStatus,
    byBucket,
    byDirectionBucket,
    classificationReasons,
  };
}
