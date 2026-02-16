import { getLatestScanRuns } from '../scanStore.js';
import { getOutcomesReport, listRecentOutcomes } from '../signalStore.js';
import { thresholdsForPreset, type Preset, getScanIntervalMs, getMaxScanMs } from '../scanner.js';
import { insertTuningBundle, pruneTuningBundles } from '../tuningBundleStore.js';
import { buildConfigSnapshot, computeConfigHash, safeEnvSnapshot } from '../configSnapshot.js';
import { getDb } from '../db/db.js';

type TuningBundleParams = {
  hours?: number;
  limit?: number;
  categories?: string[];
  configHash?: string;
};

type FailureDriver = { key: string; n: number };
type CategoryCountMap = Record<string, number>;

const BUILD_GIT_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.RENDER_GIT_COMMIT ||
  null;

function parseList(raw: string | undefined, fallback: string[]) {
  const list = (raw || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeRates(totals: any) {
  const completeN = Number(totals?.completeN ?? 0);
  const winN = Number(totals?.winN ?? 0);
  const lossN = Number(totals?.lossN ?? 0);
  const noneN = Number(totals?.noneN ?? 0);
  return {
    completeN,
    winRate: completeN ? (winN / completeN) * 100 : 0,
    lossRate: completeN ? (lossN / completeN) * 100 : 0,
    timeoutRate: completeN ? (noneN / completeN) * 100 : 0,
  };
}

function inferConfirm15Mode(row: any): string {
  const entryUsed = row.entryDebug?.confirm15?.used;
  if (entryUsed && entryUsed !== 'none') return entryUsed;
  const readyUsed = row.readyDebug?.confirm15?.used;
  if (readyUsed && readyUsed !== 'none') return readyUsed;
  const bestUsed = row.bestDebug?.confirm15?.used;
  if (bestUsed && bestUsed !== 'none') return bestUsed;
  const strictFlag = row.confirm15Strict ?? row.confirm15_strict;
  const softFlag = row.confirm15Soft ?? row.confirm15_soft;
  if (strictFlag === true || strictFlag === 1) return 'strict';
  if (softFlag === true || softFlag === 1) return 'soft';
  return 'unknown';
}

function driverKeyFromRow(row: any): string {
  const outcomeDebug = row.outcomeDebug ?? {};
  const why = outcomeDebug?.why?.reason;
  if (typeof why === 'string' && why) return `why:${why}`;
  const resolution = outcomeDebug?.resolution?.reason;
  if (typeof resolution === 'string' && resolution) return `resolution:${resolution}`;
  if (row.exitReason) return `exit:${row.exitReason}`;
  if (row.outcomeState) return `state:${row.outcomeState}`;
  if (row.result) return `result:${row.result}`;
  return 'unknown';
}

function summarizeFailureDrivers(rows: any[], topN = 5): FailureDriver[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = driverKeyFromRow(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, n]) => ({ key, n }));
}

function normalizeTotals(raw: any) {
  if (!raw || typeof raw !== 'object') return {};
  const lower = new Map<string, any>();
  for (const [k, v] of Object.entries(raw)) lower.set(k.toLowerCase(), v);

  function getNum(keys: string[]) {
    for (const key of keys) {
      if (key in raw) {
        const n = Number((raw as any)[key]);
        return Number.isFinite(n) ? n : 0;
      }
      const v = lower.get(key.toLowerCase());
      if (v !== undefined) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      }
    }
    return 0;
  }

  return {
    total: getNum(['total']),
    completeN: getNum(['completeN', 'completen', 'complete_n']),
    partialN: getNum(['partialN', 'partialn', 'partial_n']),
    invalidN: getNum(['invalidN', 'invalidn', 'invalid_n']),
    winN: getNum(['winN', 'winn', 'win_n']),
    lossN: getNum(['lossN', 'lossn', 'loss_n']),
    noneN: getNum(['noneN', 'nonen', 'none_n', 'timeoutN', 'timeoutn', 'timeout_n']),
    avgMfePct: getNum(['avgMfePct', 'avgmfepct', 'avg_mfe_pct']),
    avgMaePct: getNum(['avgMaePct', 'avgmaepct', 'avg_mae_pct']),
    avgBars: getNum(['avgBars', 'avgbars', 'avg_bars']),
    avgR: getNum(['avgR', 'avgr', 'avg_r']),
  };
}

