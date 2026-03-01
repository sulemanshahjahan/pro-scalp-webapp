import 'dotenv/config';
// Railway deploy trigger v2 - 2026-02-25T20:15
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureVapid } from './notifier.js';
import { getLastBtcMarket, getLastScanHealth, getScanIntervalMs, getMaxScanMs, startLoop, scanOnce, thresholdsForPreset, type Preset } from './scanner.js';
import { klinesRange } from './binance.js';
import { getLatestScanRuns, listScanRuns, getScanRunByRunId } from './scanStore.js';
import { listCandidateFeatures, listCandidateFeaturesMulti } from './candidateFeaturesStore.js';
import { applyOverrides, evalFromFeatures, getTuneConfigFromEnv } from './tuneSim.js';
import {
  buildStatisticalSummary,
  validateParity,
  simulate24hManagedOutcome,
  batchSimulate24hOutcomes,
  checkSampleSize,
  type ParityMismatch,
  SAMPLE_SIZE_RULES,
} from './tuneValidation.js';
import { pushToAll } from './notifier.js';
import { emailNotify } from './emailNotifier.js';
import { isEmailEnabled } from './mailer.js';
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
  getOutcomesBacklogMetrics,
  getOutcomesHealth,
  getOutcomesCoordinatorHealth,
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
import {
  listExtendedOutcomes,
  getExtendedOutcomeStats,
  backfillExtendedOutcomes,
  reevaluatePendingExtendedOutcomes,
  forceReevaluateRange,
  backfillManagedPnlForCompleted,
  getSignalDirection,
  evaluateAndUpdateExtendedOutcome,
  getOrCreateExtendedOutcome,
  listExtendedOutcomesWithComparison,
  getImprovementStats,
  getManagedPnlStats,
  backfillEarlyWindowMetrics,
  type ExtendedOutcomeInput,
} from './extendedOutcomeStore.js';
import {
  computeBucketAnalysis,
  getSymbolStats,
  getDiagnostics,
  backtestFilter,
  getFilterSetDefinitions,
  classifyOutcome,
  getDirectionFromCategory,
  type FilterSetId,
} from './outcomeAnalysis.js';
import {
  getAllSymbolTiers,
  getSymbolTier,
  setSymbolTier,
  computeAndUpdateTiers,
  clearManualOverride,
  deleteSymbolTier,
  type SymbolTier,
} from './symbolTierStore.js';
import {
  getFilterConfig,
  shouldEnterTrade,
  filterSignals,
  simulateFilter,
  calculateMQS,
  interpretMQS,
  type FilterConfig,
  type SignalWithEarlyMetrics,
} from './entryFilter.js';
import {
  checkSignalGate,
  filterSignalsThroughGate,
  getGateConfig,
  getGateStats,
  resetGateStats,
  recordGateResult,
  type GateResult,
  type SignalQuality,
} from './signalGate.js';
import {
  runGateBacktest,
  compareGateConfigs,
  getRecommendedConfigs,
  type BacktestConfig,
} from './gateBacktest.js';
import {
  initDelayedEntry,
  runDelayedEntryWatcher,
  getDelayedEntryConfig,
  getDelayedEntryStats,
  simulateDelayedEntry,
  type DelayedEntryConfig,
} from './delayedEntry.js';
import { ensureDelayedEntrySchema } from './db/delayedEntrySchema.js';
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

// Allow Vercel preview/production domains and localhost automatically
const isAllowedOrigin = (origin: string): boolean => {
  if (corsOrigins.includes('*')) return true;
  if (corsOrigins.includes(origin)) return true;
  if (origin.includes('vercel.app')) return true;
  if (origin.includes('localhost')) return true;
  if (origin.includes('127.0.0.1')) return true;
  return false;
};

