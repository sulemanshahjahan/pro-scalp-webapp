/**
 * Signal Gate - HARD Execution Filter
 * 
 * This module provides the HARD GATE that blocks signals BEFORE they are recorded.
 * This is the execution layer - not just analysis.
 * 
 * Rules (based on user requirements):
 * 1. Block RED tier symbols (or require 0.5% MFE)
 * 2. Require MFE30m >= 0.3% (minimum momentum proof)
 * 3. Require MQS >= 0.2 (momentum quality)
 * 4. Combined score >= 2 (confluence of conditions)
 * 5. Track blocked signals for analysis
 */

import type { Signal } from './types.js';
import { getSymbolTier } from './symbolTierStore.js';

// ============================================================================
// CONFIGURATION (Hard-coded for execution reliability)
// ============================================================================

export interface GateConfig {
  // Master switch
  enabled: boolean;
  
  // Hard rules
  blockRedTier: boolean;
  minMfe30mPct: number;
  redTierMinMfe30mPct: number;
  minMqs: number;
  
  // Combined score (confluence)
  useCombinedScore: boolean;
  minCombinedScore: number;
  
  // 15m confirmation (early movement proof)
  require15mConfirmation: boolean;
  minMfe15mPct: number;
  
  // Target: reduce signals by 40-60%
  targetReductionPct: number;
}

// DEFAULT: Aggressive filtering to cut bad trades
export const DEFAULT_GATE_CONFIG: GateConfig = {
  enabled: true,
  blockRedTier: true,
  minMfe30mPct: 0.30,      // 0.3% MFE in first 30m
  redTierMinMfe30mPct: 0.50, // 0.5% for RED symbols (if not blocked)
  minMqs: 0.20,             // MQS >= 0.2
  useCombinedScore: true,   // Require multiple conditions
  minCombinedScore: 2,      // Need 2+ points to pass
  require15mConfirmation: false, // Optional: wait for 15m proof
  minMfe15mPct: 0.20,       // 0.2% in first 15m
  targetReductionPct: 50,   // Aim to cut 50% of signals
};

// Get config from environment with defaults
export function getGateConfig(): GateConfig {
  return {
    enabled: (process.env.SIGNAL_GATE_ENABLED || 'true').toLowerCase() === 'true',
    blockRedTier: (process.env.SIGNAL_GATE_BLOCK_RED || 'true').toLowerCase() === 'true',
    minMfe30mPct: parseFloat(process.env.SIGNAL_GATE_MIN_MFE30M || '0.30'),
    redTierMinMfe30mPct: parseFloat(process.env.SIGNAL_GATE_RED_MIN_MFE30M || '0.50'),
    minMqs: parseFloat(process.env.SIGNAL_GATE_MIN_MQS || '0.20'),
    useCombinedScore: (process.env.SIGNAL_GATE_USE_SCORE || 'true').toLowerCase() === 'true',
    minCombinedScore: parseInt(process.env.SIGNAL_GATE_MIN_SCORE || '2', 10),
    require15mConfirmation: (process.env.SIGNAL_GATE_15M || 'false').toLowerCase() === 'true',
    minMfe15mPct: parseFloat(process.env.SIGNAL_GATE_MIN_MFE15M || '0.20'),
    targetReductionPct: parseInt(process.env.SIGNAL_GATE_TARGET_REDUCTION || '50', 10),
  };
}

// ============================================================================
// SIGNAL QUALITY SCORE
// ============================================================================

export type SignalQuality = 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECTED';

export interface SignalScore {
  total: number;
  mfe30m: number;
  mqs: number;
  tier: number;
  speed: number;
  mfe15m: number;
}

export interface GateResult {
  allowed: boolean;
  quality: SignalQuality;
  score: SignalScore;
  totalScore: number;
  reasons: string[];
  tier: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  mqs: number;
}

/**
 * Calculate MQS (Momentum Quality Score)
 */
export function calculateMQS(mfe: number, mae: number): number {
  if (!mae || mae <= 0) return mfe > 0 ? 999 : 0;
  return mfe / mae;
}

/**
 * Calculate combined score for a signal
 * Each condition worth 1 point - need confluence
 */
