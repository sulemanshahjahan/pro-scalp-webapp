/**
 * Gate Backtest - Compare filter configurations on historical signals
 * 
 * Allows testing different threshold combinations before going live.
 */

import { getDb } from './db/db.js';
import { checkSignalGate, calculateSignalScore, type GateConfig, DEFAULT_GATE_CONFIG } from './signalGate.js';
import { classifyOutcome, getDirectionFromCategory } from './outcomeAnalysis.js';
import { getSymbolTier } from './symbolTierStore.js';
import type { Signal } from './types.js';

export interface BacktestConfig extends GateConfig {
  name?: string;
}

export interface BacktestResult {
  config: BacktestConfig;
  summary: {
    totalSignals: number;
    allowed: number;
    blocked: number;
    reductionPct: number;
    targetMet: boolean;
  };
  performance: {
    wins: number;
    losses: number;
    be: number;
    pending: number;
    winRate: number;
    totalR: number;
    avgR: number;
    medianR: number;
  };
  quality: {
    high: number;
    medium: number;
    low: number;
  };
  blockedReasons: Record<string, number>;
  tierBreakdown: Record<string, { total: number; allowed: number; blocked: number }>;
}

/**
 * Run backtest with custom gate configuration
 */
export async function runGateBacktest(
  config: BacktestConfig,
  limit: number = 200
): Promise<BacktestResult> {
  console.log('[gateBacktest] Received config:', JSON.stringify(config));
  
  // Ensure all config values are explicitly set (don't fallback to env vars)
  const explicitConfig: BacktestConfig = {
    enabled: config.enabled ?? true,
    blockRedTier: config.blockRedTier ?? true,
    minMfe30mPct: config.minMfe30mPct ?? 0.30,
    redTierMinMfe30mPct: config.redTierMinMfe30mPct ?? 0.50,
    minMqs: config.minMqs ?? 0.20,
    useCombinedScore: config.useCombinedScore ?? true,
    minCombinedScore: config.minCombinedScore ?? 2,
    require15mConfirmation: config.require15mConfirmation ?? false,
    minMfe15mPct: config.minMfe15mPct ?? 0.20,
    allowEarlyReady: config.allowEarlyReady ?? false,
    targetReductionPct: config.targetReductionPct ?? 50,
    name: config.name || 'Custom',
  };
  
  console.log('[gateBacktest] Using explicit config:', JSON.stringify(explicitConfig));
  
  const d = getDb();
  
  // Fetch recent signals with their outcomes
  const rows = await d.prepare(`
    SELECT 
      s.id,
      s.symbol,
      s.category,
      s.price,
      eo.ext24_realized_r,
      eo.status,
      eo.ext24_managed_status,
      eo.mfe_30m_pct,
      eo.mae_30m_pct,
      eo.tp1_within_45m,
      eo.completed_at
    FROM signals s
    JOIN extended_outcomes eo ON eo.signal_id = s.id
    WHERE eo.completed_at IS NOT NULL
    ORDER BY s.created_at DESC
    LIMIT @limit
  `).all({ limit }) as any[];

  let allowed = 0;
  let blocked = 0;
  let wins = 0;
  let losses = 0;
  let be = 0;
  let pending = 0;
  let totalR = 0;
  const rs: number[] = [];
  
  let high = 0;
  let medium = 0;
  let low = 0;
  
  const blockedReasons: Record<string, number> = {};
  const tierBreakdown: Record<string, { total: number; allowed: number; blocked: number }> = {};

  for (const row of rows) {
    const symbol = String(row.symbol);
    const category = String(row.category);
    const direction = getDirectionFromCategory(category);
    
    // Build signal with metrics
    const signal = {
      symbol,
      category,
      price: Number(row.price),
      mfe30mPct: row.mfe_30m_pct != null ? Number(row.mfe_30m_pct) : 0,
      mae30mPct: row.mae_30m_pct != null ? Number(row.mae_30m_pct) : 0.001,
      tp1Within45m: row.tp1_within_45m === 1,
      // Required Signal fields (mocked for backtest)
      time: Number(row.time || row.signal_time || Date.now()),
      vwap: Number(row.price),
      ema200: Number(row.price),
      rsi9: 50,
      volSpike: 1,
      atrPct: 1,
      confirm15m: true,
      deltaVwapPct: 0,
      stop: null,
      tp1: null,
      tp2: null,
      target: null,
    } as Signal & { mfe30mPct?: number; mae30mPct?: number; mfe15mPct?: number; tp1Within45m?: boolean };

    // Get tier
    const tierRecord = await getSymbolTier(symbol, direction);
    const tier = tierRecord?.tier || 'YELLOW';
    
    // Run through gate
    const result = await checkSignalGate(signal, explicitConfig);
    
    // Track tier breakdown
    if (!tierBreakdown[tier]) {
      tierBreakdown[tier] = { total: 0, allowed: 0, blocked: 0 };
    }
    tierBreakdown[tier].total++;
    
    if (result.allowed) {
      allowed++;
      tierBreakdown[tier].allowed++;
      
      // Track quality
      if (result.quality === 'HIGH') high++;
      else if (result.quality === 'MEDIUM') medium++;
      else low++;
      
      // Track performance (only for allowed signals)
      const realizedR = row.ext24_realized_r != null ? Number(row.ext24_realized_r) : 0;
      
      // Classify outcome
      const classification = classifyOutcome(
        row.status,
        row.ext24_managed_status,
        realizedR,
        direction
      );
      
      if (classification.bucket === 'WIN') wins++;
      else if (classification.bucket === 'LOSS') losses++;
      else if (classification.bucket === 'BE') be++;
      else pending++;
      
      totalR += realizedR;
      rs.push(realizedR);
    } else {
      blocked++;
      tierBreakdown[tier].blocked++;
      
      // Track blocked reasons
      const reason = result.reasons[0] || 'UNKNOWN';
      blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
    }
  }

  const total = rows.length;
  const completed = wins + losses + be;
  
  // Calculate median R
  const sortedR = [...rs].sort((a, b) => a - b);
  const medianR = sortedR.length > 0 
    ? sortedR.length % 2 === 0 
      ? (sortedR[Math.floor(sortedR.length / 2) - 1] + sortedR[Math.floor(sortedR.length / 2)]) / 2
      : sortedR[Math.floor(sortedR.length / 2)]
    : 0;

  return {
    config: explicitConfig,
    summary: {
      totalSignals: total,
      allowed,
      blocked,
      reductionPct: total > 0 ? (blocked / total) * 100 : 0,
      targetMet: total > 0 && (blocked / total) >= 0.40 && (blocked / total) <= 0.60,
    },
    performance: {
      wins,
      losses,
      be,
      pending,
      winRate: completed > 0 ? wins / completed : 0,
      totalR,
      avgR: rs.length > 0 ? totalR / rs.length : 0,
      medianR,
    },
    quality: { high, medium, low },
    blockedReasons,
    tierBreakdown,
  };
}