// Handle OPTIONS preflight for debug endpoints BEFORE cors middleware
app.options('/api/debug/backfill-no-trade', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});
app.options('/api/debug/reevaluate-signal', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

app.use(cors({
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.log(`[CORS blocked] Origin: ${origin}`);
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
  if (keys.includes('READY_BODY_PCT') || keys.includes('MIN_BODY_PCT')) {
    notes.push('Legacy body overrides map to READY_BODY_MIN_PCT/BEST_BODY_MIN_PCT (fraction units) in simulator.');
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
  time: number;
  price: number;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  riskPct: number | null;
  gateSnapshot: any | null;
  outcomeResult: string | null;
  outcomeHitTp1: boolean | null;
  outcomeHitSl: boolean | null;
  outcomeWindowStatus: string | null;
  r: number | null;
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

function getLiveReadySource(computed: any, gateSnapshot: any | null): Record<string, any> | null {
  const src = gateSnapshot?.ready ?? computed?.readyGateSnapshot;
  return src && typeof src === 'object' ? src : null;
}

function getLiveShortSource(computed: any, gateSnapshot: any | null): Record<string, any> | null {
  const src = gateSnapshot?.short ?? computed?.shortGateSnapshot;
  return src && typeof src === 'object' ? src : null;
}

function toFiniteNumber(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBooleanOrNull(v: any): boolean | null {
  if (v == null) return null;
  return Boolean(v);
}

function bodyPctOpenToClose(bodyPctOpenAbs: number, bullish: boolean): number | null {
  if (!Number.isFinite(bodyPctOpenAbs) || bodyPctOpenAbs < 0) return null;
  const p = bodyPctOpenAbs / 100;
  const denom = bullish ? (1 + p) : (1 - p);
  if (!(denom > 0)) return null;
  return (p / denom) * 100;
}

function buildStrongBodyBreakdown(metrics: any, computed: any, cfg: any, final: boolean | null) {
  const close = toFiniteNumber(metrics?.price);
  const atrPct = toFiniteNumber(metrics?.atrPct);
  const bodyPctOpenAbsRaw = toFiniteNumber(metrics?.bodyPct);
  const bodyPctOpenAbs = bodyPctOpenAbsRaw == null ? null : Math.abs(bodyPctOpenAbsRaw);
  const bullish = computed?.bullish == null ? null : Boolean(computed.bullish);
  const bodyPctCloseAbs = bodyPctOpenAbs == null
    ? null
    : (bullish == null
      ? bodyPctOpenAbs
      : (bodyPctOpenToClose(bodyPctOpenAbs, bullish) ?? bodyPctOpenAbs));
  const readyBodyAtrMult = toFiniteNumber(cfg?.READY_BODY_ATR_MULT);
  const readyBodyMinPct = toFiniteNumber(cfg?.READY_BODY_MIN_PCT);
  const reqBodyPctAtr = atrPct != null && readyBodyAtrMult != null ? atrPct * readyBodyAtrMult : null;
  const reqBodyPctFloor = readyBodyMinPct != null ? readyBodyMinPct * 100 : null;
  const requiredBodyPct = bodyPctCloseAbs == null
    ? null
    : Math.max(reqBodyPctAtr ?? Number.NEGATIVE_INFINITY, reqBodyPctFloor ?? Number.NEGATIVE_INFINITY);
  const bodySize = close != null && bodyPctCloseAbs != null ? (close * bodyPctCloseAbs) / 100 : null;
  const requiredBody = close != null && requiredBodyPct != null ? (close * requiredBodyPct) / 100 : null;
  const closePos = toFiniteNumber(metrics?.closePos);
  const upperWickPct = toFiniteNumber(metrics?.upperWickPct);
  const closePosMin = toFiniteNumber(cfg?.READY_CLOSE_POS_MIN);
  const upperWickMax = toFiniteNumber(cfg?.READY_UPPER_WICK_MAX);
  const pass_bullish = bullish;
  const pass_bodySize = bodySize != null && requiredBody != null ? bodySize >= requiredBody : null;
  const pass_closePos = closePos != null && closePosMin != null ? closePos >= closePosMin : null;
  const pass_upperWick = upperWickPct != null && upperWickMax != null ? upperWickPct <= upperWickMax : null;
  const pass_bodyPctOpen = bodyPctOpenAbs != null && requiredBodyPct != null ? bodyPctOpenAbs >= requiredBodyPct : null;
  const pass_bodyPctClose = bodyPctCloseAbs != null && requiredBodyPct != null ? bodyPctCloseAbs >= requiredBodyPct : null;
  const final_recomputed = [pass_bullish, pass_bodySize, pass_closePos, pass_upperWick].every((x) => x === true)
    ? true
    : ([pass_bullish, pass_bodySize, pass_closePos, pass_upperWick].some((x) => x === false) ? false : null);
  return {
    bullish,
    bodySize,
    requiredBody,
    closePos,
    upperWickPct,
    atrPct,
    bodyPctOpenAbs,
    bodyPctCloseAbs,
    requiredBodyPct,
    pass_bullish,
    pass_bodySize,
    pass_closePos,
    pass_upperWick,
    pass_bodyPctOpen,
    pass_bodyPctClose,
    final_from_flags: final,
    final_recomputed,
    final_consistent: final == null || final_recomputed == null ? null : final === final_recomputed,
    bodyMinPct_used: readyBodyMinPct,
    bodyAtrMult_used: readyBodyAtrMult,
    minBodyPct_global_used: toFiniteNumber(cfg?.MIN_BODY_PCT),
    readyBodyPct_used: toFiniteNumber(cfg?.READY_BODY_PCT),
    closePosMin_used: closePosMin,
    upperWickMax_used: upperWickMax,
    requiredBodyPct_atr: reqBodyPctAtr,
    requiredBodyPct_floor: reqBodyPctFloor,
  };
}

function buildLiveReadyVwapBreakdown(src: any, metrics: any, cfg: any, final: boolean | null) {
  const price = toFiniteNumber(metrics?.price);
  const vwap = toFiniteNumber(metrics?.vwap);
  const delta_frac = price != null && vwap != null && vwap !== 0 ? (price - vwap) / vwap : null;
  const delta_pct = delta_frac == null ? null : delta_frac * 100;
  const eps_pct_used = toFiniteNumber(cfg?.READY_VWAP_EPS_PCT);
  const eps_frac_used = eps_pct_used == null ? null : eps_pct_used / 100;
  const threshold_price = vwap != null && eps_frac_used != null ? vwap * (1 - eps_frac_used) : null;
  const strict_calc = price != null && vwap != null ? price > vwap : null;
  const strict = src?.priceAboveVwapStrict == null ? strict_calc : Boolean(src.priceAboveVwapStrict);
  const nearVwapReady_used = src?.nearVwap == null ? null : Boolean(src.nearVwap);
  const relaxedEligible_calc = strict_calc == null || nearVwapReady_used == null ? null : (!strict_calc && nearVwapReady_used);
  const relaxedEligible = src?.priceAboveVwapRelaxedEligible == null ? relaxedEligible_calc : Boolean(src.priceAboveVwapRelaxedEligible);
  const relaxedTrue_calc = relaxedEligible_calc == null || threshold_price == null || price == null
    ? null
    : (relaxedEligible_calc && price >= threshold_price);
  const relaxedTrue = src?.priceAboveVwapRelaxedTrue == null ? relaxedTrue_calc : Boolean(src.priceAboveVwapRelaxedTrue);
  const reclaimOrTapRaw = src?.reclaimOrTap == null ? null : Boolean(src.reclaimOrTap);
  const pass_strict = strict;
  const pass_relaxed = relaxedTrue;
  const pass_reclaim = reclaimOrTapRaw;
  const pass_final_composed = (pass_strict === true) || (pass_relaxed === true) || (pass_reclaim === true);
  const delta_vs_eps_pass_pct = delta_pct != null && eps_pct_used != null ? delta_pct >= -eps_pct_used : null;
  const delta_vs_eps_pass_frac = delta_frac != null && eps_frac_used != null ? delta_frac >= -eps_frac_used : null;
  return {
    strict,
    relaxedEligible,
    relaxedTrue,
    reclaimOrTapRaw,
    pass_strict,
    pass_relaxed,
    pass_reclaim,
    pass_final_composed,
    final_from_flags: final,
    final_consistent: final == null ? null : final === pass_final_composed,
    delta_frac,
    delta_pct,
    eps_pct_used,
    eps_frac_used,
    delta_vs_eps_pass_pct,
    delta_vs_eps_pass_frac,
    threshold_price,
    price_used: price,
    vwap_i_used: vwap,
    nearVwapReady_used,
  };
}

function buildSimReadyVwapBreakdown(simFlags: any, metrics: any, cfg: any) {
  const price = toFiniteNumber(metrics?.price);
  const vwap = toFiniteNumber(metrics?.vwap);
  const delta_frac = price != null && vwap != null && vwap !== 0 ? (price - vwap) / vwap : null;
  const delta_pct = delta_frac == null ? null : delta_frac * 100;
  const eps_pct_used = toFiniteNumber(cfg?.READY_VWAP_EPS_PCT);
  const eps_frac_used = eps_pct_used == null ? null : eps_pct_used / 100;
  const threshold_price = vwap != null && eps_frac_used != null ? vwap * (1 - eps_frac_used) : null;
  const strict = simFlags?.priceAboveVwapStrict == null ? null : Boolean(simFlags.priceAboveVwapStrict);
  const relaxedEligible = simFlags?.priceAboveVwapRelaxedEligible == null ? null : Boolean(simFlags.priceAboveVwapRelaxedEligible);
  const relaxedTrue = simFlags?.priceAboveVwapRelaxedTrue == null ? null : Boolean(simFlags.priceAboveVwapRelaxedTrue);
  const reclaimOrTapRaw = simFlags?.reclaimOrTapRaw == null ? null : Boolean(simFlags.reclaimOrTapRaw);
  const pass_final_composed = (strict === true) || (relaxedTrue === true) || (reclaimOrTapRaw === true);
  const delta_vs_eps_pass_pct = delta_pct != null && eps_pct_used != null ? delta_pct >= -eps_pct_used : null;
  const delta_vs_eps_pass_frac = delta_frac != null && eps_frac_used != null ? delta_frac >= -eps_frac_used : null;
  return {
    strict,
    relaxedEligible,
    relaxedTrue,
    reclaimOrTapRaw,
    pass_strict: strict,
    pass_relaxed: relaxedTrue,
    pass_reclaim: reclaimOrTapRaw,
    pass_final_composed,
    final_from_flags: simFlags?.priceAboveVwap == null ? null : Boolean(simFlags.priceAboveVwap),
    final_consistent: simFlags?.priceAboveVwap == null ? null : Boolean(simFlags.priceAboveVwap) === pass_final_composed,
    delta_frac,
    delta_pct,
    eps_pct_used,
    eps_frac_used,
    delta_vs_eps_pass_pct,
    delta_vs_eps_pass_frac,
    threshold_price,
    price_used: price,
    vwap_i_used: vwap,
    nearVwapReady_used: simFlags?.nearVwapReady == null ? null : Boolean(simFlags.nearVwapReady),
  };
}

function normalizeLiveReadyFlags(
  computed: any,
  gateSnapshot: any | null,
  cfg?: any,
  opts?: { adjustRequired?: boolean }
): Record<string, boolean> | null {
  const src = getLiveReadySource(computed, gateSnapshot);
  if (!src || typeof src !== 'object') return null;
  const adjustRequired = opts?.adjustRequired !== false;
  const requireReclaim = adjustRequired ? (cfg?.READY_RECLAIM_REQUIRED !== false) : true;
  const requireVol = adjustRequired ? (cfg?.READY_VOL_SPIKE_REQUIRED !== false) : true;
  const requireConfirm15 = adjustRequired ? (cfg?.READY_CONFIRM15_REQUIRED !== false) : true;
  const requireTrend = adjustRequired ? (cfg?.READY_TREND_REQUIRED !== false) : true;
  const requireSweep = adjustRequired ? (cfg?.READY_SWEEP_REQUIRED !== false) : true;
  const requireBtc = adjustRequired ? (cfg?.READY_BTC_REQUIRED !== false) : true;
  const rawReclaim = Boolean(src.reclaimOrTap);
  const rawPriceAboveVwap = Boolean(src.priceAboveVwap);
  const rawPriceAboveVwapRelaxedTrue = Boolean(src.priceAboveVwapRelaxedTrue);
  // Historical snapshots may store strict-above only; compose with relaxed/reclaim paths.
  const composedPriceAboveVwap = rawPriceAboveVwap || rawPriceAboveVwapRelaxedTrue || rawReclaim;
  const out: Record<string, boolean> = {
    sessionOK: Boolean(src.sessionOk),
    priceAboveVwap: composedPriceAboveVwap,
    priceAboveEma: Boolean(src.priceAboveEma),
    nearVwapReady: Boolean(src.nearVwap),
    reclaimOrTap: requireReclaim ? rawReclaim : true,
    readyVolOk: requireVol ? Boolean(src.volSpike) : true,
    atrOkReady: Boolean(src.atr),
    confirm15mOk: requireConfirm15 ? Boolean(src.confirm15) : true,
    strongBody: Boolean(src.strongBody),
    rrOk: Boolean(src.rrOk),
    riskOk: Boolean(src.riskOk),
    rsiReadyOk: Boolean(src.rsiReadyOk),
    readyTrendOk: requireTrend ? Boolean(src.trend) : true,
    sweepOk: requireSweep ? Boolean(src.sweep) : true,
    btcOk: requireBtc ? Boolean(src.btc) : true,
    core: Boolean(src.core),
  };
  return out;
}

function normalizeLiveShortFlags(
  computed: any,
  gateSnapshot: any | null,
  cfg?: any,
  opts?: { adjustRequired?: boolean }
): Record<string, boolean> | null {
  const src = getLiveShortSource(computed, gateSnapshot);
  if (!src || typeof src !== 'object') return null;
  const adjustRequired = opts?.adjustRequired !== false;
  const requireVol = adjustRequired ? (cfg?.READY_VOL_SPIKE_REQUIRED !== false) : true;
  const requireConfirm15 = adjustRequired ? (cfg?.SHORT_CONFIRM15_REQUIRED !== false) : true;
  const requireTrend = adjustRequired ? (cfg?.SHORT_TREND_REQUIRED !== false) : true;
  const requireSweep = adjustRequired ? (cfg?.SHORT_SWEEP_REQUIRED !== false) : true;
  const requireBtc = adjustRequired ? (cfg?.SHORT_BTC_REQUIRED !== false) : true;
  const out: Record<string, boolean> = {
    sessionOK: Boolean(src.sessionOk),
    priceBelowVwap: Boolean(src.priceBelowVwap),
    priceBelowEma: Boolean(src.priceBelowEma),
    nearVwapShort: Boolean(src.nearVwap),
    rsiShortOk: Boolean(src.rsiShortOk),
    strongBody: Boolean(src.strongBody),
    readyVolOk: requireVol ? Boolean(src.volSpike) : true,
    atrOkReady: Boolean(src.atr),
    confirm15mOk: requireConfirm15 ? Boolean(src.confirm15) : true,
    trendOkShort: requireTrend ? Boolean(src.trend) : true,
    rrOk: Boolean(src.rrOk),
    riskOk: Boolean(src.riskOk),
    sweepOk: requireSweep ? Boolean(src.sweep) : true,
    btcOk: requireBtc ? Boolean(src.btc) : true,
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
    time: Number(r.time ?? 0),
    price: Number(r.price ?? 0),
    stop: r.stop == null ? null : Number(r.stop),
    tp1: r.tp1 == null ? null : Number(r.tp1),
    tp2: r.tp2 == null ? null : Number(r.tp2),
    riskPct: r.riskPct == null ? null : Number(r.riskPct),
    gateSnapshot: safeJsonParse<any>(r.gateSnapshotJson),
    outcomeResult: r.outcomeResult == null ? null : String(r.outcomeResult),
    outcomeHitTp1: toBool(r.outcomeHitTp1),
    outcomeHitSl: toBool(r.outcomeHitSl),
    outcomeWindowStatus: r.outcomeWindowStatus == null ? null : String(r.outcomeWindowStatus),
    r: r.r == null ? null : Number(r.r),
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
        e.time as "time",
        s.price as "price",
        s.stop as "stop",
        s.tp1 as "tp1",
        s.tp2 as "tp2",
        s."riskPct" as "riskPct",
        e.gate_snapshot_json as "gateSnapshotJson",
        o.result as "outcomeResult",
        o.hit_tp1 as "outcomeHitTp1",
        o.hit_sl as "outcomeHitSl",
        o.window_status as "outcomeWindowStatus",
        o.r as "r"
      FROM signal_events e
      LEFT JOIN signals s ON s.id = e.signal_id
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
        s.time as "time",
        s.price as "price",
        s.stop as "stop",
        s.tp1 as "tp1",
        s.tp2 as "tp2",
        s."riskPct" as "riskPct",
        s.gate_snapshot_json as "gateSnapshotJson",
        o.result as "outcomeResult",
        o.hit_tp1 as "outcomeHitTp1",
        o.hit_sl as "outcomeHitSl",
        o.window_status as "outcomeWindowStatus",
        o.r as "r"
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
  const readyOrderRaw = ['sessionOK', 'priceAboveVwap', 'priceAboveEma', 'nearVwapReady', 'reclaimOrTapRaw', 'readyVolOk', 'atrOkReady', 'confirm15mOk', 'strongBody', 'rrOk', 'riskOk', 'rsiReadyOk', 'readyTrendOk', 'sweepOk', 'btcOk', 'core'];
  const shortOrder = ['sessionOK', 'priceBelowVwap', 'priceBelowEma', 'nearVwapShort', 'rsiShortOk', 'strongBody', 'readyVolOk', 'atrOkReady', 'confirm15mOk', 'trendOkShort', 'rrOk', 'riskOk', 'sweepOk', 'btcOk', 'core'];
  const ready: any[] = [];
  const readyShort: any[] = [];

  for (const row of rows) {
    if (ready.length >= mismatchLimit && readyShort.length >= mismatchLimit) break;
    const simRes: any = evalFromFeatures({ metrics: row.metrics, computed: row.computed }, cfg);
    const key = `${String(row.runId ?? '')}|${String(row.symbol ?? '').toUpperCase()}`;
    const actual = signalByKey.get(key) ?? null;
    const liveReadySrc = getLiveReadySource(row.computed, actual?.gateSnapshot ?? null);
    const liveShortSrc = getLiveShortSource(row.computed, actual?.gateSnapshot ?? null);
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
      const liveFlagsRequired = normalizeLiveReadyFlags(row.computed, actual?.gateSnapshot ?? null, cfg, { adjustRequired: true });
      const liveFlagsRaw = normalizeLiveReadyFlags(row.computed, actual?.gateSnapshot ?? null, cfg, { adjustRequired: false });
      const liveFlagsRawForFailure = liveFlagsRaw == null
        ? null
        : {
          ...liveFlagsRaw,
          reclaimOrTapRaw: Boolean(liveFlagsRaw.reclaimOrTap),
        };
      const divergence = firstDiff(readyOrder, simFlags, liveFlagsRequired);
      const firstFailedLiveRequired = firstFalse(readyOrder, liveFlagsRequired);
      const firstFailedLiveRaw = firstFalse(readyOrderRaw, liveFlagsRawForFailure as Record<string, boolean> | null);
      const firstFailedLiveRawValue = firstFailedLiveRaw == null || !liveFlagsRawForFailure
        ? null
        : toBooleanOrNull((liveFlagsRawForFailure as Record<string, boolean>)[firstFailedLiveRaw]);
      ready.push({
        runId: String(row.runId ?? ''),
        symbol: String(row.symbol ?? ''),
        sim_ready: true,
        actual_ready: false,
        actual_category: actualCategory,
        why_not_emitted: divergence
          ? `first_divergence:${divergence}`
          : (actualCategory ? `actual_category:${actualCategory}` : 'actual_category:none'),
        first_failed_live: firstFailedLiveRequired,
        first_failed_live_requiredAdjusted: firstFailedLiveRequired,
        first_failed_live_raw: firstFailedLiveRaw,
        first_failed_live_raw_value: firstFailedLiveRawValue,
        reclaimOrTap_raw_bool_used: liveFlagsRawForFailure?.reclaimOrTapRaw ?? null,
        first_failed_sim: firstFalse(readyOrder, simFlags),
        sim_flags: simFlags,
        live_flags: liveFlagsRequired,
        live_flags_raw: liveFlagsRaw,
        sim_breakdown: {
          priceAboveVwap_breakdown: buildSimReadyVwapBreakdown(simFlags, row.metrics, cfg),
          strongBody_breakdown: buildStrongBodyBreakdown(row.metrics, row.computed, cfg, simFlags?.strongBody == null ? null : Boolean(simFlags.strongBody)),
        },
        live_breakdown: {
          priceAboveVwap_breakdown: buildLiveReadyVwapBreakdown(liveReadySrc, row.metrics, cfg, liveFlagsRaw?.priceAboveVwap ?? null),
          strongBody_breakdown: buildStrongBodyBreakdown(row.metrics, row.computed, cfg, liveFlagsRaw?.strongBody ?? null),
        },
      });
    }

    if (simRes.readyShortOk && !actualReadyShort && readyShort.length < mismatchLimit) {
      const simShortFlags: Record<string, boolean> = {
        ...(simRes.readyShortFlags ?? {}),
        sweepOk: Boolean(simRes.readyShortSweepOk),
        btcOk: Boolean(simRes.readyShortBtcOk),
        core: Boolean(simRes.readyShortCore),
      };
      const liveShortFlagsRequired = normalizeLiveShortFlags(row.computed, actual?.gateSnapshot ?? null, cfg, { adjustRequired: true });
      const liveShortFlagsRaw = normalizeLiveShortFlags(row.computed, actual?.gateSnapshot ?? null, cfg, { adjustRequired: false });
      const divergence = firstDiff(shortOrder, simShortFlags, liveShortFlagsRequired);
      const firstFailedShortLiveRequired = firstFalse(shortOrder, liveShortFlagsRequired);
      const firstFailedShortLiveRaw = firstFalse(shortOrder, liveShortFlagsRaw);
      const firstFailedShortLiveRawValue = firstFailedShortLiveRaw == null || !liveShortFlagsRaw
        ? null
        : toBooleanOrNull((liveShortFlagsRaw as Record<string, boolean>)[firstFailedShortLiveRaw]);
      readyShort.push({
        runId: String(row.runId ?? ''),
        symbol: String(row.symbol ?? ''),
        sim_ready_short: true,
        actual_ready_short: false,
        actual_category: actualCategory,
        why_not_emitted: divergence
          ? `first_divergence:${divergence}`
          : (actualCategory ? `actual_category:${actualCategory}` : 'actual_category:none'),
        first_failed_live: firstFailedShortLiveRequired,
        first_failed_live_requiredAdjusted: firstFailedShortLiveRequired,
        first_failed_live_raw: firstFailedShortLiveRaw,
        first_failed_live_raw_value: firstFailedShortLiveRawValue,
        first_failed_sim: firstFalse(shortOrder, simShortFlags),
        sim_flags: simShortFlags,
        live_flags: liveShortFlagsRequired,
        live_flags_raw: liveShortFlagsRaw,
        live_source_has_snapshot: Boolean(liveShortSrc),
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

// Fail fast on Postgres when schema is missing/mismatched.
void (async () => {
  if (db.driver !== 'postgres') return;
  try {
    await db.prepare('SELECT 1 as ok').get();
  } catch (e) {
    console.error('[db] postgres startup verification failed. Run: npm --prefix backend run db:migrate');
    console.error('[db] fatal:', e);
    process.exit(1);
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
    const outcomesCoordinator = getOutcomesCoordinatorHealth();
    const backlog = await getOutcomesBacklogCount({ days: safeDays });
    const backlogMetrics = await getOutcomesBacklogMetrics();
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
        coordinator: outcomesCoordinator,
        backlog,
        pendingOutcomesCount: backlogMetrics.pendingCount,
        pendingOutcomeRows: backlogMetrics.pendingOutcomeRows,
        resolverLagMs: backlogMetrics.oldestPendingMs,
        backlogGraceMin: backlogMetrics.graceMin,
        backlogHorizonMin: backlogMetrics.horizonMin,
        backlogHorizons: backlogMetrics.requiredHorizons,
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
    
    // NEW: Enhanced parity validation with warnings
    const parityValidation = validateParity({
      simCounts: sim.counts,
      actualCounts,
      mismatches: Array.isArray(parityMismatches) ? parityMismatches : [],
      tolerance: 0.15,
    });
    
    // NEW: Sample size validation
    const sampleSizeChecks: Record<string, ReturnType<typeof checkSampleSize>> = {};
    for (const [cat, count] of Object.entries(sim.counts)) {
      if (count > 0) {
        sampleSizeChecks[cat] = checkSampleSize(cat, count as number);
      }
    }
    
    // NEW: 24h managed PnL simulation
    let outcome24hSim: any = null;
    
    // Build signals from DB records OR from simulated candidate features
    let signals: any[] = [];
    let outcomes120m: Record<string, { status: 'WIN' | 'LOSS' | 'NO_HIT'; r: number }> = {};
    
    if (runSignalRows.length > 0) {
      // Use signals from database (with existing outcomes)
      signals = runSignalRows
        .filter(r => r.category === 'READY_TO_BUY' || r.category === 'READY_TO_SELL')
        .map(r => ({
          symbol: r.symbol,
          category: r.category,
          price: r.price,
          stop: r.stop,
          tp1: r.tp1,
          tp2: r.tp2,
          riskPct: r.riskPct || 0.01,
          time: r.time,
        }));
      
      for (const row of runSignalRows) {
        if (row.outcomeResult) {
          const key = `${row.symbol}|${row.time}`;
          outcomes120m[key] = {
            status: row.outcomeResult === 'WIN' ? 'WIN' : row.outcomeResult === 'LOSS' ? 'LOSS' : 'NO_HIT',
            r: row.r ?? 0,
          };
        }
      }
    } else {
      // Build simulated signals from candidate features (for recent scans without DB records)
      for (const row of rows) {
        const m = row.metrics || {};
        const c = row.computed || {};
        
        // Only include rows that the simulator classified as READY
        const isReadyLong = c.finalCategory === 'READY_TO_BUY' || c.readyCore;
        const isReadyShort = c.shortCategory === 'READY_TO_SELL' || c.shortCore;
        
        if ((isReadyLong || isReadyShort) && m.price && m.stopPrice) {
          const isShort = isReadyShort;
          const price = m.price;
          const stop = m.stopPrice;
          const risk = Math.abs(price - stop);
          const rr = m.rr || 1.5;
          
          // Calculate TP1 and TP2 from RR
          const tp1 = isShort ? price - risk : price + risk;
          const tp2 = isShort ? price - (risk * Math.min(rr, 2)) : price + (risk * Math.min(rr, 2));
          
          signals.push({
            symbol: row.symbol,
            category: isShort ? 'READY_TO_SELL' : 'READY_TO_BUY',
            price,
            stop,
            tp1,
            tp2,
            riskPct: m.riskPct || 0.01,
            time: row.startedAt,
          });
        }
      }
    }
    
    if (signals.length > 0) {
      const results24h = await batchSimulate24hOutcomes(signals, outcomes120m);
      const stats24h = buildStatisticalSummary(
        results24h.map(r => ({ status: r.outcome24h.status, r: r.outcome24h.finalR })),
        'ready'
      );
      outcome24hSim = {
        sampleSize: results24h.length,
        stats: stats24h,
        comparison: {
          avgR120m: actualOutcome120m.totals?.win_rate_120m || 0,
          avgR24h: stats24h.avgR,
          difference: stats24h.avgR - (actualOutcome120m.totals?.win_rate_120m || 0),
        },
        topDifferences: results24h
          .filter(r => Math.abs(r.difference) > 0.3)
          .slice(0, 5)
          .map(r => ({
            symbol: r.signal.symbol,
            diff120m: r.outcome120m.r,
            diff24h: r.outcome24h.finalR,
            difference: r.difference,
          })),
      };
    }

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
      // NEW: Enhanced validation
      parityValidation,
      sampleSizeChecks,
      actualOutcome120m,
      outcome24hSim,
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
    
    // NEW: Enhanced parity validation with warnings
    const parityValidation = validateParity({
      simCounts: baseSim.counts,
      actualCounts,
      mismatches: Array.isArray(baseParityMismatches) ? baseParityMismatches : [],
      tolerance: 0.15,  // 15% divergence threshold
    });
    
    // NEW: Sample size validation
    const sampleSizeChecks: Record<string, ReturnType<typeof checkSampleSize>> = {};
    for (const [cat, count] of Object.entries(baseSim.counts)) {
      if (count > 0) {
        sampleSizeChecks[cat] = checkSampleSize(cat, count as number);
      }
    }
    
    const actualOutcome120m = computeActualOutcome120m(runSignalRows);
    
    // NEW: 24h managed PnL simulation for base config
    let outcome24hSim: any = null;
    
    // Build signals from DB records OR from simulated candidate features
    let signals: any[] = [];
    let outcomes120m: Record<string, { status: 'WIN' | 'LOSS' | 'NO_HIT'; r: number }> = {};
    
    if (runSignalRows.length > 0) {
      // Use signals from database (with existing outcomes)
      signals = runSignalRows
        .filter(r => r.category === 'READY_TO_BUY' || r.category === 'READY_TO_SELL')
        .map(r => ({
          symbol: r.symbol,
          category: r.category,
          price: r.price,
          stop: r.stop,
          tp1: r.tp1,
          tp2: r.tp2,
          riskPct: r.riskPct || 0.01,
          time: r.time,
        }));
      
      for (const row of runSignalRows) {
        if (row.outcomeResult) {
          const key = `${row.symbol}|${row.time}`;
          outcomes120m[key] = {
            status: row.outcomeResult === 'WIN' ? 'WIN' : row.outcomeResult === 'LOSS' ? 'LOSS' : 'NO_HIT',
            r: row.r ?? 0,
          };
        }
      }
    } else {
      // Build simulated signals from candidate features (for recent scans without DB records)
      for (const row of rows) {
        const m = row.metrics || {};
        const c = row.computed || {};
        
        // Only include rows that the simulator classified as READY
        const isReadyLong = c.finalCategory === 'READY_TO_BUY' || c.readyCore;
        const isReadyShort = c.shortCategory === 'READY_TO_SELL' || c.shortCore;
        
        if ((isReadyLong || isReadyShort) && m.price && m.stopPrice) {
          const isShort = isReadyShort;
          const price = m.price;
          const stop = m.stopPrice;
          const risk = Math.abs(price - stop);
          const rr = m.rr || 1.5;
          
          // Calculate TP1 and TP2 from RR
          const tp1 = isShort ? price - risk : price + risk;
          const tp2 = isShort ? price - (risk * Math.min(rr, 2)) : price + (risk * Math.min(rr, 2));
          
          signals.push({
            symbol: row.symbol,
            category: isShort ? 'READY_TO_SELL' : 'READY_TO_BUY',
            price,
            stop,
            tp1,
            tp2,
            riskPct: m.riskPct || 0.01,
            time: row.startedAt,
          });
        }
      }
    }
    
    if (signals.length > 0) {
      const results24h = await batchSimulate24hOutcomes(signals, outcomes120m);
      const stats24h = buildStatisticalSummary(
        results24h.map((r: any) => ({ status: r.outcome24h.status, r: r.outcome24h.finalR })),
        'ready'
      );
      outcome24hSim = {
        sampleSize: results24h.length,
        stats: stats24h,
        comparison: {
          avgR120m: actualOutcome120m.totals?.win_rate_120m || 0,
          avgR24h: stats24h.avgR,
          difference: stats24h.avgR - (actualOutcome120m.totals?.win_rate_120m || 0),
        },
        topDifferences: results24h
          .filter((r: any) => Math.abs(r.difference) > 0.3)
          .slice(0, 5)
          .map((r: any) => ({
            symbol: r.signal.symbol,
            diff120m: r.outcome120m.r,
            diff24h: r.outcome24h.finalR,
            difference: r.difference,
          })),
      };
    }

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
        // NEW: Enhanced validation
        parityValidation,
        sampleSizeChecks,
        actualOutcome120m,
        outcome24hSim,
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

// NEW: 24h Managed PnL Simulation endpoint (admin-only)
app.post('/api/tune/sim24h', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = req.body || {};
    const runId = String(body.runId || '').trim();
    const category = String(body.category || 'READY_TO_BUY');
    
    if (!runId) return res.status(400).json({ ok: false, error: 'runId required' });
    
    // Load signals with outcomes
    const runSignalRows = await loadSignalsForRuns([runId], 120);
    const signals = runSignalRows
      .filter(r => r.category === category)
      .map(r => ({
        symbol: r.symbol,
        category: r.category,
        price: r.price,
        stop: r.stop,
        tp1: r.tp1,
        tp2: r.tp2,
        riskPct: r.riskPct || 0.01,
        time: r.time,
      } as any));
    
    if (signals.length === 0) {
      return res.status(404).json({ ok: false, error: `No ${category} signals found for run ${runId}` });
    }
    
    // Build 120m outcomes lookup
    const outcomes120m: Record<string, { status: 'WIN' | 'LOSS' | 'NO_HIT'; r: number }> = {};
    for (const row of runSignalRows) {
      if (row.category === category && row.outcomeResult) {
        const key = `${row.symbol}|${row.time}`;
        outcomes120m[key] = {
          status: row.outcomeResult === 'WIN' ? 'WIN' : row.outcomeResult === 'LOSS' ? 'LOSS' : 'NO_HIT',
          r: row.r ?? 0,
        };
      }
    }
    
    // Run 24h simulation
    const results24h = await batchSimulate24hOutcomes(signals, outcomes120m);
    
    // Build statistics
    const stats120m = buildStatisticalSummary(
      results24h.map(r => r.outcome120m),
      category
    );
    const stats24h = buildStatisticalSummary(
      results24h.map(r => ({ status: r.outcome24h.status, r: r.outcome24h.finalR })),
      category
    );
    
    // Check sample size
    const sampleSizeCheck = checkSampleSize(category, results24h.length);
    
    res.json({
      ok: true,
      meta: {
        runId,
        category,
        sampleSize: results24h.length,
      },
      sampleSizeCheck,
      comparison: {
        '120m': stats120m,
        '24h': stats24h,
        difference: {
          avgR: stats24h.avgR - stats120m.avgR,
          winRate: stats24h.winRate - stats120m.winRate,
        },
        recommendation: stats24h.avgR > stats120m.avgR 
          ? '24h simulation shows better results. Consider using 24h outcomes for tuning.'
          : stats24h.avgR < stats120m.avgR
            ? '120m outcomes are more optimistic. Use 24h for conservative estimates.'
            : 'Similar performance. Either horizon is valid.',
      },
      details: results24h.slice(0, 20),  // First 20 for inspection
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// NEW: Sample size validation endpoint (admin-only)
app.get('/api/tune/sample-size', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const category = String((req.query as any)?.category || '');
    const count = Number((req.query as any)?.count);
    
    if (!category || !Number.isFinite(count)) {
      return res.status(400).json({ ok: false, error: 'category and count required' });
    }
    
    const check = checkSampleSize(category, count);
    const minSize = SAMPLE_SIZE_RULES[category as keyof typeof SAMPLE_SIZE_RULES] || 20;
    
    res.json({
      ok: true,
      category,
      current: count,
      minimum: minSize,
      adequate: check.adequate,
      message: check.message,
      rules: SAMPLE_SIZE_RULES,
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
    
    // 🚨 HARD GATE: Filter signals before recording
    const gateConfig = getGateConfig();
    let passedSignals = out;
    let blockedCount = 0;
    const blockedMap = new Map<string, string[]>(); // symbol -> reasons
    
    if (gateConfig.enabled) {
      const gateResult = await filterSignalsThroughGate(out as any, gateConfig);
      passedSignals = gateResult.allowed;
      blockedCount = gateResult.stats.blocked;
      
      // Map blocked signals to their reasons
      for (const blocked of gateResult.blocked) {
        blockedMap.set(blocked.symbol, blocked.reasons);
      }
      
      // Log gate results
      console.log(`[signal-gate] Scan ${preset}: ${gateResult.stats.allowed}/${gateResult.stats.total} passed (${gateResult.stats.reductionPct.toFixed(1)}% blocked)`);
      
      // Log blocked signals for debugging
      if (gateResult.blocked.length > 0) {
        for (const blocked of gateResult.blocked.slice(0, 5)) {
          console.log(`[signal-gate] BLOCKED: ${blocked.symbol} ${blocked.category} - ${blocked.reasons.join(', ')}`);
        }
        if (gateResult.blocked.length > 5) {
          console.log(`[signal-gate] ... and ${gateResult.blocked.length - 5} more blocked`);
        }
      }
      
      // Log quality distribution
      console.log(`[signal-gate] Quality: HIGH=${gateResult.stats.byQuality.HIGH || 0}, MEDIUM=${gateResult.stats.byQuality.MEDIUM || 0}, LOW=${gateResult.stats.byQuality.LOW || 0}`);
    }
    
    lastByPreset.set(preset, { signals: passedSignals, at });
    
    // DEBUG: Log what we're about to record
    console.log(`[DEBUG] Recording ${out.length} signals (${blockedCount} blocked, ${passedSignals.length} passed)`);
    
    try {
      // Record ALL signals (both blocked and passed)
      const allSignals = out;
      let recorded = 0;
      let failed = 0;
      
      for (const sig of allSignals) {
        const isBlocked = blockedMap.has(sig.symbol);
        const blockedReasons = blockedMap.get(sig.symbol) ?? [];
        
        const sigWithGateInfo = {
          ...sig,
          blockedReasons: blockedReasons.length > 0 ? blockedReasons : undefined,
          firstFailedGate: blockedReasons[0] ?? null,
          gateBlocked: isBlocked,
        };
        
        console.log(`[DEBUG] Recording ${sig.symbol} ${sig.category} (blocked: ${isBlocked})...`);
        
        try {
          const signalId = await recordSignal(sigWithGateInfo as any, preset);
          
          if (signalId) {
            recorded++;
            console.log(`[DEBUG] Recorded ${sig.symbol} with ID ${signalId}`);
            
            const delayedConfig = getDelayedEntryConfig();
            if (delayedConfig.enabled && !isBlocked) {
              await initDelayedEntry(
                { ...sig, id: signalId },
                sig.stop,
                sig.tp1,
                sig.tp2
              );
            }
          } else {
            console.log(`[DEBUG] recordSignal returned null for ${sig.symbol}`);
            failed++;
          }
        } catch (recordErr) {
          console.error(`[DEBUG] FAILED to record ${sig.symbol}:`, recordErr);
          failed++;
        }
      }
      
      console.log(`[DEBUG] Recording complete: ${recorded} success, ${failed} failed, ${allSignals.length} total`);
    } catch (e) {
      console.warn('[signals] record failed:', e);
    }
    return passedSignals;
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
    // Check email config
    const emailConfig = {
      enabled: process.env.EMAIL_ENABLED,
      smtpHost: process.env.SMTP_HOST,
      smtpPort: process.env.SMTP_PORT,
      smtpUser: process.env.SMTP_USER,
      smtpPassSet: !!process.env.SMTP_PASS,
      alertEmails: process.env.ALERT_EMAILS,
      fromName: process.env.EMAIL_FROM_NAME,
      isEnabled: isEmailEnabled(),
    };

    const fakeSignal: any = {
      symbol: 'TESTUSDT',
      category: 'READY_TO_BUY',
      price: 123.45,
      rsi9: 55.2,
      vwapDistancePct: 0.001,
      ema200: 123.00,
      volume: 99999,
      chartUrl: 'https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT'
    };

    if (!isEmailEnabled()) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Email not enabled',
        config: emailConfig,
        hint: 'Set EMAIL_ENABLED=true and SMTP_* vars in Railway'
      });
    }

    await emailNotify(undefined, fakeSignal);
    res.json({ ok: true, sent: fakeSignal, config: emailConfig });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err), stack: (err as any)?.stack });
  }
});

// --- DEBUG: record signal test ---
app.get('/api/debug/record-signal', async (_req, res) => {
  try {
    const testSignal = {
      symbol: 'DEBUGUSDT',
      category: 'READY_TO_BUY',
      time: Date.now(),
      price: 100.50,
      vwap: 100.25,
      ema200: 99.80,
      rsi9: 65.0,
      volSpike: 2.0,
      atrPct: 1.5,
      confirm15m: false,
      deltaVwapPct: 0.25,
      stop: 99.00,
      tp1: 102.00,
      tp2: 104.00,
      target: 104.00,
      rr: 2.0,
      riskPct: 1.5,
      sessionOk: true,
      sweepOk: false,
      trendOk: true,
      blockedByBtc: false,
      runId: 'debug_run_' + Date.now(),
      instanceId: 'debug_instance',
      reasons: ['Debug test'],
      thresholdVwapDistancePct: 0.3,
      thresholdVolSpikeX: 1.5,
      thresholdAtrGuardPct: 2.5,
    };

    console.log('[debug] Testing recordSignal...');
    const signalId = await recordSignal(testSignal as any, 'BALANCED');
    console.log('[debug] recordSignal returned:', signalId);

    // Check what was created
    const d = getDb();
    const events = await d.prepare('SELECT COUNT(*) as n FROM signal_events WHERE signal_id = ?').get(signalId);
    const outcomes = await d.prepare('SELECT COUNT(*) as n FROM signal_outcomes WHERE signal_id = ?').all(signalId);

    res.json({
      ok: true,
      signalId,
      eventsCreated: events?.n ?? 0,
      outcomesCreated: outcomes?.length ?? 0,
      signal: testSignal,
    });
  } catch (err) {
    console.error('[debug] recordSignal test failed:', err);
    res.status(500).json({ 
      ok: false, 
      error: String(err),
      stack: (err as any)?.stack 
    });
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
    let signalEventsTotal: { n: number } | null = null;
    try {
      signalEventsTotal = await db.prepare('SELECT COUNT(1) as n FROM signal_events').get() as { n: number };
    } catch {
      signalEventsTotal = { n: 0 };
    }
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
    const source = String((req.query as any)?.source || '').trim() || undefined;
    const out = await getStats({
      days: Number.isFinite(days) ? days : undefined,
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      category,
      categories,
      symbol,
      preset,
      strategyVersion,
      source,
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
    const source = String((req.query as any)?.source || '').trim() || undefined;

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
      source,
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
    const source = String((req.query as any)?.source || '').trim() || undefined;

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
      source,
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
    const source = String((req.query as any)?.source || '').trim() || undefined;

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
      source,
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
    const source = String((req.query as any)?.source || '').trim() || undefined;

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
      source,
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
    const source = String((req.query as any)?.source || '').trim() || undefined;

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
      source,
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

// Extended Outcomes (24h) API
app.get('/api/extended-outcomes', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const status = String((req.query as any)?.status || '').trim() || undefined;
    const direction = String((req.query as any)?.direction || '').trim() || undefined;
    const completedRaw = String((req.query as any)?.completed || '').toLowerCase();
    const completed = ['1', 'true', 'yes'].includes(completedRaw) ? true
      : ['0', 'false', 'no'].includes(completedRaw) ? false : undefined;
    const limit = Number((req.query as any)?.limit);
    const offset = Number((req.query as any)?.offset);
    const sort = String((req.query as any)?.sort || '').trim() || undefined;

    const out = await listExtendedOutcomes({
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      symbol,
      category,
      status: status as any,
      direction: direction as any,
      completed,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      sort: sort as any,
    });
    res.json({ ok: true, ...out });
  } catch (e: any) {
    console.error('[api/extended-outcomes] Error:', e);
    res.status(500).json({ ok: false, error: String(e), details: e?.message });
  }
});

app.get('/api/extended-outcomes/stats', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const direction = String((req.query as any)?.direction || '').trim() || undefined;

    const out = await getExtendedOutcomeStats({
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      symbol,
      category,
      direction: direction as any,
    });
    res.json({ ok: true, ...out });
  } catch (e: any) {
    console.error('[api/extended-outcomes/stats] Error:', e);
    res.status(500).json({ ok: false, error: String(e), details: e?.message });
  }
});

// Managed PnL (Option B) stats endpoint
app.get('/api/extended-outcomes/managed-stats', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const direction = String((req.query as any)?.direction || '').trim() || undefined;

    const out = await getManagedPnlStats({
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      symbol,
      category,
      direction: direction as any,
    });
    res.json({ ok: true, ...out });
  } catch (e: any) {
    console.error('[api/extended-outcomes/managed-stats] Error:', e);
    res.status(500).json({ ok: false, error: String(e), details: e?.message });
  }
});

/**
 * Self-verifying stats endpoint (Step 2)
 * Returns counts + denominators for every percentage
 */
app.get('/api/stats/verifiable', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const direction = String((req.query as any)?.direction || '').trim() || undefined;

    const d = getDb();
    
    // Build WHERE clause
    const conditions: string[] = [];
    const values: any[] = [];

    if (start !== undefined && Number.isFinite(start)) {
      conditions.push('eo.signal_time >= ?');
      values.push(start);
    }
    if (end !== undefined && Number.isFinite(end)) {
      conditions.push('eo.signal_time <= ?');
      values.push(end);
    }
    if (symbol) {
      conditions.push('eo.symbol = ?');
      values.push(symbol.toUpperCase());
    }
    if (category) {
      conditions.push('eo.category = ?');
      values.push(category);
    }
    if (direction) {
      conditions.push('eo.direction = ?');
      values.push(direction);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get all counts in a single query
    const stats = await d.prepare(`
      SELECT
        -- Totals
        COUNT(*) as total_signals,
        SUM(CASE WHEN eo.completed_at IS NOT NULL THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN eo.completed_at IS NULL THEN 1 ELSE 0 END) as pending,
        
        -- Signal outcome counts
        SUM(CASE WHEN eo.status = 'WIN_TP2' THEN 1 ELSE 0 END) as win_tp2,
        SUM(CASE WHEN eo.status = 'WIN_TP1' THEN 1 ELSE 0 END) as win_tp1,
        SUM(CASE WHEN eo.status = 'LOSS_STOP' THEN 1 ELSE 0 END) as loss_stop,
        SUM(CASE WHEN eo.status = 'FLAT_TIMEOUT_24H' THEN 1 ELSE 0 END) as flat_timeout,
        SUM(CASE WHEN eo.status = 'NO_TRADE' THEN 1 ELSE 0 END) as no_trade,
        SUM(CASE WHEN eo.status = 'ACHIEVED_TP1' THEN 1 ELSE 0 END) as achieved_tp1,
        -- Strict pending (only PENDING status, not ACHIEVED_TP1)
        SUM(CASE WHEN eo.status = 'PENDING' THEN 1 ELSE 0 END) as pending_strict,
        
        -- Debug: Check for mismatches between status and completed_at
        SUM(CASE WHEN eo.completed_at IS NOT NULL AND eo.status IN ('PENDING', 'ACHIEVED_TP1') THEN 1 ELSE 0 END) as mismatch_active_with_completed_at,
        SUM(CASE WHEN eo.completed_at IS NULL AND eo.status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP', 'FLAT_TIMEOUT_24H', 'NO_TRADE') THEN 1 ELSE 0 END) as mismatch_completed_without_completed_at,
        
        -- TP touch counts (for rates)
        SUM(CASE WHEN eo.first_tp1_at IS NOT NULL THEN 1 ELSE 0 END) as tp1_touched,
        SUM(CASE WHEN eo.tp2_at IS NOT NULL THEN 1 ELSE 0 END) as tp2_touched,
        
        -- Managed counts
        SUM(CASE WHEN eo.ext24_managed_r IS NOT NULL THEN 1 ELSE 0 END) as managed_closed,
        SUM(CASE WHEN eo.ext24_managed_r > 0 THEN 1 ELSE 0 END) as managed_wins,
        SUM(CASE WHEN eo.ext24_managed_r < 0 THEN 1 ELSE 0 END) as managed_losses,
        SUM(CASE WHEN eo.ext24_managed_r = 0 AND eo.ext24_managed_status IS NOT NULL THEN 1 ELSE 0 END) as managed_be,
        SUM(CASE WHEN eo.ext24_runner_exit_reason = 'BREAK_EVEN' THEN 1 ELSE 0 END) as be_saves,
        SUM(CASE WHEN eo.ext24_runner_exit_reason = 'TIMEOUT_MARKET' THEN 1 ELSE 0 END) as timeout_exits,
        SUM(CASE WHEN eo.ext24_runner_exit_reason = 'TP2' THEN 1 ELSE 0 END) as tp2_hits,
        
        -- Averages
        AVG(eo.time_to_tp1_seconds) as avg_time_to_tp1,
        AVG(eo.max_favorable_excursion_pct) as avg_mfe_pct,
        AVG(eo.max_adverse_excursion_pct) as avg_mae_pct,
        AVG(eo.ext24_managed_r) as avg_managed_r,
        SUM(eo.ext24_managed_r) as total_managed_r
      FROM extended_outcomes eo
      ${whereClause}
    `).get(...values) as any;

    // Parse counts
    const totalSignals = Number(stats.total_signals) || 0;
    const completed = Number(stats.completed) || 0;
    const pending = Number(stats.pending) || 0;
    const winTp2 = Number(stats.win_tp2) || 0;
    const winTp1 = Number(stats.win_tp1) || 0;
    const lossStop = Number(stats.loss_stop) || 0;
    const flatTimeout = Number(stats.flat_timeout) || 0;
    const noTrade = Number(stats.no_trade) || 0;
    const achievedTp1 = Number(stats.achieved_tp1) || 0;
    const pendingStrict = Number(stats.pending_strict) || 0;
    const mismatchActiveWithCompleted = Number(stats.mismatch_active_with_completed_at) || 0;
    const mismatchCompletedWithoutCompleted = Number(stats.mismatch_completed_without_completed_at) || 0;
    const tp1Touched = Number(stats.tp1_touched) || 0;
    const tp2Touched = Number(stats.tp2_touched) || 0;
    const managedClosed = Number(stats.managed_closed) || 0;
    const managedWins = Number(stats.managed_wins) || 0;
    const managedLosses = Number(stats.managed_losses) || 0;
    const managedBE = Number(stats.managed_be) || 0;
    const beSaves = Number(stats.be_saves) || 0;
    const timeoutExits = Number(stats.timeout_exits) || 0;
    const tp2Hits = Number(stats.tp2_hits) || 0;

    // Calculate rates with explicit numerators/denominators
    const wins = winTp1 + winTp2;
    
    // Verification calculations (Step 4)
    // Note: ACHIEVED_TP1 is NOT completed (still active, waiting for TP2/stop/timeout)
    // pendingStrict = only PENDING status (not ACHIEVED_TP1)
    // achievedTp1 = only ACHIEVED_TP1 status
    // active = pendingStrict + achievedTp1 (all with completed_at IS NULL)
    const sumOfCompleted = winTp1 + winTp2 + lossStop + flatTimeout + noTrade;
    const sumActive = pendingStrict + achievedTp1; // These have completed_at = NULL
    const sumAllBuckets = winTp1 + winTp2 + lossStop + flatTimeout + noTrade + achievedTp1 + pendingStrict;
    
    const response = {
      ok: true,
      
      // Totals
      totals: {
        totalSignals,
        completedSignals: completed,
        activeSignals: pendingStrict + achievedTp1, // pendingStrict + achievedTp1 (both have completed_at IS NULL)
      },
      
      // Signal outcome counts (the canonical buckets)
      signalCounts: {
        winTp1,
        winTp2,
        lossStop,
        flatTimeout,
        noTrade,
        achievedTp1: achievedTp1,
      },
      
      // Signal rates with num/den
      signalRates: {
        winRate: {
          pct: completed > 0 ? Number(((wins / completed) * 100).toFixed(1)) : 0,
          num: wins,
          den: completed,
          label: `${wins} / ${completed} completed`
        },
        tp1TouchRate: {
          pct: totalSignals > 0 ? Number(((tp1Touched / totalSignals) * 100).toFixed(1)) : 0,
          num: tp1Touched,
          den: totalSignals,
          label: `${tp1Touched} / ${totalSignals} total`
        },
        tp2Conversion: {
          pct: tp1Touched > 0 ? Number(((tp2Touched / tp1Touched) * 100).toFixed(1)) : 0,
          num: tp2Touched,
          den: tp1Touched,
          label: `${tp2Touched} / ${tp1Touched} touched TP1`
        },
      },
      
      // Managed outcome counts
      managedCounts: {
        closed: managedClosed,
        wins: managedWins,
        losses: managedLosses,
        breakeven: managedBE,
        beSaves,
        timeoutExits,
        tp2Hits,
      },
      
      // Managed rates with num/den
      managedRates: {
        winRate: {
          pct: managedClosed > 0 ? Number(((managedWins / managedClosed) * 100).toFixed(1)) : 0,
          num: managedWins,
          den: managedClosed,
          label: `${managedWins} / ${managedClosed} closed`
        },
        beRate: {
          pct: managedClosed > 0 ? Number(((managedBE / managedClosed) * 100).toFixed(1)) : 0,
          num: managedBE,
          den: managedClosed,
          label: `${managedBE} / ${managedClosed} closed`
        },
      },
      
      // Performance metrics
      performance: {
        totalManagedR: Number(stats.total_managed_r) || 0,
        avgManagedR: Number(stats.avg_managed_r) || 0,
        avgTimeToTp1Seconds: stats.avg_time_to_tp1,
        avgMfePct: stats.avg_mfe_pct,
        avgMaePct: stats.avg_mae_pct,
      },
      
      // Outcome breakdown for full transparency (Step 4)
      breakdown: {
        // UI-ready list with counts, percentages, and denominators
        bySignal: [
          { 
            key: "winTp2", 
            label: "WIN TP2", 
            count: winTp2, 
            den: totalSignals, 
            pctOfTotal: totalSignals > 0 ? Number(((winTp2 / totalSignals) * 100).toFixed(1)) : 0,
            category: "win" 
          },
          { 
            key: "winTp1", 
            label: "WIN TP1", 
            count: winTp1, 
            den: totalSignals, 
            pctOfTotal: totalSignals > 0 ? Number(((winTp1 / totalSignals) * 100).toFixed(1)) : 0,
            category: "win" 
          },
          { 
            key: "achievedTp1", 
            label: "ACHIEVED TP1", 
            count: achievedTp1, 
            den: totalSignals, 
            pctOfTotal: totalSignals > 0 ? Number(((achievedTp1 / totalSignals) * 100).toFixed(1)) : 0,
            category: "pending" 
          },
          { 
            key: "lossStop", 
            label: "LOSS STOP", 
            count: lossStop, 
            den: totalSignals, 
            pctOfTotal: totalSignals > 0 ? Number(((lossStop / totalSignals) * 100).toFixed(1)) : 0,
            category: "loss" 
          },
          { 
            key: "flatTimeout", 
            label: "NO HIT (24h)", 
            count: flatTimeout, 
            den: totalSignals, 
            pctOfTotal: totalSignals > 0 ? Number(((flatTimeout / totalSignals) * 100).toFixed(1)) : 0,
            category: "neutral" 
          },
          { 
            key: "noTrade", 
            label: "NO TRADE", 
            count: noTrade, 
            den: totalSignals, 
            pctOfTotal: totalSignals > 0 ? Number(((noTrade / totalSignals) * 100).toFixed(1)) : 0,
            category: "neutral" 
          },
          { 
            key: "pending", 
            label: "PENDING", 
            count: pendingStrict, 
            den: totalSignals, 
            pctOfTotal: totalSignals > 0 ? Number(((pendingStrict / totalSignals) * 100).toFixed(1)) : 0,
            category: "pending" 
          },
        ],
        // Denominators for reference
        completedDen: completed,
        totalDen: totalSignals,
        // Win rate definition reference
        winRateDefinition: "(WIN_TP1 + WIN_TP2) / completed",
      },
      
      // Verification checksums (Step 4)
      verification: {
        // Check 1: completed signals match sum of completed outcome buckets
        completedCheck: completed,
        sumOfOutcomes: sumOfCompleted,
        completedMatches: completed === sumOfCompleted,
        
        // Check 2: total = completed + active (pending + achieved_tp1)
        totalCheck: totalSignals,
        sumCompletedAndActive: completed + sumActive,
        totalMatches: totalSignals === (completed + sumActive),
        
        // Check 3: all outcome buckets sum to total
        sumAllBuckets: sumAllBuckets,
        allBucketsMatch: totalSignals === sumAllBuckets,
        
        // Overall verification status
        allMatch: completed === sumOfCompleted && totalSignals === (completed + sumActive),
        
        // Debug info to diagnose mismatches
        debug: {
          // Raw counts from SQL
          sqlCompleted: completed,
          sqlPending: pending,
          sqlPendingStrict: pendingStrict,
          sqlAchievedTp1: achievedTp1,
          // Status bucket counts
          winTp1, winTp2, lossStop, flatTimeout, noTrade,
          // Calculated sums
          sumOfCompleted,
          sumActive,
          sumAllBuckets,
          // Mismatch detection (these should be 0)
          mismatchActiveWithCompleted,
          mismatchCompletedWithoutCompleted,
        }
      }
    };

    res.json(response);
  } catch (e: any) {
    console.error('[api/stats/verifiable] Error:', e);
    res.status(500).json({ ok: false, error: String(e), details: e?.message });
  }
});

app.post('/api/extended-outcomes/backfill', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Number((req.query as any)?.days);
    const batchSize = Number((req.query as any)?.batchSize);
    const sinceMs = Date.now() - (Number.isFinite(days) ? days : 7) * 24 * 60 * 60 * 1000;
    console.log(`[api/backfill] Starting backfill for last ${days || 7} days, batchSize: ${batchSize || 50}`);
    const out = await backfillExtendedOutcomes(sinceMs, Number.isFinite(batchSize) ? batchSize : 50);
    console.log(`[api/backfill] Complete:`, out);
    res.json({ ok: true, ...out });
  } catch (e: any) {
    console.error('[api/extended-outcomes/backfill] Error:', e);
    res.status(500).json({ ok: false, error: String(e), details: e?.message });
  }
});

app.post('/api/extended-outcomes/reevaluate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Number((req.query as any)?.limit);
    const out = await reevaluatePendingExtendedOutcomes(Number.isFinite(limit) ? limit : 25);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Full backfill of ALL historical signals (admin only)
app.post('/api/extended-outcomes/backfill-all', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const db = getDb();
    
    // Count total
    const countRow = await db.prepare(`
      SELECT COUNT(*) as n
      FROM signals s
      LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
      WHERE eo.id IS NULL
    `).get() as { n: number };
    
    const total = countRow?.n || 0;
    
    if (total === 0) {
      return res.json({ ok: true, message: 'All signals already have extended outcomes', processed: 0, total: 0 });
    }
    
    // Process in background - don't wait
    res.json({ 
      ok: true, 
      message: `Backfill started for ${total} signals`, 
      total,
      note: 'Processing in background. Check logs for progress.'
    });
    
    // Continue processing after response
    let processed = 0;
    let errors = 0;
    const batchSize = 50;
    
    while (processed < total) {
      const signals = await db.prepare(`
        SELECT s.id, s.symbol, s.category, s.time, s.price, s.stop, s.tp1, s.tp2
        FROM signals s
        LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
        WHERE eo.id IS NULL
        ORDER BY s.time DESC
        LIMIT ?
      `).all(batchSize);
      
      if (!signals || signals.length === 0) break;
      
      for (const signal of signals) {
        try {
          await getOrCreateExtendedOutcome({
            signalId: signal.id,
            symbol: signal.symbol,
            category: signal.category,
            direction: getSignalDirection(signal.category),
            signalTime: signal.time,
            entryPrice: signal.price,
            stopPrice: signal.stop,
            tp1Price: signal.tp1,
            tp2Price: signal.tp2,
          });
          processed++;
        } catch (e) {
          console.error(`[backfill-all] Error for signal ${signal.id}:`, e);
          errors++;
        }
      }
      
      console.log(`[backfill-all] Progress: ${processed}/${total} (${((processed/total)*100).toFixed(1)}%)`);
      await new Promise(r => setTimeout(r, 50));
    }
    
    console.log(`[backfill-all] Complete! Processed: ${processed}, Errors: ${errors}`);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/extended-outcomes/force-reevaluate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return res.status(400).json({ ok: false, error: 'start and end required' });
    }
    const out = await forceReevaluateRange(start, end);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Backfill managed PnL values for completed outcomes missing them
app.post('/api/extended-outcomes/backfill-managed', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Number((req.query as any)?.limit);
    const out = await backfillManagedPnlForCompleted(Number.isFinite(limit) ? limit : 50);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Evaluate single signal's extended outcome
app.post('/api/extended-outcomes/evaluate/:signalId', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const signalId = Number(req.params.signalId);
    if (!Number.isFinite(signalId)) {
      return res.status(400).json({ ok: false, error: 'Invalid signalId' });
    }

    // Get signal details from DB
    const signal = await getSignalById(signalId);
    if (!signal) {
      return res.status(404).json({ ok: false, error: 'Signal not found' });
    }

    const input: ExtendedOutcomeInput = {
      signalId,
      symbol: signal.symbol,
      category: signal.category,
      direction: getSignalDirection(signal.category),
      signalTime: signal.time,
      entryPrice: signal.price,
      stopPrice: signal.stop,
      tp1Price: signal.tp1,
      tp2Price: signal.tp2,
    };

    const result = await evaluateAndUpdateExtendedOutcome(input);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get extended outcomes with 240m horizon comparison
app.get('/api/extended-outcomes/comparison', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const symbol = String((req.query as any)?.symbol || '').trim() || undefined;
    const category = String((req.query as any)?.category || '').trim() || undefined;
    const status = String((req.query as any)?.status || '').trim() || undefined;
    const direction = String((req.query as any)?.direction || '').trim() || undefined;
    const improvementsOnlyRaw = String((req.query as any)?.improvementsOnly || '').toLowerCase();
    const improvementsOnly = ['1', 'true', 'yes'].includes(improvementsOnlyRaw);
    const limit = Number((req.query as any)?.limit);
    const offset = Number((req.query as any)?.offset);

    const out = await listExtendedOutcomesWithComparison({
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
      symbol,
      category,
      status: status as any,
      direction: direction as any,
      showImprovementsOnly: improvementsOnly,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get improvement statistics (240m vs 24h)
app.get('/api/extended-outcomes/improvements', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);

    const out = await getImprovementStats({
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(end) ? end : undefined,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// OUTCOME ANALYSIS API (Steps 0-4)
// ============================================================================

// Diagnostics - status inventory and bucket counts
app.get('/api/stats/ext24/diagnostics', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);

    const out = await getDiagnostics(
      Number.isFinite(start) ? start : undefined,
      Number.isFinite(end) ? end : undefined
    );
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[api/stats/ext24/diagnostics] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Bucket analysis - stats by direction+bucket
app.get('/api/stats/ext24/by-bucket', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);

    const out = await computeBucketAnalysis(
      Number.isFinite(start) ? start : undefined,
      Number.isFinite(end) ? end : undefined
    );
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[api/stats/ext24/by-bucket] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Symbol stats with tiering
app.get('/api/stats/ext24/by-symbol', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const minSignalsRaw = Number((req.query as any)?.minSignals);
    const minSignals = Number.isFinite(minSignalsRaw) ? minSignalsRaw : 10;

    const out = await getSymbolStats(
      Number.isFinite(start) ? start : undefined,
      Number.isFinite(end) ? end : undefined,
      minSignals
    );
    res.json({ ok: true, symbols: out });
  } catch (e) {
    console.error('[api/stats/ext24/by-symbol] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Filter set definitions
app.get('/api/stats/ext24/filter-definitions', async (_req, res) => {
  try {
    const out = getFilterSetDefinitions();
    res.json({ ok: true, filters: out });
  } catch (e) {
    console.error('[api/stats/ext24/filter-definitions] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Filter backtest
app.get('/api/stats/ext24/backtest', async (req, res) => {
  try {
    const start = Number((req.query as any)?.start);
    const end = Number((req.query as any)?.end);
    const filterId = String((req.query as any)?.filter || 'A') as FilterSetId;

    if (!['A', 'B', 'C'].includes(filterId)) {
      return res.status(400).json({ ok: false, error: 'Invalid filter ID. Use A, B, or C.' });
    }

    const out = await backtestFilter(
      filterId,
      Number.isFinite(start) ? start : undefined,
      Number.isFinite(end) ? end : undefined
    );
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[api/stats/ext24/backtest] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Backfill early window metrics
app.post('/api/extended-outcomes/backfill-early-window', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const limitRaw = Number((req.query as any)?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50;
    const out = await backfillEarlyWindowMetrics(limit);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[api/extended-outcomes/backfill-early-window] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// DECISION ENGINE API (Entry Filter & Symbol Tiers)
// ============================================================================

// Get current filter config
app.get('/api/filter/config', (_req, res) => {
  try {
    const config = getFilterConfig();
    res.json({ ok: true, config });
  } catch (e) {
    console.error('[api/filter/config] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Test a signal against the filter (dry run)
app.post('/api/filter/test', async (req, res) => {
  try {
    const signal = req.body.signal as SignalWithEarlyMetrics;
    const customConfig = req.body.config as Partial<FilterConfig> | undefined;
    
    if (!signal) {
      return res.status(400).json({ ok: false, error: 'Signal required' });
    }

    const result = await shouldEnterTrade(signal, customConfig);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[api/filter/test] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Simulate filter on multiple signals
app.post('/api/filter/simulate', async (req, res) => {
  try {
    const signals = req.body.signals as SignalWithEarlyMetrics[];
    const customConfig = req.body.config as FilterConfig | undefined;
    
    if (!Array.isArray(signals)) {
      return res.status(400).json({ ok: false, error: 'Signals array required' });
    }

    const result = await simulateFilter(signals, customConfig || getFilterConfig());
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[api/filter/simulate] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Calculate MQS for a signal
app.post('/api/filter/mqs', (req, res) => {
  try {
    const { mfe30mPct, mae30mPct } = req.body;
    const mqs = calculateMQS(mfe30mPct, mae30mPct);
    const interpretation = interpretMQS(mqs);
    res.json({ ok: true, mqs, interpretation });
  } catch (e) {
    console.error('[api/filter/mqs] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// SIGNAL GATE API (Hard Execution Filter)
// ============================================================================

// Get gate config
app.get('/api/gate/config', (_req, res) => {
  try {
    const config = getGateConfig();
    res.json({ ok: true, config });
  } catch (e) {
    console.error('[api/gate/config] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Check a signal through the gate (dry run)
app.post('/api/gate/check', async (req, res) => {
  try {
    const signal = req.body.signal;
    const customConfig = req.body.config;
    
    if (!signal) {
      return res.status(400).json({ ok: false, error: 'Signal required' });
    }

    const result = await checkSignalGate(signal, customConfig);
    recordGateResult(result);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[api/gate/check] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Batch check signals through gate
app.post('/api/gate/batch', async (req, res) => {
  try {
    const signals = req.body.signals;
    const customConfig = req.body.config;
    
    if (!Array.isArray(signals)) {
      return res.status(400).json({ ok: false, error: 'Signals array required' });
    }

    const result = await filterSignalsThroughGate(signals, customConfig);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[api/gate/batch] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get gate statistics
app.get('/api/gate/stats', (_req, res) => {
  try {
    const stats = getGateStats();
    res.json({ ok: true, stats });
  } catch (e) {
    console.error('[api/gate/stats] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get current gate config
app.get('/api/gate/config', (_req, res) => {
  try {
    const config = getGateConfig();
    res.json({ ok: true, config });
  } catch (e) {
    console.error('[api/gate/config] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Reset gate statistics (admin)
app.post('/api/gate/stats/reset', (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    resetGateStats();
    res.json({ ok: true, message: 'Gate stats reset' });
  } catch (e) {
    console.error('[api/gate/stats/reset] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// GATE BACKTEST API
// ============================================================================

// Run backtest with custom config
app.post('/api/gate/backtest', async (req, res) => {
  try {
    const config = req.body.config as BacktestConfig;
    const limit = Math.min(500, Math.max(10, Number(req.body.limit) || 200));
    
    if (!config) {
      return res.status(400).json({ ok: false, error: 'Config required' });
    }

    const result = await runGateBacktest(config, limit);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[api/gate/backtest] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Compare multiple configs
app.post('/api/gate/backtest/compare', async (req, res) => {
  try {
    const configs = req.body.configs as BacktestConfig[];
    const limit = Math.min(500, Math.max(10, Number(req.body.limit) || 200));
    
    if (!Array.isArray(configs) || configs.length === 0) {
      return res.status(400).json({ ok: false, error: 'Configs array required' });
    }

    const results = await compareGateConfigs(configs, limit);
    res.json({ ok: true, results });
  } catch (e) {
    console.error('[api/gate/backtest/compare] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get recommended configs to test
app.get('/api/gate/backtest/recommended', (_req, res) => {
  try {
    const configs = getRecommendedConfigs();
    res.json({ ok: true, configs });
  } catch (e) {
    console.error('[api/gate/backtest/recommended] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// DELETE EARLY_READY_SHORT SIGNALS (ADMIN)
// ============================================================================

app.post('/api/admin/delete-early-ready-short', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    
    const dryRun = (req.query.dryRun || req.body?.dryRun) !== 'false';
    const d = getDb();
    
    // Count signals to delete
    const countResult = await d.prepare(`
      SELECT COUNT(*) as count FROM signals WHERE category = 'EARLY_READY_SHORT'
    `).get() as { count: number };
    
    const count = countResult?.count || 0;
    
    if (count === 0) {
      return res.json({ ok: true, message: 'No EARLY_READY_SHORT signals found', deleted: 0 });
    }
    
    if (dryRun) {
      const sample = await d.prepare(`
        SELECT id, symbol, category, created_at 
        FROM signals 
        WHERE category = 'EARLY_READY_SHORT'
        ORDER BY created_at DESC
        LIMIT 5
      `).all();
      
      return res.json({
        ok: true,
        dryRun: true,
        wouldDelete: count,
        sample,
        message: `${count} EARLY_READY_SHORT signals would be deleted. Set dryRun=false to confirm.`
      });
    }
    
    // Get all signal IDs to delete
    const idRows = await d.prepare(`
      SELECT id FROM signals WHERE category = 'EARLY_READY_SHORT'
    `).all() as Array<{ id: number }>;
    
    if (idRows.length === 0) {
      return res.json({ ok: true, message: 'No EARLY_READY_SHORT signals found', deleted: 0 });
    }
    
    // Delete in batches to avoid parameter limit issues
    const batchSize = 100;
    let outcomesDeleted = 0;
    let extendedDeleted = 0;
    
    for (let i = 0; i < idRows.length; i += batchSize) {
      const batch = idRows.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      const ids = batch.map(r => r.id);
      
      try {
        const outResult = await d.prepare(`
          DELETE FROM outcomes WHERE signal_id IN (${placeholders})
        `).run(...ids);
        outcomesDeleted += outResult.changes || 0;
      } catch (e) {
        console.log('[delete-early-ready-short] Outcomes delete batch failed (may not exist):', e);
      }
      
      try {
        const extResult = await d.prepare(`
          DELETE FROM extended_outcomes WHERE signal_id IN (${placeholders})
        `).run(...ids);
        extendedDeleted += extResult.changes || 0;
      } catch (e) {
        console.log('[delete-early-ready-short] Extended outcomes delete batch failed (may not exist):', e);
      }
    }
    
    // Delete signals last
    const signalsResult = await d.prepare(`
      DELETE FROM signals WHERE category = 'EARLY_READY_SHORT'
    `).run();
    
    res.json({
      ok: true,
      deleted: {
        signals: signalsResult.changes || 0,
        outcomes: outcomesDeleted,
        extendedOutcomes: extendedDeleted
      },
      message: `Deleted ${signalsResult.changes || 0} EARLY_READY_SHORT signals and their outcomes`
    });
    
  } catch (e: any) {
    console.error('[api/admin/delete-early-ready-short] Error:', e);
    res.status(500).json({ 
      ok: false, 
      error: String(e),
      details: e?.message 
    });
  }
});

// ============================================================================
// SYMBOL TIER API
// ============================================================================

// Get all symbol tiers
app.get('/api/symbol-tiers', async (req, res) => {
  try {
    const direction = req.query.direction as 'LONG' | 'SHORT' | undefined;
    const tier = req.query.tier as SymbolTier | undefined;
    const out = await getAllSymbolTiers(direction, tier);
    res.json({ ok: true, tiers: out });
  } catch (e) {
    console.error('[api/symbol-tiers] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Get specific symbol tier
app.get('/api/symbol-tiers/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol);
    const direction = (req.query.direction as 'LONG' | 'SHORT') || 'SHORT';
    const out = await getSymbolTier(symbol, direction);
    if (!out) {
      return res.status(404).json({ ok: false, error: 'Tier not found' });
    }
    res.json({ ok: true, tier: out });
  } catch (e) {
    console.error('[api/symbol-tiers/:symbol] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Set symbol tier (manual override)
app.post('/api/symbol-tiers/:symbol', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const symbol = String(req.params.symbol);
    const direction = (req.body.direction as 'LONG' | 'SHORT') || 'SHORT';
    const tier = req.body.tier as SymbolTier;
    const reason = req.body.reason as string | undefined;

    if (!['GREEN', 'YELLOW', 'RED'].includes(tier)) {
      return res.status(400).json({ ok: false, error: 'Invalid tier. Use GREEN, YELLOW, or RED.' });
    }

    await setSymbolTier(symbol, direction, tier, reason);
    res.json({ ok: true, message: `Set ${symbol} ${direction} to ${tier}` });
  } catch (e) {
    console.error('[api/symbol-tiers/:symbol POST] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Compute and update tiers from historical data
app.post('/api/symbol-tiers/compute', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const start = Number(req.query.start);
    const end = Number(req.query.end);
    const minSignals = Number(req.query.minSignals) || 10;
    
    const out = await computeAndUpdateTiers(
      Number.isFinite(start) ? start : undefined,
      Number.isFinite(end) ? end : undefined,
      minSignals
    );
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[api/symbol-tiers/compute] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Clear manual override for a symbol
app.post('/api/symbol-tiers/:symbol/clear-override', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const symbol = String(req.params.symbol);
    const direction = (req.body.direction as 'LONG' | 'SHORT') || 'SHORT';
    await clearManualOverride(symbol, direction);
    res.json({ ok: true, message: `Cleared manual override for ${symbol} ${direction}` });
  } catch (e) {
    console.error('[api/symbol-tiers/:symbol/clear-override] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Delete a symbol tier
app.delete('/api/symbol-tiers/:symbol', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const symbol = String(req.params.symbol);
    const direction = (req.query.direction as 'LONG' | 'SHORT') || 'SHORT';
    await deleteSymbolTier(symbol, direction);
    res.json({ ok: true, message: `Deleted tier for ${symbol} ${direction}` });
  } catch (e) {
    console.error('[api/symbol-tiers/:symbol DELETE] Error:', e);
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

// Serve frontend build (only in local dev, not on Railway)
const isRailwayEnv = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
if (!isRailwayEnv) {
  const feRoot = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(feRoot));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(feRoot, 'index.html'));
  });
} else {
  // Railway: API only, frontend is on Vercel
  // Add health check endpoint for root
  app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'pro-scalp-backend', env: 'railway' });
  });
}

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
      // 🚨 HARD GATE: Filter signals before recording (same as runScan)
      const gateConfig = getGateConfig();
      let passedSignals = signals;
      
      if (gateConfig.enabled) {
        const gateResult = await filterSignalsThroughGate(signals as any, gateConfig);
        passedSignals = gateResult.allowed;
        
        if (gateResult.stats.blocked > 0) {
          console.log(`[signal-gate][loop] ${gateResult.stats.allowed}/${gateResult.stats.total} passed (${gateResult.stats.blocked} blocked)`);
          // Log blocked EARLY_READY signals
          const earlyBlocked = gateResult.blocked.filter(b => 
            b.category === 'EARLY_READY' || b.category === 'EARLY_READY_SHORT'
          );
          if (earlyBlocked.length > 0) {
            console.log(`[signal-gate][loop] Blocked ${earlyBlocked.length} EARLY_READY signals: ${earlyBlocked.map(s => s.symbol).join(', ')}`);
          }
        }
      }
      
      for (const sig of passedSignals) {
        const signalId = await recordSignal(sig as any, undefined);
        if (signalId) {
          await initDelayedEntry(
            { ...sig, id: signalId },
            sig.stop,
            sig.tp1,
            sig.tp2
          );
        }
      }
    } catch (e) {
      console.warn('[signals] record failed (loop):', e);
    }
  });
} else {
  console.log('[scan] server loop disabled (SERVER_LOOP_ENABLED=false)');
}

// Outcomes updater (safe to run even if no signals yet)
startOutcomeUpdater();

// ============================================================================
// DELAYED ENTRY WATCHER (Confirmation-Based Trading)
// ============================================================================

const delayedConfig = getDelayedEntryConfig();

if (delayedConfig.enabled) {
  console.log('[delayed-entry] Enabled - confirmation required before entry');
  console.log(`[delayed-entry] Config: ${delayedConfig.confirmMovePct}% move, ${delayedConfig.maxWaitMinutes}min max wait`);
  
  // Ensure schema
  ensureDelayedEntrySchema().catch(console.error);
  
  // Start watcher loop
  const watcherInterval = setInterval(async () => {
    try {
      const result = await runDelayedEntryWatcher();
      if (result.checked > 0) {
        console.log(`[delayed-entry] Watcher: ${result.checked} watching, ${result.entered} entered, ${result.expired} expired`);
      }
    } catch (e) {
      console.error('[delayed-entry] Watcher error:', e);
    }
  }, delayedConfig.pollIntervalSeconds * 1000);
  
  // Cleanup on exit
  process.on('SIGINT', () => clearInterval(watcherInterval));
  process.on('SIGTERM', () => clearInterval(watcherInterval));
} else {
  console.log('[delayed-entry] Disabled - immediate entry mode');
}

// ============================================================================
// DELAYED ENTRY ENDPOINTS
// ============================================================================

// Config endpoint (no DB required)
app.get('/api/delayed-entry/config', (_req, res) => {
  try {
    const config = getDelayedEntryConfig();
    res.json({ ok: true, config });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/delayed-entry/stats', async (_req, res) => {
  try {
    const stats = await getDelayedEntryStats();
    res.json({ ok: true, stats });
  } catch (e) {
    console.error('[api/delayed-entry/stats] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// BACKTEST SIMULATION ENDPOINT (Delayed Entry)
// ============================================================================

app.post('/api/delayed-entry/simulate', async (req, res) => {
  try {
    const { signalId } = req.body;
    if (!signalId) {
      return res.status(400).json({ ok: false, error: 'signalId required' });
    }
    
    const d = getDb();
    
    // Get signal
    const signal = await d.prepare(`
      SELECT * FROM signals WHERE id = ?
    `).get(signalId) as any;
    
    if (!signal) {
      return res.status(404).json({ ok: false, error: 'Signal not found' });
    }
    
    // Get candles after signal time
    const endTime = Date.now();
    const candles = await klinesRange(signal.symbol, '5m', signal.time, endTime, 50);
    
    // Simulate delayed entry
    const result = await simulateDelayedEntry(
      {
        symbol: signal.symbol,
        category: signal.category,
        price: signal.price,
        time: signal.time,
      } as any,
      candles,
      req.body.config
    );
    
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[api/delayed-entry/simulate] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// DELAYED ENTRY VALIDATION ENDPOINT (200/100/50 test)
// ============================================================================

app.post('/api/delayed-entry/validate', async (req, res) => {
  try {
    const confirmMovePct = Number(req.body.confirmMovePct ?? 0.30);
    const windowSizes = req.body.windowSizes || [200, 100, 50];
    const maxWaitMinutes = Number(req.body.maxWaitMinutes ?? 45);
    
    if (!Number.isFinite(confirmMovePct) || confirmMovePct <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid confirmMovePct' });
    }
    
    console.log(`[api/delayed-entry/validate] Testing confirmMovePct=${confirmMovePct} on windows: ${windowSizes.join(',')}`);
    
    const { validateDelayedEntry } = await import('./delayedEntryValidation.js');
    const results = await validateDelayedEntry(confirmMovePct, windowSizes, maxWaitMinutes);
    
    res.json({ 
      ok: true, 
      results,
      summary: {
        confirmMovePct,
        windows: results.map(r => ({
          size: r.windowSize,
          confirmRate: r.confirmRate,
          winRate: r.winRate,
          rPer100: r.rPer100Signals,
          improvement: r.improvementPct,
        })),
      }
    });
  } catch (e) {
    console.error('[api/delayed-entry/validate] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// DELAYED ENTRY COMPARE THRESHOLDS (Find optimal confirmMovePct)
// ============================================================================

app.post('/api/delayed-entry/compare', async (req, res) => {
  try {
    const thresholds = req.body.thresholds || [0.20, 0.25, 0.30, 0.35, 0.40];
    const windowSize = Number(req.body.windowSize ?? 200);
    
    console.log(`[api/delayed-entry/compare] Comparing thresholds: ${thresholds.join(',')}`);
    
    const { compareConfirmThresholds } = await import('./delayedEntryValidation.js');
    const comparisons = await compareConfirmThresholds(thresholds, windowSize);
    
    res.json({ 
      ok: true, 
      comparisons,
      best: comparisons[0], // Highest score
      recommendation: `
        Best threshold: ${comparisons[0]?.threshold}%
        R per 100 signals: ${comparisons[0]?.results[0]?.rPer100Signals.toFixed(2)}
        Confirm rate: ${(comparisons[0]?.results[0]?.confirmRate * 100).toFixed(1)}%
      `.trim()
    });
  } catch (e) {
    console.error('[api/delayed-entry/compare] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// SCORE + DELAYED ENTRY COMPARISON (Test production candidates)
// ============================================================================

app.post('/api/delayed-entry/compare-score-configs', async (req, res) => {
  try {
    const windowSize = Number(req.body.windowSize ?? 200);
    const configs = req.body.configs || [
      { name: 'Config A (Score≥2, 0.25%)', minScore: 2, confirmMovePct: 0.25 },
      { name: 'Config B (Score≥3, 0.30%)', minScore: 3, confirmMovePct: 0.30 },
      { name: 'Config C (Score≥2, 0.30%)', minScore: 2, confirmMovePct: 0.30 },
    ];
    
    console.log(`[api/delayed-entry/compare-score-configs] Testing ${configs.length} configs...`);
    
    const { compareScoreDelayedConfigs } = await import('./delayedEntryValidation.js');
    const results = await compareScoreDelayedConfigs(configs, windowSize);
    
    // Format for easy comparison
    const formatted = results.map(r => ({
      config: r.configName,
      passedFilter: r.passedSignals,
      entered: r.entered,
      confirmRate: `${(r.confirmRate * 100).toFixed(1)}%`,
      winRate: `${(r.winRate * 100).toFixed(1)}%`,
      avgR: r.avgR.toFixed(2),
      totalR: r.totalR.toFixed(1),
      rPer100Signals: r.rPer100Signals.toFixed(2),
      vsBaseline: `${r.improvementPct >= 0 ? '+' : ''}${r.improvementPct.toFixed(0)}%`,
    }));
    
    res.json({ 
      ok: true, 
      results,
      formatted,
      winner: results[0]?.configName || null,
      recommendation: results[0] ? `
🏆 WINNER: ${results[0].configName}
📊 R per 100 signals: ${results[0].rPer100Signals.toFixed(2)}
📈 Win rate: ${(results[0].winRate * 100).toFixed(1)}% (${results[0].wins}/${results[0].entered})
🎯 Confirm rate: ${(results[0].confirmRate * 100).toFixed(1)}% (${results[0].entered}/${results[0].watchCreated})
      `.trim() : 'No results'
    });
  } catch (e) {
    console.error('[api/delayed-entry/compare-score-configs] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================================
// SCORE + DELAYED ENTRY COMPARISON - GET VERSION (No CORS preflight issues)
// ============================================================================
// Usage: /api/delayed-entry/compare-score-configs-get?windowSize=200&configs=A,B,C
// Where A = Score≥2+0.25%, B = Score≥3+0.30%, C = Score≥2+0.30%

app.get('/api/delayed-entry/compare-score-configs-get', async (req, res) => {
  try {
    const windowSize = Number(req.query.windowSize ?? 200);
    const configParam = String(req.query.configs || 'A,B,C');
    
    // Parse config selection (A, B, C)
    const configMap: Record<string, { name: string; minScore: number; confirmMovePct: number }> = {
      'A': { name: 'Config A (Score≥2, 0.25%)', minScore: 2, confirmMovePct: 0.25 },
      'B': { name: 'Config B (Score≥3, 0.30%)', minScore: 3, confirmMovePct: 0.30 },
      'C': { name: 'Config C (Score≥2, 0.30%)', minScore: 2, confirmMovePct: 0.30 },
      'D': { name: 'Config D (Score≥2, 0.20%)', minScore: 2, confirmMovePct: 0.20 },
      'E': { name: 'Config E (Score≥3, 0.35%)', minScore: 3, confirmMovePct: 0.35 },
    };
    
    const configs = configParam
      .split(',')
      .map(c => c.trim().toUpperCase())
      .filter(c => configMap[c])
      .map(c => configMap[c]);
    
    if (configs.length === 0) {
      return res.status(400).json({ ok: false, error: 'Invalid configs. Use A,B,C,D,E' });
    }
    
    console.log(`[api/delayed-entry/compare-score-configs-get] Testing ${configs.length} configs: ${configParam}`);
    
    const { compareScoreDelayedConfigs } = await import('./delayedEntryValidation.js');
    const results = await compareScoreDelayedConfigs(configs, windowSize);
    
    // Format for easy comparison
    const formatted = results.map(r => ({
      config: r.configName,
      passedFilter: r.passedSignals,
      entered: r.entered,
      confirmRate: `${(r.confirmRate * 100).toFixed(1)}%`,
      winRate: `${(r.winRate * 100).toFixed(1)}%`,
      avgR: r.avgR.toFixed(2),
      totalR: r.totalR.toFixed(1),
      rPer100Signals: r.rPer100Signals.toFixed(2),
      vsBaseline: `${r.improvementPct >= 0 ? '+' : ''}${r.improvementPct.toFixed(0)}%`,
    }));
    
    res.json({ 
      ok: true, 
      results,
      formatted,
      winner: results[0]?.configName || null,
      recommendation: results[0] ? `
🏆 WINNER: ${results[0].configName}
📊 R per 100 signals: ${results[0].rPer100Signals.toFixed(2)}
📈 Win rate: ${(results[0].winRate * 100).toFixed(1)}% (${results[0].wins}/${results[0].entered})
🎯 Confirm rate: ${(results[0].confirmRate * 100).toFixed(1)}% (${results[0].entered}/${results[0].watchCreated})
      `.trim() : 'No results'
    });
  } catch (e) {
    console.error('[api/delayed-entry/compare-score-configs-get] Error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// TEMP: Version check - returns immediately, no DB, no imports
app.get('/api/version', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ 
    version: '1.0.2', 
    commit: '125e2da',
    timestamp: Date.now(),
    cors: 'manual-*'
  });
});

// TEMP: Direct test endpoints with manual CORS headers (bypass env issues)
app.get('/api/x-compare', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { compareScoreDelayedConfigs } = await import('./delayedEntryValidation.js');
  const configs = [
    { name: 'Config A (Score≥2, 0.25%)', minScore: 2, confirmMovePct: 0.25 },
    { name: 'Config B (Score≥3, 0.30%)', minScore: 3, confirmMovePct: 0.30 },
    { name: 'Config C (Score≥2, 0.30%)', minScore: 2, confirmMovePct: 0.30 },
  ];
  const results = await compareScoreDelayedConfigs(configs, 200);
  res.json({ ok: true, results, winner: results[0]?.configName });
});

// TEMP: Check recent signals including delayed entry status
app.get('/api/x-signals', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  const signals = await d.prepare(`
    SELECT s.id, s.symbol, s.category, s.time, s.run_id,
           der.status as delayed_status, der.watch_created_at, der.confirmed_price
    FROM signals s
    LEFT JOIN delayed_entry_records der ON der.signal_id = s.id
    ORDER BY s.created_at DESC LIMIT 10
  `).all();
  res.json({ ok: true, signals, count: signals.length });
});

// TEMP: Latest signals check (no DB join)
app.get('/api/latest-check', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  
  // Get last 20 signals of any category
  const signals = await d.prepare(`
    SELECT id, symbol, category, price, time, created_at
    FROM signals
    ORDER BY created_at DESC
    LIMIT 20
  `).all();
  
  // Get last scan
  const scan = await d.prepare(`
    SELECT run_id, started_at, finished_at, status, signals_by_category
    FROM scan_runs
    ORDER BY started_at DESC
    LIMIT 1
  `).get();
  
  res.json({ 
    ok: true, 
    signals: signals.map(s => ({...s, timeFormatted: new Date(Number(s.time)).toISOString()})),
    scan,
    serverTime: Date.now()
  });
});

// TEMP: Check delayed entry watches
app.get('/api/watch-list', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  const rows = await d.prepare(`
    SELECT 
      s.id, s.symbol, s.category, s.price, s.time,
      der.status, der.reference_price, der.watch_created_at, der.watch_expires_at
    FROM signals s
    LEFT JOIN delayed_entry_records der ON der.signal_id = s.id
    WHERE der.status = 'WATCH' 
       OR (der.status IS NULL AND s.category IN ('READY_TO_BUY', 'READY_TO_SELL', 'BEST_ENTRY', 'BEST_SHORT_ENTRY'))
    ORDER BY s.time DESC
    LIMIT 20
  `).all();
  res.json({ ok: true, watches: rows, count: rows.length });
});

// TEMP: Simple version endpoint that works
app.get('/api/v', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ v: '1', t: Date.now() });
});

// TEMP: Debug why signals aren't being recorded
app.get('/api/debug/why-no-signals', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  
  // Recent scan runs - use portable columns
  const scans = await d.prepare(`
    SELECT run_id, started_at, finished_at, status
    FROM scan_runs
    ORDER BY started_at DESC
    LIMIT 3
  `).all();
  
  // Recent signals
  const signals = await d.prepare(`
    SELECT id, symbol, category, created_at
    FROM signals
    ORDER BY created_at DESC
    LIMIT 5
  `).all();
  
  // Count
  const counts = await d.prepare(`
    SELECT COUNT(*) as total,
           MAX(created_at) as latest
    FROM signals
  `).get();
  
  res.json({
    ok: true,
    scans,
    signals,
    counts,
    now: Date.now()
  });
});

// TEMP: Kill stuck scan
app.post('/api/debug/kill-stuck-scan', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  
  // Find stuck scans (running for > 10 minutes)
  const stuck = await d.prepare(`
    SELECT id, run_id, started_at, instance_id
    FROM scan_runs
    WHERE status = 'RUNNING'
      AND started_at < ${Date.now() - 10*60*1000}
    ORDER BY started_at DESC
  `).all();
  
  let fixed = 0;
  for (const scan of stuck) {
    await d.prepare(`
      UPDATE scan_runs
      SET status = 'FAILED',
          finished_at = ${Date.now()},
          error_message = 'Killed: stuck scan'
      WHERE id = ${scan.id}
    `).run();
    fixed++;
  }
  
  res.json({ ok: true, killed: fixed, stuckScans: stuck });
});

// TEMP: See blocked signals with reasons
app.get('/api/expired-signals', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  
  try {
    // Recent signals with blocked reasons
    const recent = await d.prepare(`
      SELECT id, symbol, category, time, blocked_reasons_json, first_failed_gate
      FROM signals
      ORDER BY created_at DESC
      LIMIT 20
    `).all();
    
    // Parse blocked reasons
    const withReasons = recent.map(r => {
      let reasons = [];
      try {
        if (r.blocked_reasons_json) {
          reasons = JSON.parse(r.blocked_reasons_json);
        }
      } catch {}
      return {
        symbol: r.symbol,
        category: r.category,
        blocked: reasons.length > 0 ? 'YES' : 'NO',
        reasons: reasons.join(', '),
        firstFailed: r.first_failed_gate
      };
    });
    
    res.json({
      ok: true,
      recent: withReasons
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// TEMP: Fix outcome status for ALL mismatched signals
app.post('/api/debug/fix-all-status', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  
  // Find ALL signals with managed PnL data to check for mismatches
  const signals = await d.prepare(`
    SELECT id, signal_id, symbol, status, ext24_runner_exit_reason, ext24_managed_r, completed_at
    FROM extended_outcomes
    WHERE ext24_runner_exit_reason IS NOT NULL
  `).all();
  
  let fixed = 0;
  const updates = [];
  
  for (const sig of signals) {
    const now = Date.now();
    
    // Determine correct status based on runner exit
    let expectedStatus = sig.status;
    if (sig.ext24_runner_exit_reason === 'TP2') {
      expectedStatus = 'WIN_TP2';
    } else if (sig.ext24_runner_exit_reason === 'BREAK_EVEN') {
      expectedStatus = 'WIN_TP1'; // TP1 hit, then BE = WIN
    } else if (sig.ext24_runner_exit_reason === 'STOP_BEFORE_TP1') {
      expectedStatus = 'LOSS_STOP';
    } else if (sig.ext24_runner_exit_reason === 'TIMEOUT_MARKET') {
      expectedStatus = 'FLAT_TIMEOUT_24H';
    }
    
    // Fix if status is wrong or not completed
    if (expectedStatus !== sig.status || !sig.completed_at) {
      await d.prepare(`
        UPDATE extended_outcomes SET
          status = @status,
          completed_at = @now,
          updated_at = @now
        WHERE id = @id
      `).run({
        status: expectedStatus,
        now: now,
        id: sig.id
      });
      fixed++;
      updates.push({
        symbol: sig.symbol,
        oldStatus: sig.status,
        newStatus: expectedStatus,
        runnerExit: sig.ext24_runner_exit_reason,
        managedR: sig.ext24_managed_r
      });
    }
  }
  
  res.json({ ok: true, fixed, totalChecked: signals.length, updates });
});

// TEMP: Fix managed PnL values for WIN_TP2 signals
app.post('/api/debug/fix-managed-pnl', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  
  // Find all WIN_TP2 signals with incorrect managedR
  const signals = await d.prepare(`
    SELECT id, signal_id, symbol, status, tp2_at, first_tp1_at
    FROM extended_outcomes
    WHERE status = 'WIN_TP2'
      AND (ext24_managed_r IS NULL OR ext24_managed_r < 1.0)
  `).all();
  
  let fixed = 0;
  const riskUsd = 15; // Default risk
  
  for (const sig of signals) {
    const pnlUsd = 1.5 * riskUsd;
    const now = Date.now();
    await d.prepare(`
      UPDATE extended_outcomes SET
        ext24_managed_status = @status,
        ext24_managed_r = @managedR,
        ext24_managed_pnl_usd = @pnlUsd,
        ext24_realized_r = @realizedR,
        ext24_runner_exit_reason = @exitReason,
        ext24_runner_be_at = NULL,
        updated_at = @now
      WHERE id = @id
    `).run({
      status: 'CLOSED_TP2',
      managedR: 1.5,
      pnlUsd: pnlUsd,
      realizedR: 1.5,
      exitReason: 'TP2',
      now: now,
      id: sig.id
    });
    fixed++;
  }
  
  res.json({ ok: true, fixed, signals: signals.map(s => ({ symbol: s.symbol, id: s.id })) });
});

/**
 * Debug endpoint: Backfill NO_TRADE status for signals that never confirmed
 * Finds signals with EXPIRED_NO_ENTRY delayed entry status that are currently marked as LOSS_STOP
 * and updates them to NO_TRADE (0R instead of -1R)
 */
app.post('/api/debug/backfill-no-trade', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  const body = req.body || {};
  // Force boolean - handle both boolean false and string "false"
  const dryRun = body.dryRun === false || body.dryRun === 'false' ? false : (body.dryRun !== undefined ? body.dryRun : true);
  
  console.log(`[debug/backfill-no-trade] dryRun=${dryRun}, original=`, body.dryRun, 'type=', typeof body.dryRun);
  
  try {
    // Find all delayed entry records that expired without confirmation
    // OR are still in WATCH but have LOSS_STOP outcomes (never confirmed but marked as loss)
    const expiredRecords = await d.prepare(`
      SELECT 
        der.signal_id,
        der.symbol,
        der.status as delayed_status,
        der.confirmed_at,
        eo.id as outcome_id,
        eo.status as outcome_status,
        eo.ext24_managed_r
      FROM delayed_entry_records der
      JOIN extended_outcomes eo ON eo.signal_id = der.signal_id
      WHERE (
        der.status IN ('EXPIRED_NO_ENTRY', 'CANCELLED')
        OR (der.status = 'WATCH' AND der.confirmed_at IS NULL AND eo.status = 'LOSS_STOP')
      )
        AND eo.status != 'NO_TRADE'
    `).all();
    
    console.log(`[debug/backfill-no-trade] Found ${expiredRecords.length} signals that never confirmed`);
    
    let updated = 0;
    const updates = [];
    
    for (const record of expiredRecords) {
      const { signal_id, symbol, delayed_status, confirmed_at, outcome_id, outcome_status, ext24_managed_r } = record;
      
      updates.push({
        signalId: signal_id,
        symbol,
        delayedStatus: delayed_status,
        confirmedAt: confirmed_at,
        oldOutcomeStatus: outcome_status,
        oldManagedR: ext24_managed_r,
        newOutcomeStatus: 'NO_TRADE',
        newManagedR: 0
      });
      
      if (!dryRun) {
        try {
          // Update extended outcome to NO_TRADE
          await d.prepare(`
            UPDATE extended_outcomes SET
              status = 'NO_TRADE',
              ext24_managed_status = 'NO_TRADE',
              ext24_managed_r = 0,
              ext24_managed_pnl_usd = 0,
              ext24_realized_r = 0,
              ext24_runner_exit_reason = NULL,
              updated_at = ?
            WHERE id = ?
          `).run(Date.now(), outcome_id);
          
          // Also update signal_outcomes if exists
          await d.prepare(`
            UPDATE signal_outcomes 
            SET outcome = 'NO_TRADE', updated_at = ?
            WHERE signal_id = ?
          `).run(new Date().toISOString(), signal_id);
          
          updated++;
        } catch (updateError) {
          console.error(`[debug/backfill-no-trade] Error updating signal ${signal_id}:`, updateError);
        }
      }
    }
    
    res.json({ 
      ok: true, 
      dryRun,
      found: expiredRecords.length,
      updated,
      updates: updates.slice(0, 20) // Return first 20 for inspection
    });
    
  } catch (error) {
    console.error('[debug/backfill-no-trade] Error:', error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

/**
 * Debug endpoint: Check delayed entry stats
 */
app.get('/api/debug/delayed-entry-stats', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const d = getDb();
  
  try {
    // Count by status
    const statusCounts = await d.prepare(`
      SELECT status, COUNT(*) as count 
      FROM delayed_entry_records 
      GROUP BY status
    `).all();
    
    // Get recent records
    const recent = await d.prepare(`
      SELECT 
        signal_id,
        symbol,
        status,
        watch_started_at,
        watch_expires_at,
        confirmed_at
      FROM delayed_entry_records
      ORDER BY watch_started_at DESC
      LIMIT 20
    `).all();
    
    // Check for signals with LOSS_STOP that have delayed entry records
    const lossWithDelayed = await d.prepare(`
      SELECT 
        eo.signal_id,
        eo.symbol,
        eo.status as outcome_status,
        der.status as delayed_status
      FROM extended_outcomes eo
      JOIN delayed_entry_records der ON der.signal_id = eo.signal_id
      WHERE eo.status = 'LOSS_STOP'
      LIMIT 10
    `).all();
    
    res.json({
      ok: true,
      statusCounts,
      recentRecords: recent,
      lossWithDelayed: lossWithDelayed
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

/**
 * Debug endpoint: Re-evaluate specific signal with NO_TRADE check
 */
app.post('/api/debug/reevaluate-signal', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { signalId } = req.body || {};
  
  if (!signalId) {
    return res.status(400).json({ ok: false, error: 'signalId required' });
  }
  
  try {
    const d = getDb();
    
    // Get signal details
    const signal = await d.prepare(`
      SELECT * FROM signals WHERE id = ?
    `).get(signalId) as any;
    
    if (!signal) {
      return res.status(404).json({ ok: false, error: 'Signal not found' });
    }
    
    // Get delayed entry record
    const { getDelayedEntryRecordBySignalId } = await import('./delayedEntry.js');
    const delayedRecord = await getDelayedEntryRecordBySignalId(Number(signalId));
    
    // Get current outcome
    const currentOutcome = await d.prepare(`
      SELECT * FROM extended_outcomes WHERE signal_id = ?
    `).get(signalId);
    
    // Force re-evaluation by clearing completed_at temporarily
    await d.prepare(`
      UPDATE extended_outcomes 
      SET completed_at = NULL, status = 'PENDING'
      WHERE signal_id = ?
    `).run(signalId);
    
    // Re-evaluate
    const { evaluateAndUpdateExtendedOutcome } = await import('./extendedOutcomeStore.js');
    
    const result = await evaluateAndUpdateExtendedOutcome({
      signalId: Number(signalId),
      symbol: signal.symbol,
      category: signal.category,
      direction: signal.category.includes('SHORT') ? 'SHORT' : 'LONG',
      signalTime: signal.time,
      entryPrice: signal.price,
      stopPrice: signal.stop_price,
      tp1Price: signal.tp1_price,
      tp2Price: signal.tp2_price,
    });
    
    res.json({
      ok: true,
      signalId,
      symbol: signal.symbol,
      delayedEntryStatus: delayedRecord?.status || 'NO_RECORD',
      previousStatus: currentOutcome?.status,
      newStatus: result.status,
      newManagedR: result.managedPnl.managedR,
      completed: result.completed
    });
    
  } catch (error) {
    console.error('[debug/reevaluate-signal] Error:', error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

export { app };
