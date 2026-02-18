import { topUSDTByQuoteVolume, listAllUSDTMarkets, klines } from './binance.js';
import { tryStartScanRun, finishScanRun, failScanRun, pruneScanRuns } from './scanStore.js';
import { upsertCandidateFeatures, pruneCandidateFeatures } from './candidateFeaturesStore.js';
import { analyzeSymbolDetailed } from './logic.js';
import { atrPct, ema, rsi } from './indicators.js';
import { pushToAll } from './notifier.js';
import { emailNotify } from './emailNotifier.js';
import { buildConfigSnapshot, computeConfigHash } from './configSnapshot.js';
import type { MarketInfo, OHLCV } from './types.js';

// Configuration
const TOP_N = parseInt(process.env.TOP_N || '300', 10);
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const SYMBOL_DELAY_MS = parseInt(process.env.SYMBOL_DELAY_MS || '120', 10);
const MAX_SCAN_MS = parseInt(process.env.MAX_SCAN_MS || String(4 * 60_000), 10);
const BACKOFF_STEP_MS = parseInt(process.env.BACKOFF_STEP_MS || '200', 10);
const BACKOFF_MAX_MS = parseInt(process.env.BACKOFF_MAX_MS || '2000', 10);
const CLOCK_SKEW_MS = Math.max(0, parseInt(process.env.CLOCK_SKEW_MS || '1500', 10) || 0);
const INCLUDE_NON_TOP = (process.env.INCLUDE_NON_TOP ?? 'true').toLowerCase() !== 'false';
const EXTRA_USDT_COUNT = parseInt(process.env.EXTRA_USDT_COUNT || '200', 10);

// ---- Liquidity / quality guardrails ---------------------------------
const MIN_QUOTE_USDT = parseFloat(process.env.MIN_QUOTE_USDT || '20000000'); // 20M
const MIN_PRICE_USDT = parseFloat(process.env.MIN_PRICE_USDT || '0.00001');   // $0.00001
const STABLE_BASES = new Set(['USDT','USDC','BUSD','FDUSD','TUSD','DAI','USDD','USDJ']);
const LEVERAGED_SUFFIXES = /(UP|DOWN|BULL|BEAR)USDT$/i;
const PRECHECK_ATR_MIN_PCT = parseFloat(process.env.PRECHECK_ATR_MIN_PCT || process.env.MIN_ATR_PCT_PRECHECK || '0.05');
const PRECHECK_ATR_MAX_PCT = parseFloat(process.env.PRECHECK_ATR_MAX_PCT || '');
const RSI_PRECHECK_MIN = parseFloat(process.env.RSI_PRECHECK_MIN || '45');
const RSI_PRECHECK_MAX = parseFloat(process.env.RSI_PRECHECK_MAX || '85');
const PRECHECK_VWAP_MAX_PCT = parseFloat(process.env.PRECHECK_VWAP_MAX_PCT || '1.5');
const PRECHECK_EMA_SOFT_PCT = parseFloat(process.env.PRECHECK_EMA_SOFT_PCT || '5.0');
const PRECHECK_EMA_SOFT_ENABLED = (process.env.PRECHECK_EMA_SOFT_ENABLED ?? 'false').toLowerCase() === 'true';
const PRECHECK_DEBUG_LOG = (process.env.PRECHECK_DEBUG_LOG ?? 'true').toLowerCase() !== 'false';
const PRECHECK_DEBUG_LOG_MAX = Math.max(0, parseInt(process.env.PRECHECK_DEBUG_LOG_MAX || '40', 10) || 40);
const GATE_TRACE_LOG_MAX = Math.max(0, parseInt(process.env.GATE_TRACE_LOG_MAX || '0', 10) || 0);

function isStableVsStable(sym: string): boolean {
  if (!sym.endsWith('USDT')) return false;
  const base = sym.slice(0, -4);
  return STABLE_BASES.has(base.toUpperCase());
}
// ---------------------------------------------------------------------

export type Preset = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
export function thresholdsForPreset(preset: Preset) {
  switch (preset) {
    case 'CONSERVATIVE': return { vwapDistancePct: 0.20, volSpikeX: 2.0, atrGuardPct: 1.8 };
    case 'AGGRESSIVE':   return { vwapDistancePct: 1.00, volSpikeX: 1.0, atrGuardPct: 4.0 };
    case 'BALANCED':
    default:             return { vwapDistancePct: 0.30, volSpikeX: 1.5, atrGuardPct: 2.5 };
  }
}

type GateFailures = {
  failed_btc_gate: number;
  failed_confirm15: number;
  failed_trend: number;
  failed_near_vwap: number;
  failed_volSpike: number;
  failed_atr: number;
  failed_sweep: number;
  failed_rr: number;
};

type ReadyGateFailures = GateFailures & {
  ready_core_evaluated: number;
  ready_core_true: number;
  ready_core_first_failed: Record<string, number>;
  ready_core_flag_true: Record<string, number>;
  ready_sweep_path_taken: number;
  ready_no_sweep_path_taken: number;
  ready_fallback_eligible: number;
  ready_sweep_true: number;
  ready_shadow_if_reclaim_relaxed: number;
  ready_shadow_if_volSpike_1_2: number;
  ready_confirm15_strict_true: number;
  ready_priceAboveVwap_relaxed_eligible: number;
  ready_priceAboveVwap_relaxed_true: number;
};

type ReadyShortGateFailures = GateFailures & {
  ready_core_evaluated: number;
  ready_core_true: number;
  ready_core_first_failed: Record<string, number>;
  ready_core_flag_true: Record<string, number>;
  ready_confirm15_strict_true: number;
};

type Confirm15Stats = {
  pass_strict: number;
  pass_soft: number;
  fail_len: number;
  fail_vwap: number;
  fail_ema: number;
  fail_rsi: number;
  fail_other: number;
};

