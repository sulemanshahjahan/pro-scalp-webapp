/**
 * Tune Validation Utilities
 * 
 * Provides parity checking, statistical validation, and 24h outcome simulation
 * to ensure simulator results match actual trading performance.
 */

import type { TuneConfig } from './tuneSim.js';
import type { Signal } from './types.js';
import { evaluateManagedPnl, ManagedPnlResult } from './managedPnlEvaluator.js';

// Sample size requirements for statistical significance
export const SAMPLE_SIZE_RULES = {
  watch: 50,
  early: 40,
  ready: 30,
  best: 20,
  watchShort: 50,
  earlyShort: 40,
  readyShort: 50,  // Higher threshold for new feature
  bestShort: 20,
};

// Minimum acceptable sample size for trustworthy results
export const MIN_SAMPLE_SIZE = 20;

// Statistical result with confidence metrics
export type StatisticalResult = {
  winRate: number;
  lossRate: number;
  timeoutRate: number;
  avgR: number;
  totalR: number;
  sampleSize: number;
  // Confidence metrics
  confidenceInterval: [number, number];  // 95% CI for win rate
  sharpeRatio: number;
  profitFactor: number;
  maxDrawdownR: number;
  // Reliability flags
  isSignificant: boolean;
  warning?: string;
};

// Parity mismatch between sim and actual
export type ParityMismatch = {
  symbol: string;
  runId: string;
  simCategory: string;
  actualCategory: string | null;
  reason: 'missing_in_actual' | 'category_mismatch' | 'not_logged';
  firstFailedGate?: string;
};

// Parity validation result
export type ParityValidation = {
  isValid: boolean;
  mismatches: ParityMismatch[];
  simCounts: Record<string, number>;
  actualCounts: Record<string, number>;
  divergence: number;  // Percentage divergence (0-100)
  warnings: string[];
};

// 24h Extended outcome simulation result
export type ExtendedSimResult = {
  signal: Signal;
  // 120m outcome (existing)
  outcome120m: {
    status: 'WIN' | 'LOSS' | 'NO_HIT';
    r: number;
  };
  // 24h managed outcome (Option B)
  outcome24h: ManagedPnlResult & {
    status: 'WIN_TP1' | 'WIN_TP2' | 'LOSS_STOP' | 'FLAT_TIMEOUT';
    finalR: number;
  };
  // Comparison
  difference: number;  // 24hR - 120mR
  recommendation: 'trust_120m' | 'trust_24h' | 'inconclusive';
};

/**
 * Calculate 95% confidence interval for win rate using Wilson score
 */
function wilsonScoreInterval(wins: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  
  const p = wins / total;
  const z = 1.96;  // 95% confidence
  const n = total;
  
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const width = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n) / denominator;
  
  return [
    Math.max(0, centre - width),
    Math.min(1, centre + width)
  ];
}

/**
 * Calculate Sharpe ratio from R returns
 */
function calculateSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  
  return stdDev === 0 ? 0 : mean / stdDev;
}

/**
 * Calculate Profit Factor (gross wins / gross losses)
 */
function calculateProfitFactor(returns: number[]): number {
  const grossWins = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  
  return grossLosses === 0 ? (grossWins > 0 ? Infinity : 0) : grossWins / grossLosses;
}

/**
 * Calculate maximum drawdown in R
 */
function calculateMaxDrawdown(returns: number[]): number {
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  
  for (const r of returns) {
    cumulative += r;
    if (cumulative > peak) {
      peak = cumulative;
    }
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }
  
  return maxDrawdown;
}

/**
 * Build statistical summary with confidence metrics
 */
export function buildStatisticalSummary(
  outcomes: Array<{ status: string; r: number }>,
  category: string
): StatisticalResult {
  const sampleSize = outcomes.length;
  
  const wins = outcomes.filter(o => o.status === 'WIN' || o.status.includes('TP')).length;
  const losses = outcomes.filter(o => o.status === 'LOSS' || o.status === 'LOSS_STOP').length;
  const timeouts = outcomes.filter(o => o.status.includes('TIMEOUT') || o.status === 'NO_HIT').length;
  
  const winRate = sampleSize > 0 ? wins / sampleSize : 0;
  const lossRate = sampleSize > 0 ? losses / sampleSize : 0;
  const timeoutRate = sampleSize > 0 ? timeouts / sampleSize : 0;
  
  const returns = outcomes.map(o => o.r).filter((r): r is number => Number.isFinite(r));
  const avgR = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const totalR = returns.reduce((a, b) => a + b, 0);
  
  // Confidence interval
  const confidenceInterval = wilsonScoreInterval(wins, sampleSize);
  
  // Advanced metrics
  const sharpeRatio = calculateSharpe(returns);
  const profitFactor = calculateProfitFactor(returns);
  const maxDrawdownR = calculateMaxDrawdown(returns);
  
  // Check significance
  const minSize = SAMPLE_SIZE_RULES[category as keyof typeof SAMPLE_SIZE_RULES] || MIN_SAMPLE_SIZE;
  const isSignificant = sampleSize >= minSize;
  
  let warning: string | undefined;
  if (sampleSize < minSize) {
    warning = `Sample size (${sampleSize}) below minimum (${minSize}). Results may not be reliable.`;
  } else if (confidenceInterval[1] - confidenceInterval[0] > 0.3) {
    warning = `Wide confidence interval (${(confidenceInterval[0] * 100).toFixed(1)}% - ${(confidenceInterval[1] * 100).toFixed(1)}%). More data needed.`;
  }
  
  return {
    winRate,
    lossRate,
    timeoutRate,
    avgR,
    totalR,
    sampleSize,
    confidenceInterval,
    sharpeRatio,
    profitFactor,
    maxDrawdownR,
    isSignificant,
    warning,
  };
}