export function calculateSignalScore(
  mfe30mPct: number,
  mae30mPct: number,
  mfe15mPct: number | null,
  tp1Within45m: boolean | null,
  tier: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN',
  config?: Partial<GateConfig>
): { score: SignalScore; total: number; mqs: number; quality: SignalQuality } {
  const cfg = { ...DEFAULT_GATE_CONFIG, ...config };
  const mqs = calculateMQS(mfe30mPct, mae30mPct);
  
  const score: SignalScore = {
    total: 0,
    mfe30m: 0,
    mqs: 0,
    tier: 0,
    speed: 0,
    mfe15m: 0,
  };
  
  // MFE30m check (momentum proof)
  let requiredMfe = cfg.minMfe30mPct;
  if (tier === 'RED') requiredMfe = cfg.redTierMinMfe30mPct;
  
  if (mfe30mPct >= requiredMfe) {
    score.mfe30m = 1;
    score.total++;
  }
  
  // MQS check (quality)
  if (mqs >= cfg.minMqs) {
    score.mqs = 1;
    score.total++;
  }
  
  // Tier bonus (GREEN = easier to pass)
  if (tier === 'GREEN') {
    score.tier = 1;
    score.total++;
  }
  
  // Speed bonus (quick TP1)
  if (tp1Within45m === true) {
    score.speed = 1;
    score.total++;
  }
  
  // 15m confirmation
  if (mfe15mPct !== null && mfe15mPct >= cfg.minMfe15mPct) {
    score.mfe15m = 1;
    score.total++;
  }
  
  // Determine quality
  let quality: SignalQuality;
  if (score.total >= 3) quality = 'HIGH';
  else if (score.total >= 2) quality = 'MEDIUM';
  else if (score.total >= 1) quality = 'LOW';
  else quality = 'REJECTED';
  
  return { score, total: score.total, mqs, quality };
}

// ============================================================================
// HARD GATE FUNCTION
// ============================================================================

/**
 * THE HARD GATE - Blocks signals before they are recorded
 * 
 * This is called BEFORE recordSignal() in the scan flow.
 * If it returns allowed=false, the signal is dropped.
 */
export async function checkSignalGate(
  signal: Signal & {
    mfe30mPct?: number;
    mae30mPct?: number;
    mfe15mPct?: number;
    tp1Within45m?: boolean;
  },
  config?: Partial<GateConfig>
): Promise<GateResult> {
  const cfg = { ...getGateConfig(), ...config };
  
  // If gate is disabled, allow everything
  if (!cfg.enabled) {
    return {
      allowed: true,
      quality: 'HIGH',
      score: { total: 5, mfe30m: 1, mqs: 1, tier: 1, speed: 1, mfe15m: 1 },
      totalScore: 5,
      reasons: ['GATE_DISABLED'],
      tier: 'UNKNOWN',
      mqs: 0,
    };
  }
  
  // Get direction
  const shortCategories = ['READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT'];
  const direction = shortCategories.includes(signal.category.toUpperCase()) ? 'SHORT' : 'LONG';
  
  // Look up symbol tier
  const tierRecord = await getSymbolTier(signal.symbol, direction);
  const tier = tierRecord?.tier || 'YELLOW'; // Default cautious
  
  // Get early metrics (may be missing for new signals)
  const mfe30m = signal.mfe30mPct ?? 0;
  const mae30m = signal.mae30mPct ?? 0.001;
  const mfe15m = signal.mfe15mPct ?? null;
  const tp1Within45m = signal.tp1Within45m ?? null;
  
  // Calculate score
  const { score, total, mqs, quality } = calculateSignalScore(
    mfe30m, mae30m, mfe15m, tp1Within45m, tier, cfg
  );
  
  const reasons: string[] = [];
  
  // Hard rule 1: Block RED tier
  if (cfg.blockRedTier && tier === 'RED') {
    return {
      allowed: false,
      quality: 'REJECTED',
      score,
      totalScore: total,
      reasons: ['RED_TIER_BLOCKED', `Symbol ${signal.symbol} is RED tier (${tierRecord?.winRate ? (tierRecord.winRate * 100).toFixed(0) : 'N/A'}% win rate)`],
      tier,
      mqs,
    };
  }
  
  // Hard rule 2: Combined score check (confluence)
  if (cfg.useCombinedScore && total < cfg.minCombinedScore) {
    if (score.mfe30m === 0) reasons.push(`MFE30m too low: ${(mfe30m * 100).toFixed(2)}% < ${(cfg.minMfe30mPct * 100).toFixed(0)}% required`);
    if (score.mqs === 0) reasons.push(`MQS too low: ${mqs.toFixed(2)} < ${cfg.minMqs} required`);
    if (score.tier === 0 && tier !== 'GREEN') reasons.push(`Symbol tier not GREEN: ${tier}`);
    
    return {
      allowed: false,
      quality: 'REJECTED',
      score,
      totalScore: total,
      reasons,
      tier,
      mqs,
    };
  }
  
  // Hard rule 3: 15m confirmation (if enabled)
  if (cfg.require15mConfirmation && mfe15m !== null && mfe15m < cfg.minMfe15mPct) {
    return {
      allowed: false,
      quality: 'REJECTED',
      score,
      totalScore: total,
      reasons: [`15m confirmation failed: MFE15m ${(mfe15m * 100).toFixed(2)}% < ${(cfg.minMfe15mPct * 100).toFixed(0)}%`],
      tier,
      mqs,
    };
  }
  
  // All checks passed
  return {
    allowed: true,
    quality,
    score,
    totalScore: total,
    reasons: ['PASSED_ALL_CHECKS'],
    tier,
    mqs,
  };
}