async function getWindowSignalsByCategory(params: {
  windowStartMs: number;
  windowEndMs: number;
  configHash?: string | null;
}): Promise<CategoryCountMap> {
  const d = getDb();
  const where: string[] = ['time >= @start', 'time < @end'];
  const bind: any = {
    start: params.windowStartMs,
    end: params.windowEndMs,
  };
  if (params.configHash) {
    where.push('config_hash = @configHash');
    bind.configHash = params.configHash;
  }
  const rows = await d.prepare(`
    SELECT category, COUNT(*) AS n
    FROM signals
    WHERE ${where.join(' AND ')}
    GROUP BY category
  `).all(bind);
  const out: CategoryCountMap = {};
  for (const row of rows) {
    out[String(row.category)] = Number(row.n ?? 0);
  }
  return out;
}

function sumCounts(map: CategoryCountMap) {
  return Object.values(map).reduce((acc, n) => acc + (Number(n) || 0), 0);
}

function buildChecklistMd(input: {
  windowHours: number;
  buildSha: string | null;
  configHash?: string | null;
  scanSummary: any;
  outcomesSummary: any;
  failureDrivers: FailureDriver[];
}) {
  const { windowHours, buildSha, configHash, scanSummary, outcomesSummary, failureDrivers } = input;
  const totals = outcomesSummary?.totals ?? {};
  const rates = outcomesSummary?.rates ?? {};
  const now = new Date().toISOString();
  return [
    '# Tuning Bundle Report',
    '',
    `Generated: ${now}`,
    `Window: last ${windowHours}h`,
    `Build: ${buildSha ?? 'unknown'}`,
    `Config: ${configHash ?? 'unknown'}`,
    '',
    '## Scan summary',
    `- last run: ${scanSummary?.runId ?? 'n/a'} (${scanSummary?.status ?? 'n/a'})`,
    `- processed: ${scanSummary?.processedSymbols ?? 'n/a'}`,
    `- precheckPassed: ${scanSummary?.precheckPassed ?? 'n/a'}`,
    `- fetchedOk: ${scanSummary?.fetchedOk ?? 'n/a'}`,
    '',
    '## Outcomes summary',
    `- total: ${totals?.total ?? 0}`,
    `- win: ${totals?.winN ?? 0}`,
    `- loss: ${totals?.lossN ?? 0}`,
    `- none/timeout: ${totals?.noneN ?? 0}`,
    `- winRate: ${rates?.winRate?.toFixed(2) ?? '0.00'}%`,
    `- lossRate: ${rates?.lossRate?.toFixed(2) ?? '0.00'}%`,
    `- timeoutRate: ${rates?.timeoutRate?.toFixed(2) ?? '0.00'}%`,
    '',
    '## Top failure drivers',
    ...failureDrivers.map((d, i) => `${i + 1}. ${d.key} (${d.n})`),
    '',
    '## Drilldown',
    '- GET /api/tuning/bundles/latest',
    '- GET /api/tuning/bundles/recent?limit=20',
    '- GET /api/tuning/bundles/:id',
  ].join('\n');
}