/**
 * Validate parity between simulator and actual scanner
 */
export function validateParity(params: {
  simCounts: Record<string, number>;
  actualCounts: Record<string, number> | null;
  mismatches: ParityMismatch[];
  tolerance?: number;
}): ParityValidation {
  const { simCounts, actualCounts, mismatches, tolerance = 0.1 } = params;
  
  const warnings: string[] = [];
  let divergence = 0;
  
  // Calculate divergence
  if (actualCounts) {
    const categories = new Set([...Object.keys(simCounts), ...Object.keys(actualCounts)]);
    let totalDiff = 0;
    let total = 0;
    
    for (const cat of categories) {
      const sim = simCounts[cat] || 0;
      const actual = actualCounts[cat] || 0;
      totalDiff += Math.abs(sim - actual);
      total += Math.max(sim, actual);
    }
    
    divergence = total > 0 ? (totalDiff / total) * 100 : 0;
  }
  
  // Check short signal logging
  const hasShortMismatches = mismatches.some(m => 
    m.simCategory.includes('SHORT') || m.simCategory === 'READY_TO_SELL'
  );
  
  if (hasShortMismatches) {
    warnings.push('Short signal mismatches detected. Check SIGNAL_LOG_CATS env var includes READY_TO_SELL and BEST_SHORT_ENTRY.');
  }
  
  // Check for systematic bias
  if (actualCounts) {
    const simTotal = Object.values(simCounts).reduce((a, b) => a + b, 0);
    const actualTotal = Object.values(actualCounts).reduce((a, b) => a + b, 0);
    
    if (simTotal > actualTotal * 1.5) {
      warnings.push(`Simulator generates ${(simTotal / actualTotal).toFixed(1)}x more signals than actual. Check gate synchronization.`);
    }
  }
  
  // Determine validity
  const isValid = mismatches.length === 0 || divergence < tolerance * 100;
  
  if (!isValid) {
    warnings.push(`Parity divergence: ${divergence.toFixed(1)}%. Simulator results may not reflect actual performance.`);
  }
  
  return {
    isValid,
    mismatches,
    simCounts,
    actualCounts: actualCounts || {},
    divergence,
    warnings,
  };
}

import { klinesRange } from './binance.js';
import type { OHLCV } from './types.js';

/**
 * Simulate 24h managed PnL outcome using ACTUAL Binance price data
 * Uses Option B: 50% TP1, runner to TP2 or BE
 * 
 * Fetches real 24h candles from Binance and walks through them to determine
 * exactly which level (TP1, TP2, SL) gets hit first within 24 hours.
 */
