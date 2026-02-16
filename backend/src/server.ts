import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureVapid } from './notifier.js';
import { getLastBtcMarket, getLastScanHealth, getScanIntervalMs, getMaxScanMs, startLoop, scanOnce, thresholdsForPreset, type Preset } from './scanner.js';
import { getLatestScanRuns, listScanRuns, getScanRunByRunId } from './scanStore.js';
import { listCandidateFeatures, listCandidateFeaturesMulti } from './candidateFeaturesStore.js';
import { applyOverrides, evalFromFeatures, getTuneConfigFromEnv } from './tuneSim.js';
import { pushToAll } from './notifier.js';
import { emailNotify } from './emailNotifier.js';
import { getDb } from './db/db.js';
import { getLatestTuningBundle, listRecentTuningBundles, getTuningBundleById } from './tuningBundleStore.js';
import { generateTuningBundle } from './tuning/generateTuningBundle.js';
import { getMarketConditions } from './marketConditions.js';
import {
  clearAllSignalsData,
  deleteOutcomesBulk,
  deleteOutcomesByFilter,
  getInvalidReasons,
  getOutcomesBacklogCount,
  getOutcomesHealth,
  getSignalById,
  getStats,
  getStatsBuckets,
  getStatsHealth,
  getStatsMatrixBtc,
  getStatsSummary,
  listOutcomes,
  listRecentOutcomes,
  getOutcomesReport,
  listSignals,
  listStrategyVersions,
  getLoggedCategories,
  recordSignal,
  rebuildOutcomesByFilter,
  updateOutcomesOnce,
  startOutcomeUpdater
} from './signalStore.js';
import fs from 'fs';
import { DB_PATH } from './dbPath.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverStartedAt = Date.now();
const buildGitSha =
  process.env.GIT_SHA ||
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.RENDER_GIT_COMMIT ||
  '';
const buildStartedAt = Number(process.env.BUILD_STARTED_AT) || serverStartedAt;

const app = express();
const corsOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    if (corsOrigins.includes('*') || corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed'));
  },
  credentials: true,
}));
app.options('*', cors());
app.use(express.json());

function parsePreset(v: any): Preset {
  const s = String(v || '').toUpperCase();
  if (s === 'CONSERVATIVE' || s === 'AGGRESSIVE' || s === 'BALANCED') return s as Preset;
  return 'BALANCED';
}

function requireAdmin(req: express.Request, res: express.Response) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;
  const got = req.header('x-admin-token');
  if (got !== token) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

function computePercentiles(values: number[], ps = [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const clean = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  const n = clean.length;
  const out: Record<string, number | null> = {};
  for (const p of ps) {
    if (!n) { out[`p${Math.round(p * 100)}`] = null; continue; }
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const t = idx - lo;
    const v = lo === hi ? clean[lo] : clean[lo] * (1 - t) + clean[hi] * t;
    out[`p${Math.round(p * 100)}`] = Number.isFinite(v) ? v : null;
  }
  return out;
}

function buildOverrideNotes(overrides: Record<string, any> | undefined) {
  const notes: string[] = [];
  if (!overrides) return notes;
  const keys = Object.keys(overrides);
  const confirmKeys = ['CONFIRM15_VWAP_EPS_PCT', 'CONFIRM15_VWAP_ROLL_BARS'];
  if (keys.some(k => confirmKeys.includes(k))) {
    notes.push('Confirm15 overrides do not recompute stored confirm15 flags. Re-run a scan to apply confirm15 logic changes.');
  }
  return notes;
}

function hasNoOverrides(report: {
  appliedOverrides?: Record<string, any>;
  unknownOverrideKeys?: string[];
  overrideTypeErrors?: Record<string, any>;
}) {
  const applied = Object.keys(report.appliedOverrides ?? {}).length;
  const unknown = (report.unknownOverrideKeys ?? []).length;
  const typeErr = Object.keys(report.overrideTypeErrors ?? {}).length;
  return applied === 0 && unknown === 0 && typeErr === 0;
}

type SignalCounts = {
  watch: number;
  early: number;
  ready: number;
  best: number;
  watchShort: number;
  earlyShort: number;
  readyShort: number;
  bestShort: number;
};

type SimFunnel = {
  candidate_evaluated: number;
  watch_created: number;
  early_created: number;
  ready_core_true: number;
  best_core_true: number;
  ready_final_true: number;
  best_final_true: number;
  watch_short_created: number;
  early_short_created: number;
  ready_short_core_true: number;
  best_short_core_true: number;
  ready_short_final_true: number;
  best_short_final_true: number;
};

type RunSignalLite = {
  id: number;
  runId: string;
  symbol: string;
  category: string;
  gateSnapshot: any | null;
  outcomeResult: string | null;
  outcomeHitTp1: boolean | null;
  outcomeHitSl: boolean | null;
  outcomeWindowStatus: string | null;
};

const ZERO_COUNTS: SignalCounts = { watch: 0, early: 0, ready: 0, best: 0, watchShort: 0, earlyShort: 0, readyShort: 0, bestShort: 0 };

function safeJsonParse<T>(raw: any): T | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function toBool(v: any): boolean | null {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n'].includes(s)) return false;
  }
  return null;
}

function diffCounts(left: SignalCounts, right: SignalCounts): SignalCounts {
  return {
    watch: left.watch - right.watch,
    early: left.early - right.early,
    ready: left.ready - right.ready,
    best: left.best - right.best,
    watchShort: left.watchShort - right.watchShort,
    earlyShort: left.earlyShort - right.earlyShort,
    readyShort: left.readyShort - right.readyShort,
    bestShort: left.bestShort - right.bestShort,
  };
}

function alignFunnelToCounts(funnel: SimFunnel, counts: SignalCounts): SimFunnel {
  return {
    ...funnel,
    watch_created: counts.watch,
    early_created: counts.early,
    ready_final_true: counts.ready,
    best_final_true: counts.best,
    watch_short_created: counts.watchShort,
    early_short_created: counts.earlyShort,
    ready_short_final_true: counts.readyShort,
    best_short_final_true: counts.bestShort,
  };
}

function normalizeLiveReadyFlags(computed: any, gateSnapshot: any | null): Record<string, boolean> | null {
  const src = computed?.readyGateSnapshot ?? gateSnapshot?.ready;
  if (!src || typeof src !== 'object') return null;
  const out: Record<string, boolean> = {
    sessionOK: Boolean(src.sessionOk),
    priceAboveVwap: Boolean(src.priceAboveVwap),
    priceAboveEma: Boolean(src.priceAboveEma),
    nearVwapReady: Boolean(src.nearVwap),
    reclaimOrTap: Boolean(src.reclaimOrTap),
    readyVolOk: Boolean(src.volSpike),
    atrOkReady: Boolean(src.atr),
    confirm15mOk: Boolean(src.confirm15),
    strongBody: Boolean(src.strongBody),
    rrOk: Boolean(src.rrOk),
    riskOk: Boolean(src.riskOk),
    rsiReadyOk: Boolean(src.rsiReadyOk),
    readyTrendOk: Boolean(src.trend),
    sweepOk: Boolean(src.sweep),
    btcOk: Boolean(src.btc),
    core: Boolean(src.core),
  };
  return out;
}

function normalizeLiveShortFlags(computed: any, gateSnapshot: any | null): Record<string, boolean> | null {
  const src = computed?.shortGateSnapshot ?? gateSnapshot?.short;
  if (!src || typeof src !== 'object') return null;
  const out: Record<string, boolean> = {
    sessionOK: Boolean(src.sessionOk),
    priceBelowVwap: Boolean(src.priceBelowVwap),
    priceBelowEma: Boolean(src.priceBelowEma),
    nearVwapShort: Boolean(src.nearVwap),
    rsiShortOk: Boolean(src.rsiShortOk),
    strongBody: Boolean(src.strongBody),
    readyVolOk: Boolean(src.volSpike),
    atrOkReady: Boolean(src.atr),
    confirm15mOk: Boolean(src.confirm15),
    trendOkShort: Boolean(src.trend),
    rrOk: Boolean(src.rrOk),
    riskOk: Boolean(src.riskOk),
    sweepOk: Boolean(src.sweep),
    btcOk: Boolean(src.btc),
    core: Boolean(src.core),
  };
  return out;
}

function firstDiff(order: string[], sim: Record<string, boolean>, live: Record<string, boolean> | null): string | null {
  if (!live) return null;
  for (const k of order) {
    if (typeof live[k] !== 'boolean') continue;
    if (sim[k] !== live[k]) return k;
  }
  return null;
}

function firstFalse(order: string[], flags: Record<string, boolean> | null): string | null {
  if (!flags) return null;
  return order.find((k) => flags[k] === false) ?? null;
}

