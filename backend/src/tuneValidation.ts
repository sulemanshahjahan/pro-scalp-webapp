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

/**
 * Simulate 24h managed PnL outcome from 120m outcome
 * Uses Option B: 50% TP1, runner to TP2 or BE
 */
export function simulate24hManagedOutcome(
  signal: Signal,
  outcome120m: { status: 'WIN' | 'LOSS' | 'NO_HIT'; r: number },
  // Optional: actual 24h candles if available for precise simulation
  candles24h?: Array<{ high: number; low: number; close: number }>
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
  
  const isShort = signal.category?.includes('SHORT') || signal.category === 'READY_TO_SELL';
  const risk = Math.abs(entry - stop);
  const direction = isShort ? -1 : 1;
  
  // Determine TP1 and TP2 hit based on 120m outcome and randomization for realism
  // In a full implementation, this would use actual 24h candles
  
  let hitTp1 = false;
  let hitTp2 = false;
  let hitStop = false;
  
  if (outcome120m.status === 'WIN') {
    // If won in 120m, likely hit TP1, maybe TP2
    hitTp1 = true;
    hitTp2 = Math.random() < 0.4;  // 40% chance to reach TP2
  } else if (outcome120m.status === 'LOSS') {
    hitStop = true;
  } else {
    // NO_HIT - check if it would hit TP1 in 24h
    // Conservative estimate: 30% chance
    hitTp1 = Math.random() < 0.3;
  }
  
  // Calculate managed PnL (Option B)
  let realizedR = 0;
  let unrealizedR = 0;
  let exitPrice = entry;
  let exitReason = '';
  
  if (hitStop) {
    // Hit stop - full loss
    realizedR = -1;
    exitPrice = stop ?? entry;
    exitReason = 'stop_loss';
  } else if (hitTp2) {
    // Hit TP2 - 50% at TP1 (0.5R), 50% at TP2 (1.5R)
    realizedR = 0.5 + 1.5;  // 2R total
    exitPrice = tp2 ?? tp1 ?? entry;
    exitReason = 'tp2_full';
  } else if (hitTp1) {
    // Hit TP1 only - 50% at TP1 (0.5R), runner stopped out at BE
    const runnerOutcome = Math.random();
    if (runnerOutcome < 0.5) {
      // Runner hit BE
      realizedR = 0.5;  // TP1 only
      unrealizedR = 0;
      exitReason = 'tp1_be';
    } else if (runnerOutcome < 0.7) {
      // Runner hit stop (full position)
      realizedR = 0.5 - 0.5;  // TP1 - runner loss = 0
      exitReason = 'tp1_then_stop';
    } else {
      // Runner still running at 24h
      realizedR = 0.5;
      unrealizedR = 0.3;  // Estimated unrealized
      exitReason = 'tp1_open_runner';
    }
  } else {
    // No hit - timeout
    realizedR = 0;
    exitReason = 'timeout';
  }
  
  const finalR = realizedR + unrealizedR;
  
  // Determine status
  let status: ExtendedSimResult['outcome24h']['status'] = 'FLAT_TIMEOUT';
  if (hitStop && realizedR <= -0.5) {
    status = 'LOSS_STOP';
  } else if (hitTp2) {
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
    pnlUsd: finalR * (signal.riskPct || 0.01) * 1000,  // Estimated USD
    exitReason,
  } as any;
}

/**
 * Batch process 24h outcomes for multiple signals
 */
export function batchSimulate24hOutcomes(
  signals: Signal[],
  outcomes120m: Record<string, { status: 'WIN' | 'LOSS' | 'NO_HIT'; r: number }>
): ExtendedSimResult[] {
  return signals.map(signal => {
    const key = `${signal.symbol}|${signal.time}`;
    const outcome120m = outcomes120m[key] || { status: 'NO_HIT', r: 0 };
    
    const outcome24h = simulate24hManagedOutcome(signal, outcome120m);
    const difference = outcome24h.finalR - outcome120m.r;
    
    let recommendation: ExtendedSimResult['recommendation'] = 'inconclusive';
    if (Math.abs(difference) < 0.2) {
      recommendation = 'trust_120m';
    } else if (outcome24h.finalR > outcome120m.r) {
      recommendation = 'trust_24h';
    }
    
    return {
      signal,
      outcome120m,
      outcome24h,
      difference,
      recommendation,
    };
  });
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