type CandidateStats = {
  candidate_evaluated: number;
  candidate_skipped: number;
  candidate_skip_reason: Record<string, number>;
  watch_created: number;
  early_created: number;
  watch_first_failed: Record<string, number>;
  early_first_failed: Record<string, number>;
  watch_flag_true: Record<string, number>;
  early_flag_true: Record<string, number>;
};

type PrecheckStats = {
  skip_stable: number;
  skip_leveraged: number;
  fail_5m_candles: number;
  fail_last_candle: number;
  fail_min_price: number;
  fail_atr_rsi: number;
  fail_atr_pct: number;
  fail_rsi_range: number;
  fail_ema: number;
  fail_vwap: number;
  fail_ema_soft: number;
  fail_near_vwap_pre: number;
  fail_15m_candles: number;
};

type ScanGateStats = {
  readyCandidates: number;
  bestCandidates: number;
  ready: ReadyGateFailures;
  best: GateFailures;
  readyShort: ReadyShortGateFailures;
  bestShort: GateFailures;
  candidate: CandidateStats;
  precheck: PrecheckStats;
  confirm15: Confirm15Stats;
  confirm15Short: Confirm15Stats;
};

type ScanHealth = {
  preset: Preset;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  processedSymbols: number;
  precheckPassed: number;
  fetchedOk: number;
  errors429: number;
  errorsOther: number;
  signalsByCategory: Record<string, number>;
  gateStats: ScanGateStats;
  error?: string;
};

let lastScanHealth: ScanHealth | null = null;
let currentScan: { runId: string; preset: string; configHash: string; instanceId: string; startedAt: number } | null = null;
let lastSymbols: string[] | null = null;
const INSTANCE_ID = String(
  process.env.INSTANCE_ID ||
  process.env.RAILWAY_REPLICA_ID ||
  process.env.HOSTNAME ||
  'unknown'
).trim() || 'unknown';
export function getLastScanHealth() {
  return lastScanHealth;
}

export function getCurrentScan() {
  return currentScan;
}

export function getScanIntervalMs() {
  return SCAN_INTERVAL_MS;
}

export function getMaxScanMs() {
  return MAX_SCAN_MS;
}

function initGateFailures(): GateFailures {
  return {
    failed_btc_gate: 0,
    failed_confirm15: 0,
    failed_trend: 0,
    failed_near_vwap: 0,
    failed_volSpike: 0,
    failed_atr: 0,
    failed_sweep: 0,
    failed_rr: 0,
  };
}

function initReadyGateFailures(): ReadyGateFailures {
  return {
    ...initGateFailures(),
    ready_core_evaluated: 0,
    ready_core_true: 0,
    ready_core_first_failed: {},
    ready_core_flag_true: {},
    ready_sweep_path_taken: 0,
    ready_no_sweep_path_taken: 0,
    ready_fallback_eligible: 0,
    ready_sweep_true: 0,
    ready_shadow_if_reclaim_relaxed: 0,
    ready_shadow_if_volSpike_1_2: 0,
    ready_confirm15_strict_true: 0,
    ready_priceAboveVwap_relaxed_eligible: 0,
    ready_priceAboveVwap_relaxed_true: 0,
  };
}

function initReadyShortGateFailures(): ReadyShortGateFailures {
  return {
    ...initGateFailures(),
    ready_core_evaluated: 0,
    ready_core_true: 0,
    ready_core_first_failed: {},
    ready_core_flag_true: {},
    ready_confirm15_strict_true: 0,
  };
}

function initConfirm15Stats(): Confirm15Stats {
  return {
    pass_strict: 0,
    pass_soft: 0,
    fail_len: 0,
    fail_vwap: 0,
    fail_ema: 0,
    fail_rsi: 0,
    fail_other: 0,
  };
}

function initPrecheckStats(): PrecheckStats {
  return {
    skip_stable: 0,
    skip_leveraged: 0,
    fail_5m_candles: 0,
    fail_last_candle: 0,
    fail_min_price: 0,
    fail_atr_rsi: 0,
    fail_atr_pct: 0,
    fail_rsi_range: 0,
    fail_ema: 0,
    fail_vwap: 0,
    fail_ema_soft: 0,
    fail_near_vwap_pre: 0,
    fail_15m_candles: 0,
  };
}

function initCandidateStats(): CandidateStats {
  return {
    candidate_evaluated: 0,
    candidate_skipped: 0,
    candidate_skip_reason: {},
    watch_created: 0,
    early_created: 0,
    watch_first_failed: {},
    early_first_failed: {},
    watch_flag_true: {},
    early_flag_true: {},
  };
}

function accumulateSequentialGatePasses(
  order: string[],
  flags: Record<string, boolean>,
  out: Record<string, number>,
): string | undefined {
  const firstFailed = order.find((k) => !flags[k]);
  const stopAt = firstFailed == null ? order.length : order.indexOf(firstFailed);
  for (let i = 0; i < stopAt; i++) {
    const k = order[i];
    out[k] = (out[k] ?? 0) + 1;
  }
  return firstFailed;
}

function initGateStats(): ScanGateStats {
  return {
    readyCandidates: 0,
    bestCandidates: 0,
    ready: initReadyGateFailures(),
    best: initGateFailures(),
    readyShort: initReadyShortGateFailures(),
    bestShort: initGateFailures(),
    candidate: initCandidateStats(),
    precheck: initPrecheckStats(),
    confirm15: initConfirm15Stats(),
    confirm15Short: initConfirm15Stats(),
  };
}

// ---- Push rate limit & batch send -----------------------------------
const lastBucketPushed = new Map<string, number>();
function shouldPushBucket(baseKey: string, bucket: number): boolean {
  const prev = lastBucketPushed.get(baseKey);
  if (prev === bucket) return false;
  lastBucketPushed.set(baseKey, bucket);
  return true;
}
// ---------------------------------------------------------------------