async function loadSignalsForRuns(runIds: string[], horizonMin = 120): Promise<RunSignalLite[]> {
  const cleaned = Array.from(new Set((runIds || []).map((r) => String(r || '').trim()).filter(Boolean)));
  if (!cleaned.length) return [];
  const toRows = (rows: any[]): RunSignalLite[] => rows.map((r) => ({
    id: Number(r.id ?? 0),
    runId: String(r.runId ?? ''),
    symbol: String(r.symbol ?? ''),
    category: String(r.category ?? ''),
    gateSnapshot: safeJsonParse<any>(r.gateSnapshotJson),
    outcomeResult: r.outcomeResult == null ? null : String(r.outcomeResult),
    outcomeHitTp1: toBool(r.outcomeHitTp1),
    outcomeHitSl: toBool(r.outcomeHitSl),
    outcomeWindowStatus: r.outcomeWindowStatus == null ? null : String(r.outcomeWindowStatus),
  }));

  const bindEvents: Record<string, any> = { horizonMin };
  const eventPlaceholders = cleaned.map((_, i) => {
    bindEvents[`run_${i}`] = cleaned[i];
    return `@run_${i}`;
  }).join(',');

  let eventRows: any[] = [];
  try {
    eventRows = await db.prepare(`
      SELECT
        e.id as "id",
        e.run_id as "runId",
        e.symbol as "symbol",
        e.category as "category",
        e.gate_snapshot_json as "gateSnapshotJson",
        o.result as "outcomeResult",
        o.hit_tp1 as "outcomeHitTp1",
        o.hit_sl as "outcomeHitSl",
        o.window_status as "outcomeWindowStatus"
      FROM signal_events e
      LEFT JOIN signal_outcomes o
        ON o.signal_id = e.signal_id
        AND o.horizon_min = @horizonMin
      WHERE e.run_id IN (${eventPlaceholders})
      ORDER BY e.id ASC
    `).all(bindEvents) as any[];
  } catch {
    eventRows = [];
  }

  const out = toRows(eventRows);
  const runsWithEvents = new Set(out.map((r) => r.runId).filter(Boolean));
  const missingRunIds = cleaned.filter((runId) => !runsWithEvents.has(runId));
  if (!missingRunIds.length) return out;

  const bindSignals: Record<string, any> = { horizonMin };
  const signalPlaceholders = missingRunIds.map((_, i) => {
    bindSignals[`run_${i}`] = missingRunIds[i];
    return `@run_${i}`;
  }).join(',');
  let signalRows: any[] = [];
  try {
    signalRows = await db.prepare(`
      SELECT
        s.id as "id",
        s.run_id as "runId",
        s.symbol as "symbol",
        s.category as "category",
        s.gate_snapshot_json as "gateSnapshotJson",
        o.result as "outcomeResult",
        o.hit_tp1 as "outcomeHitTp1",
        o.hit_sl as "outcomeHitSl",
        o.window_status as "outcomeWindowStatus"
      FROM signals s
      LEFT JOIN signal_outcomes o
        ON o.signal_id = s.id
        AND o.horizon_min = @horizonMin
      WHERE s.run_id IN (${signalPlaceholders})
      ORDER BY s.id ASC
    `).all(bindSignals) as any[];
  } catch {
    signalRows = [];
  }
  return out.concat(toRows(signalRows));
}

function computeActualOutcome120m(signalRows: RunSignalLite[]) {
  const categories = ['READY_TO_BUY', 'BEST_ENTRY', 'READY_TO_SELL', 'BEST_SHORT_ENTRY'];
  const byCategory: Record<string, any> = {};
  for (const cat of categories) {
    byCategory[cat] = {
      count: 0,
      tp1_hit_120m: 0,
      sl_hit_120m: 0,
      no_hit_120m: 0,
      missing_outcome_120m: 0,
      unresolved_120m: 0,
      win_rate_120m: 0,
      loss_rate_120m: 0,
      no_hit_rate_120m: 0,
    };
  }

  for (const row of signalRows) {
    const bucket = byCategory[row.category];
    if (!bucket) continue;
    bucket.count += 1;
    if (row.outcomeResult == null && row.outcomeHitTp1 == null && row.outcomeHitSl == null) {
      bucket.missing_outcome_120m += 1;
      continue;
    }
    if (row.outcomeHitTp1 === true || row.outcomeResult === 'WIN') {
      bucket.tp1_hit_120m += 1;
    } else if (row.outcomeHitSl === true || row.outcomeResult === 'LOSS') {
      bucket.sl_hit_120m += 1;
    } else if (row.outcomeResult === 'NONE') {
      bucket.no_hit_120m += 1;
    } else {
      bucket.unresolved_120m += 1;
    }
  }

  const totals = {
    count: 0,
    tp1_hit_120m: 0,
    sl_hit_120m: 0,
    no_hit_120m: 0,
    missing_outcome_120m: 0,
    unresolved_120m: 0,
    win_rate_120m: 0,
    loss_rate_120m: 0,
    no_hit_rate_120m: 0,
  };

  for (const cat of categories) {
    const b = byCategory[cat];
    const denom = b.count > 0 ? b.count : 1;
    b.win_rate_120m = b.tp1_hit_120m / denom;
    b.loss_rate_120m = b.sl_hit_120m / denom;
    b.no_hit_rate_120m = b.no_hit_120m / denom;
    totals.count += b.count;
    totals.tp1_hit_120m += b.tp1_hit_120m;
    totals.sl_hit_120m += b.sl_hit_120m;
    totals.no_hit_120m += b.no_hit_120m;
    totals.missing_outcome_120m += b.missing_outcome_120m;
    totals.unresolved_120m += b.unresolved_120m;
  }
  const totalDenom = totals.count > 0 ? totals.count : 1;
  totals.win_rate_120m = totals.tp1_hit_120m / totalDenom;
  totals.loss_rate_120m = totals.sl_hit_120m / totalDenom;
  totals.no_hit_rate_120m = totals.no_hit_120m / totalDenom;

  return {
    horizonMin: 120,
    byCategory,
    totals,
  };
}

function buildParityMismatches(params: {
  rows: Array<{ runId?: string; symbol: string; metrics: any; computed: any }>;
  cfg: any;
  signalByKey: Map<string, RunSignalLite>;
  mismatchLimit: number;
}) {
  const { rows, cfg, signalByKey, mismatchLimit } = params;
  const readyOrder = ['sessionOK', 'priceAboveVwap', 'priceAboveEma', 'nearVwapReady', 'reclaimOrTap', 'readyVolOk', 'atrOkReady', 'confirm15mOk', 'strongBody', 'rrOk', 'riskOk', 'rsiReadyOk', 'readyTrendOk', 'sweepOk', 'btcOk', 'core'];
  const shortOrder = ['sessionOK', 'priceBelowVwap', 'priceBelowEma', 'nearVwapShort', 'rsiShortOk', 'strongBody', 'readyVolOk', 'atrOkReady', 'confirm15mOk', 'trendOkShort', 'rrOk', 'riskOk', 'sweepOk', 'btcOk', 'core'];
  const ready: any[] = [];
  const readyShort: any[] = [];

  for (const row of rows) {
    if (ready.length >= mismatchLimit && readyShort.length >= mismatchLimit) break;
    const simRes: any = evalFromFeatures({ metrics: row.metrics, computed: row.computed }, cfg);
    const key = `${String(row.runId ?? '')}|${String(row.symbol ?? '').toUpperCase()}`;
    const actual = signalByKey.get(key) ?? null;
    const actualCategory = actual?.category
      ?? (row.computed?.finalCategory != null ? String(row.computed.finalCategory) : null)
      ?? null;
    const actualReady = actualCategory === 'READY_TO_BUY' || actualCategory === 'BEST_ENTRY';
    const actualReadyShort = actualCategory === 'READY_TO_SELL' || actualCategory === 'BEST_SHORT_ENTRY';

    if (simRes.readyOk && !actualReady && ready.length < mismatchLimit) {
      const simFlags: Record<string, boolean> = {
        ...(simRes.readyFlags ?? {}),
        sweepOk: Boolean(simRes.readySweepOk),
        btcOk: Boolean(simRes.readyBtcOk),
        core: Boolean(simRes.readyCore),
      };
      const liveFlags = normalizeLiveReadyFlags(row.computed, actual?.gateSnapshot ?? null);
      const divergence = firstDiff(readyOrder, simFlags, liveFlags);
      ready.push({
        runId: String(row.runId ?? ''),
        symbol: String(row.symbol ?? ''),
        sim_ready: true,
        actual_ready: false,
        actual_category: actualCategory,
        why_not_emitted: divergence
          ? `first_divergence:${divergence}`
          : (actualCategory ? `actual_category:${actualCategory}` : 'actual_category:none'),
        first_failed_live: firstFalse(readyOrder, liveFlags),
        first_failed_sim: firstFalse(readyOrder, simFlags),
        sim_flags: simFlags,
        live_flags: liveFlags,
      });
    }

    if (simRes.readyShortOk && !actualReadyShort && readyShort.length < mismatchLimit) {
      const simShortFlags: Record<string, boolean> = {
        ...(simRes.readyShortFlags ?? {}),
        sweepOk: Boolean(simRes.readyShortSweepOk),
        btcOk: Boolean(simRes.readyShortBtcOk),
        core: Boolean(simRes.readyShortCore),
      };
      const liveShortFlags = normalizeLiveShortFlags(row.computed, actual?.gateSnapshot ?? null);
      const divergence = firstDiff(shortOrder, simShortFlags, liveShortFlags);
      readyShort.push({
        runId: String(row.runId ?? ''),
        symbol: String(row.symbol ?? ''),
        sim_ready_short: true,
        actual_ready_short: false,
        actual_category: actualCategory,
        why_not_emitted: divergence
          ? `first_divergence:${divergence}`
          : (actualCategory ? `actual_category:${actualCategory}` : 'actual_category:none'),
        first_failed_live: firstFalse(shortOrder, liveShortFlags),
        first_failed_sim: firstFalse(shortOrder, simShortFlags),
        sim_flags: simShortFlags,
        live_flags: liveShortFlags,
      });
    }
  }

  return { ready, readyShort };
}

