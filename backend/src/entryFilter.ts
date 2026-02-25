/**
 * Entry Filter / Decision Engine
 * 
 * Implements the MASTER FILTER logic to prevent weak entries.
 * This is the gate that decides whether a signal should be entered or rejected.
 */

import type { Signal } from './types.js';
import { getSymbolTier, type SymbolTier, computeSymbolTier as computeTierFromStats } from './symbolTierStore.js';

// ============================================================================
// FILTER CONFIGURATION
// ============================================================================

export interface FilterConfig {
  // Master switch
  enabled: boolean;
  
  // Symbol tier filters
  blockRedSymbols: boolean;
  yellowRequiresStrictFilter: boolean;
  
  // Early momentum filters
  minMfe30mPct: number;
  yellowMinMfe30mPct: number;
  redMinMfe30mPct: number;
  
  // Momentum quality (MFE/MAE ratio)
  minMfeMaeRatio30m: number;
  
  // Speed filter
  requireTp1Within45Min: boolean;
  
  // Category filters
  allowedCategories: string[];
}

// Default configuration (conservative)
export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  enabled: false, // Start disabled, user must enable
  blockRedSymbols: true,
  yellowRequiresStrictFilter: true,
  minMfe30mPct: 0.30,      // 0.3% MFE in first 30m
  yellowMinMfe30mPct: 0.50, // 0.5% for yellow symbols
  redMinMfe30mPct: 0.80,    // 0.8% for red symbols (very strict)
  minMfeMaeRatio30m: 0.20,  // MFE should be 20% of MAE or better
  requireTp1Within45Min: false,
  allowedCategories: [
    'READY_TO_BUY',
    'BEST_ENTRY',
    'READY_TO_SELL',
    'BEST_SHORT_ENTRY',
    'EARLY_READY',
    'EARLY_READY_SHORT',
  ],
};

// Get config from environment
export function getFilterConfig(): FilterConfig {
  return {
    enabled: (process.env.ENTRY_FILTER_ENABLED || 'false').toLowerCase() === 'true',
    blockRedSymbols: (process.env.ENTRY_FILTER_BLOCK_RED || 'true').toLowerCase() === 'true',
    yellowRequiresStrictFilter: (process.env.ENTRY_FILTER_YELLOW_STRICT || 'true').toLowerCase() === 'true',
    minMfe30mPct: parseFloat(process.env.ENTRY_FILTER_MIN_MFE30M || '0.30'),
    yellowMinMfe30mPct: parseFloat(process.env.ENTRY_FILTER_YELLOW_MIN_MFE30M || '0.50'),
    redMinMfe30mPct: parseFloat(process.env.ENTRY_FILTER_RED_MIN_MFE30M || '0.80'),
    minMfeMaeRatio30m: parseFloat(process.env.ENTRY_FILTER_MIN_RATIO || '0.20'),
    requireTp1Within45Min: (process.env.ENTRY_FILTER_REQUIRE_SPEED || 'false').toLowerCase() === 'true',
    allowedCategories: (process.env.ENTRY_FILTER_CATEGORIES || 
      'READY_TO_BUY,BEST_ENTRY,READY_TO_SELL,BEST_SHORT_ENTRY,EARLY_READY,EARLY_READY_SHORT'
    ).split(',').map(s => s.trim()).filter(Boolean),
  };
}

// ============================================================================
// REJECTION REASONS
// ============================================================================

export type RejectionReason = 
  | 'FILTER_DISABLED'
  | 'SYMBOL_BLOCKED_RED_TIER'
  | 'SYMBOL_BLOCKED_YELLOW_TIER'
  | 'CATEGORY_NOT_ALLOWED'
  | 'MFE30M_TOO_LOW'
  | 'MFE_MAE_RATIO_TOO_LOW'
  | 'NO_EARLY_MOMENTUM'
  | 'SPEED_REQUIREMENT_FAILED'
  | 'UNKNOWN';