export async function simulate24hManagedOutcome(
  signal: Signal,
  outcome120m?: { status: 'WIN' | 'LOSS' | 'NO_HIT'; r: number }
): Promise<ExtendedSimResult['outcome24h']> {
  const entry = signal.price;
  const stop = signal.stop;
  const tp1 = signal.tp1;
  const tp2 = signal.tp2;
  
  if (!entry || !stop || !tp1) {
    return {
      status: 'FLAT_TIMEOUT',
      finalR: 0,
      exitPrice: entry,
      realizedR: 0,
      unrealizedR: 0,
      pnlUsd: 0,
      exitReason: 'invalid_levels',
    } as any;
  }
  
  const isShort = signal.category?.includes('SHORT') || signal.category === 'READY_TO_SELL';
  const risk = Math.abs(entry - stop);
  
  // Calculate R multiple for each level
  const tp1R = tp1 ? Math.abs(tp1 - entry) / risk : 1;
  const tp2R = tp2 ? Math.abs(tp2 - entry) / risk : tp1R * 2;
  
  try {
    // Fetch 24h of 5m candles from Binance (288 candles = 24h)
    const startTime = signal.time;
    const endTime = startTime + (24 * 60 * 60 * 1000); // 24h later
    
    const candles = await klinesRange(signal.symbol, '5m', startTime, endTime, 1000);
    
    if (!candles.length) {
      // Fallback: use 120m outcome if available
      return simulateFrom120mOutcome(signal, outcome120m);
    }
    
    // Walk through candles to find which level hits first
    let hitTp1 = false;
    let hitTp2 = false;
    let hitStop = false;
    let tp1HitTime: number | null = null;
    let stopHitTime: number | null = null;
    let tp2HitTime: number | null = null;
    
    for (const candle of candles) {
      const { high, low } = candle;
      
      if (isShort) {
        // Short: TP is below entry, SL is above entry
        if (!hitTp1 && tp1 && low <= tp1) {
          hitTp1 = true;
          tp1HitTime = candle.time;
        }
        if (!hitTp2 && tp2 && low <= tp2) {
          hitTp2 = true;
          tp2HitTime = candle.time;
        }
        if (!hitStop && high >= stop) {
          hitStop = true;
          stopHitTime = candle.time;
        }
      } else {
        // Long: TP is above entry, SL is below entry
        if (!hitTp1 && tp1 && high >= tp1) {
          hitTp1 = true;
          tp1HitTime = candle.time;
        }
        if (!hitTp2 && tp2 && high >= tp2) {
          hitTp2 = true;
          tp2HitTime = candle.time;
        }
        if (!hitStop && low <= stop) {
          hitStop = true;
          stopHitTime = candle.time;
        }
      }
      
      // Stop if all levels hit or we've processed 24h
      if ((hitTp2 || !tp2) && hitTp1 && hitStop) break;
    }
    
    // Determine order of hits for Option B management
    // Option B: 50% position closes at TP1, runner continues to TP2 or BE
    let realizedR = 0;
    let unrealizedR = 0;
    let exitPrice = entry;
    let exitReason = '';
    
    if (hitStop && (!tp1HitTime || stopHitTime! <= tp1HitTime)) {
      // Stop hit before or at same time as TP1 - full loss
      realizedR = -1;
      exitPrice = stop;
      exitReason = 'stop_loss_first';
    } else if (hitTp2 && tp2HitTime && (!tp1HitTime || tp2HitTime <= tp1HitTime)) {
      // TP2 hit first or at same time - full position at TP2
      // But Option B would have taken TP1 first if it was available
      // This is an edge case - assume we got TP1 before TP2
      realizedR = 0.5 + 1.5; // 2R total
      exitPrice = tp2 ?? tp1 ?? entry;
      exitReason = 'tp2_direct';
    } else if (hitTp1) {
      // TP1 hit first - Option B applies
      // 50% at TP1 = 0.5R realized immediately
      realizedR = 0.5 * tp1R;
      
      // Check what happens to the runner
      if (hitTp2 && tp2HitTime && tp1HitTime && tp2HitTime > tp1HitTime) {
        // Runner hit TP2 after TP1
        realizedR += 0.5 * tp2R; // Rest at TP2
        exitPrice = tp2 ?? tp1 ?? entry;
        exitReason = 'tp1_then_tp2';
      } else if (hitStop && stopHitTime && tp1HitTime && stopHitTime > tp1HitTime) {
        // Runner hit stop after TP1 - move to BE
        realizedR += 0; // Runner stopped at BE
        exitPrice = entry; // Breakeven for runner
        exitReason = 'tp1_then_be';
      } else {
        // Runner still open at end of 24h
        // Mark to market at last candle close
        const lastCandle = candles[candles.length - 1];
        const runnerPnl = isShort 
          ? (entry - lastCandle.close) / risk
          : (lastCandle.close - entry) / risk;
        unrealizedR = 0.5 * Math.max(-1, Math.min(tp2R, runnerPnl)); // Capped
        exitPrice = lastCandle.close;
        exitReason = 'tp1_open_runner_24h';
      }
    } else if (hitStop) {
      // Only stop hit (no TP1) - full loss
      realizedR = -1;
      exitPrice = stop;
      exitReason = 'stop_only';
    } else {
      // No levels hit in 24h - mark to market
      const lastCandle = candles[candles.length - 1];
      const mtmR = isShort 
        ? (entry - lastCandle.close) / risk
        : (lastCandle.close - entry) / risk;
      unrealizedR = Math.max(-1, Math.min(tp2R, mtmR)); // Capped at stop/tp2
      exitPrice = lastCandle.close;
      exitReason = 'timeout_mtm';
    }
    
    const finalR = realizedR + unrealizedR;
    
    // Determine status
    let status: ExtendedSimResult['outcome24h']['status'] = 'FLAT_TIMEOUT';
    if (hitStop && realizedR <= -0.5) {
      status = 'LOSS_STOP';
    } else if (hitTp2 && realizedR >= 1.0) {
      status = 'WIN_TP2';
    } else if (hitTp1 && realizedR > 0) {
      status = 'WIN_TP1';
    }
    
    return {
      status,
      finalR,
      exitPrice,
      realizedR,
      unrealizedR,
      pnlUsd: finalR * (signal.riskPct || 0.01) * 1000,
      exitReason,
    } as any;
    
  } catch (error) {
    // Fallback to 120m outcome if Binance fetch fails
    console.warn(`Failed to fetch 24h candles for ${signal.symbol}:`, error);
    return simulateFrom120mOutcome(signal, outcome120m);
  }
}