type SimEval = {
  counts: SignalCounts;
  funnel: SimFunnel;
  intersections: {
    ready_core_all_true: number;
    ready_all_required_true: number;
    best_core_all_true: number;
    best_all_required_true: number;
    ready_short_core_all_true: number;
    ready_short_all_required_true: number;
    best_short_core_all_true: number;
    best_short_all_required_true: number;
  };
  firstFailed: Record<string, Record<string, number>>;
  gateTrue: Record<string, Record<string, number>>;
  postCoreFailed: Record<string, Record<string, number>>;
  examples?: Record<string, Record<string, string[]>>;
  readySymbols: Set<string>;
  bestSymbols: Set<string>;
};

function runTuneSimRows(rows: Array<{ symbol: string; metrics: any; computed: any }>, cfg: any, opts?: { includeExamples?: boolean; examplesPerGate?: number }): SimEval {
  const includeExamples = Boolean(opts?.includeExamples);
  const examplesPerGate = Math.max(1, Math.min(50, Number(opts?.examplesPerGate ?? 5)));

  const counts = { watch: 0, early: 0, ready: 0, best: 0, watchShort: 0, earlyShort: 0, readyShort: 0, bestShort: 0 };
  const funnel = {
    candidate_evaluated: rows.length,
    watch_created: 0,
    early_created: 0,
    ready_core_true: 0,
    best_core_true: 0,
    ready_final_true: 0,
    best_final_true: 0,
    watch_short_created: 0,
    early_short_created: 0,
    ready_short_core_true: 0,
    best_short_core_true: 0,
    ready_short_final_true: 0,
    best_short_final_true: 0,
  };
  const intersections = {
    ready_core_all_true: 0,
    ready_all_required_true: 0,
    best_core_all_true: 0,
    best_all_required_true: 0,
    ready_short_core_all_true: 0,
    ready_short_all_required_true: 0,
    best_short_core_all_true: 0,
    best_short_all_required_true: 0,
  };
  const firstFailed: Record<string, Record<string, number>> = {
    watch: {},
    early: {},
    ready: {},
    best: {},
  };
  const gateTrue: Record<string, Record<string, number>> = {
    watch: {},
    early: {},
    ready: {},
    best: {},
  };
  const postCoreFailed: Record<string, Record<string, number>> = {
    ready: {},
    best: {},
  };
  const examples: Record<string, Record<string, string[]>> | undefined = includeExamples
    ? { watch: {}, early: {}, ready: {}, best: {} }
    : undefined;

  const watchOrder = ['nearVwapWatch', 'rsiWatchOk', 'emaWatchOk'];
  const earlyOrder = ['sessionOK', 'nearVwapWatch', 'rsiWatchOk', 'emaWatchOk', 'atrOkReady', 'reclaimOrTap', 'priceAboveVwap'];
  const readyOrder = [
    'sessionOK',
    'priceAboveVwap',
    'priceAboveEma',
    'nearVwapReady',
    'reclaimOrTap',
    'readyVolOk',
    'atrOkReady',
    'confirm15mOk',
    'strongBody',
    'rsiReadyOk',
    'readyTrendOk',
  ];
  const bestOrder = [
    'priceAboveVwap',
    'priceAboveEma',
    'nearVwapBuy',
    'rsiBestOk',
    'strongBody',
    'atrOkBest',
    'trendOk',
    'sessionOK',
    'confirm15mOk',
    'sweepOk',
    'reclaimOrTap',
    'bestVolOk',
    'rrOk',
    'hasMarket',
  ];

  const addGateTrue = (bucket: Record<string, number>, flags: Record<string, boolean>) => {
    for (const [k, ok] of Object.entries(flags)) {
      if (ok) bucket[k] = (bucket[k] ?? 0) + 1;
    }
  };
  const addFirstFailed = (stage: string, order: string[], flags: Record<string, boolean>, symbol: string) => {
    const k = order.find(key => !flags[key]);
    if (!k) return;
    firstFailed[stage][k] = (firstFailed[stage][k] ?? 0) + 1;
    if (examples) {
      const arr = examples[stage][k] ?? (examples[stage][k] = []);
      if (arr.length < examplesPerGate) arr.push(symbol);
    }
  };
  const addExample = (stage: string, key: string, symbol: string) => {
    if (!examples) return;
    const arr = examples[stage][key] ?? (examples[stage][key] = []);
    if (arr.length < examplesPerGate) arr.push(symbol);
  };

  const readySymbols = new Set<string>();
  const bestSymbols = new Set<string>();

  for (const row of rows) {
    const evalRes = evalFromFeatures({ metrics: row.metrics, computed: row.computed }, cfg);
    if (evalRes.watchOk) counts.watch += 1;
    if (evalRes.earlyOk) counts.early += 1;
    if (evalRes.readyOk) counts.ready += 1;
    if (evalRes.bestOk) counts.best += 1;
    if (evalRes.watchShortOk) counts.watchShort += 1;
    if (evalRes.earlyShortOk) counts.earlyShort += 1;
    if (evalRes.readyShortOk) counts.readyShort += 1;
    if (evalRes.bestShortOk) counts.bestShort += 1;

    if (evalRes.readyCore) intersections.ready_core_all_true += 1;
    if (evalRes.readyOk) intersections.ready_all_required_true += 1;
    if (evalRes.bestCore) intersections.best_core_all_true += 1;
    if (evalRes.bestOk) intersections.best_all_required_true += 1;
    if (evalRes.readyShortCore) intersections.ready_short_core_all_true += 1;
    if (evalRes.readyShortOk) intersections.ready_short_all_required_true += 1;
    if (evalRes.bestShortCore) intersections.best_short_core_all_true += 1;
    if (evalRes.bestShortOk) intersections.best_short_all_required_true += 1;

    if (evalRes.watchOk) funnel.watch_created += 1;
    if (evalRes.earlyOk) funnel.early_created += 1;
    if (evalRes.readyCore) funnel.ready_core_true += 1;
    if (evalRes.bestCore) funnel.best_core_true += 1;
    if (evalRes.readyOk) funnel.ready_final_true += 1;
    if (evalRes.bestOk) funnel.best_final_true += 1;
    if (evalRes.watchShortOk) funnel.watch_short_created += 1;
    if (evalRes.earlyShortOk) funnel.early_short_created += 1;
    if (evalRes.readyShortCore) funnel.ready_short_core_true += 1;
    if (evalRes.bestShortCore) funnel.best_short_core_true += 1;
    if (evalRes.readyShortOk) funnel.ready_short_final_true += 1;
    if (evalRes.bestShortOk) funnel.best_short_final_true += 1;

    addGateTrue(gateTrue.watch, evalRes.watchFlags);
    addGateTrue(gateTrue.early, evalRes.earlyFlags);
    addGateTrue(gateTrue.ready, evalRes.readyFlags);
    addGateTrue(gateTrue.best, evalRes.bestFlags);

    if (!evalRes.watchOk) addFirstFailed('watch', watchOrder, evalRes.watchFlags, row.symbol);
    if (!evalRes.earlyOk) addFirstFailed('early', earlyOrder, evalRes.earlyFlags, row.symbol);

    if (!evalRes.readyCore) {
      addFirstFailed('ready', readyOrder, evalRes.readyFlags, row.symbol);
    } else if (!evalRes.readySweepOk) {
      firstFailed.ready.readySweep = (firstFailed.ready.readySweep ?? 0) + 1;
      addExample('ready', 'readySweep', row.symbol);
    } else if (!evalRes.readyBtcOk) {
      firstFailed.ready.btcOkReady = (firstFailed.ready.btcOkReady ?? 0) + 1;
      addExample('ready', 'btcOkReady', row.symbol);
    }

    if (!evalRes.bestCore) {
      addFirstFailed('best', bestOrder, evalRes.bestFlags, row.symbol);
    } else if (!evalRes.bestBtcOk) {
      firstFailed.best.btcBull = (firstFailed.best.btcBull ?? 0) + 1;
      addExample('best', 'btcBull', row.symbol);
    }

    if (evalRes.readyCore && !evalRes.readyOk) {
      if (!evalRes.readySweepOk) postCoreFailed.ready.readySweep = (postCoreFailed.ready.readySweep ?? 0) + 1;
      if (!evalRes.readyBtcOk) postCoreFailed.ready.btcOkReady = (postCoreFailed.ready.btcOkReady ?? 0) + 1;
    }
    if (evalRes.bestCore && !evalRes.bestOk) {
      if (!evalRes.bestBtcOk) postCoreFailed.best.btcBull = (postCoreFailed.best.btcBull ?? 0) + 1;
    }

    if (evalRes.readyOk) readySymbols.add(row.symbol);
    if (evalRes.bestOk) bestSymbols.add(row.symbol);
  }

  return { counts, funnel, intersections, firstFailed, gateTrue, postCoreFailed, examples, readySymbols, bestSymbols };
}

const db = getDb();
const dbPath = db.driver === 'sqlite' ? DB_PATH : null;

console.log('[db] server dbPath:', dbPath || '(postgres)');
console.log('[db] env DB_PATH:', process.env.DB_PATH || '');

