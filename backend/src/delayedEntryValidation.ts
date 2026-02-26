/**
 * Delayed Entry Validation - Test different confirmMovePct values on historical data
 * 
 * Run 200/100/50 signal windows to find optimal threshold
 * Key metric: R per 100 signals (system productivity)
 */

import { getDb } from './db/db.js';
import { klinesRange } from './binance.js';
import { simulateDelayedEntry, type DelayedEntryConfig } from './delayedEntry.js';
import { classifyOutcome } from './outcomeAnalysis.js';
import type { Signal } from './types.js';

export interface ValidationResult {
  windowSize: number;
  confirmMovePct: number;
  
  // Delayed entry stats
  watchCreated: number;
  entered: number;
  expired: number;
  skippedSpike: number;
  confirmRate: number;
  
  // Performance (entered signals only)
  wins: number;
  losses: number;
  be: number;
  winRate: number;
  totalR: number;
  avgR: number;
  
  // System productivity (key metric)
  rPer100Signals: number;  // TotalR / watchCreated * 100
  
  // Comparison
  baselineTotalR: number;  // What if we entered all signals immediately?
  improvementPct: number;   // vs baseline
}

/**
 * Run validation on last N signals with given confirmMovePct
 */
export async function validateDelayedEntry(
  confirmMovePct: number,
  windowSizes: number[] = [200, 100, 50],
  maxWaitMinutes: number = 45
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const d = getDb();
  
  // Fetch recent completed signals with extended outcomes
  const signals = await d.prepare(`
    SELECT 
      s.id,
      s.symbol,
      s.category,
      s.price,
      s.time,
      s.stop,
      s.tp1,
      s.tp2,
      eo.ext24_realized_r as realizedR,
      eo.status as outcomeStatus,
      eo.ext24_managed_status as managedStatus
    FROM signals s
    JOIN extended_outcomes eo ON eo.signal_id = s.id
    WHERE eo.completed_at IS NOT NULL
      AND s.category IN ('READY_TO_BUY', 'READY_TO_SELL', 'BEST_ENTRY', 'BEST_SHORT_ENTRY')
    ORDER BY s.created_at DESC
    LIMIT 250
  `).all() as any[];
  
  for (const windowSize of windowSizes) {
    const windowSignals = signals.slice(0, windowSize);
    
    if (windowSignals.length === 0) {
      continue;
    }
    
    const result = await validateWindow(
      windowSignals,
      confirmMovePct,
      maxWaitMinutes,
      windowSize
    );
    
    results.push(result);
  }
  
  return results;
}

async function validateWindow(
  signals: any[],
  confirmMovePct: number,
  maxWaitMinutes: number,
  windowSize: number
): Promise<ValidationResult> {
  const config: DelayedEntryConfig = {
    enabled: true,
    confirmMovePct,
    maxWaitMinutes,
    pollIntervalSeconds: 30,
    maxExtraMovePct: 0.10,
    maxSpreadPct: 0.15,
  };
  
  let watchCreated = 0;
  let entered = 0;
  let expired = 0;
  let skippedSpike = 0;
  
  let wins = 0;
  let losses = 0;
  let be = 0;
  let totalR = 0;
  
  let baselineTotalR = 0;
  
  for (const sig of signals) {
    watchCreated++;
    
    // Get baseline (immediate entry)
    const baselineR = sig.realizedR != null ? Number(sig.realizedR) : 0;
    baselineTotalR += baselineR;
    
    // Fetch candles for this signal
    const endTime = sig.time + (maxWaitMinutes * 60 * 1000) + 300000; // +5min buffer
    const candles = await fetchCandlesWithFallback(sig.symbol, sig.time, endTime);
    
    if (!candles || candles.length === 0) {
      expired++;
      continue;
    }
    
    // Simulate delayed entry
    const simResult = await simulateDelayedEntry(
      {
        symbol: sig.symbol,
        category: sig.category,
        price: sig.price,
        time: sig.time,
      } as Signal,
      candles,
      config
    );
    
    if (simResult.wouldEnter && simResult.entryPrice) {
      entered++;
      
      // Calculate outcome from confirmed entry
      const confirmedR = calculateOutcomeFromConfirmedEntry(
        sig,
        simResult.entryPrice,
        candles
      );
      
      totalR += confirmedR;
      
      if (confirmedR > 0.1) wins++;
      else if (confirmedR < -0.1) losses++;
      else be++;
      
    } else if (simResult.reason === 'SKIPPED_SPIKE') {
      skippedSpike++;
    } else {
      expired++;
    }
  }
  
  const confirmRate = watchCreated > 0 ? entered / watchCreated : 0;
  const winRate = entered > 0 ? wins / entered : 0;
  const avgR = entered > 0 ? totalR / entered : 0;
  const rPer100Signals = watchCreated > 0 ? (totalR / watchCreated) * 100 : 0;
  const improvementPct = baselineTotalR !== 0 
    ? ((totalR - baselineTotalR) / Math.abs(baselineTotalR)) * 100 
    : 0;
  
  return {
    windowSize,
    confirmMovePct,
    watchCreated,
    entered,
    expired,
    skippedSpike,
    confirmRate,
    wins,
    losses,
    be,
    winRate,
    totalR,
    avgR,
    rPer100Signals,
    baselineTotalR,
    improvementPct,
  };
}