export interface FilterResult {
  allowed: boolean;
  reason: RejectionReason;
  message: string;
  details: Record<string, any>;
  tier?: SymbolTier;
  mqs?: number; // Momentum Quality Score
}

// ============================================================================
// MOMENTUM QUALITY SCORE (MQS)
// ============================================================================

/**
 * Calculate Momentum Quality Score
 * MQS = mfe30mPct / mae30mPct (higher is better)
 * 
 * Interpretation:
 * - < 0.1: BAD (no momentum)
 * - 0.1–0.3: WEAK
 * - > 0.3: GOOD (strong momentum)
 */
export function calculateMQS(
  mfe30mPct: number | null | undefined,
  mae30mPct: number | null | undefined
): number {
  const mfe = mfe30mPct ?? 0;
  const mae = mae30mPct ?? 0.001; // Avoid division by zero
  if (mae <= 0) return mfe > 0 ? 999 : 0;
  return mfe / mae;
}

export function interpretMQS(mqs: number): { label: string; class: 'bad' | 'weak' | 'good' } {
  if (mqs < 0.1) return { label: 'BAD', class: 'bad' };
  if (mqs < 0.3) return { label: 'WEAK', class: 'weak' };
  return { label: 'GOOD', class: 'good' };
}

// ============================================================================
// MAIN FILTER FUNCTION
// ============================================================================

export interface SignalWithEarlyMetrics extends Signal {
  // Early window metrics (from 30m of data)
  mfe30mPct?: number;
  mae30mPct?: number;
  firstHit30m?: boolean;
  tp1Within45m?: boolean;
  
  // Symbol tier (looked up or computed)
  symbolTier?: SymbolTier;
}

/**
 * The MASTER FILTER - decides if a signal should be entered
 */
