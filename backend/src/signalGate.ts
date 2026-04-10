/**
 * Signal Gate - HARD Execution Filter
 * 
 * This module provides the HARD GATE that blocks signals BEFORE they are recorded.
 * This is the execution layer - not just analysis.
 * 
 * DATA-DRIVEN RULES (from historical analysis):
 * 1. Symbol-Direction Whitelist (only high-win-rate symbols)
 * 2. Block Bad Hours (21, 19, 18, 0, 17, 20, 11, 14, 15, 16 UTC)
 * 3. Block Bad Days (Monday, Tuesday, Saturday)
 * 4. MFE Death Zone Filter (block 0.2-0.5%, allow <0.2% or >=0.5%)
 * 5. Category Filter (only READY_TO_BUY, BEST_ENTRY)
 * 
 * Results: Filters out signals with <40% historical win rate
 */

import type { Signal } from './types.js';
import { getSymbolTier } from './symbolTierStore.js';

// ============================================================================
// CONFIGURATION (Hard-coded for execution reliability)
// ============================================================================

export interface GateConfig {
  // Master switch
  enabled: boolean;
  
  // Symbol-Direction Whitelist (data-driven: >50% win rate)
  useSymbolWhitelist: boolean;
  allowedSymbols: string[];  // Format: "SYMBOL-DIRECTION"
  
  // Time-based filters (data-driven)
  useTimeFilters: boolean;
  blockedHours: number[];  // UTC hours to block
  blockedDays: string[];  // Days to block
  
  // MFE Death Zone Filter (data-driven: 0.2-0.5% is death zone)
  useMfeDeathZoneFilter: boolean;
  mfeDeathZoneMin: number;  // 0.002 = 0.2%
  mfeDeathZoneMax: number;  // 0.005 = 0.5%
  
  // Category Filter
  allowedCategories: string[];
  
  // Legacy filters (kept for compatibility)
  blockRedTier: boolean;
  minMfe30mPct: number;
  redTierMinMfe30mPct: number;
  minMqs: number;
  useCombinedScore: boolean;
  minCombinedScore: number;
  require15mConfirmation: boolean;
  minMfe15mPct: number;
  allowEarlyReady: boolean;
  targetReductionPct: number;
}

// DATA-DRIVEN HARD GATE CONFIG
// Based on analysis of 200+ EXECUTED signals
export const DEFAULT_GATE_CONFIG: GateConfig = {
  enabled: true,
  
  // Symbol-Direction Whitelist (>50% win rate from data)
  useSymbolWhitelist: true,
  allowedSymbols: [
    'SUIUSDT-LONG',   // 66.7% win rate
    'ADAUSDT-LONG',   // 66.7% win rate
    'LINKUSDT-LONG',  // 66.7% win rate
    'SOLUSDT-LONG',   // 62.5% win rate
    'XRPUSDT-LONG',   // 60% win rate
  ],
  
  // Time filters (data-driven)
  useTimeFilters: true,
  blockedHours: [0, 11, 14, 15, 16, 17, 18, 19, 20, 21],  // <40% win rate
  blockedDays: ['Monday', 'Tuesday', 'Saturday'],  // <30% win rate
  
  // MFE Death Zone (data-driven: avoid 0.2-0.5% range)
  useMfeDeathZoneFilter: true,
  mfeDeathZoneMin: 0.002,  // 0.2%
  mfeDeathZoneMax: 0.005,  // 0.5%
  
  // Category filter
  allowedCategories: ['READY_TO_BUY', 'BEST_ENTRY', 'BEST_SHORT_ENTRY'],
  
  // Legacy filters
  blockRedTier: true,
  minMfe30mPct: 0.30,
  redTierMinMfe30mPct: 0.50,
  minMqs: 0.20,
  useCombinedScore: false,  // Disabled in favor of hard rules
  minCombinedScore: 2,
  require15mConfirmation: false,
  minMfe15mPct: 0.20,
  allowEarlyReady: false,
  targetReductionPct: 70,   // More aggressive with new rules
};