async function fetchCandlesWithFallback(
  symbol: string,
  startTime: number,
  endTime: number
): Promise<Array<{ time: number; open: number; high: number; low: number; close: number }> | null> {
  try {
    // Try to fetch from DB first (extended_outcomes might have candle data)
    const d = getDb();
    
    // Check if we have early window metrics stored
    const metrics = await d.prepare(`
      SELECT mfe_30m_pct, mae_30m_pct, tp1_within_45m
      FROM extended_outcomes
      WHERE signal_id = (
        SELECT id FROM signals WHERE symbol = ? AND time BETWEEN ? AND ? LIMIT 1
      )
    `).get({ symbol, start: startTime - 60000, end: endTime + 60000 }) as any;
    
    if (metrics && metrics.mfe_30m_pct != null) {
      // We have metrics, construct synthetic candle data
      // This is approximation for validation purposes
      return [{
        time: startTime + 30 * 60 * 1000, // 30 min later
        open: 0, // Not used in simulation
        high: Number(metrics.mfe_30m_pct) / 100,
        low: -Number(metrics.mae_30m_pct) / 100,
        close: 0,
      }];
    }
    
    // Fall back to fetching from Binance
    const candles = await klinesRange(symbol, '5m', startTime, endTime, 50);
    
    return candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    
  } catch (e) {
    console.error(`[validation] Failed to fetch candles for ${symbol}:`, e);
    return null;
  }
}

function calculateOutcomeFromConfirmedEntry(
  signal: any,
  confirmedEntry: number,
  candles: Array<{ time: number; high: number; low: number; close: number }>
): number {
  // Recalculate TP/SL from confirmed entry
  const originalEntry = signal.price;
  const direction = signal.category.includes('SELL') ? 'SHORT' : 'LONG';
  
  // Get original distances
  const stopDistance = signal.stop != null 
    ? Math.abs((signal.stop - originalEntry) / originalEntry)
    : 0.02; // Default 2%
  
  const tp1Distance = signal.tp1 != null
    ? Math.abs((signal.tp1 - originalEntry) / originalEntry)
    : stopDistance * 1.5; // Default 1.5:1 RR
  
  // Calculate new TP/SL from confirmed entry
  const newStop = direction === 'LONG'
    ? confirmedEntry * (1 - stopDistance)
    : confirmedEntry * (1 + stopDistance);
  
  const newTp1 = direction === 'LONG'
    ? confirmedEntry * (1 + tp1Distance)
    : confirmedEntry * (1 - tp1Distance);
  
  // Simulate outcome - check if TP1 or Stop hit first
  for (const candle of candles) {
    const tpHit = direction === 'LONG'
      ? candle.high >= newTp1
      : candle.low <= newTp1;
    
    const stopHit = direction === 'LONG'
      ? candle.low <= newStop
      : candle.high >= newStop;
    
    if (tpHit && !stopHit) {
      return 1.0; // +1R for TP1 hit
    }
    
    if (stopHit && !tpHit) {
      return -1.0; // -1R for stop hit
    }
    
    if (tpHit && stopHit) {
      // Same candle conflict - use time priority or favor stop for safety
      return -1.0; // Conservative: count as loss
    }
  }
  
  // No resolution in window - timeout at breakeven or small loss
  return 0;
}

/**
 * Compare multiple confirmMovePct values
 */
export async function compareConfirmThresholds(
  thresholds: number[] = [0.20, 0.25, 0.30, 0.35, 0.40],
  windowSize: number = 200
): Promise<Array<{
  threshold: number;
  results: ValidationResult[];
  score: number; // Composite score for ranking
}>> {
  const comparisons = [];
  
  for (const threshold of thresholds) {
    const results = await validateDelayedEntry(threshold, [windowSize]);
    
    // Calculate composite score
    // Balance: high R per 100 signals + high confirm rate
    const result = results[0];
    const score = result 
      ? result.rPer100Signals * 0.7 + result.confirmRate * 30 // Weighted
      : -999;
    
    comparisons.push({
      threshold,
      results,
      score,
    });
  }
  
  // Sort by score descending
  comparisons.sort((a, b) => b.score - a.score);
  
  return comparisons;
}
