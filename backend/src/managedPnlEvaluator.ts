/**
 * Managed PnL Evaluator (Option B Trade Management)
 * 
 * This module implements the Option B trade execution model for extended outcomes:
 * - At TP1 hit: Take 50% partial profit, move stop on remaining 50% to break-even (entry)
 * - Continue tracking remaining 50% until: TP2 hit, break-even hit, or 24h expiry
 * 
 * Core Managed PnL Logic (Option B):
 * 
 * R = 1 = full initial risk
 * Full SL = -1R
 * TP1 = +1R
 * TP2 = +2R
 * 
 * Managed outcomes and R values:
 * 1) STOP before TP1: Managed result = -1.0R (full loss)
 * 2) TP1 hit, then TP2 hit: 50% @ TP1 (+0.5R) + 50% @ TP2 (+1.0R) = +1.5R
 * 3) TP1 hit, then break-even hit: 50% @ TP1 (+0.5R) + 50% @ BE (0R) = +0.5R
 * 4) TP1 hit, no TP2, no BE, 24h expires: +0.5R + runner_R (market close at expiry)
 * 5) No TP1, no SL, timeout at 24h: Close full position at market, compute R
 * 
 * Same-Candle Ambiguity Rules (conservative):
 * - Before TP1: If stop and TP1 hit in same candle → STOP wins (full loss)
 * - After TP1: If TP2 and BE hit in same candle → BE wins (conservative)
 */

import type { OHLCV } from './types.js';
import type { SignalDirection } from './extendedOutcomeStore.js';

// Configurable risk per trade (USD)
const DEFAULT_RISK_PER_TRADE_USD = 15;
const RISK_PER_TRADE_USD = Number(process.env.EXT24_RISK_PER_TRADE_USD) || DEFAULT_RISK_PER_TRADE_USD;

// Timeout runner mode: 'MARKET_CLOSE' (recommended) or 'BREAKEVEN_ASSUMED'
const TIMEOUT_RUNNER_MODE = process.env.EXT24_TIMEOUT_RUNNER_MODE || 'MARKET_CLOSE';

// Same-candle policy: 'CONSERVATIVE' (stop/BE wins) 
const SAME_CANDLE_POLICY = process.env.EXT24_SAME_CANDLE_POLICY || 'CONSERVATIVE';

// Managed status for extended outcomes
export type ManagedStatus =
  | 'PENDING'
  | 'PARTIAL_TP1_OPEN'
  | 'CLOSED_STOP'
  | 'CLOSED_TP2'
  | 'CLOSED_BE_AFTER_TP1'
  | 'CLOSED_TIMEOUT';

// Runner exit reason
export type RunnerExitReason =
  | 'TP2'
  | 'BREAK_EVEN'
  | 'TIMEOUT_MARKET'
  | 'STOP_BEFORE_TP1'
  | null;

// Managed PnL evaluation result
export interface ManagedPnlResult {
  // Status
  managedStatus: ManagedStatus;
  
  // Final R values (when closed)
  managedR: number | null;           // Final managed R if closed; null if pending
  managedPnlUsd: number | null;      // Final USD PnL if closed; null if pending
  
  // Component breakdown
  realizedR: number;                 // R already locked (e.g., +0.5R after TP1)
  unrealizedRunnerR: number | null;  // Unrealized runner R (for live rows)
  liveManagedR: number | null;       // Realized + unrealized (for live rows)
  
  // Timestamps
  tp1PartialAt: number | null;       // When TP1 partial was taken
  runnerBeAt: number | null;         // When runner BE was triggered
  runnerExitAt: number | null;       // When runner finally exited
  
  // Exit details
  runnerExitReason: RunnerExitReason;
  timeoutExitPrice: number | null;   // Price at 24h expiry if closed at market
  
  // Risk snapshot
  riskUsdSnapshot: number;           // Risk per trade used for calculation
  
