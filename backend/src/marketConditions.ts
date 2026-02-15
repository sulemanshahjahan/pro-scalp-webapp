// backend/src/marketConditions.ts
// Market Conditions Dashboard - calculates health metrics from scan gateStats

import { getDb } from './db/db.js';

export type TimeFrame = '1h' | '4h';

export type MarketHealthMetrics = {
  volatilityHealth: number;  // 0-100%
  volumeHealth: number;      // 0-100%
  trendHealth: number;       // 0-100%
  vwapHealth: number;        // 0-100%
  readinessScore: number;    // 0-100 (weighted average)
  regime: 'DORMANT' | 'WARMING' | 'ACTIVE';
  blockingGate: string | null;
  scanCount: number;
  lastUpdated: number;
  details: {
    failedAtr: number;
    evaluated: number;
    failedVolSpike: number;
    confirm15Pass: number;
    processedSymbols: number;
    nearVwapReady: number;
  };
};

export type MarketConditionsResponse = {
  ok: boolean;
  '1h'?: MarketHealthMetrics;
  '4h'?: MarketHealthMetrics;
  error?: string;
};

/**
 * Calculate health metrics from aggregated gate stats
 */
function calculateMetrics(
  scans: Array<{
    gate_stats_json: string | null;
    processed_symbols: number | null;
    started_at: number;
  }>
): MarketHealthMetrics | null {
  if (!scans.length) return null;

  // Aggregate counters across all scans in window
  let totalFailedAtr = 0;
  let totalEvaluated = 0;
  let totalFailedVolSpike = 0;
  let totalConfirm15Pass = 0;
  let totalProcessedSymbols = 0;
  let totalNearVwapReady = 0;

  for (const scan of scans) {
    if (!scan.gate_stats_json) continue;
    
    try {
      const gateStats = JSON.parse(scan.gate_stats_json);
      const ready = gateStats?.ready || {};
      const confirm15 = gateStats?.confirm15 || {};
      const flags = ready?.ready_core_flag_true || {};

      totalFailedAtr += Number(ready?.failed_atr) || 0;
      totalEvaluated += Number(ready?.ready_core_evaluated) || 0;
      totalFailedVolSpike += Number(ready?.failed_volSpike) || 0;
      totalConfirm15Pass += (Number(confirm15?.pass_strict) || 0) + (Number(confirm15?.pass_soft) || 0);
      totalProcessedSymbols += Number(scan.processed_symbols) || 0;
      totalNearVwapReady += Number(flags?.nearVwapReady) || 0;
    } catch {
      // Skip invalid JSON
      continue;
    }
  }

  if (totalEvaluated === 0 || totalProcessedSymbols === 0) {
    return null;
  }

  // Calculate health metrics (0-1, then convert to percentage)
  // Volatility Health: 1 - (failed_atr / ready_core_evaluated)
  const volatilityHealth = totalEvaluated > 0 
    ? Math.max(0, 1 - (totalFailedAtr / totalEvaluated))
    : 0;

  // Volume Health: 1 - (failed_volSpike / ready_core_evaluated)
  const volumeHealth = totalEvaluated > 0
    ? Math.max(0, 1 - (totalFailedVolSpike / totalEvaluated))
    : 0;

  // Trend Health: (pass_strict + pass_soft) / processedSymbols
  const trendHealth = totalProcessedSymbols > 0
    ? Math.min(1, totalConfirm15Pass / totalProcessedSymbols)
    : 0;

  // VWAP Health: nearVwapReady / processedSymbols
  const vwapHealth = totalProcessedSymbols > 0
    ? Math.min(1, totalNearVwapReady / totalProcessedSymbols)
    : 0;

  // Weighted Readiness Score (25% each), capped at 100
  const readinessScore = Math.min(100, Math.round(
    (volatilityHealth * 0.25 +
     volumeHealth * 0.25 +
     trendHealth * 0.25 +
     vwapHealth * 0.25) * 100
  ));

  // Determine regime based on readiness score
  let regime: 'DORMANT' | 'WARMING' | 'ACTIVE';
  if (readinessScore < 40) {
    regime = 'DORMANT';
  } else if (readinessScore < 70) {
    regime = 'WARMING';
  } else {
    regime = 'ACTIVE';
  }

  // Find the blocking gate (lowest health metric)
  const metrics = [
    { name: 'Volatility', value: volatilityHealth },
    { name: 'Volume', value: volumeHealth },
    { name: 'Trend', value: trendHealth },
    { name: 'VWAP', value: vwapHealth },
  ];
  const lowest = metrics.reduce((min, m) => m.value < min.value ? m : min, metrics[0]);
  const blockingGate = lowest.value < 0.6 ? lowest.name : null;

  return {
    volatilityHealth: Math.round(volatilityHealth * 100),
    volumeHealth: Math.round(volumeHealth * 100),
    trendHealth: Math.round(trendHealth * 100),
    vwapHealth: Math.round(vwapHealth * 100),
    readinessScore,
    regime,
    blockingGate,
    scanCount: scans.length,
    lastUpdated: Math.max(...scans.map(s => s.started_at)),
    details: {
      failedAtr: totalFailedAtr,
      evaluated: totalEvaluated,
      failedVolSpike: totalFailedVolSpike,
      confirm15Pass: totalConfirm15Pass,
      processedSymbols: totalProcessedSymbols,
      nearVwapReady: totalNearVwapReady,
    },
  };
}

/**
 * Fetch market conditions for specified timeframes
 */
export async function getMarketConditions(
  timeframes: TimeFrame[] = ['1h', '4h']
): Promise<MarketConditionsResponse> {
  try {
    const db = getDb();
    const now = Date.now();
    const result: MarketConditionsResponse = { ok: true };

    for (const tf of timeframes) {
      const windowMs = tf === '1h' ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
      const cutoff = now - windowMs;

      let scans: Array<{
        gate_stats_json: string | null;
        processed_symbols: number | null;
        started_at: number;
      }> = [];

      const stmt = db.prepare(`
        SELECT gate_stats_json, processed_symbols, started_at
        FROM scan_runs
        WHERE started_at >= ?
          AND status = 'FINISHED'
          AND gate_stats_json IS NOT NULL
        ORDER BY started_at DESC
      `);
      scans = await stmt.all(cutoff) as any;

      const metrics = calculateMetrics(scans);
      if (metrics) {
        result[tf] = metrics;
      }
    }

    return result;
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
    };
  }
}