let lastBtcMarket: MarketInfo | null = null;
let lastBtcAt = 0;
export function getLastBtcMarket() {
  return { market: lastBtcMarket, at: lastBtcAt };
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getCandleCloseMs(c: OHLCV, intervalMs: number): number {
  if (Number.isFinite(c.closeTime)) return c.closeTime as number;
  if (Number.isFinite(c.openTime)) return (c.openTime as number) + intervalMs;
  if (Number.isFinite(c.time)) return c.time;
  return 0;
}

function sliceToLastClosed(data: OHLCV[], intervalMs: number, now = Date.now()): OHLCV[] {
  if (data.length < 3) return data;
  const last = data[data.length - 1];
  const close = getCandleCloseMs(last, intervalMs);
  // Safe: CLOCK_SKEW_MS acts as "close buffer" (delay acceptance), never early acceptance.
  if (close > 0 && now < close + CLOCK_SKEW_MS) return data.slice(0, -1);
  return data;
}

/** Detect gaps in candle data (missing intervals) */
function detectGaps(data: OHLCV[], intervalMs: number, symbol: string, label: string): { gaps: number; maxGapMs: number; firstGapTime: string | null } {
  if (data.length < 2) return { gaps: 0, maxGapMs: 0, firstGapTime: null };
  let gaps = 0;
  let maxGapMs = 0;
  let firstGapTime: string | null = null;
  for (let i = 1; i < data.length; i++) {
    const prevClose = getCandleCloseMs(data[i - 1], intervalMs);
    const currOpen = Number(data[i].openTime) || (Number(data[i].time) - intervalMs);
    if (prevClose > 0 && currOpen > 0) {
      const gap = currOpen - prevClose;
      // Allow small tolerance (1s) for exchange timing variations
      if (gap > intervalMs + 1000) {
        gaps++;
        maxGapMs = Math.max(maxGapMs, gap);
        if (!firstGapTime) {
          firstGapTime = new Date(prevClose).toISOString();
        }
      }
    }
  }
  if (gaps > 0) {
    const gapCandles = Math.round(maxGapMs / intervalMs);
    console.warn(`[gap] ${symbol} ${label} gaps=${gaps} maxGap=${gapCandles}candles at ${firstGapTime}`);
  }
  return { gaps, maxGapMs, firstGapTime };
}

let lastVwapDayFlipLogScanner = 0;
const VWAP_DAY_FLIP_LOG_COOLDOWN_MS = 60_000; // Log at most once per minute

function dayAnchorIndexAt(data: OHLCV[], j: number, fallbackBars: number, symbol?: string): number {
  if (j <= 0) return 0;
  const hasTime = data[j].time != null || data[j].openTime != null;
  if (!hasTime) return Math.max(0, j - fallbackBars + 1);
  const getMs = (d: OHLCV) => (d.openTime ?? d.time ?? 0);
  const dateKey = (ms: number) => {
    const dt = new Date(ms);
    return dt.getUTCFullYear() * 10_000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
  };
  const toDateStr = (key: number) => {
    const year = Math.floor(key / 10_000);
    const month = Math.floor((key % 10_000) / 100);
    const day = key % 100;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  const endKey = dateKey(getMs(data[j]));
  let anchor = j;
  while (anchor > 0) {
    const prevKey = dateKey(getMs(data[anchor - 1]));
    if (prevKey !== endKey) {
      // Day boundary detected - log with cooldown to avoid spam
      const now = Date.now();
      if (symbol && now - lastVwapDayFlipLogScanner > VWAP_DAY_FLIP_LOG_COOLDOWN_MS) {
        lastVwapDayFlipLogScanner = now;
        console.log(`[vwap] day flip ${symbol} ${toDateStr(prevKey)} → ${toDateStr(endKey)} anchor=${anchor} barsIntoDay=${j - anchor}`);
      }
      break;
    }
    anchor--;
  }
  return anchor;
}

function buildCum(tp: number[], vol: number[]) {
  const cumPV: number[] = [];
  const cumV: number[] = [];
  for (let i = 0; i < tp.length; i++) {
    const pv = tp[i] * vol[i];
    cumPV[i] = (i ? cumPV[i - 1] : 0) + pv;
    cumV[i] = (i ? cumV[i - 1] : 0) + vol[i];
  }
  return { cumPV, cumV };
}

function anchoredVwapAt(cumPV: number[], cumV: number[], start: number, j: number): number {
  if (j < 0) return NaN;
  const s = Math.min(start, j);
  const num = cumPV[j] - (s > 0 ? cumPV[s - 1] : 0);
  const den = cumV[j] - (s > 0 ? cumV[s - 1] : 0);
  return den ? num / den : NaN;
}

function computeBtcMarket(data15: OHLCV[]): MarketInfo | null {
  if (data15.length < 210) return null;
  const closes = data15.map(d => d.close);
  const vols = data15.map(d => d.volume);
  const tp = data15.map(d => (d.high + d.low + d.close) / 3);
  const { cumPV, cumV } = buildCum(tp, vols);
  const e = ema(closes, 200);
  const r = rsi(closes, 9);
  const i = closes.length - 1;
  if (i < 2) return null;
  const anchor = dayAnchorIndexAt(data15, i, 96, 'BTCUSDT');
  const vwap = anchoredVwapAt(cumPV, cumV, anchor, i);
  const close = closes[i];
  const emaNow = e[i];
  const rsiNow = r[i];
  const rsiPrev = r[i - 1];
  if (!Number.isFinite(vwap) || vwap <= 0) return null;
  if (!Number.isFinite(emaNow) || emaNow <= 0) return null;
  if (!Number.isFinite(close) || !Number.isFinite(rsiNow)) return null;

  const btcBull15m = close > vwap && close > emaNow && rsiNow >= rsiPrev;
  const btcBear15m = close < vwap && (close < emaNow || rsiNow < rsiPrev);
  const btcDeltaVwapPct15m = ((close - vwap) / vwap) * 100;

  return {
    btcBull15m,
    btcBear15m,
    btcClose15m: close,
    btcVwap15m: vwap,
    btcEma200_15m: emaNow,
    btcRsi9_15m: rsiNow,
    btcDeltaVwapPct15m,
  };
}

export async function scanOnce(preset: Preset = 'BALANCED') {
  const t0 = Date.now();
  const thresholds = thresholdsForPreset(preset);
  const runConfigSnapshot = buildConfigSnapshot({
    preset,
    thresholds: {
      vwapDistancePct: thresholds.vwapDistancePct,
      volSpikeX: thresholds.volSpikeX,
      atrGuardPct: thresholds.atrGuardPct,
    },
  });
  const runConfigHash = computeConfigHash(runConfigSnapshot);
  const now = Date.now();
  const scanRun = await tryStartScanRun(preset, MAX_SCAN_MS, {
    configHash: runConfigHash,
    instanceId: INSTANCE_ID,
  });
  if (!scanRun) {
    console.log('[scan] skip: another scan is already running');
    return [];
  }
  currentScan = scanRun;

  // Log scan start with time sync info (symbols count logged after fetch)
  const last5mClose = new Date(now - (now % (5 * 60_000)) - 1).toISOString();
  const last15mClose = new Date(now - (now % (15 * 60_000)) - 1).toISOString();
  console.log(`[scan] start runId=${scanRun.runId} now=${new Date(now).toISOString()} 5mLastClose=${last5mClose} 15mLastClose=${last15mClose}`);

  const signalsByCategory: Record<string, number> = {
    WATCH: 0,
    EARLY_READY: 0,
    READY_TO_BUY: 0,
    BEST_ENTRY: 0,
    EARLY_READY_SHORT: 0,
    READY_TO_SELL: 0,
    BEST_SHORT_ENTRY: 0,
  };
  const gateStats = initGateStats();
  const precheck = gateStats.precheck;
  let processed = 0;
  let precheckPassed = 0;
  let fetchedOk = 0;
  let err429 = 0;
  let errOther = 0;
  let errorMessage: string | null = null;

  let symbols: string[] = [];
  try {
    symbols = await topUSDTByQuoteVolume(MIN_QUOTE_USDT, TOP_N);
    if (INCLUDE_NON_TOP && EXTRA_USDT_COUNT > 0) {
      const all = await listAllUSDTMarkets();
      const topSet = new Set(symbols);
      const extras = shuffle(all.filter(s => !topSet.has(s))).slice(0, EXTRA_USDT_COUNT);
      symbols = symbols.concat(extras);
    }
    if (symbols.length) lastSymbols = symbols;
  } catch (e) {
    const msg = String((e as any)?.message || e);
    console.error('[scan] top symbols failed:', msg);
    if (lastSymbols?.length) {
      console.warn('[scan] using cached symbols list after fetch failure');
      symbols = lastSymbols;
    } else {
      errorMessage = `top symbols failed: ${msg}`;
      errOther += 1;
    }
  }
  console.log(`[scan] symbols=${symbols.length}`);

  const outs: any[] = [];
  const toNotify: Array<{ sym: string; title: string; body: string; sig: any; dedupeKey: string; }> = [];

  let market: MarketInfo | null = null;
  try {
    let btc15 = await klines('BTCUSDT', '15m', 260);
    btc15 = sliceToLastClosed(btc15, 15 * 60_000, now);
    market = computeBtcMarket(btc15);
    if (market) {
      lastBtcMarket = market;
      lastBtcAt = Date.now();
    }
    console.log('[btc]',
      market ? {
        bull: market.btcBull15m,
        bear: market.btcBear15m,
        dvwap: Number.isFinite(market.btcDeltaVwapPct15m) ? market.btcDeltaVwapPct15m.toFixed(2) : '-',
        rsi: Number.isFinite(market.btcRsi9_15m) ? market.btcRsi9_15m.toFixed(1) : '-',
      } : 'market=null'
    );
  } catch (e) {
    console.warn('[scan] btc regime fetch failed:', e);
  }

  let adaptiveDelayMs = SYMBOL_DELAY_MS;
  let no429Streak = 0;
  let precheckAtrLogCount = 0;
  let precheckEmaSoftLogCount = 0;
  let gateTraceLogCount = 0;
  const shouldAbort = Boolean(errorMessage && symbols.length === 0);
  for (const sym of (shouldAbort ? [] : symbols)) {
    if (isStableVsStable(sym)) { precheck.skip_stable += 1; continue; }
    if (LEVERAGED_SUFFIXES.test(sym)) { precheck.skip_leveraged += 1; continue; }

    if (Date.now() - t0 > MAX_SCAN_MS) {
      console.warn(`[scan] max duration reached (${MAX_SCAN_MS}ms), stopping early`);
      break;
    }

    processed++;

    try {
      let d5 = await klines(sym, '5m', 300);
      d5 = sliceToLastClosed(d5, 5 * 60_000, now);
      detectGaps(d5, 5 * 60_000, sym, '5m');
      if (d5.length < 210) { precheck.fail_5m_candles += 1; continue; }

      const last5 = d5[d5.length - 1];
      if (!last5 || !Number.isFinite(last5.close) || !Number.isFinite(last5.high) || !Number.isFinite(last5.low) || !Number.isFinite(last5.volume)) {
        precheck.fail_last_candle += 1;
        continue;
      }
      if (last5.close < MIN_PRICE_USDT) { precheck.fail_min_price += 1; continue; }

      const closes5 = d5.map(d => d.close);
      const highs5 = d5.map(d => d.high);
      const lows5 = d5.map(d => d.low);
      const atr5 = atrPct(highs5, lows5, closes5, 14);
      const rsi5 = rsi(closes5, 9);
      const i5 = closes5.length - 1;
      const atrNow = atr5[i5];
      const rsiNow = rsi5[i5];

      if (!Number.isFinite(atrNow) || !Number.isFinite(rsiNow)) { precheck.fail_atr_rsi += 1; continue; }
      const atrTooLow = Number.isFinite(PRECHECK_ATR_MIN_PCT) && atrNow < PRECHECK_ATR_MIN_PCT;
      const atrTooHigh = Number.isFinite(PRECHECK_ATR_MAX_PCT) && atrNow > PRECHECK_ATR_MAX_PCT;
      if (atrTooLow || atrTooHigh) {
        precheck.fail_atr_pct += 1;
        if (PRECHECK_DEBUG_LOG && precheckAtrLogCount < PRECHECK_DEBUG_LOG_MAX) {
          precheckAtrLogCount += 1;
          console.log(
            `[precheck][atr_pct] ${sym} atrPct=${atrNow.toFixed(4)} ` +
            `min=${Number.isFinite(PRECHECK_ATR_MIN_PCT) ? PRECHECK_ATR_MIN_PCT.toFixed(4) : 'n/a'} ` +
            `max=${Number.isFinite(PRECHECK_ATR_MAX_PCT) ? PRECHECK_ATR_MAX_PCT.toFixed(4) : 'n/a'} ` +
            `failed=${atrTooLow ? 'LOW' : 'HIGH'}`
          );
        }
        continue;
      }
      if (rsiNow < RSI_PRECHECK_MIN || rsiNow > RSI_PRECHECK_MAX) { precheck.fail_rsi_range += 1; continue; }

      // 5m prefilter: only pull 15m if price is near VWAP/EMA200 window
      const ema200_5 = ema(closes5, 200);
      const emaNow = ema200_5[i5];
      if (!Number.isFinite(emaNow) || emaNow <= 0) { precheck.fail_ema += 1; continue; }
      const emaDistPct = ((last5.close - emaNow) / emaNow) * 100;
      const emaSoftWouldFail = emaDistPct < -PRECHECK_EMA_SOFT_PCT;
      const emaSoftOk = !emaSoftWouldFail;

      const vols5 = d5.map(d => d.volume);
      const tp5 = d5.map(d => (d.high + d.low + d.close) / 3);
      const { cumPV, cumV } = buildCum(tp5, vols5);
      const a0 = dayAnchorIndexAt(d5, i5, 288, sym);
      const vwap5 = anchoredVwapAt(cumPV, cumV, a0, i5);
      if (!Number.isFinite(vwap5) || vwap5 <= 0) { precheck.fail_vwap += 1; continue; }
      const distToVwapPct = ((last5.close - vwap5) / vwap5) * 100;
      const nearVwapPre = Math.abs(distToVwapPct) <= Math.max(thresholds.vwapDistancePct, PRECHECK_VWAP_MAX_PCT);

      if (!emaSoftOk) {
        if (PRECHECK_DEBUG_LOG && precheckEmaSoftLogCount < PRECHECK_DEBUG_LOG_MAX) {
          precheckEmaSoftLogCount += 1;
          console.log(
            `[precheck][ema_soft] ${sym} side=${emaDistPct < 0 ? 'BELOW_EMA' : 'ABOVE_EMA'} ` +
            `close=${last5.close.toFixed(6)} ema=${emaNow.toFixed(6)} ` +
            `distPct=${emaDistPct.toFixed(4)} thresholdPct=${PRECHECK_EMA_SOFT_PCT.toFixed(4)} ` +
            `enforced=${PRECHECK_EMA_SOFT_ENABLED ? 'YES' : 'NO'}`
          );
        }
        if (PRECHECK_EMA_SOFT_ENABLED) {
          precheck.fail_ema_soft += 1;
          continue;
        }
      }
      if (!nearVwapPre) { precheck.fail_near_vwap_pre += 1; continue; }
      precheckPassed++;

      let d15 = await klines(sym, '15m', 260);
      d15 = sliceToLastClosed(d15, 15 * 60_000, now);
      detectGaps(d15, 15 * 60_000, sym, '15m');
      if (d15.length < 210) { precheck.fail_15m_candles += 1; continue; }
      fetchedOk++;

      const res = analyzeSymbolDetailed(sym, d5, d15, thresholds, market ?? undefined);
      if (!res?.debug?.candidate) {
        gateStats.candidate.candidate_skipped += 1;
        gateStats.candidate.candidate_skip_reason.analyze_null =
          (gateStats.candidate.candidate_skip_reason.analyze_null ?? 0) + 1;
        continue;
      }
      if (res?.debug?.candidate) {
        const cand = res.debug.candidate;
        gateStats.candidate.candidate_evaluated += 1;
        if (cand.watchOk) gateStats.candidate.watch_created += 1;
        if (cand.earlyOk) gateStats.candidate.early_created += 1;

        const watchOrder = ['nearVwapWatch', 'rsiWatchOk', 'emaWatchOk'] as const;
        const earlyOrder = [
          'sessionOK',
          'nearVwapWatch',
          'rsiWatchOk',
          'emaWatchOk',
          'atrOkReady',
          'reclaimOrTap',
          'priceAboveVwap',
        ] as const;

        for (const k of watchOrder) {
          if (cand.watchFlags[k]) {
            gateStats.candidate.watch_flag_true[k] =
              (gateStats.candidate.watch_flag_true[k] ?? 0) + 1;
          }
        }
        for (const k of earlyOrder) {
          if (cand.earlyFlags[k]) {
            gateStats.candidate.early_flag_true[k] =
              (gateStats.candidate.early_flag_true[k] ?? 0) + 1;
          }
        }

        if (!cand.watchOk) {
          const firstFailedWatch = watchOrder.find((k) => !cand.watchFlags[k]);
          if (firstFailedWatch) {
            gateStats.candidate.watch_first_failed[firstFailedWatch] =
              (gateStats.candidate.watch_first_failed[firstFailedWatch] ?? 0) + 1;
          }
        }
        if (!cand.earlyOk) {
          const firstFailedEarly = earlyOrder.find((k) => !cand.earlyFlags[k]);
          if (firstFailedEarly) {
            gateStats.candidate.early_first_failed[firstFailedEarly] =
              (gateStats.candidate.early_first_failed[firstFailedEarly] ?? 0) + 1;
          }
        }
      }

      const accumulateConfirm15 = (stats: Confirm15Stats, c15: any) => {
        if (!c15) return;
        if (c15.strict?.ok) {
          stats.pass_strict += 1;
        } else if (c15.soft?.ok) {
          stats.pass_soft += 1;
        } else {
          const reason = c15.soft?.reason || c15.strict?.reason || 'unknown';
          if (reason === 'len' || reason === 'i') stats.fail_len += 1;
          else if (reason === 'vwap') stats.fail_vwap += 1;
          else if (reason === 'ema') stats.fail_ema += 1;
          else if (reason === 'rsi') stats.fail_rsi += 1;
          else stats.fail_other += 1;
        }
      };
      accumulateConfirm15(gateStats.confirm15, res?.debug?.confirm15);
      accumulateConfirm15(gateStats.confirm15Short, res?.debug?.confirm15Short);

      const features = res?.debug?.features;
      if (features) {
        try {
          await upsertCandidateFeatures({
            runId: scanRun.runId,
            symbol: sym,
            preset,
            startedAt: scanRun.startedAt,
            metrics: features.metrics,
            computed: features.computed,
          });
        } catch (e) {
          console.warn('[candidate_features] upsert failed:', e);
        }
      }

      const snap = res?.debug?.gateSnapshot;
      if (snap) {
        const ready = snap.ready;
        const best = snap.best;
        const short = snap.short;
        const bestShort = snap.bestShort;

        gateStats.readyCandidates += 1;
        gateStats.bestCandidates += 1;

        if (!ready.nearVwap) gateStats.ready.failed_near_vwap += 1;
        if (!ready.confirm15) gateStats.ready.failed_confirm15 += 1;
        if (!ready.trend) gateStats.ready.failed_trend += 1;
        if (!ready.volSpike) gateStats.ready.failed_volSpike += 1;
        if (!ready.atr) gateStats.ready.failed_atr += 1;
        if (ready.core && !ready.sweep) gateStats.ready.failed_sweep += 1;
        if (ready.core && ready.sweep && !ready.btc) gateStats.ready.failed_btc_gate += 1;

        gateStats.ready.ready_core_evaluated += 1;
        if (ready.core) gateStats.ready.ready_core_true += 1;
        if (ready.core && ready.sweep) gateStats.ready.ready_sweep_true += 1;
        if (ready.core && !ready.sweep && ready.sweepFallback) gateStats.ready.ready_fallback_eligible += 1;
        if (ready.core && ready.sweep) gateStats.ready.ready_sweep_path_taken += 1;
        if (ready.core && !ready.sweep && ready.sweepFallback) gateStats.ready.ready_no_sweep_path_taken += 1;

        const coreFlags: Record<string, boolean> = {
          sessionOK: Boolean(ready.sessionOk),
          priceAboveVwap: Boolean(ready.priceAboveVwap),
          priceAboveEma: Boolean(ready.priceAboveEma),
          nearVwapReady: Boolean(ready.nearVwap),
          reclaimOrTap: Boolean(ready.reclaimOrTap),
          readyVolOk: Boolean(ready.volSpike),
          atrOkReady: Boolean(ready.atr),
          confirm15mOk: Boolean(ready.confirm15),
          strongBody: Boolean(ready.strongBody),
          rrOk: Boolean(ready.rrOk),
          riskOk: Boolean(ready.riskOk),
          rsiReadyOk: Boolean(ready.rsiReadyOk),
          readyTrendOk: Boolean(ready.trend),
        };

          if (ready.confirm15Strict) gateStats.ready.ready_confirm15_strict_true += 1;
          if (ready.priceAboveVwapRelaxedEligible) {
            gateStats.ready.ready_priceAboveVwap_relaxed_eligible += 1;
            if (ready.priceAboveVwapRelaxedTrue) gateStats.ready.ready_priceAboveVwap_relaxed_true += 1;
          }

        const coreOrder = [
          'sessionOK',
          'priceAboveVwap',
          'priceAboveEma',
          'nearVwapReady',
          'reclaimOrTap',
          'readyVolOk',
          'atrOkReady',
          'confirm15mOk',
          'strongBody',
          'rrOk',
          'riskOk',
          'rsiReadyOk',
          'readyTrendOk',
        ];

        const firstFailed = accumulateSequentialGatePasses(
          coreOrder,
          coreFlags,
          gateStats.ready.ready_core_flag_true,
        );
        if (firstFailed) {
          gateStats.ready.ready_core_first_failed[firstFailed] =
            (gateStats.ready.ready_core_first_failed[firstFailed] ?? 0) + 1;
        }

        const rrFailed = !coreFlags.rrOk
          && coreOrder.filter(k => k !== 'rrOk').every((k) => coreFlags[k]);
        if (rrFailed) gateStats.ready.failed_rr += 1;

        const shadowRelaxReclaim = !coreFlags.reclaimOrTap
          && coreOrder.filter(k => k !== 'reclaimOrTap').every((k) => coreFlags[k]);
        if (shadowRelaxReclaim) gateStats.ready.ready_shadow_if_reclaim_relaxed += 1;

        const relaxVolCond = Boolean(coreFlags.nearVwapReady && coreFlags.reclaimOrTap);
        const shadowRelaxVol = !coreFlags.readyVolOk
          && relaxVolCond
          && coreOrder.filter(k => k !== 'readyVolOk').every((k) => coreFlags[k])
          && Number(res?.signal?.volSpike ?? 0) >= 1.2;
        if (shadowRelaxVol) gateStats.ready.ready_shadow_if_volSpike_1_2 += 1;

        if (!best.nearVwap) gateStats.best.failed_near_vwap += 1;
        if (!best.confirm15) gateStats.best.failed_confirm15 += 1;
        if (!best.trend) gateStats.best.failed_trend += 1;
        if (!best.volSpike) gateStats.best.failed_volSpike += 1;
        if (!best.atr) gateStats.best.failed_atr += 1;
        if (best.corePreSweep && !best.sweep) gateStats.best.failed_sweep += 1;
        if (best.corePreRr && !best.rr) gateStats.best.failed_rr += 1;
        if (best.core && !best.btc) gateStats.best.failed_btc_gate += 1;

        if (short) {
          if (!short.nearVwap) gateStats.readyShort.failed_near_vwap += 1;
          if (!short.confirm15) gateStats.readyShort.failed_confirm15 += 1;
          if (!short.trend) gateStats.readyShort.failed_trend += 1;
          if (!short.volSpike) gateStats.readyShort.failed_volSpike += 1;
          if (!short.atr) gateStats.readyShort.failed_atr += 1;
          if (short.core && !short.sweep) gateStats.readyShort.failed_sweep += 1;
          if (short.core && short.sweep && !short.btc) gateStats.readyShort.failed_btc_gate += 1;

          gateStats.readyShort.ready_core_evaluated += 1;
          if (short.core) gateStats.readyShort.ready_core_true += 1;
          if (short.confirm15Strict) gateStats.readyShort.ready_confirm15_strict_true += 1;

          const shortCoreFlags: Record<string, boolean> = {
            sessionOK: Boolean(short.sessionOk),
            priceBelowVwap: Boolean(short.priceBelowVwap),
            priceBelowEma: Boolean(short.priceBelowEma),
            nearVwapShort: Boolean(short.nearVwap),
            rsiShortOk: Boolean(short.rsiShortOk),
            strongBody: Boolean(short.strongBody),
            readyVolOk: Boolean(short.volSpike),
            atrOkReady: Boolean(short.atr),
            confirm15mOk: Boolean(short.confirm15),
            trendOkShort: Boolean(short.trend),
            rrOk: Boolean(short.rrOk),
            riskOk: Boolean(short.riskOk),
          };
          const shortCoreOrder = [
            'sessionOK',
            'priceBelowVwap',
            'priceBelowEma',
            'nearVwapShort',
            'rsiShortOk',
            'strongBody',
            'readyVolOk',
            'atrOkReady',
            'confirm15mOk',
            'trendOkShort',
            'rrOk',
            'riskOk',
          ];
          const shortFirstFailed = accumulateSequentialGatePasses(
            shortCoreOrder,
            shortCoreFlags,
            gateStats.readyShort.ready_core_flag_true,
          );
          if (shortFirstFailed) {
            gateStats.readyShort.ready_core_first_failed[shortFirstFailed] =
              (gateStats.readyShort.ready_core_first_failed[shortFirstFailed] ?? 0) + 1;
          }

          const rrFailedShort = !shortCoreFlags.rrOk
            && shortCoreOrder.filter(k => k !== 'rrOk').every((k) => shortCoreFlags[k]);
          if (rrFailedShort) gateStats.readyShort.failed_rr += 1;
        }

        if (bestShort) {
          if (!bestShort.nearVwap) gateStats.bestShort.failed_near_vwap += 1;
          if (!bestShort.confirm15) gateStats.bestShort.failed_confirm15 += 1;
          if (!bestShort.trend) gateStats.bestShort.failed_trend += 1;
          if (!bestShort.volSpike) gateStats.bestShort.failed_volSpike += 1;
          if (!bestShort.atr) gateStats.bestShort.failed_atr += 1;
          if (bestShort.corePreSweep && !bestShort.sweep) gateStats.bestShort.failed_sweep += 1;
          if (bestShort.corePreRr && !bestShort.rr) gateStats.bestShort.failed_rr += 1;
          if (bestShort.core && !bestShort.btc) gateStats.bestShort.failed_btc_gate += 1;
        }

        if (GATE_TRACE_LOG_MAX > 0 && gateTraceLogCount < GATE_TRACE_LOG_MAX) {
          gateTraceLogCount += 1;
          const bestFlags: Record<string, boolean> = {
            nearVwapBuy: Boolean(best.nearVwap),
            confirm15mOk: Boolean(best.confirm15),
            trendOk: Boolean(best.trend),
            bestVolOk: Boolean(best.volSpike),
            atrOkBest: Boolean(best.atr),
            sweepOk: Boolean(best.sweep),
            rrOk: Boolean(best.rr),
            btcOk: Boolean(best.btc),
          };
          const bestOrder = [
            'nearVwapBuy',
            'confirm15mOk',
            'trendOk',
            'bestVolOk',
            'atrOkBest',
            'sweepOk',
            'rrOk',
            'btcOk',
          ];
          const bestFirstFailed = bestOrder.find((k) => !bestFlags[k]) ?? null;

          const shortFlags = short ? {
            nearVwapShort: Boolean(short.nearVwap),
            confirm15mOk: Boolean(short.confirm15),
            trendOkShort: Boolean(short.trend),
            readyVolOk: Boolean(short.volSpike),
            atrOkReady: Boolean(short.atr),
            sweepOk: Boolean(short.sweep),
            rrOk: Boolean(short.rrOk),
            btcOk: Boolean(short.btc),
          } : null;
          const shortOrder = ['nearVwapShort', 'confirm15mOk', 'trendOkShort', 'readyVolOk', 'atrOkReady', 'sweepOk', 'rrOk', 'btcOk'];
          const shortFirstFailed = shortFlags ? shortOrder.find((k) => !(shortFlags as any)[k]) ?? null : null;

          console.log(
            `[gate-trace] ${sym} readyFirst=${firstFailed ?? null} bestFirst=${bestFirstFailed} shortFirst=${shortFirstFailed} ` +
            `ready=${JSON.stringify(coreFlags)} best=${JSON.stringify(bestFlags)} short=${JSON.stringify(shortFlags)}`
          );
        }
      }

      const sig = res?.signal ?? null;
      if (sig) {
        const candleCloseMs = getCandleCloseMs(last5, 5 * 60_000);
        const withTime = {
          ...sig,
          time: candleCloseMs,
          runId: scanRun.runId,
          configHash: scanRun.configHash,
          instanceId: scanRun.instanceId,
        };
        outs.push(withTime);
        if (withTime?.category) {
          const key = String(withTime.category);
          signalsByCategory[key] = (signalsByCategory[key] ?? 0) + 1;
        }

        if (['BEST_ENTRY', 'READY_TO_BUY', 'BEST_SHORT_ENTRY', 'READY_TO_SELL'].includes(withTime.category)) {
          const title = withTime.category === 'BEST_ENTRY' ? '[BEST] Best Entry'
            : withTime.category === 'READY_TO_BUY' ? '[BUY] Ready to BUY'
            : withTime.category === 'BEST_SHORT_ENTRY' ? '[BEST SHORT] Best Short Entry'
            : '[SELL] Ready to SELL';

          const body = `${sym} @ ${withTime.price.toFixed(6)} | ΔVWAP ${withTime.deltaVwapPct.toFixed(2)}% | RSI ${withTime.rsi9.toFixed(1)} | Vol× ${withTime.volSpike.toFixed(2)}`;
          const bucket = Math.floor(withTime.time / (5 * 60_000));
          const baseKey = `${preset}|${sym}|${withTime.category}`;
          const dedupeKey = `${baseKey}|${bucket}`;
          toNotify.push({ sym, title, body, sig: withTime, dedupeKey });
        }
      }

      if (adaptiveDelayMs > 0) await sleep(adaptiveDelayMs);
      no429Streak++;
      if (no429Streak >= 50) {
        adaptiveDelayMs = Math.max(SYMBOL_DELAY_MS, adaptiveDelayMs - BACKOFF_STEP_MS);
        no429Streak = 0;
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('BINANCE_HTTP_429') || msg.includes('429')) err429++;
      else errOther++;

      if (msg.includes('BINANCE_HTTP_429') || msg.includes('429')) {
        adaptiveDelayMs = Math.min(adaptiveDelayMs + BACKOFF_STEP_MS, BACKOFF_MAX_MS);
        no429Streak = 0;
      }

      // sample logs so you can see the real issue without spamming
      if ((err429 + errOther) % 10 === 1) {
        console.warn('[scan] sample error:', msg);
      }
      continue;
    }
  }

  // notify after scan (inline, no setTimeout)
  const seen = new Set<string>();
  for (const n of toNotify) {
    if (seen.has(n.dedupeKey)) continue;
    seen.add(n.dedupeKey);
    const parts = n.dedupeKey.split('|');
    const bucket = Number(parts.pop());
    const baseKey = parts.join('|');
    if (!Number.isFinite(bucket)) continue;
    if (!shouldPushBucket(baseKey, bucket)) continue;

    try { await emailNotify(undefined, n.sig); } catch (e) { console.error('emailNotify error', e); }
    try {
      // Hold time recommendation based on outcome analysis
      const holdHours = Number(process.env.SIGNAL_HOLD_MINUTES || 120) / 60;
      const holdRec = n.sig.category?.toUpperCase().includes('BEST') 
        ? `Hold ${holdHours}-4h for optimal R (37-44% win rate)`
        : `Consider ${holdHours}-4h hold`;
      
      await pushToAll({
        title: n.title,
        body: `${n.body} | ${holdRec}`,
        data: { 
          symbol: n.sym, 
          price: n.sig.price, 
          category: n.sig.category, 
          preset, 
          time: n.sig.time,
          holdMinutes: Number(process.env.SIGNAL_HOLD_MINUTES || 120),
          holdRecommendation: holdRec
        }
      });
    } catch (err) { console.error('notify error', err); }
  }

  const dtMs = Date.now() - t0;
  const precheckTop = Object.entries(precheck)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`[precheck] pass=${precheckPassed}${precheckTop ? ' ' + precheckTop : ''}`);
  console.log(`[scan] done preset=${preset} processed=${processed} signals=${outs.length} 429=${err429} otherErr=${errOther} dt=${dtMs}ms`);

  lastScanHealth = {
    preset,
    startedAt: t0,
    finishedAt: Date.now(),
    durationMs: dtMs,
    processedSymbols: processed,
    precheckPassed,
    fetchedOk,
    errors429: err429,
    errorsOther: errOther,
    signalsByCategory,
    gateStats,
    ...(errorMessage ? { error: errorMessage } : {}),
  };

  const finishedAt = Date.now();
  const payload = {
    finishedAt,
    durationMs: finishedAt - t0,
    processedSymbols: processed,
    precheckPassed,
    fetchedOk,
    errors429: err429,
    errorsOther: errOther,
    signalsByCategory,
    gateStats,
  };
  if (errorMessage) {
    await failScanRun(scanRun.runId, errorMessage, payload);
  } else {
    await finishScanRun(scanRun.runId, payload);
  }
  await pruneScanRuns();
  try { await pruneCandidateFeatures(); } catch (e) { console.warn('[candidate_features] prune failed:', e); }
  currentScan = null;

  return outs;
}

export function startLoop(onUpdate?: (signals: any[]) => void) {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      const res = await scanOnce();
      onUpdate && onUpdate(res);
    } finally {
      running = false;
      setTimeout(loop, SCAN_INTERVAL_MS);
    }
  };
  loop();
}