  // Debug info
  debug: ManagedPnlDebug;
}

interface ManagedPnlDebug {
  fullPositionStopHit: boolean;
  fullPositionStopTime: number | null;
  runnerActive: boolean;
  runnerStopPrice: number | null;    // BE price (entry) after TP1
  lastEvaluatedPrice: number | null;
  sameCandleConflicts: Array<{
    stage: 'FULL_POSITION' | 'RUNNER';
    candleTime: number;
    hits: string[];
    resolution: string;
  }>;
}

// Input for managed PnL evaluation
export interface ManagedPnlInput {
  signalTime: number;
  entryPrice: number;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  direction: SignalDirection;
  
  // From extended outcome evaluation
  firstTp1At: number | null;
  tp2At: number | null;
  stopAt: number | null;
  status: string;  // ExtendedOutcomeStatus
  completed: boolean;
  expiresAt: number;
}

/**
 * Calculate risk distance in R terms
 * For longs: (entry - stop) / (entry - stop) = 1R
 * For shorts: (stop - entry) / (stop - entry) = 1R
 */
function calculateRiskDistance(
  direction: SignalDirection,
  entryPrice: number,
  stopPrice: number
): number {
  if (direction === 'LONG') {
    return entryPrice - stopPrice;
  } else {
    return stopPrice - entryPrice;
  }
}

/**
 * Convert price movement to R terms
 */
function priceToR(
  direction: SignalDirection,
  entryPrice: number,
  stopPrice: number,
  exitPrice: number
): number {
  const riskDistance = calculateRiskDistance(direction, entryPrice, stopPrice);
  if (riskDistance === 0) return 0;
  
  if (direction === 'LONG') {
    return (exitPrice - entryPrice) / riskDistance;
  } else {
    return (entryPrice - exitPrice) / riskDistance;
  }
}

/**
 * Check if stop is hit (direction-aware)
 */
function isStopHit(direction: SignalDirection, candle: OHLCV, stopPrice: number): boolean {
  if (direction === 'LONG') {
    return candle.low <= stopPrice;
  } else {
    return candle.high >= stopPrice;
  }
}

/**
 * Check if TP1 is hit
 */
function isTp1Hit(direction: SignalDirection, candle: OHLCV, tp1Price: number): boolean {
  if (direction === 'LONG') {
    return candle.high >= tp1Price;
  } else {
    return candle.low <= tp1Price;
  }
}

/**
 * Check if TP2 is hit
 */
function isTp2Hit(direction: SignalDirection, candle: OHLCV, tp2Price: number): boolean {
  if (direction === 'LONG') {
    return candle.high >= tp2Price;
  } else {
    return candle.low <= tp2Price;
  }
}

/**
 * Check if break-even (entry) is hit for runner
 * For longs: price drops to entry (low <= entry)
 * For shorts: price rises to entry (high >= entry)
 */
function isBreakEvenHit(direction: SignalDirection, candle: OHLCV, entryPrice: number): boolean {
  if (direction === 'LONG') {
    return candle.low <= entryPrice;
  } else {
    return candle.high >= entryPrice;
  }
}

/**
 * Evaluate managed PnL using Option B trade management rules
 * 
 * This function traces through the price path and applies Option B logic:
 * 1. Before TP1: Full position active, stop hits = -1R
 * 2. At TP1: Realize 50% (+0.5R), move runner stop to BE
 * 3. After TP1: Track runner for TP2, BE, or timeout
 */
