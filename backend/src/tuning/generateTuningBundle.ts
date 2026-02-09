import { getLatestScanRuns } from '../scanStore.js';
import { getOutcomesReport, listRecentOutcomes } from '../signalStore.js';
import { thresholdsForPreset, type Preset, getScanIntervalMs, getMaxScanMs } from '../scanner.js';
import { insertTuningBundle, pruneTuningBundles } from '../tuningBundleStore.js';

type TuningBundleParams = {
  hours?: number;
  limit?: number;
  categories?: string[];
};

type FailureDriver = { key: string; n: number };

const BUILD_GIT_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.RENDER_GIT_COMMIT ||
  null;

const SECRET_ENV_RE = /(TOKEN|KEY|SECRET|PASSWORD|DATABASE|URL)/i;

const SAFE_ENV_KEYS = [
  'READY_BTC_REQUIRED',
  'READY_CONFIRM15_REQUIRED',
  'READY_TREND_REQUIRED',
  'READY_VOL_SPIKE_REQUIRED',
  'READY_SWEEP_REQUIRED',
  'READY_RECLAIM_REQUIRED',
  'READY_VWAP_MAX_PCT',
  'READY_VWAP_EPS_PCT',
  'READY_VWAP_TOUCH_PCT',
  'READY_VWAP_TOUCH_BARS',
  'READY_BODY_PCT',
  'READY_CLOSE_POS_MIN',
  'READY_UPPER_WICK_MAX',
  'READY_EMA_EPS_PCT',
  'WATCH_EMA_EPS_PCT',
  'RSI_READY_MIN',
  'RSI_READY_MAX',
  'RSI_EARLY_MIN',
  'RSI_EARLY_MAX',
  'RSI_DELTA_STRICT',
  'CONFIRM15_VWAP_EPS_PCT',
  'CONFIRM15_VWAP_ROLL_BARS',
  'BEST_BTC_REQUIRED',
  'BEST_VWAP_MAX_PCT',
  'BEST_VWAP_EPS_PCT',
  'BEST_EMA_EPS_PCT',
  'RSI_BEST_MIN',
  'RSI_BEST_MAX',
  'RR_MIN_BEST',
  'MIN_BODY_PCT',
  'MIN_ATR_PCT',
  'MIN_RISK_PCT',
  'SESSION_FILTER_ENABLED',
  'SESSIONS_UTC',
  'SCAN_INTERVAL_MS',
];

function parseList(raw: string | undefined, fallback: string[]) {
  const list = (raw || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeEnvSnapshot() {
  const out: Record<string, string | number | boolean> = {};
  for (const key of SAFE_ENV_KEYS) {
    if (!(key in process.env)) continue;
    if (SECRET_ENV_RE.test(key)) continue;
    const raw = String(process.env[key]);
    const lower = raw.toLowerCase();
    if (lower === 'true') out[key] = true;
    else if (lower === 'false') out[key] = false;
    else if (Number.isFinite(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
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

function buildChecklistMd(input: {
  windowHours: number;
  buildSha: string | null;
  scanSummary: any;
  outcomesSummary: any;
  failureDrivers: FailureDriver[];
}) {
  const { windowHours, buildSha, scanSummary, outcomesSummary, failureDrivers } = input;
  const totals = outcomesSummary?.totals ?? {};
  const rates = outcomesSummary?.rates ?? {};
  const now = new Date().toISOString();
  return [
    '# Tuning Bundle Report',
    '',
    `Generated: ${now}`,
    `Window: last ${windowHours}h`,
    `Build: ${buildSha ?? 'unknown'}`,
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
    : parseList(process.env.TUNING_CATEGORIES, ['READY_TO_BUY', 'BEST_ENTRY']);

  const resultsFilter = parseList(process.env.TUNING_RESULTS, ['STOP', 'TIMEOUT']);
  const sampleLimit = Math.max(5, Math.min(50, Number(process.env.TUNING_SYMBOL_LIMIT ?? 10)));

  const windowEndMs = Date.now();
  const windowStartMs = windowEndMs - hours * 60 * 60_000;

  const { lastFinished } = await getLatestScanRuns();
  const preset = (lastFinished?.preset ?? 'BALANCED') as Preset;
  const thresholds = thresholdsForPreset(preset);

  const report = await getOutcomesReport({ hours });
  const recentOutcomes = await listRecentOutcomes({
    hours,
    limit,
    categories,
    result: resultsFilter,
  });

  const rates = computeRates(report?.totals ?? {});

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

  const samples = recentOutcomes.slice(0, sampleLimit).map((row: any) => ({
    signalId: row.signalId,
    symbol: row.symbol,
    category: row.category,
    result: row.result,
    exitReason: row.exitReason ?? null,
    entryTime: row.entryTime ?? row.time,
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
      report,
      rates,
      byCategory,
    },
    failureDrivers,
    samples,
    config: {
      preset,
      env: safeEnvSnapshot(),
      thresholds,
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
    scanSummary,
    outcomesSummary: { totals: report?.totals, rates },
    failureDrivers,
  });

  const inserted = await insertTuningBundle({
    windowHours: hours,
    windowStartMs,
    windowEndMs,
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

