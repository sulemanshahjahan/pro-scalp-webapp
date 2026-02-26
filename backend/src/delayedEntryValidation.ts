/**
 * Delayed Entry Validation - Test different confirmMovePct values on historical data
 * 
 * Uses existing mfe_30m_pct from extended_outcomes to simulate delayed entry.
 * If mfe_30m_pct >= confirmMovePct, the signal would have confirmed.
 * 
 * Run 200/100/50 signal windows to find optimal threshold
 * Key metric: R per 100 signals (system productivity)
 */

import { getDb } from './db/db.js';

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
  _maxWaitMinutes: number = 45
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const d = getDb();
  
  console.log(`[validation] Fetching signals with MFE data...`);
  
  // Fetch recent signals with early window metrics
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
      eo.mfe_30m_pct as mfe30m,
      eo.mae_30m_pct as mae30m
    FROM signals s
    JOIN extended_outcomes eo ON eo.signal_id = s.id
    WHERE eo.mfe_30m_pct IS NOT NULL
      AND s.category IN ('READY_TO_BUY', 'READY_TO_SELL', 'BEST_ENTRY', 'BEST_SHORT_ENTRY')
    ORDER BY s.created_at DESC
    LIMIT 250
  `).all() as any[];
  
  console.log(`[validation] Found ${signals.length} signals with MFE data`);
  
  if (signals.length === 0) {
    console.log('[validation] No signals with mfe_30m_pct found. Run backfill first?');
    return [];
  }
  
  for (const windowSize of windowSizes) {
    const windowSignals = signals.slice(0, Math.min(windowSize, signals.length));
    
    if (windowSignals.length === 0) {
      continue;
    }
    
    console.log(`[validation] Testing window ${windowSize} with ${windowSignals.length} signals...`);
    
    const result = await validateWindow(
      windowSignals,
      confirmMovePct,
      windowSize
    );
    
    results.push(result);
  }
  
  return results;
}

async function validateWindow(
  signals: any[],
  confirmMovePct: number,
  windowSize: number
): Promise<ValidationResult> {
  // Simplified validation using existing mfe_30m_pct data
  // If mfe_30m_pct >= confirmMovePct, signal would have confirmed
  
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
    
    const mfe30m = sig.mfe30m != null ? Number(sig.mfe30m) : 0;
    
    // Check spike protection (mfe > confirm + extra)
    const maxAllowedMove = confirmMovePct + 0.10; // 0.10 is maxExtraMovePct
    if (mfe30m > maxAllowedMove) {
      skippedSpike++;
      continue;
    }
    
    // Check if confirmed (mfe >= confirm threshold)
    if (mfe30m >= confirmMovePct) {
      entered++;
      
      // Use actual outcome from original entry
      totalR += baselineR;
      
      if (baselineR > 0.1) wins++;
      else if (baselineR < -0.1) losses++;
      else be++;
    } else {
      // Didn't confirm within window - expired
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

/**
 * Compare multiple confirmMovePct values
 */
export async function compareConfirmThresholds(
  thresholds: number[] = [0.20, 0.25, 0.30, 0.35, 0.40],
  windowSize: number = 200
): Promise<Array<{
  threshold: number;
  results: ValidationResult[];
  score: number;
}>> {
  const comparisons = [];
  
  for (const threshold of thresholds) {
    console.log(`[validation] Testing threshold ${threshold}%...`);
    const results = await validateDelayedEntry(threshold, [windowSize]);
    
    const result = results[0];
    
    // Calculate composite score
    // Balance: high R per 100 signals + reasonable confirm rate
    // Penalize very low confirm rates (<20%)
    const confirmRatePenalty = result && result.confirmRate < 0.20 ? 0.5 : 1.0;
    const score = result 
      ? (result.rPer100Signals * 0.7 + result.confirmRate * 30) * confirmRatePenalty
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