export function evaluateManagedPnl(
  input: ManagedPnlInput,
  candles: OHLCV[]
): ManagedPnlResult {
  const {
    signalTime,
    entryPrice,
    stopPrice,
    tp1Price,
    tp2Price,
    direction,
    firstTp1At,
    tp2At,
    stopAt,
    status,
    completed,
    expiresAt,
  } = input;

  // Initialize debug
  const debug: ManagedPnlDebug = {
    fullPositionStopHit: false,
    fullPositionStopTime: null,
    runnerActive: false,
    runnerStopPrice: null,
    lastEvaluatedPrice: null,
    sameCandleConflicts: [],
  };

  // Validate required prices
  const hasStop = Number.isFinite(stopPrice) && stopPrice !== null && stopPrice > 0;
  const hasTp1 = Number.isFinite(tp1Price) && tp1Price !== null && tp1Price > 0;
  const hasTp2 = Number.isFinite(tp2Price) && tp2Price !== null && tp2Price > 0;

  // Sort candles by time
  const sortedCandles = [...candles].filter(c => c.time >= signalTime).sort((a, b) => a.time - b.time);
  
  if (sortedCandles.length === 0 || !hasStop) {
    // No data or no stop - cannot evaluate
    return {
      managedStatus: 'PENDING',
      managedR: null,
      managedPnlUsd: null,
      realizedR: 0,
      unrealizedRunnerR: null,
      liveManagedR: null,
      tp1PartialAt: null,
      runnerBeAt: null,
      runnerExitAt: null,
      runnerExitReason: null,
      timeoutExitPrice: null,
      riskUsdSnapshot: RISK_PER_TRADE_USD,
      debug,
    };
  }

  // Initialize state
  let managedStatus: ManagedStatus = 'PENDING';
  let realizedR = 0;
  let unrealizedRunnerR: number | null = null;
  let tp1PartialAt: number | null = null;
  let runnerBeAt: number | null = null;
  let runnerExitAt: number | null = null;
  let runnerExitReason: RunnerExitReason = null;
  let timeoutExitPrice: number | null = null;
  let runnerActive = false;

  const riskDistance = calculateRiskDistance(direction, entryPrice, stopPrice!);
  
  // Find the last candle before/at expiry for timeout price
  const lastCandle = sortedCandles.length > 0 
    ? sortedCandles[sortedCandles.length - 1] 
    : null;
  
  // Phase 1: Track full position until TP1 or stop
  let tp1HitIndex = -1;
  let stopHitIndex = -1;

  for (let i = 0; i < sortedCandles.length; i++) {
    const candle = sortedCandles[i];
    
    // Stop if we've passed expiry
    if (candle.time > expiresAt) break;

    const stopHit = isStopHit(direction, candle, stopPrice!);
    const tp1Hit = hasTp1 ? isTp1Hit(direction, candle, tp1Price!) : false;

    // Same-candle ambiguity: Before TP1, STOP wins (conservative)
    if (stopHit && tp1Hit && SAME_CANDLE_POLICY === 'CONSERVATIVE') {
      debug.sameCandleConflicts.push({
        stage: 'FULL_POSITION',
        candleTime: candle.time,
        hits: ['STOP', 'TP1'],
        resolution: 'STOP_WINS',
      });
      stopHitIndex = i;
      debug.fullPositionStopHit = true;
      debug.fullPositionStopTime = candle.time;
      realizedR = -1.0;
      managedStatus = 'CLOSED_STOP';
      runnerExitReason = 'STOP_BEFORE_TP1';
      
      return {
        managedStatus,
        managedR: realizedR,
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt: candle.time,
        runnerExitReason,
        timeoutExitPrice: null,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }

    if (stopHit) {
      stopHitIndex = i;
      debug.fullPositionStopHit = true;
      debug.fullPositionStopTime = candle.time;
      realizedR = -1.0;
      managedStatus = 'CLOSED_STOP';
      runnerExitReason = 'STOP_BEFORE_TP1';
      
      return {
        managedStatus,
        managedR: realizedR,
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt: candle.time,
        runnerExitReason,
        timeoutExitPrice: null,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }

    if (tp1Hit && tp1HitIndex === -1) {
      tp1HitIndex = i;
      tp1PartialAt = candle.time;
      realizedR = 0.5; // 50% position at TP1 = +0.5R
      runnerActive = true;
      managedStatus = 'PARTIAL_TP1_OPEN';
      debug.runnerActive = true;
      debug.runnerStopPrice = entryPrice; // BE stop
      break; // Exit phase 1, start phase 2
    }
  }

  // If we didn't hit TP1 and there's a stop hit after TP1 would have been
  // or we have a stopAt from extended outcome
  if (tp1HitIndex === -1) {
    // No TP1 hit - check if stop was hit later
    if (stopAt !== null && stopAt <= expiresAt) {
      // Stop was hit before expiry
      realizedR = -1.0;
      managedStatus = 'CLOSED_STOP';
      runnerExitReason = 'STOP_BEFORE_TP1';
      
      return {
        managedStatus,
        managedR: realizedR,
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt: stopAt,
        runnerExitReason,
        timeoutExitPrice: null,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }
    
    // No TP1, no stop - timeout at 24h
    if (completed || status === 'FLAT_TIMEOUT_24H') {
      // Close full position at market (last price in window)
      const exitPrice = lastCandle ? lastCandle.close : entryPrice;
      timeoutExitPrice = exitPrice;
      
      // Calculate R for full position
      const fullR = priceToR(direction, entryPrice, stopPrice!, exitPrice);
      realizedR = fullR;
      managedStatus = 'CLOSED_TIMEOUT';
      runnerExitReason = 'TIMEOUT_MARKET';
      
      return {
        managedStatus,
        managedR: realizedR,
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt: expiresAt,
        runnerExitReason,
        timeoutExitPrice,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }
    
    // Still pending - no hits yet
    return {
      managedStatus: 'PENDING',
      managedR: null,
      managedPnlUsd: null,
      realizedR: 0,
      unrealizedRunnerR: null,
      liveManagedR: 0,
      tp1PartialAt,
      runnerBeAt,
      runnerExitAt,
      runnerExitReason,
      timeoutExitPrice,
      riskUsdSnapshot: RISK_PER_TRADE_USD,
      debug,
    };
  }

  // Phase 2: Track runner (remaining 50%) after TP1 hit
  // Runner stop is at BE (entry price)
  for (let i = tp1HitIndex + 1; i < sortedCandles.length; i++) {
    const candle = sortedCandles[i];
    
    // Stop if we've passed expiry
    if (candle.time > expiresAt) break;

    const beHit = isBreakEvenHit(direction, candle, entryPrice);
    const tp2Hit = hasTp2 ? isTp2Hit(direction, candle, tp2Price!) : false;

    // Same-candle ambiguity: After TP1, BE wins over TP2 (conservative)
    if (beHit && tp2Hit && SAME_CANDLE_POLICY === 'CONSERVATIVE') {
      debug.sameCandleConflicts.push({
        stage: 'RUNNER',
        candleTime: candle.time,
        hits: ['BE', 'TP2'],
        resolution: 'BE_WINS',
      });
      
      runnerBeAt = candle.time;
      managedStatus = 'CLOSED_BE_AFTER_TP1';
      runnerExitReason = 'BREAK_EVEN';
      runnerExitAt = candle.time;
      // realizedR is already +0.5R from TP1 partial
      
      return {
        managedStatus,
        managedR: realizedR, // +0.5R
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt,
        runnerExitReason,
        timeoutExitPrice: null,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }

    if (beHit) {
      runnerBeAt = candle.time;
      managedStatus = 'CLOSED_BE_AFTER_TP1';
      runnerExitReason = 'BREAK_EVEN';
      runnerExitAt = candle.time;
      // realizedR is already +0.5R from TP1 partial
      
      return {
        managedStatus,
        managedR: realizedR, // +0.5R
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt,
        runnerExitReason,
        timeoutExitPrice: null,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }

    if (tp2Hit) {
      managedStatus = 'CLOSED_TP2';
      runnerExitReason = 'TP2';
      runnerExitAt = candle.time;
      realizedR = 1.5; // +0.5R from TP1 + 1.0R from runner at TP2
      
      return {
        managedStatus,
        managedR: realizedR, // +1.5R
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt,
        runnerExitReason,
        timeoutExitPrice: null,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }
  }

  // Check if completed via extended outcome status
  if (completed) {
    // Determine final state from extended outcome
    if (status === 'WIN_TP2' && tp2At) {
      managedStatus = 'CLOSED_TP2';
      runnerExitReason = 'TP2';
      runnerExitAt = tp2At;
      realizedR = 1.5;
      
      return {
        managedStatus,
        managedR: realizedR,
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt,
        runnerExitReason,
        timeoutExitPrice: null,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }
    
    if ((status === 'WIN_TP1' || status === 'ACHIEVED_TP1') && !tp2At) {
      // TP1 hit but TP2 not hit - check if BE was hit
      // We need to scan candles between TP1 and expiry for BE hit
      const beHitAfterTp1 = findBreakEvenHit(
        sortedCandles,
        tp1HitIndex + 1,
        direction,
        entryPrice,
        expiresAt
      );
      
      if (beHitAfterTp1) {
        runnerBeAt = beHitAfterTp1;
        managedStatus = 'CLOSED_BE_AFTER_TP1';
        runnerExitReason = 'BREAK_EVEN';
        runnerExitAt = beHitAfterTp1;
        // realizedR stays +0.5R
      } else {
        // Timeout with runner still active - close at market
        const exitPrice = lastCandle ? lastCandle.close : entryPrice;
        timeoutExitPrice = exitPrice;
        
        // Calculate runner R (50% position)
        const runnerR = priceToR(direction, entryPrice, stopPrice!, exitPrice) * 0.5;
        realizedR = 0.5 + runnerR; // +0.5R from TP1 + runner_R
        
        managedStatus = 'CLOSED_TIMEOUT';
        runnerExitReason = 'TIMEOUT_MARKET';
        runnerExitAt = expiresAt;
      }
      
      return {
        managedStatus,
        managedR: realizedR,
        managedPnlUsd: realizedR * RISK_PER_TRADE_USD,
        realizedR,
        unrealizedRunnerR: null,
        liveManagedR: realizedR,
        tp1PartialAt,
        runnerBeAt,
        runnerExitAt,
        runnerExitReason,
        timeoutExitPrice,
        riskUsdSnapshot: RISK_PER_TRADE_USD,
        debug,
      };
    }
  }

  // Still active with runner
  // Calculate unrealized runner value based on last price
  if (lastCandle) {
    const currentRunnerR = priceToR(direction, entryPrice, stopPrice!, lastCandle.close) * 0.5;
    unrealizedRunnerR = currentRunnerR;
    
    return {
      managedStatus: 'PARTIAL_TP1_OPEN',
      managedR: null,
      managedPnlUsd: null,
      realizedR: 0.5,
      unrealizedRunnerR,
      liveManagedR: 0.5 + currentRunnerR,
      tp1PartialAt,
      runnerBeAt: null,
      runnerExitAt: null,
      runnerExitReason: null,
      timeoutExitPrice: null,
      riskUsdSnapshot: RISK_PER_TRADE_USD,
      debug,
    };
  }

  // Fallback to pending
  return {
    managedStatus: 'PENDING',
    managedR: null,
    managedPnlUsd: null,
    realizedR: 0,
    unrealizedRunnerR: null,
    liveManagedR: 0,
    tp1PartialAt,
    runnerBeAt,
    runnerExitAt,
    runnerExitReason,
    timeoutExitPrice,
    riskUsdSnapshot: RISK_PER_TRADE_USD,
    debug,
  };
}

/**
 * Find if break-even was hit after TP1
 */
function findBreakEvenHit(
  candles: OHLCV[],
  startIndex: number,
  direction: SignalDirection,
  entryPrice: number,
  expiresAt: number
): number | null {
  for (let i = startIndex; i < candles.length; i++) {
    const candle = candles[i];
    if (candle.time > expiresAt) break;
    
    if (isBreakEvenHit(direction, candle, entryPrice)) {
      return candle.time;
    }
  }
  return null;
}

/**
 * Get risk per trade USD (configurable)
 */
export function getRiskPerTradeUsd(): number {
  return RISK_PER_TRADE_USD;
}

/**
 * Format managed R for display
 */
export function formatManagedR(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return '--';
  const sign = r >= 0 ? '+' : '';
  return `${sign}${r.toFixed(2)}R`;
}

/**
 * Format managed PnL USD for display
 */
export function formatManagedPnl(usd: number | null, riskPerTrade: number): string {
  if (usd === null || !Number.isFinite(usd)) return '--';
  const sign = usd >= 0 ? '+' : '';
  return `${sign}$${usd.toFixed(2)}`;
}

/**
 * Calculate summary statistics for managed PnL
 */
export interface ManagedPnlStats {
  // Trade counts
  totalClosed: number;
  wins: number;
  losses: number;
  beSaves: number;           // TP1 hit then BE
  tp1OnlyExits: number;      // TP1 hit then timeout (no BE, no TP2)
  
  // R metrics
  totalManagedR: number;
  avgManagedR: number;
  maxWinR: number;
  maxLossR: number;
  
  // USD metrics
  totalManagedPnlUsd: number;
  avgManagedPnlUsd: number;
  
  // Rates
  managedWinRate: number;    // managed_r > 0 / closed
  tp1TouchRate: number;      // touched TP1 at any point
  tp2ConversionRate: number; // hit TP2 / touched TP1
  
  // Risk config
  riskPerTradeUsd: number;
}

export function calculateManagedPnlStats(
  results: Array<{ managedR: number | null; status: string; firstTp1At: number | null; tp2At: number | null }>
): ManagedPnlStats {
  const riskPerTradeUsd = RISK_PER_TRADE_USD;
  
  const closed = results.filter(r => r.managedR !== null);
  const wins = closed.filter(r => (r.managedR || 0) > 0);
  const losses = closed.filter(r => (r.managedR || 0) <= 0);
  const beSaves = results.filter(r => 
    r.firstTp1At !== null && r.tp2At === null && (r.managedR || 0) === 0.5
  );
  const tp1OnlyExits = results.filter(r =>
    r.firstTp1At !== null && r.tp2At === null && r.status === 'CLOSED_TIMEOUT'
  );
  const tp1Touches = results.filter(r => r.firstTp1At !== null);
  const tp2Hits = results.filter(r => r.tp2At !== null);
  
  const totalManagedR = closed.reduce((sum, r) => sum + (r.managedR || 0), 0);
  const totalManagedPnlUsd = totalManagedR * riskPerTradeUsd;
  
  const managedRs = closed.map(r => r.managedR || 0);
  const maxWinR = managedRs.length > 0 ? Math.max(...managedRs) : 0;
  const maxLossR = managedRs.length > 0 ? Math.min(...managedRs) : 0;
  
  return {
    totalClosed: closed.length,
    wins: wins.length,
    losses: losses.length,
    beSaves: beSaves.length,
    tp1OnlyExits: tp1OnlyExits.length,
    totalManagedR,
    avgManagedR: closed.length > 0 ? totalManagedR / closed.length : 0,
    maxWinR,
    maxLossR,
    totalManagedPnlUsd,
    avgManagedPnlUsd: closed.length > 0 ? totalManagedPnlUsd / closed.length : 0,
    managedWinRate: closed.length > 0 ? wins.length / closed.length : 0,
    tp1TouchRate: results.length > 0 ? tp1Touches.length / results.length : 0,
    tp2ConversionRate: tp1Touches.length > 0 ? tp2Hits.length / tp1Touches.length : 0,
    riskPerTradeUsd,
  };
}