export async function shouldEnterTrade(
  signal: SignalWithEarlyMetrics,
  config?: Partial<FilterConfig>
): Promise<FilterResult> {
  const cfg = { ...getFilterConfig(), ...config };
  
  // If filter is disabled, allow everything
  if (!cfg.enabled) {
    return {
      allowed: true,
      reason: 'FILTER_DISABLED',
      message: 'Entry filter is disabled - allowing all signals',
      details: {},
    };
  }

  // Get direction
  const shortCategories = ['READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT'];
  const direction = shortCategories.includes(signal.category.toUpperCase()) ? 'SHORT' : 'LONG';

  // Look up symbol tier
  let tier = signal.symbolTier;
  if (!tier) {
    const tierRecord = await getSymbolTier(signal.symbol, direction);
    tier = tierRecord?.tier ?? 'YELLOW'; // Default to cautious
  }

  // Calculate MQS
  const mqs = calculateMQS(signal.mfe30mPct, signal.mae30mPct);
  const mqsInterpretation = interpretMQS(mqs);

  // Build base result
  const baseResult: Partial<FilterResult> = {
    tier,
    mqs,
    details: {
      symbol: signal.symbol,
      category: signal.category,
      direction,
      tier,
      mfe30mPct: signal.mfe30mPct,
      mae30mPct: signal.mae30mPct,
      mqs,
      mqsLabel: mqsInterpretation.label,
      mqsClass: mqsInterpretation.class,
    },
  };

  // Check 1: Category allowed?
  if (!cfg.allowedCategories.includes(signal.category.toUpperCase())) {
    return {
      ...baseResult,
      allowed: false,
      reason: 'CATEGORY_NOT_ALLOWED',
      message: `Category ${signal.category} is not in allowed list`,
    } as FilterResult;
  }

  // Check 2: Red tier blocked?
  if (cfg.blockRedSymbols && tier === 'RED') {
    return {
      ...baseResult,
      allowed: false,
      reason: 'SYMBOL_BLOCKED_RED_TIER',
      message: `${signal.symbol} is RED tier - blocked (win rate < 15%)`,
    } as FilterResult;
  }

  // Check 3: Early momentum (MFE30m)
  const mfe30m = signal.mfe30mPct ?? 0;
  let requiredMfe = cfg.minMfe30mPct;
  
  if (tier === 'YELLOW' && cfg.yellowRequiresStrictFilter) {
    requiredMfe = cfg.yellowMinMfe30mPct;
  } else if (tier === 'RED' && !cfg.blockRedSymbols) {
    requiredMfe = cfg.redMinMfe30mPct;
  }

  if (mfe30m < requiredMfe) {
    return {
      ...baseResult,
      allowed: false,
      reason: 'MFE30M_TOO_LOW',
      message: `Early momentum too weak: ${mfe30m.toFixed(2)}% < ${(requiredMfe * 100).toFixed(0)}% required`,
      details: {
        ...baseResult.details,
        requiredMfe,
        actualMfe: mfe30m,
      },
    } as FilterResult;
  }

  // Check 4: Momentum Quality Score (MFE/MAE ratio)
  if (mqs < cfg.minMfeMaeRatio30m) {
    return {
      ...baseResult,
      allowed: false,
      reason: 'MFE_MAE_RATIO_TOO_LOW',
      message: `Momentum quality too low: MQS ${mqs.toFixed(2)} < ${cfg.minMfeMaeRatio30m} required`,
      details: {
        ...baseResult.details,
        requiredRatio: cfg.minMfeMaeRatio30m,
        actualRatio: mqs,
      },
    } as FilterResult;
  }

  // Check 5: Speed requirement (if enabled)
  if (cfg.requireTp1Within45Min && signal.tp1Within45m === false) {
    return {
      ...baseResult,
      allowed: false,
      reason: 'SPEED_REQUIREMENT_FAILED',
      message: 'TP1 not hit within 45 minutes',
    } as FilterResult;
  }

  // All checks passed - ALLOW
  return {
    ...baseResult,
    allowed: true,
    reason: 'UNKNOWN', // Not a rejection
    message: 'Signal passes all entry filters',
    details: {
      ...baseResult.details,
      passedChecks: [
        'category_allowed',
        'tier_check',
        'momentum_check',
        'quality_check',
        ...(cfg.requireTp1Within45Min ? ['speed_check'] : []),
      ],
    },
  } as FilterResult;
}

// ============================================================================
// BATCH FILTERING
// ============================================================================

export interface BatchFilterResult {
  allowed: SignalWithEarlyMetrics[];
  rejected: Array<{ signal: SignalWithEarlyMetrics; result: FilterResult }>;
  summary: {
    total: number;
    allowed: number;
    rejected: number;
    byReason: Record<RejectionReason, number>;
  };
}

export async function filterSignals(
  signals: SignalWithEarlyMetrics[],
  config?: Partial<FilterConfig>
): Promise<BatchFilterResult> {
  const allowed: SignalWithEarlyMetrics[] = [];
  const rejected: Array<{ signal: SignalWithEarlyMetrics; result: FilterResult }> = [];
  const byReason: Partial<Record<RejectionReason, number>> = {};

  for (const signal of signals) {
    const result = await shouldEnterTrade(signal, config);
    
    if (result.allowed) {
      allowed.push(signal);
    } else {
      rejected.push({ signal, result });
      byReason[result.reason] = (byReason[result.reason] || 0) + 1;
    }
  }

  return {
    allowed,
    rejected,
    summary: {
      total: signals.length,
      allowed: allowed.length,
      rejected: rejected.length,
      byReason: byReason as Record<RejectionReason, number>,
    },
  };
}

// ============================================================================
// SIMULATION (for testing without enabling live)
// ============================================================================

export async function simulateFilter(
  signals: SignalWithEarlyMetrics[],
  config: FilterConfig
): Promise<BatchFilterResult> {
  return filterSignals(signals, config);
}