/**
 * Fallback simulation using 120m outcome when Binance data unavailable
 */
function simulateFrom120mOutcome(
  signal: Signal,
  outcome120m?: { status: 'WIN' | 'LOSS' | 'NO_HIT'; r: number }
): ExtendedSimResult['outcome24h'] {
  const entry = signal.price;
  const stop = signal.stop;
  const tp1 = signal.tp1;
  const tp2 = signal.tp2;
  
  if (!entry || !stop || !tp1) {
    return {
      status: 'FLAT_TIMEOUT',
      finalR: 0,
      exitPrice: entry,
      realizedR: 0,
      unrealizedR: 0,
      pnlUsd: 0,
      exitReason: 'invalid_levels',
    } as any;
  }
  
  // Conservative estimate based on 120m outcome
  let realizedR = 0;
  let exitReason = 'unknown';
  
  if (!outcome120m || outcome120m.status === 'NO_HIT') {
    realizedR = 0;
    exitReason = 'timeout_fallback';
  } else if (outcome120m.status === 'WIN') {
    // Assume TP1 hit
    realizedR = 0.5;
    exitReason = 'tp1_fallback';
  } else {
    // Loss
    realizedR = -1;
    exitReason = 'stop_fallback';
  }
  
  const status = realizedR > 0 ? 'WIN_TP1' : realizedR < 0 ? 'LOSS_STOP' : 'FLAT_TIMEOUT';
  
  return {
    status,
    finalR: realizedR,
    exitPrice: realizedR > 0 ? tp1 : realizedR < 0 ? stop : entry,
    realizedR,
    unrealizedR: 0,
    pnlUsd: realizedR * (signal.riskPct || 0.01) * 1000,
    exitReason,
  } as any;
}

/**
 * Batch process 24h outcomes for multiple signals
 * Fetches real Binance data for accurate simulation
 */
export async function batchSimulate24hOutcomes(
  signals: Signal[],
  outcomes120m?: Record<string, { status: 'WIN' | 'LOSS' | 'NO_HIT'; r: number }>
): Promise<ExtendedSimResult[]> {
  const results: ExtendedSimResult[] = [];
  
  // Process in batches to avoid rate limits (max 10 concurrent)
  const BATCH_SIZE = 5;
  const DELAY_MS = 200; // 200ms between batches
  
  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    const batch = signals.slice(i, i + BATCH_SIZE);
    
    const batchPromises = batch.map(async (signal) => {
      const key = `${signal.symbol}|${signal.time}`;
      const outcome120m = outcomes120m?.[key];
      
      const outcome24h = await simulate24hManagedOutcome(signal, outcome120m);
      const r120m = outcome120m?.r ?? 0;
      const difference = outcome24h.finalR - r120m;
      
      let recommendation: ExtendedSimResult['recommendation'] = 'inconclusive';
      if (Math.abs(difference) < 0.2) {
        recommendation = 'trust_120m';
      } else if (outcome24h.finalR > r120m) {
        recommendation = 'trust_24h';
      }
      
      return {
        signal,
        outcome120m: outcome120m || { status: 'NO_HIT', r: 0 },
        outcome24h,
        difference,
        recommendation,
      };
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    // Rate limiting delay between batches
    if (i + BATCH_SIZE < signals.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }
  
  return results;
}

/**
 * Check if sample size is adequate for a category
 */
export function checkSampleSize(category: string, count: number): { adequate: boolean; message?: string } {
  const minSize = SAMPLE_SIZE_RULES[category as keyof typeof SAMPLE_SIZE_RULES] || MIN_SAMPLE_SIZE;
  
  if (count >= minSize) {
    return { adequate: true };
  }
  
  if (count >= minSize * 0.5) {
    return { 
      adequate: false, 
      message: `Sample size ${count}/${minSize} (50%+). Results are directional but not conclusive.` 
    };
  }
  
  return { 
    adequate: false, 
    message: `Sample size ${count}/${minSize} (<50%). Results are unreliable. Collect more data.` 
  };
}