// init schema (if present)
void (async () => {
  if (db.driver === 'sqlite') {
    try {
      const schemaPath = path.join(__dirname, '../../db/schema.sql');
      console.log('[db] schemaPath:', schemaPath, 'exists?', fs.existsSync(schemaPath));
      if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        await db.exec(schema);
      }
    } catch (e) {
      console.warn('[db] schema load failed (continuing):', e);
    }

    // Ensure subscriptions table exists even if schema.sql is missing
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          endpoint TEXT PRIMARY KEY,
          keys_p256dh TEXT NOT NULL,
          keys_auth TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
        );
      `);
    } catch (e) {
      console.warn('[db] subscriptions table ensure failed:', e);
    }
  }
})();

// VAPID
let publicKey = '';
void ensureVapid()
  .then((r) => { publicKey = r.publicKey; })
  .catch((e) => console.warn('[vapid] init failed', e));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// System health (scan + outcomes + BTC)
app.get('/api/system/health', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(365, days)) : 7;
    const { lastFinished, lastRunning } = await getLatestScanRuns();
    const legacyScan = getLastScanHealth();
    const scanLast = lastFinished ?? legacyScan ?? null;
    const scanIntervalMs = getScanIntervalMs();
    let scanState: 'IDLE' | 'RUNNING' | 'COOLDOWN' = 'IDLE';
    let nextScanAt: number | null = null;
    if (lastRunning && lastRunning.status === 'RUNNING') {
      scanState = 'RUNNING';
    } else if (scanLast?.finishedAt) {
      const next = Number(scanLast.finishedAt) + scanIntervalMs;
      nextScanAt = next;
      if (Date.now() < next) scanState = 'COOLDOWN';
    }
    const scan = {
      state: scanState,
      nextScanAt,
      meta: {
        intervalMs: scanIntervalMs,
        maxScanMs: getMaxScanMs(),
      },
      last: scanLast,
      current: lastRunning ?? null,
    };
    const { market, at } = getLastBtcMarket();
    const outcomes = getOutcomesHealth();
    const backlog = await getOutcomesBacklogCount({ days: safeDays });
    res.json({
      ok: true,
      days: safeDays,
      categoriesLogged: getLoggedCategories(),
      build: {
        gitSha: buildGitSha || null,
        startedAt: buildStartedAt,
      },
      scan,
      btc: { market, at },
      outcomes: {
        lastRun: outcomes,
        backlog,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Scan runs (history)
app.get('/api/scanRuns', async (req, res) => {
  try {
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(400, limitRaw)) : 50;
    const rows = await listScanRuns(limit);
    res.json({ ok: true, limit, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/scanRuns/:runId/detail', async (req, res) => {
  try {
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });

    const run = await getScanRunByRunId(runId);
    if (!run) return res.status(404).json({ ok: false, error: 'Scan run not found' });

    const limitRaw = Number((req.query as any)?.limit);
    const offsetRaw = Number((req.query as any)?.offset);
    const horizonRaw = Number((req.query as any)?.horizonMin);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2000, limitRaw)) : 500;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.min(50_000, offsetRaw)) : 0;
    const horizonMin = Number.isFinite(horizonRaw) ? Math.max(1, Math.min(1440, horizonRaw)) : 120;

    const bind = { runId, limit, offset, horizonMin };
    let source: 'signal_events' | 'signals_fallback' = 'signal_events';
    let total = 0;
    let rows: any[] = [];

    try {
      const countRow = await db.prepare(`
        SELECT COUNT(1) as n
        FROM signal_events
        WHERE run_id = @runId
      `).get({ runId }) as { n?: number } | undefined;
      total = Number(countRow?.n ?? 0);

      rows = await db.prepare(`
        SELECT
          e.id as "id",
          e.signal_id as "signalId",
          e.run_id as "runId",
          e.symbol as "symbol",
          e.category as "category",
          e.time as "time",
          e.preset as "preset",
          e.config_hash as "configHash",
          e.instance_id as "instanceId",
          e.created_at as "createdAt",
          e.first_failed_gate as "firstFailedGate",
          e.gate_snapshot_json as "gateSnapshotJson",
          e.ready_debug_json as "readyDebugJson",
          e.best_debug_json as "bestDebugJson",
          e.entry_debug_json as "entryDebugJson",
          e.config_snapshot_json as "configSnapshotJson",
          e.blocked_reasons_json as "blockedReasonsJson",
          e.signal_json as "signalJson",
          o.result as "outcomeResult",
          o.hit_tp1 as "outcomeHitTp1",
          o.hit_sl as "outcomeHitSl",
          o.window_status as "outcomeWindowStatus"
        FROM signal_events e
        LEFT JOIN signal_outcomes o
          ON o.signal_id = e.signal_id
          AND o.horizon_min = @horizonMin
        WHERE e.run_id = @runId
        ORDER BY e.id ASC
        LIMIT @limit OFFSET @offset
      `).all(bind) as any[];
    } catch {
      source = 'signals_fallback';
      total = 0;
      rows = [];
    }

    if (source === 'signal_events' && total === 0) {
      source = 'signals_fallback';
    }

    if (source === 'signals_fallback') {
      const countRow = await db.prepare(`
        SELECT COUNT(1) as n
        FROM signals
        WHERE run_id = @runId
      `).get({ runId }) as { n?: number } | undefined;
      total = Number(countRow?.n ?? 0);
      rows = await db.prepare(`
        SELECT
          s.id as "id",
          s.id as "signalId",
          s.run_id as "runId",
          s.symbol as "symbol",
          s.category as "category",
          s.time as "time",
          s.preset as "preset",
          s.config_hash as "configHash",
          s.instance_id as "instanceId",
          s.created_at as "createdAt",
          s.first_failed_gate as "firstFailedGate",
          s.gate_snapshot_json as "gateSnapshotJson",
          s.ready_debug_json as "readyDebugJson",
          s.best_debug_json as "bestDebugJson",
          s.entry_debug_json as "entryDebugJson",
          s.config_snapshot_json as "configSnapshotJson",
          s.blocked_reasons_json as "blockedReasonsJson",
          NULL as "signalJson",
          o.result as "outcomeResult",
          o.hit_tp1 as "outcomeHitTp1",
          o.hit_sl as "outcomeHitSl",
          o.window_status as "outcomeWindowStatus"
        FROM signals s
        LEFT JOIN signal_outcomes o
          ON o.signal_id = s.id
          AND o.horizon_min = @horizonMin
        WHERE s.run_id = @runId
        ORDER BY s.id ASC
        LIMIT @limit OFFSET @offset
      `).all(bind) as any[];
    }

    const outRows = rows.map((r) => ({
      id: Number(r.id ?? 0),
      signalId: r.signalId == null ? null : Number(r.signalId),
      runId: String(r.runId ?? runId),
      symbol: String(r.symbol ?? ''),
      category: String(r.category ?? ''),
      time: Number(r.time ?? 0),
      preset: r.preset == null ? null : String(r.preset),
      configHash: r.configHash == null ? null : String(r.configHash),
      instanceId: r.instanceId == null ? null : String(r.instanceId),
      createdAt: Number(r.createdAt ?? 0),
      firstFailedGate: r.firstFailedGate == null ? null : String(r.firstFailedGate),
      gateSnapshot: safeJsonParse<any>(r.gateSnapshotJson),
      readyDebug: safeJsonParse<any>(r.readyDebugJson),
      bestDebug: safeJsonParse<any>(r.bestDebugJson),
      entryDebug: safeJsonParse<any>(r.entryDebugJson),
      configSnapshot: safeJsonParse<any>(r.configSnapshotJson),
      blockedReasons: safeJsonParse<any>(r.blockedReasonsJson),
      signal: safeJsonParse<any>(r.signalJson),
      outcome: {
        result: r.outcomeResult == null ? null : String(r.outcomeResult),
        hitTp1: toBool(r.outcomeHitTp1),
        hitSl: toBool(r.outcomeHitSl),
        windowStatus: r.outcomeWindowStatus == null ? null : String(r.outcomeWindowStatus),
      },
    }));

    res.json({
      ok: true,
      runId,
      run,
      meta: {
        source,
        limit,
        offset,
        total,
        horizonMin,
      },
      rows: outRows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Tune simulator (admin-only)
app.post('/api/tune/sim', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = req.body || {};
    let runId = String(body.runId || '').trim();
    const useLatest = body.useLatestFinishedIfMissing !== false;
    let scanRun = runId ? await getScanRunByRunId(runId) : null;
    if (!runId && useLatest) {
      const latest = await getLatestScanRuns();
      scanRun = latest.lastFinished;
      runId = scanRun?.runId ?? '';
    }
    if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });
    if (!scanRun && runId) scanRun = await getScanRunByRunId(runId);

    const preset = parsePreset(body.preset ?? scanRun?.preset ?? 'BALANCED');
    const scope = body.scope || {};
    const limitRaw = Number(scope?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, limitRaw)) : 500;
    const symbols = Array.isArray(scope?.symbols) ? scope.symbols : null;

    const rows = await listCandidateFeatures({
      runId,
      preset: body.preset ? preset : undefined,
      limit,
      symbols,
    });
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No candidate features found' });

    const cfgBase = getTuneConfigFromEnv(thresholdsForPreset(preset));
    const overrideReport = applyOverrides(cfgBase, body.overrides || {});
    const includeExamples = Boolean(body.includeExamples);
    const sim = runTuneSimRows(rows, overrideReport.config, { includeExamples, examplesPerGate: body.examplesPerGate });
    const actualCounts = scanRun?.signalsByCategory ? {
      watch: Number(scanRun.signalsByCategory?.WATCH ?? 0),
      early: Number(scanRun.signalsByCategory?.EARLY_READY ?? 0),
      ready: Number(scanRun.signalsByCategory?.READY_TO_BUY ?? 0),
      best: Number(scanRun.signalsByCategory?.BEST_ENTRY ?? 0),
      watchShort: Number(scanRun.signalsByCategory?.WATCH_SHORT ?? 0),
      earlyShort: Number(scanRun.signalsByCategory?.EARLY_READY_SHORT ?? 0),
      readyShort: Number(scanRun.signalsByCategory?.READY_TO_SELL ?? 0),
      bestShort: Number(scanRun.signalsByCategory?.BEST_SHORT_ENTRY ?? 0),
    } : null;
    const parityWithActual = body.parityWithActual !== false;
    const useActualParity = Boolean(actualCounts && parityWithActual && hasNoOverrides(overrideReport));
    const countsOut = useActualParity ? (actualCounts as NonNullable<typeof actualCounts>) : sim.counts;
    const funnelOut = useActualParity ? alignFunnelToCounts(sim.funnel, countsOut) : sim.funnel;
    const runSignalRows = await loadSignalsForRuns([runId], 120);
    const signalByKey = new Map<string, RunSignalLite>();
    for (const row of runSignalRows) {
      const key = `${row.runId}|${row.symbol.toUpperCase()}`;
      const prev = signalByKey.get(key);
      if (!prev || row.id > prev.id) signalByKey.set(key, row);
    }
    const mismatchLimitRaw = Number(body.mismatchLimit ?? 20);
    const mismatchLimit = Number.isFinite(mismatchLimitRaw) ? Math.max(1, Math.min(200, mismatchLimitRaw)) : 20;
    const parityMismatches = buildParityMismatches({
      rows: rows.map((r) => ({ runId: r.runId, symbol: r.symbol, metrics: r.metrics, computed: r.computed })),
      cfg: overrideReport.config,
      signalByKey,
      mismatchLimit,
    });
    const actualOutcome120m = computeActualOutcome120m(runSignalRows);

    const startedAt = scanRun?.startedAt ?? rows[0]?.startedAt ?? null;
    const diffVsActual = actualCounts ? diffCounts(countsOut, actualCounts) : null;

    res.json({
      meta: {
        preset,
        runId,
        startedAt,
        evaluated: rows.length,
        parityWithActualApplied: useActualParity,
        overrides: {
          applied: overrideReport.appliedOverrides,
          unknownKeys: overrideReport.unknownOverrideKeys,
          typeErrors: overrideReport.overrideTypeErrors,
          effectiveConfig: overrideReport.config,
        },
        notes: buildOverrideNotes(body.overrides),
      },
      counts: countsOut,
      funnel: funnelOut,
      simCountsRaw: sim.counts,
      simFunnelRaw: sim.funnel,
      intersections: sim.intersections,
      postCoreFailed: sim.postCoreFailed,
      firstFailed: sim.firstFailed,
      gateTrue: sim.gateTrue,
      ...(sim.examples ? { examples: sim.examples } : {}),
      actualCounts,
      diffVsActual,
      parityMismatches,
      actualOutcome120m,
      riskNotes: [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Tune simulator (batch) (admin-only)
app.post('/api/tune/simBatch', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = req.body || {};
    const source = body.source || {};
    const sourceMode = String(source.mode || '').toLowerCase();
    let runId = String(body.runId || source.runId || '').trim();
    const useLatest = body.useLatestFinishedIfMissing !== false;
    const runIdsRaw = Array.isArray(source.runIds) ? source.runIds : (Array.isArray(body.runIds) ? body.runIds : null);
    if (sourceMode === 'lastscan') runId = '';
    let scanRun = runId ? await getScanRunByRunId(runId) : null;
    let runIds: string[] = [];
    let runMeta: Array<{ runId: string; startedAt: number }> = [];
    let selectedRuns: any[] = [];

    if (sourceMode === 'runids') {
      const ids = (runIdsRaw ?? [])
        .map((v: any) => String(v).trim())
        .filter(Boolean);
      if (!ids.length) return res.status(400).json({ ok: false, error: 'runIds required' });
      runIds = ids.slice(0, 200);
      scanRun = await getScanRunByRunId(runIds[0]);
      const runsRaw = await listScanRuns(2000);
      const runMap = new Map(runsRaw.map((r: any) => [r.runId, r]));
      runMeta = runIds
        .map((id) => ({ runId: id, startedAt: Number(runMap.get(id)?.startedAt ?? 0) }))
        .filter((r) => Number.isFinite(r.startedAt) && r.startedAt > 0);
      selectedRuns = runIds
        .map((id) => runMap.get(id))
        .filter((r): r is any => Boolean(r));
      runId = runIds[0] || '';
      if (!runIds.length) return res.status(404).json({ ok: false, error: 'No scan runs found' });
    } else if (sourceMode === 'lastn') {
      const limitRaw = Number(source.limit ?? source.count ?? 25);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(400, limitRaw)) : 25;
      const runsRaw = await listScanRuns(limit);
      const runs = runsRaw.filter((r): r is any => Boolean(r));
      runIds = runs.map(r => r.runId);
      runMeta = runs.map(r => ({ runId: r.runId, startedAt: r.startedAt }));
      selectedRuns = runs;
      runId = runIds[0] || '';
      if (!runIds.length) return res.status(404).json({ ok: false, error: 'No scan runs found' });
    } else {
      if (!runId && useLatest) {
        const latest = await getLatestScanRuns();
        scanRun = latest.lastFinished;
        runId = scanRun?.runId ?? '';
      }
      if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });
      if (!scanRun && runId) scanRun = await getScanRunByRunId(runId);
      selectedRuns = scanRun ? [scanRun] : [];
    }

    const preset = parsePreset(body.preset ?? scanRun?.preset ?? 'BALANCED');
    const scope = body.scope || {};
    const limitRaw = Number(scope?.limit);
    const limitPerRun = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, limitRaw)) : 500;
    const symbols = Array.isArray(scope?.symbols) ? scope.symbols : null;
    const includeExamples = Boolean(body.includeExamples);
    const examplesPerGate = body.examplesPerGate;
    const diffSymbolsLimitRaw = Number(body.diffSymbolsLimit ?? 200);
    const diffSymbolsLimit = Number.isFinite(diffSymbolsLimitRaw) ? Math.max(0, Math.min(2000, diffSymbolsLimitRaw)) : 200;

    const runIdsList = runIds;
    const useMulti = runIdsList.length > 1;
    const effectiveLimit = useMulti ? Math.min(50000, limitPerRun * runIdsList.length) : limitPerRun;
    const rows = useMulti
      ? await listCandidateFeaturesMulti({
        runIds: runIdsList,
        preset: body.preset ? preset : undefined,
        limit: effectiveLimit,
        symbols,
      })
      : await listCandidateFeatures({
        runId,
        preset: body.preset ? preset : undefined,
        limit: effectiveLimit,
        symbols,
      });
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No candidate features found' });

    const variants = Array.isArray(body.variants) ? body.variants : [];
    if (!variants.length) return res.status(400).json({ ok: false, error: 'variants required' });
    const runIdsOut = useMulti ? runIds : [runId].filter(Boolean);

    const cfgBase = getTuneConfigFromEnv(thresholdsForPreset(preset));
    const baseOverrideReport = applyOverrides(cfgBase, body.baseOverrides || {});
    const baseSim = runTuneSimRows(rows, baseOverrideReport.config, { includeExamples, examplesPerGate });
    const parityWithActual = body.parityWithActual !== false;
    const hasActualCounts = selectedRuns.some((r) => r && typeof r.signalsByCategory === 'object' && r.signalsByCategory != null);
    const actualCounts = hasActualCounts
      ? selectedRuns.reduce((acc, r) => {
        const cats = r?.signalsByCategory ?? {};
        acc.watch += Number(cats.WATCH ?? 0);
        acc.early += Number(cats.EARLY_READY ?? 0);
        acc.ready += Number(cats.READY_TO_BUY ?? 0);
        acc.best += Number(cats.BEST_ENTRY ?? 0);
        acc.watchShort += Number(cats.WATCH_SHORT ?? 0);
        acc.earlyShort += Number(cats.EARLY_READY_SHORT ?? 0);
        acc.readyShort += Number(cats.READY_TO_SELL ?? 0);
        acc.bestShort += Number(cats.BEST_SHORT_ENTRY ?? 0);
        return acc;
      }, { ...ZERO_COUNTS })
      : null;
    const baseNoOverrides = hasNoOverrides(baseOverrideReport);
    const useActualBase = Boolean(actualCounts && parityWithActual && baseNoOverrides);
    const baseCounts = useActualBase ? (actualCounts as SignalCounts) : baseSim.counts;
    const baseFunnel = useActualBase ? alignFunnelToCounts(baseSim.funnel, baseCounts) : baseSim.funnel;
    const baseDiffVsActual = actualCounts ? diffCounts(baseCounts, actualCounts) : null;
    const runSignalRows = await loadSignalsForRuns(runIdsOut, 120);
    const signalByKey = new Map<string, RunSignalLite>();
    for (const row of runSignalRows) {
      const key = `${row.runId}|${row.symbol.toUpperCase()}`;
      const prev = signalByKey.get(key);
      if (!prev || row.id > prev.id) signalByKey.set(key, row);
    }
    const mismatchLimitRaw = Number(body.mismatchLimit ?? 20);
    const mismatchLimit = Number.isFinite(mismatchLimitRaw) ? Math.max(1, Math.min(200, mismatchLimitRaw)) : 20;
    const baseParityMismatches = buildParityMismatches({
      rows: rows.map((r) => ({ runId: r.runId, symbol: r.symbol, metrics: r.metrics, computed: r.computed })),
      cfg: baseOverrideReport.config,
      signalByKey,
      mismatchLimit,
    });
    const actualOutcome120m = computeActualOutcome120m(runSignalRows);

    const buildDiff = (baseSet: Set<string>, curSet: Set<string>) => {
      const added: string[] = [];
      const removed: string[] = [];
      for (const sym of curSet) {
        if (!baseSet.has(sym)) {
          added.push(sym);
          if (added.length >= diffSymbolsLimit) break;
        }
      }
      for (const sym of baseSet) {
        if (!curSet.has(sym)) {
          removed.push(sym);
          if (removed.length >= diffSymbolsLimit) break;
        }
      }
      return { added, removed };
    };

    const variantResults = variants.map((variant: any, idx: number) => {
      const nameRaw = variant?.name ?? `variant_${idx + 1}`;
      const name = String(nameRaw || `variant_${idx + 1}`);
      const overrides = variant?.overrides || {};
      const overrideReport = applyOverrides(baseOverrideReport.config, overrides);
      const sim = runTuneSimRows(rows, overrideReport.config, { includeExamples, examplesPerGate });
      const variantNoOverrides = hasNoOverrides(overrideReport);
      const useActualVariant = Boolean(actualCounts && parityWithActual && variantNoOverrides);
      const countsOut = useActualVariant ? (actualCounts as SignalCounts) : sim.counts;
      const funnelOut = useActualVariant ? alignFunnelToCounts(sim.funnel, countsOut) : sim.funnel;
      const readyDiff = (useActualVariant || useActualBase)
        ? { added: [] as string[], removed: [] as string[] }
        : buildDiff(baseSim.readySymbols, sim.readySymbols);
      const bestDiff = (useActualVariant || useActualBase)
        ? { added: [] as string[], removed: [] as string[] }
        : buildDiff(baseSim.bestSymbols, sim.bestSymbols);
      return {
        name,
        parityWithActualApplied: useActualVariant,
        overrides: {
          applied: overrideReport.appliedOverrides,
          unknownKeys: overrideReport.unknownOverrideKeys,
          typeErrors: overrideReport.overrideTypeErrors,
          effectiveConfig: overrideReport.config,
        },
        notes: buildOverrideNotes({ ...(body.baseOverrides || {}), ...(overrides || {}) }),
        counts: countsOut,
        funnel: funnelOut,
        simCountsRaw: sim.counts,
        simFunnelRaw: sim.funnel,
        intersections: sim.intersections,
        postCoreFailed: sim.postCoreFailed,
        firstFailed: sim.firstFailed,
        gateTrue: sim.gateTrue,
        ...(sim.examples ? { examples: sim.examples } : {}),
        diffVsBase: {
          counts: diffCounts(countsOut, baseCounts),
          addedReadySymbols: readyDiff.added,
          removedReadySymbols: readyDiff.removed,
          addedBestSymbols: bestDiff.added,
          removedBestSymbols: bestDiff.removed,
        },
        diffVsActual: actualCounts ? diffCounts(countsOut, actualCounts) : null,
      };
    });

    const startedAt = scanRun?.startedAt ?? rows[0]?.startedAt ?? null;
    const startedAtRange = runMeta.length
      ? {
        min: Math.min(...runMeta.map(r => r.startedAt)),
        max: Math.max(...runMeta.map(r => r.startedAt)),
      }
      : null;

    res.json({
      meta: {
        preset,
        runId,
        runIds: runIdsOut,
        runCount: runIdsOut.length,
        actualRunCount: selectedRuns.length,
        parityWithActualApplied: useActualBase,
        startedAt,
        startedAtRange,
        evaluated: rows.length,
        limitPerRun,
        effectiveLimit,
        baseOverrides: {
          applied: baseOverrideReport.appliedOverrides,
          unknownKeys: baseOverrideReport.unknownOverrideKeys,
          typeErrors: baseOverrideReport.overrideTypeErrors,
          effectiveConfig: baseOverrideReport.config,
        },
        notes: buildOverrideNotes(body.baseOverrides),
        source: {
          mode: sourceMode || (useMulti ? 'lastN' : (runId ? 'runId' : 'lastScan')),
          runIds: runIdsOut,
        },
      },
      base: {
        counts: baseCounts,
        actualCounts,
        diffVsActual: baseDiffVsActual,
        funnel: baseFunnel,
        simCountsRaw: baseSim.counts,
        simFunnelRaw: baseSim.funnel,
        intersections: baseSim.intersections,
        postCoreFailed: baseSim.postCoreFailed,
        firstFailed: baseSim.firstFailed,
        gateTrue: baseSim.gateTrue,
        parityMismatches: baseParityMismatches,
        actualOutcome120m,
        ...(baseSim.examples ? { examples: baseSim.examples } : {}),
      },
      variants: variantResults,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Tune histograms (admin-only)
app.get('/api/tune/hist', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    let runId = String((req.query as any)?.runId || '').trim();
    const useLatestRaw = String((req.query as any)?.useLatestFinishedIfMissing || '').toLowerCase();
    const useLatest = useLatestRaw ? ['1', 'true', 'yes'].includes(useLatestRaw) : true;
    let scanRun = runId ? await getScanRunByRunId(runId) : null;
    if (!runId && useLatest) {
      const latest = await getLatestScanRuns();
      scanRun = latest.lastFinished;
      runId = scanRun?.runId ?? '';
    }
    if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });
    if (!scanRun && runId) scanRun = await getScanRunByRunId(runId);

    const preset = parsePreset((req.query as any)?.preset ?? scanRun?.preset ?? 'BALANCED');
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10000, limitRaw)) : 5000;
    const rows = await listCandidateFeatures({ runId, preset: (req.query as any)?.preset ? preset : undefined, limit });
    if (!rows.length) return res.status(404).json({ ok: false, error: 'No candidate features found' });

    const rsiVals: number[] = [];
    const vwapAbs: number[] = [];
    const emaAbs: number[] = [];
    const bodyPctVals: number[] = [];
    const atrPctVals: number[] = [];

    for (const row of rows) {
      const m = row.metrics ?? {};
      const rsi = Number(m.rsi);
      const vwapDist = Number(m.vwapDistPct);
      const emaDist = Number(m.emaDistPct);
      const body = Number(m.bodyPct);
      const atr = Number(m.atrPct);
      if (Number.isFinite(rsi)) rsiVals.push(rsi);
      if (Number.isFinite(vwapDist)) vwapAbs.push(Math.abs(vwapDist));
      if (Number.isFinite(emaDist)) emaAbs.push(Math.abs(emaDist));
      if (Number.isFinite(body)) bodyPctVals.push(body);
      if (Number.isFinite(atr)) atrPctVals.push(atr);
    }

    res.json({
      ok: true,
      meta: {
        runId,
        preset,
        startedAt: scanRun?.startedAt ?? rows[0]?.startedAt ?? null,
        evaluated: rows.length,
      },
      rsi: computePercentiles(rsiVals),
      vwapAbs: computePercentiles(vwapAbs),
      emaAbs: computePercentiles(emaAbs),
      bodyPct: computePercentiles(bodyPctVals),
      atrPct: computePercentiles(atrPctVals),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Tuning bundles (admin-only)
app.get('/api/tuning/bundles/latest', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const hoursRaw = Number((req.query as any)?.hours);
    const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(168, hoursRaw)) : undefined;
    const configHash = String((req.query as any)?.configHash || '').trim();
    const bundle = await getLatestTuningBundle({ windowHours: hours, configHash: configHash || undefined });
    if (!bundle) return res.status(404).json({ ok: false, error: 'No tuning bundle found' });
    res.json({ ok: true, bundle });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/tuning/bundles/recent', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
    const configHash = String((req.query as any)?.configHash || '').trim();
    const bundles = await listRecentTuningBundles({ limit, configHash: configHash || undefined });
    res.json({ ok: true, bundles });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/tuning/bundles/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const bundle = await getTuningBundleById(id);
    if (!bundle) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, bundle });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Admin: generate a fresh bundle on demand
app.post('/api/tuning/bundles/generate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const hoursRaw = Number((req.query as any)?.hours);
    const limitRaw = Number((req.query as any)?.limit);
    const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(168, hoursRaw)) : undefined;
    const limit = Number.isFinite(limitRaw) ? Math.max(50, Math.min(1000, limitRaw)) : undefined;
    const configHash = String((req.query as any)?.configHash || '').trim() || undefined;
    const result = await generateTuningBundle({ hours, limit, configHash });
    res.json({ ok: true, bundle: result?.payload ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Admin: list recent config hashes from signals
app.get('/api/tuning/config-hashes', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const hoursRaw = Number((req.query as any)?.hours);
    const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(720, hoursRaw)) : 6;
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 20;
    const windowEndMs = Date.now();
    const windowStartMs = windowEndMs - hours * 60 * 60_000;
    const rows = await getDb().prepare(`
      SELECT config_hash as "configHash", COUNT(*) as n
      FROM signals
      WHERE time >= @start AND time < @end
        AND config_hash IS NOT NULL
      GROUP BY config_hash
      ORDER BY n DESC
      LIMIT @limit
    `).all({ start: windowStartMs, end: windowEndMs, limit });
    res.json({ ok: true, hashes: rows ?? [], windowStartMs, windowEndMs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Debug: list tables
app.get('/api/debug/tables', async (_req, res) => {
  try {
    if (db.driver === 'sqlite') {
      const rows = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{ name: string }>;
      res.json({ ok: true, tables: rows.map(r => r.name) });
      return;
    }
    const rows = await db.prepare(`
      SELECT table_name as name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `).all() as Array<{ name: string }>;
    res.json({ ok: true, tables: rows.map(r => r.name) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Public key
app.get('/api/vapidPublicKey', async (_req, res) => {
  try {
    if (!publicKey) {
      const r = await ensureVapid();
      publicKey = r.publicKey;
    }
    res.json({ publicKey });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// BTC market snapshot (for frontend display)
app.get('/api/market/btc', (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const { market, at } = getLastBtcMarket();
    res.json({ ok: true, market, at });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Subscriptions
app.post('/api/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  try {
    await db.prepare(`INSERT INTO subscriptions(endpoint, keys_p256dh, keys_auth)
                VALUES(?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET keys_p256dh=excluded.keys_p256dh, keys_auth=excluded.keys_auth`)
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  } catch (e) {
    console.warn('[db] subscribe insert failed:', e);
  }
  res.json({ ok: true });
});

app.post('/api/unsubscribe', async (req, res) => {
  const sub = req.body;
  if (sub?.endpoint) {
    try { await db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(sub.endpoint); } catch {}
  }
  res.json({ ok: true });
});

// ✅ Scan-once with coalescing queue (max 1 running + 1 pending)
let running: Promise<any[]> | null = null;
let runningPreset: Preset | null = null;
let runningStartedAt = 0;
let pendingPreset: Preset | null = null;
const lastByPreset = new Map<Preset, { signals: any[]; at: number }>();

async function runScan(preset: Preset) {
  runningPreset = preset;
  runningStartedAt = Date.now();
  try {
    const out = await scanOnce(preset);
    const at = Date.now();
    lastByPreset.set(preset, { signals: out, at });
    try {
      for (const sig of out) await recordSignal(sig as any, preset);
    } catch (e) {
      console.warn('[signals] record failed:', e);
    }
    return out;
  } finally {
    running = null;
    runningPreset = null;
    const next = pendingPreset;
    pendingPreset = null;
    if (next) running = runScan(next);
  }
}

app.get('/api/scan', async (req, res) => {
  const preset = parsePreset((req.query as any)?.preset);
  const asyncModeRaw = String((req.query as any)?.async ?? '').toLowerCase();
  const asyncMode = ['1', 'true', 'yes'].includes(asyncModeRaw);

  const last = lastByPreset.get(preset) ?? { signals: [], at: 0 };

  if (!running) {
    running = runScan(preset);
  } else {
    pendingPreset = preset;
  }

  if (asyncMode) {
    return res.json({
      queued: true,
      running: Boolean(running),
      runningPreset,
      runningStartedAt,
      preset,
      at: last.at || Date.now(),
      signals: last.signals,
    });
  }

  try {
    const out = await running;
    return res.json({ preset, at: Date.now(), signals: out });
  } catch (e) {
    return res.status(500).json({ preset, at: Date.now(), signals: [], error: String(e) });
  }
});

// --- DEBUG: push ---
app.post('/api/debug/push', async (req, res) => {
  try {
    const { symbol = 'DEMOUSDT', category = 'BEST_ENTRY', price = 1.2345 } = req.body || {};
    const title =
      category === 'READY_TO_BUY' ? '[BUY] Ready to BUY' :
      category === 'BEST_ENTRY' ? '[BEST] Best Entry' :
      category === 'READY_TO_SELL' ? '[SELL] Ready to SELL' :
      category === 'BEST_SHORT_ENTRY' ? '[BEST SHORT] Best Short Entry' :
      '[WATCH] Watch';
    const body = `${symbol} @ ${Number(price).toFixed(6)} | ΔVWAP 0.20% | RSI 56.5 | Vol× 1.80`;
    await pushToAll({ title, body, data: { symbol, price, category } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- DEBUG: email ---
app.get('/api/debug/email', async (_req, res) => {
  try {
    const fakeSignal: any = {
      symbol: 'TESTUSDT',
      category: 'BEST_ENTRY',
      price: 123.45,
      rsi9: 55.2,
      vwapDistancePct: 0.001,
      ema200: 123.00,
      volume: 99999,
      chartUrl: 'https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT'
    };
    await emailNotify(undefined, fakeSignal);
    res.json({ ok: true, sent: fakeSignal });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- DEBUG: outcomes health ---
app.get('/api/debug/outcomes/health', async (req, res) => {
  const enabled = (process.env.DEBUG_ENDPOINTS ?? 'false').toLowerCase() === 'true';
  if (!enabled) return res.status(404).json({ ok: false });
  const debugKey = process.env.DEBUG_KEY;
  if (debugKey && req.header('x-debug-key') !== debugKey) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    const days = Number((req.query as any)?.days);
    const safeDays = Number.isFinite(days) ? Math.max(1, Math.min(365, days)) : 7;
    const since = Date.now() - safeDays * 24 * 60 * 60_000;

    const byStatus = await db.prepare(`
      SELECT
        o.window_status as status,
        COALESCE(o.invalid_reason, '') as reason,
        COUNT(*) as n
      FROM signal_outcomes o
      JOIN signals s ON s.id = o.signal_id
      WHERE s.time >= ?
      GROUP BY 1, 2
      ORDER BY n DESC
    `).all(since);

    const coverage = await db.prepare(`
      SELECT
        o.horizon_min as horizonMin,
        AVG((o.n_candles * 100.0) / (1.0 * o.horizon_min / NULLIF(o.interval_min, 0))) as avgCoveragePct,
        MIN((o.n_candles * 100.0) / (1.0 * o.horizon_min / NULLIF(o.interval_min, 0))) as minCoveragePct
      FROM signal_outcomes o
      JOIN signals s ON s.id = o.signal_id
      WHERE s.time >= ?
        AND o.window_status = 'COMPLETE'
      GROUP BY o.horizon_min
      ORDER BY o.horizon_min
    `).all(since);

    res.json({ ok: true, days: safeDays, since, byStatus, coverage });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- DEBUG: ready gate diagnostics ---
app.get('/api/debug/readyGate', async (req, res) => {
  const enabled = (process.env.DEBUG_ENDPOINTS ?? 'false').toLowerCase() === 'true';
  if (!enabled) return res.status(404).json({ ok: false });
  const debugKey = process.env.DEBUG_KEY;
  if (debugKey && req.header('x-debug-key') !== debugKey) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50;

    const rows = await db.prepare(`
      SELECT
        id,
        symbol,
        time,
        category,
        blocked_by_btc as blockedByBtc,
        ready_debug_json as readyDebugJson,
        gate_snapshot_json as gateSnapshotJson
      FROM signals
      ORDER BY time DESC
      LIMIT ?
    `).all(limit) as Array<any>;

    const countsAll: Record<string, number> = {};
    const countsEarly: Record<string, number> = {};
    const items = rows.map((r) => {
      let blockedReasons: string[] = [];
      let firstFailedGate: string | null = null;
      let gateScore: number | null = null;

      try {
        if (r.readyDebugJson) {
          const parsed = JSON.parse(String(r.readyDebugJson));
          blockedReasons = Array.isArray(parsed?.blockedReasons) ? parsed.blockedReasons : [];
          firstFailedGate = parsed?.firstFailedGate ?? null;
          gateScore = Number.isFinite(parsed?.gateScore) ? parsed.gateScore : null;
        } else if (r.gateSnapshotJson) {
          const snap = JSON.parse(String(r.gateSnapshotJson));
          const ready = snap?.ready ?? {};
          const gateMap: Array<{ key: string; ok: boolean; reason: string }> = [
            { key: 'nearVwapBuy', ok: Boolean(ready.nearVwap), reason: 'Too far from VWAP (extended)' },
            { key: 'confirm15mOk', ok: Boolean(ready.confirm15), reason: '15m confirmation not satisfied' },
            { key: 'trendOk', ok: Boolean(ready.trend), reason: 'Trend not OK (EMA50>EMA200 + both rising)' },
            { key: 'volSpike', ok: Boolean(ready.volSpike), reason: 'Volume spike not met' },
            { key: 'atrOk', ok: Boolean(ready.atr), reason: 'ATR too high' },
            { key: 'sweepOk', ok: Boolean(ready.sweep), reason: 'Liquidity sweep not detected' },
            { key: 'strongBody', ok: Boolean(ready.strongBody), reason: 'No strong bullish body candle' },
            { key: 'reclaimOrTap', ok: Boolean(ready.reclaimOrTap), reason: 'No reclaim/tap pattern (or blocked by day boundary)' },
            { key: 'hasMarket', ok: Boolean(ready.hasMarket), reason: 'BTC market data missing' },
            { key: 'btcOk', ok: Boolean(ready.btc), reason: 'BTC regime gate failed' },
          ];
          const failed = gateMap.filter(g => !g.ok);
          blockedReasons = failed.map(g => g.reason);
          firstFailedGate = failed[0]?.key ?? null;
          gateScore = gateMap.length ? Math.round(((gateMap.length - failed.length) / gateMap.length) * 100) : null;
        }
      } catch {
        blockedReasons = [];
        firstFailedGate = null;
        gateScore = null;
      }

      for (const reason of blockedReasons) {
        countsAll[reason] = (countsAll[reason] ?? 0) + 1;
        if (r.category === 'EARLY_READY') {
          countsEarly[reason] = (countsEarly[reason] ?? 0) + 1;
        }
      }

      return {
        id: r.id,
        symbol: r.symbol,
        time: r.time,
        category: r.category,
        blockedByBtc: Boolean(r.blockedByBtc),
        blockedReasons,
        firstFailedGate,
        gateScore,
      };
    });

    res.json({ ok: true, limit, counts: countsAll, countsEarly, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- DEBUG: run outcomes once (manual trigger) ---
app.post('/api/debug/outcomes/run', async (req, res) => {
  const enabled = (process.env.DEBUG_ENDPOINTS ?? 'false').toLowerCase() === 'true';
  if (!enabled) return res.status(404).json({ ok: false });
  const debugKey = process.env.DEBUG_KEY;
  if (debugKey && req.header('x-debug-key') !== debugKey) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    await updateOutcomesOnce();
    const outcomes = getOutcomesHealth();
    const signalsTotal = await db.prepare('SELECT COUNT(1) as n FROM signals').get() as { n: number };
    const signalEventsTotal = await db.prepare('SELECT COUNT(1) as n FROM signal_events').get() as { n: number };
    const outcomesTotal = await db.prepare('SELECT COUNT(1) as n FROM signal_outcomes').get() as { n: number };
    res.json({
      ok: true,
      outcomes,
      signalsTotal: signalsTotal?.n ?? 0,
      signalEventsTotal: signalEventsTotal?.n ?? 0,
      outcomesTotal: outcomesTotal?.n ?? 0,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Signals
app.get('/api/signals', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const limit = Number((req.query as any)?.limit);
    const offset = Number((req.query as any)?.offset);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const uniqueRaw = String((req.query as any)?.unique || '').toLowerCase();
    const unique = ['1', 'true', 'yes'].includes(uniqueRaw);

    const out = await listSignals({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      unique,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/signal/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const out = await getSignalById(id);
    if (!out) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, signal: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const out = await getStats({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/stats/summary', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);

    const out = await getStatsSummary({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/matrix/btc', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);

    const out = await getStatsMatrixBtc({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/buckets', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);

    const out = await getStatsBuckets({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/invalidReasons', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);

    const out = await getInvalidReasons({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/versions', async (_req, res) => {
  try {
    const out = await listStrategyVersions();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/stats/health', async (req, res) => {
  try {
    const enabled = process.env.ENABLE_STATS_HEALTH === '1';
    if (!enabled) return res.status(404).json({ ok: false, error: 'Not found' });
    const token = process.env.ADMIN_TOKEN;
    if (token) {
      const got = req.header('x-admin-token');
      if (got !== token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const days = Number((req.query as any)?.days);
    const out = await getStatsHealth({ days: Number.isFinite(days) ? days : undefined });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Market Conditions Dashboard - dual timeframe health metrics
app.get('/api/market/conditions', async (_req, res) => {
  try {
    const result = await getMarketConditions(['1h', '4h']);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/outcomes', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const limit = Number((req.query as any)?.limit);
    const offset = Number((req.query as any)?.offset);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const btcState = String((req.query as any)?.btcState || '').trim() || undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);
    const windowStatus = String((req.query as any)?.windowStatus || '').trim() || undefined;
    const result = String((req.query as any)?.result || '').trim() || undefined;
    const invalidReason = String((req.query as any)?.invalidReason || '').trim() || undefined;
    const sort = String((req.query as any)?.sort || '').trim() || undefined;

    const out = await listOutcomes({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      btcState,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
      windowStatus,
      result,
      invalidReason,
      sort,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Recent outcomes feed (for tuning)
app.get('/api/outcomes/recent', async (req, res) => {
  try {
    const hours = Number((req.query as any)?.hours);
    const limit = Number((req.query as any)?.limit);
    const filterRaw = String((req.query as any)?.filter || '').trim();
    const resultRaw = String((req.query as any)?.result || '').trim();
    const categoryRaw = String((req.query as any)?.category || '').trim();
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const filter = filterRaw ? filterRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const result = resultRaw ? resultRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const categories = categoriesRaw
      ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean)
      : (categoryRaw ? [categoryRaw] : undefined);
    const rows = await listRecentOutcomes({
      hours: Number.isFinite(hours) ? hours : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      filter,
      result,
      categories,
    });
    res.json({ ok: true, hours: Number.isFinite(hours) ? hours : 6, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Aggregated tuning report
app.get('/api/outcomes/report', async (req, res) => {
  try {
    const hours = Number((req.query as any)?.hours);
    const report = await getOutcomesReport({
      hours: Number.isFinite(hours) ? hours : undefined,
    });
    res.json({ ok: true, ...report });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.delete('/api/outcomes', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);
    const windowStatus = String((req.query as any)?.windowStatus || '').trim() || undefined;
    const result = String((req.query as any)?.result || '').trim() || undefined;

    const deleted = await deleteOutcomesByFilter({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
      windowStatus,
      result,
    });
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/outcomes/rebuild', async (req, res) => {
  try {
    const days = Number((req.query as any)?.days);
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const categoriesRaw = String((req.query as any)?.categories || '').trim();
    const categories = categoriesRaw ? categoriesRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const preset = String((req.query as any)?.preset || '').trim() || undefined;
    const strategyVersion = String((req.query as any)?.version || '').trim() || undefined;
    const blockedByBtcRaw = String((req.query as any)?.blockedByBtc || '').toLowerCase();
    const blockedByBtc = ['1', 'true', 'yes'].includes(blockedByBtcRaw) ? true
      : ['0', 'false', 'no'].includes(blockedByBtcRaw) ? false : undefined;
    const horizonMin = Number((req.query as any)?.horizonMin);
    const result = String((req.query as any)?.result || '').trim() || undefined;

    const rebuilt = await rebuildOutcomesByFilter({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      blockedByBtc,
      horizonMin: Number.isFinite(horizonMin) ? horizonMin : undefined,
      result,
    });
    res.json({ ok: true, rebuilt });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/outcomes/delete', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const cleaned = items
      .map((it: any) => ({
        signalId: Number(it?.signalId),
        horizonMin: Number(it?.horizonMin),
      }))
      .filter((it: any) => Number.isFinite(it.signalId) && Number.isFinite(it.horizonMin));

    const deleted = await deleteOutcomesBulk(cleaned);
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/signals/clear', async (_req, res) => {
  try {
    const out = await clearAllSignalsData();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Serve frontend build
const feRoot = path.join(__dirname, '../../frontend/dist');
app.use(express.static(feRoot));
app.get('*', (_req, res) => {
  res.sendFile(path.join(feRoot, 'index.html'));
});

// Server
const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, () => console.log(`Server on http://localhost:${port}`));

function logRegisteredRoutes() {
  const stack = (app as any)?._router?.stack || [];
  const out: string[] = [];

  for (const layer of stack) {
    if (layer?.route?.path && layer?.route?.methods) {
      const methods = Object.keys(layer.route.methods)
        .filter(m => layer.route.methods[m])
        .map(m => m.toUpperCase())
        .join(',');
      out.push(`${methods} ${layer.route.path}`);
    } else if (layer?.name === 'router' && Array.isArray(layer?.handle?.stack)) {
      for (const child of layer.handle.stack) {
        if (child?.route?.path && child?.route?.methods) {
          const methods = Object.keys(child.route.methods)
            .filter(m => child.route.methods[m])
            .map(m => m.toUpperCase())
            .join(',');
          out.push(`${methods} ${child.route.path}`);
        }
      }
    }
  }

  console.log('[routes] registered');
  for (const line of out) console.log(`[routes] ${line}`);
}

logRegisteredRoutes();

// ✅ Server background loop OFF by default (prevents double-scanning)
// Auto-enable on Railway unless explicitly disabled.
const railwayDetected = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const serverLoopDefault = railwayDetected ? 'true' : 'false';
const SERVER_LOOP_ENABLED = (process.env.SERVER_LOOP_ENABLED ?? serverLoopDefault).toLowerCase() === 'true';
if (SERVER_LOOP_ENABLED) {
  console.log('[scan] server loop enabled');
  startLoop(async (signals) => {
    try {
      for (const sig of signals) await recordSignal(sig as any, undefined);
    } catch (e) {
      console.warn('[signals] record failed (loop):', e);
    }
  });
} else {
  console.log('[scan] server loop disabled (SERVER_LOOP_ENABLED=false)');
}

// Outcomes updater (safe to run even if no signals yet)
startOutcomeUpdater();

export { app };