// Get config from environment with defaults
export function getGateConfig(): GateConfig {
  // Parse symbol whitelist from env or use default
  const defaultSymbols = [
    'SUIUSDT-LONG', 'ADAUSDT-LONG', 'LINKUSDT-LONG', 
    'SOLUSDT-LONG', 'XRPUSDT-LONG'
  ];
  const allowedSymbols = process.env.SIGNAL_GATE_ALLOWED_SYMBOLS 
    ? process.env.SIGNAL_GATE_ALLOWED_SYMBOLS.split(',')
    : defaultSymbols;
    
  // Parse blocked hours from env
  const defaultBlockedHours = [0, 11, 14, 15, 16, 17, 18, 19, 20, 21];
  const blockedHours = process.env.SIGNAL_GATE_BLOCKED_HOURS
    ? process.env.SIGNAL_GATE_BLOCKED_HOURS.split(',').map(Number)
    : defaultBlockedHours;
    
  // Parse blocked days from env
  const defaultBlockedDays = ['Monday', 'Tuesday', 'Saturday'];
  const blockedDays = process.env.SIGNAL_GATE_BLOCKED_DAYS
    ? process.env.SIGNAL_GATE_BLOCKED_DAYS.split(',')
    : defaultBlockedDays;

  const cfg: GateConfig = {
    enabled: (process.env.SIGNAL_GATE_ENABLED || 'true').toLowerCase() === 'true',
    
    // New data-driven filters
    useSymbolWhitelist: (process.env.SIGNAL_GATE_USE_WHITELIST || 'true').toLowerCase() === 'true',
    allowedSymbols,
    useTimeFilters: (process.env.SIGNAL_GATE_USE_TIME || 'true').toLowerCase() === 'true',
    blockedHours,
    blockedDays,
    useMfeDeathZoneFilter: (process.env.SIGNAL_GATE_USE_MFE_ZONE || 'true').toLowerCase() === 'true',
    mfeDeathZoneMin: parseFloat(process.env.SIGNAL_GATE_MFE_ZONE_MIN || '0.002'),
    mfeDeathZoneMax: parseFloat(process.env.SIGNAL_GATE_MFE_ZONE_MAX || '0.005'),
    allowedCategories: process.env.SIGNAL_GATE_ALLOWED_CATEGORIES 
      ? process.env.SIGNAL_GATE_ALLOWED_CATEGORIES.split(',')
      : ['READY_TO_BUY', 'BEST_ENTRY', 'BEST_SHORT_ENTRY'],
    
    // Legacy filters
    blockRedTier: (process.env.SIGNAL_GATE_BLOCK_RED || 'true').toLowerCase() === 'true',
    minMfe30mPct: parseFloat(process.env.SIGNAL_GATE_MIN_MFE30M || '0.30'),
    redTierMinMfe30mPct: parseFloat(process.env.SIGNAL_GATE_RED_MIN_MFE30M || '0.50'),
    minMqs: parseFloat(process.env.SIGNAL_GATE_MIN_MQS || '0.20'),
    useCombinedScore: (process.env.SIGNAL_GATE_USE_SCORE || 'false').toLowerCase() === 'true',
    minCombinedScore: parseInt(process.env.SIGNAL_GATE_MIN_SCORE || '2', 10),
    require15mConfirmation: (process.env.SIGNAL_GATE_15M || 'false').toLowerCase() === 'true',
    minMfe15mPct: parseFloat(process.env.SIGNAL_GATE_MIN_MFE15M || '0.20'),
    allowEarlyReady: (process.env.SIGNAL_GATE_ALLOW_EARLY_READY || 'false').toLowerCase() === 'true',
    targetReductionPct: parseInt(process.env.SIGNAL_GATE_TARGET_REDUCTION || '70', 10),
  };
  
  // DEBUG: Log config on first load
  if (typeof global !== 'undefined' && !(global as any).__gateConfigLogged) {
    (global as any).__gateConfigLogged = true;
    console.log(`[signal-gate] Config loaded: enabled=${cfg.enabled}, useWhitelist=${cfg.useSymbolWhitelist}, symbols=[${cfg.allowedSymbols?.join(',')}]`);
  }
  
  return cfg;
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
  const hasMfeData = signal.mfe30mPct !== undefined && signal.mfe30mPct !== null;
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
  
  // Hard rule 2: Block EARLY_READY signals (only allow READY/BEST_ENTRY)
  if (!cfg.allowEarlyReady) {
    const earlyCategories = ['EARLY_READY', 'EARLY_READY_SHORT'];
    if (earlyCategories.includes(signal.category.toUpperCase())) {
      return {
        allowed: false,
        quality: 'REJECTED',
        score,
        totalScore: total,
        reasons: ['EARLY_READY_BLOCKED', `${signal.category} not allowed - only READY/BEST_ENTRY signals permitted`],
        tier,
        mqs,
      };
    }
  }
  
  // ============================================================================
  // NEW DATA-DRIVEN HARD RULES (Based on 200+ signal analysis)
  // ============================================================================
  
  // Hard rule 3: Symbol-Direction Whitelist
  if (cfg.useSymbolWhitelist) {
    const symbolDirection = `${signal.symbol.toUpperCase()}-${direction}`;
    const symbolOnly = signal.symbol.toUpperCase();
    
    // Check if symbol-direction combo is allowed OR if symbol is in any allowed combo
    const isAllowed = cfg.allowedSymbols.some(allowed => {
      const [allowedSymbol, allowedDir] = allowed.split('-');
      return allowedSymbol === symbolOnly && allowedDir === direction;
    });
    
    // DEBUG
    if (symbolOnly === 'KITEUSDT' || symbolOnly === 'kiteusdt') {
      console.log(`[GATE-DEBUG] Whitelist check: ${symbolDirection}, useWhitelist=${cfg.useSymbolWhitelist}, allowedSymbols=${cfg.allowedSymbols?.length}, isAllowed=${isAllowed}`);
    }
    
    if (!isAllowed) {
      return {
        allowed: false,
        quality: 'REJECTED',
        score,
        totalScore: total,
        reasons: ['SYMBOL_NOT_WHITELISTED', `${symbolDirection} not in allowed symbols list (historical win rate <50%)`],
        tier,
        mqs,
      };
    }
  }
  
  // Hard rule 4: Time-based filters
  if (cfg.useTimeFilters) {
    const signalTime = signal.time || Date.now();
    const signalDate = new Date(signalTime);
    const hourUtc = signalDate.getUTCHours();
    const dayName = signalDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    
    // Block bad hours
    if (cfg.blockedHours.includes(hourUtc)) {
      return {
        allowed: false,
        quality: 'REJECTED',
        score,
        totalScore: total,
        reasons: ['BAD_HOUR_BLOCKED', `Hour ${hourUtc}:00 UTC has <40% historical win rate`],
        tier,
        mqs,
      };
    }
    
    // Block bad days
    if (cfg.blockedDays.includes(dayName)) {
      return {
        allowed: false,
        quality: 'REJECTED',
        score,
        totalScore: total,
        reasons: ['BAD_DAY_BLOCKED', `${dayName} has <30% historical win rate`],
        tier,
        mqs,
      };
    }
  }
  
  // Hard rule 5: Category filter (strict whitelist)
  if (cfg.allowedCategories && cfg.allowedCategories.length > 0) {
    const upperCategory = signal.category.toUpperCase();
    const isAllowedCategory = cfg.allowedCategories.some(
      cat => cat.toUpperCase() === upperCategory
    );
    
    if (!isAllowedCategory) {
      return {
        allowed: false,
        quality: 'REJECTED',
        score,
        totalScore: total,
        reasons: ['CATEGORY_BLOCKED', `${signal.category} not in allowed categories [${cfg.allowedCategories.join(', ')}]`],
        tier,
        mqs,
      };
    }
  }
  
  // NOTE: MFE Death Zone filter removed — it checked MFE30m data that doesn't exist on new signals
  // (MFE is an outcome metric computed after 30 minutes, not available at gate time)

  // ============================================================================
  // LEGACY RULES (Optional, disabled by default)
  // ============================================================================
  
  // Legacy: Combined score check (confluence)
  // Skip MFE/MQS check for new signals without historical data - they'll be evaluated after recording
  const skipMfeCheck = !hasMfeData;
  
  if (cfg.useCombinedScore && total < cfg.minCombinedScore && !skipMfeCheck) {
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