// ============================================================================
// BATCH FILTERING FOR EXISTING SIGNALS
// ============================================================================

export interface BatchGateResult {
  allowed: Array<Signal & { quality: SignalQuality; score: number }>;
  blocked: Array<Signal & { reasons: string[]; tier: string; score: number }>;
  stats: {
    total: number;
    allowed: number;
    blocked: number;
    reductionPct: number;
    byQuality: Record<SignalQuality, number>;
    byTier: Record<string, number>;
  };
}

export async function filterSignalsThroughGate(
  signals: Array<Signal & {
    mfe30mPct?: number;
    mae30mPct?: number;
    mfe15mPct?: number;
    tp1Within45m?: boolean;
  }>,
  config?: Partial<GateConfig>
): Promise<BatchGateResult> {
  const allowed: BatchGateResult['allowed'] = [];
  const blocked: BatchGateResult['blocked'] = [];
  const byQuality: Partial<Record<SignalQuality, number>> = {};
  const byTier: Record<string, number> = {};
  
  for (const signal of signals) {
    const result = await checkSignalGate(signal, config);
    
    if (result.allowed) {
      allowed.push({ ...signal, quality: result.quality, score: result.totalScore });
    } else {
      blocked.push({ 
        ...signal, 
        reasons: result.reasons, 
        tier: result.tier,
        score: result.totalScore 
      });
    }
    
    byQuality[result.quality] = (byQuality[result.quality] || 0) + 1;
    byTier[result.tier] = (byTier[result.tier] || 0) + 1;
  }
  
  const total = signals.length;
  const blockedCount = blocked.length;
  
  return {
    allowed,
    blocked,
    stats: {
      total,
      allowed: allowed.length,
      blocked: blockedCount,
      reductionPct: total > 0 ? (blockedCount / total) * 100 : 0,
      byQuality: byQuality as Record<SignalQuality, number>,
      byTier,
    },
  };
}

// ============================================================================
// METRICS TRACKING
// ============================================================================

let gateStats = {
  totalChecked: 0,
  totalBlocked: 0,
  blockedByRed: 0,
  blockedByScore: 0,
  blockedBy15m: 0,
  passedHigh: 0,
  passedMedium: 0,
  passedLow: 0,
};

export function recordGateResult(result: GateResult): void {
  gateStats.totalChecked++;
  
  if (!result.allowed) {
    gateStats.totalBlocked++;
    if (result.reasons.some(r => r.includes('RED'))) gateStats.blockedByRed++;
    if (result.reasons.some(r => r.includes('score') || r.includes('SCORE'))) gateStats.blockedByScore++;
    if (result.reasons.some(r => r.includes('15m'))) gateStats.blockedBy15m++;
  } else {
    if (result.quality === 'HIGH') gateStats.passedHigh++;
    else if (result.quality === 'MEDIUM') gateStats.passedMedium++;
    else if (result.quality === 'LOW') gateStats.passedLow++;
  }
}

export function getGateStats() {
  return { ...gateStats };
}

export function resetGateStats(): void {
  gateStats = {
    totalChecked: 0,
    totalBlocked: 0,
    blockedByRed: 0,
    blockedByScore: 0,
    blockedBy15m: 0,
    passedHigh: 0,
    passedMedium: 0,
    passedLow: 0,
  };
}