export async function generateTuningBundle(params: TuningBundleParams = {}) {
  const hours = Math.max(1, Math.min(168, Number(params.hours ?? process.env.TUNING_HOURS ?? 6)));
  const limit = Math.max(50, Math.min(1000, Number(params.limit ?? process.env.TUNING_LIMIT ?? 200)));
  const categories = params.categories?.length
    ? params.categories
    : parseList(process.env.TUNING_CATEGORIES, ['READY_TO_BUY', 'BEST_ENTRY', 'READY_TO_SELL', 'BEST_SHORT_ENTRY']);

  const resultsFilter = parseList(process.env.TUNING_RESULTS, ['STOP', 'TIMEOUT']);
  const sampleLimit = Math.max(5, Math.min(50, Number(process.env.TUNING_SYMBOL_LIMIT ?? 10)));

  const windowEndMs = Date.now();
  const windowStartMs = windowEndMs - hours * 60 * 60_000;

  const { lastFinished } = await getLatestScanRuns();
  const preset = (lastFinished?.preset ?? 'BALANCED') as Preset;
  const thresholds = thresholdsForPreset(preset);
  const envSnapshot = safeEnvSnapshot();
  const configSnapshot = buildConfigSnapshot({
    preset,
    thresholds,
    buildGitSha: BUILD_GIT_SHA,
    env: envSnapshot,
  });
  const configHash = String(params.configHash || '').trim() || computeConfigHash(configSnapshot);
  (configSnapshot as any).configHash = configHash;

  const report = await getOutcomesReport({ hours, configHash });
  const normalizedTotals = normalizeTotals(report?.totals);
  const reportOut = report ? { ...report, totals: normalizedTotals } : report;
  const recentOutcomes = await listRecentOutcomes({
    hours,
    limit,
    categories,
    result: resultsFilter,
    configHash,
  });

  const rates = computeRates(normalizedTotals);
  const windowSignalsByCategory = await getWindowSignalsByCategory({
    windowStartMs,
    windowEndMs,
    configHash,
  });
  const windowSignalsTotal = sumCounts(windowSignalsByCategory);

  const byCategory: Record<string, { total: number; win: number; loss: number; none: number }> = {};
  for (const row of recentOutcomes) {
    const cat = row.category || 'UNKNOWN';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, win: 0, loss: 0, none: 0 };
    byCategory[cat].total += 1;
    if (row.result === 'WIN') byCategory[cat].win += 1;
    else if (row.result === 'LOSS') byCategory[cat].loss += 1;
    else byCategory[cat].none += 1;
  }

  const failureDrivers = summarizeFailureDrivers(recentOutcomes);

  const dedupedSamples: any[] = [];
  const seenSignals = new Set<string>();
  for (const row of recentOutcomes) {
    const key = String(row.signalId ?? `${row.symbol ?? 'sym'}:${row.entryTime ?? row.time ?? ''}`);
    if (seenSignals.has(key)) continue;
    seenSignals.add(key);
    dedupedSamples.push(row);
    if (dedupedSamples.length >= sampleLimit) break;
  }

  const samples = dedupedSamples.map((row: any) => ({
    signalId: row.signalId,
    symbol: row.symbol,
    category: row.category,
    result: row.result,
    exitReason: row.exitReason ?? null,
    entryTime: row.entryTime ?? row.time,
    horizonMin: row.horizonMin ?? null,
    configHash: row.configHash ?? null,
    confirm15Mode: inferConfirm15Mode(row),
    atrPct: num(row.entryDebug?.metrics?.atrPct ?? row.readyDebug?.metrics?.atrPct),
    rr: num(row.entryDebug?.metrics?.rr ?? row.readyDebug?.metrics?.rr ?? row.bestDebug?.metrics?.rr),
    volSpike: num(row.entryDebug?.metrics?.volSpike ?? row.readyDebug?.metrics?.volSpike),
    mfePct: num(row.mfePct),
    maePct: num(row.maePct),
    entryDebug: row.entryDebug ?? null,
    outcomeDebug: row.outcomeDebug ?? null,
  }));

  const scanSummary = lastFinished
    ? {
        runId: lastFinished.runId,
        preset: lastFinished.preset,
        status: lastFinished.status,
        startedAt: lastFinished.startedAt,
        finishedAt: lastFinished.finishedAt,
        durationMs: lastFinished.durationMs,
        processedSymbols: lastFinished.processedSymbols,
        precheckPassed: lastFinished.precheckPassed,
        fetchedOk: lastFinished.fetchedOk,
        errors429: lastFinished.errors429,
        errorsOther: lastFinished.errorsOther,
        signalsByCategory: lastFinished.signalsByCategory ?? null,
        gateStats: lastFinished.gateStats ?? null,
      }
    : null;

  const payload = {
    generatedAt: windowEndMs,
    windowHours: hours,
    windowStartMs,
    windowEndMs,
    configHash,
    build: { gitSha: BUILD_GIT_SHA },
    scan: {
      summary: scanSummary,
      meta: {
        intervalMs: getScanIntervalMs(),
        maxScanMs: getMaxScanMs(),
      },
      confirm15: scanSummary?.gateStats?.confirm15 ?? null,
    },
    outcomes: {
      report: reportOut,
      rates,
      byCategory,
    },
    windowSignalsByCategory,
    windowSignalsTotal,
    failureDrivers,
    samples,
    config: {
      preset,
      env: envSnapshot,
      thresholds,
      configHash,
    },
    notes: {
      limit,
      categories,
      resultsFilter,
      sampleLimit,
    },
  };

  const reportMd = buildChecklistMd({
    windowHours: hours,
    buildSha: BUILD_GIT_SHA,
    configHash,
    scanSummary,
    outcomesSummary: { totals: normalizedTotals, rates },
    failureDrivers,
  });

  const inserted = await insertTuningBundle({
    windowHours: hours,
    windowStartMs,
    windowEndMs,
    configHash,
    buildGitSha: BUILD_GIT_SHA,
    scanRunId: scanSummary?.runId ?? null,
    payload,
    reportMd,
  });

  const retention = await pruneTuningBundles();

  return {
    inserted,
    retention,
    payload,
  };
}
