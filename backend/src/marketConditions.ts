// backend/src/marketConditions.ts
// Market Conditions Dashboard - calculates health metrics from scan gateStats

import { getDb } from './db/db.js';

export type TimeFrame = '1h' | '4h';
export type MarketSide = 'long' | 'short';

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

type SideMetricsByTimeframe = Partial<Record<TimeFrame, MarketHealthMetrics>>;

export type MarketConditionsResponse = {
  ok: boolean;
  // New side-aware payload
  long?: SideMetricsByTimeframe;
  short?: SideMetricsByTimeframe;
  // Backward-compatible long-side fields
  '1h'?: MarketHealthMetrics;
  '4h'?: MarketHealthMetrics;
  error?: string;
};

type ScanRow = {
  gate_stats_json: string | null;
  processed_symbols: number | null;
  started_at: number;
};

/**
 * Calculate health metrics from aggregated gate stats
 */
function calculateMetrics(scans: ScanRow[], side: MarketSide): MarketHealthMetrics | null {
  if (!scans.length) return null;

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
      const ready = side === 'short'
        ? (gateStats?.readyShort ?? null)
        : (gateStats?.ready ?? null);
      if (!ready) continue;

      const confirm15 = side === 'short'
        ? (gateStats?.confirm15Short ?? null)
        : (gateStats?.confirm15 ?? null);
      const flags = ready?.ready_core_flag_true || {};
      const nearVwapCount = side === 'short'
        ? (Number(flags?.nearVwapShort) || Number(flags?.nearVwapReady) || 0)
        : (Number(flags?.nearVwapReady) || 0);

      totalFailedAtr += Number(ready?.failed_atr) || 0;
      totalEvaluated += Number(ready?.ready_core_evaluated) || 0;
      totalFailedVolSpike += Number(ready?.failed_volSpike) || 0;
      totalProcessedSymbols += Number(scan.processed_symbols) || 0;
      totalNearVwapReady += nearVwapCount;

      const confirmPass =
        (Number(confirm15?.pass_strict) || 0) +
        (Number(confirm15?.pass_soft) || 0);
      totalConfirm15Pass += confirmPass > 0
        ? confirmPass
        : (Number(flags?.confirm15mOk) || 0);
    } catch {
      continue;
    }
  }

  const denominator = totalProcessedSymbols > 0 ? totalProcessedSymbols : totalEvaluated;
  if (totalEvaluated === 0 || denominator === 0) {
    return null;
  }

  const volatilityHealth = Math.max(0, 1 - (totalFailedAtr / totalEvaluated));
  const volumeHealth = Math.max(0, 1 - (totalFailedVolSpike / totalEvaluated));
  const trendHealth = Math.min(1, totalConfirm15Pass / denominator);
  const vwapHealth = Math.min(1, totalNearVwapReady / denominator);

  const readinessScore = Math.min(100, Math.round(
    (volatilityHealth * 0.25 +
     volumeHealth * 0.25 +
     trendHealth * 0.25 +
     vwapHealth * 0.25) * 100
  ));

  let regime: 'DORMANT' | 'WARMING' | 'ACTIVE';
  if (readinessScore < 40) regime = 'DORMANT';
  else if (readinessScore < 70) regime = 'WARMING';
  else regime = 'ACTIVE';

  const metrics = [
    { name: 'Volatility', value: volatilityHealth },
    { name: 'Volume', value: volumeHealth },
    { name: 'Trend', value: trendHealth },
    { name: 'VWAP', value: vwapHealth },
  ];
  const lowest = metrics.reduce((min, m) => (m.value < min.value ? m : min), metrics[0]);
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
    const result: MarketConditionsResponse = {
      ok: true,
      long: {},
      short: {},
    };

    for (const tf of timeframes) {
      const windowMs = tf === '1h' ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
      const cutoff = now - windowMs;
      const stmt = db.prepare(`
        SELECT gate_stats_json, processed_symbols, started_at
        FROM scan_runs
        WHERE started_at >= ?
          AND status = 'FINISHED'
          AND gate_stats_json IS NOT NULL
        ORDER BY started_at DESC
      `);
      const scans = await stmt.all(cutoff) as ScanRow[];

      const longMetrics = calculateMetrics(scans, 'long');
      if (longMetrics) {
        result.long![tf] = longMetrics;
        // Backward compatibility with existing clients.
        result[tf] = longMetrics;
      }

      const shortMetrics = calculateMetrics(scans, 'short');
      if (shortMetrics) {
        result.short![tf] = shortMetrics;
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