/**
 * Compare multiple gate configurations
 */
export async function compareGateConfigs(
  configs: BacktestConfig[],
  limit: number = 200
): Promise<BacktestResult[]> {
  const results: BacktestResult[] = [];
  
  for (const config of configs) {
    const result = await runGateBacktest(config, limit);
    results.push(result);
  }
  
  return results;
}

/**
 * Get recommended configs to test
 */
export function getRecommendedConfigs(): BacktestConfig[] {
  return [
    {
      name: 'Current (Default)',
      ...DEFAULT_GATE_CONFIG,
    },
    {
      name: 'Strict - High MFE',
      ...DEFAULT_GATE_CONFIG,
      minMfe30mPct: 0.50,
      redTierMinMfe30mPct: 0.90,
      minMqs: 0.30,
      minCombinedScore: 3,
    },
    {
      name: 'Strict - Score 3',
      ...DEFAULT_GATE_CONFIG,
      minCombinedScore: 3,
    },
    {
      name: 'Block RED Only',
      ...DEFAULT_GATE_CONFIG,
      blockRedTier: true,
      minMfe30mPct: 0.20,
      minMqs: 0.10,
      minCombinedScore: 1,
    },
    {
      name: 'Very Aggressive',
      ...DEFAULT_GATE_CONFIG,
      minMfe30mPct: 0.60,
      minMqs: 0.40,
      minCombinedScore: 3,
      redTierMinMfe30mPct: 1.00,
    },
    {
      name: 'No Early Ready',
      ...DEFAULT_GATE_CONFIG,
      allowEarlyReady: false,
    },
    {
      name: 'Allow Early Ready',
      ...DEFAULT_GATE_CONFIG,
      allowEarlyReady: true,
    },
  ];
}
