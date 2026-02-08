import { topUSDTByQuoteVolume, listAllUSDTMarkets, klines } from './binance.js';
import { tryStartScanRun, finishScanRun, failScanRun, pruneScanRuns } from './scanStore.js';
import { analyzeSymbol } from './logic.js';
import { atrPct, ema, rsi } from './indicators.js';
import { pushToAll } from './notifier.js';
import { emailNotify } from './emailNotifier.js';
import type { MarketInfo, OHLCV } from './types.js';

// Configuration
const TOP_N = parseInt(process.env.TOP_N || '300', 10);
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);
const SYMBOL_DELAY_MS = parseInt(process.env.SYMBOL_DELAY_MS || '120', 10);
const MAX_SCAN_MS = parseInt(process.env.MAX_SCAN_MS || String(4 * 60_000), 10);
const BACKOFF_STEP_MS = parseInt(process.env.BACKOFF_STEP_MS || '200', 10);
const BACKOFF_MAX_MS = parseInt(process.env.BACKOFF_MAX_MS || '2000', 10);
const CLOCK_SKEW_MS = parseInt(process.env.CLOCK_SKEW_MS || '1500', 10);
const INCLUDE_NON_TOP = (process.env.INCLUDE_NON_TOP ?? 'true').toLowerCase() !== 'false';
const EXTRA_USDT_COUNT = parseInt(process.env.EXTRA_USDT_COUNT || '200', 10);

// ---- Liquidity / quality guardrails ---------------------------------
const MIN_QUOTE_USDT = parseFloat(process.env.MIN_QUOTE_USDT || '20000000'); // 20M
const MIN_PRICE_USDT = parseFloat(process.env.MIN_PRICE_USDT || '0.00001');   // $0.00001
const STABLE_BASES = new Set(['USDT','USDC','BUSD','FDUSD','TUSD','DAI','USDD','USDJ']);
const LEVERAGED_SUFFIXES = /(UP|DOWN|BULL|BEAR)USDT$/i;
const MIN_ATR_PCT_PRECHECK = parseFloat(process.env.MIN_ATR_PCT_PRECHECK || '0.10');
const RSI_PRECHECK_MIN = parseFloat(process.env.RSI_PRECHECK_MIN || '45');
const RSI_PRECHECK_MAX = parseFloat(process.env.RSI_PRECHECK_MAX || '85');
const PRECHECK_VWAP_MAX_PCT = parseFloat(process.env.PRECHECK_VWAP_MAX_PCT || '1.5');
const PRECHECK_EMA_SOFT_PCT = parseFloat(process.env.PRECHECK_EMA_SOFT_PCT || '0.5');

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

type ScanGateStats = {
  readyCandidates: number;
  bestCandidates: number;
  ready: ReadyGateFailures;
  best: GateFailures;
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
let currentScan: { runId: string; preset: string; startedAt: number } | null = null;
let lastSymbols: string[] | null = null;
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

function initGateStats(): ScanGateStats {
  return {
    readyCandidates: 0,
    bestCandidates: 0,
    ready: initReadyGateFailures(),
    best: initGateFailures(),
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
  if (close > 0 && (now + CLOCK_SKEW_MS) < close) return data.slice(0, -1);
  return data;
}

function dayAnchorIndexAt(data: OHLCV[], j: number, fallbackBars: number): number {
  if (j <= 0) return 0;
  const hasTime = data[j].time != null || data[j].openTime != null;
  if (!hasTime) return Math.max(0, j - fallbackBars + 1);
  const getMs = (d: OHLCV) => (d.openTime ?? d.time ?? 0);
  const dateKey = (ms: number) => {
    const dt = new Date(ms);
    return dt.getUTCFullYear() * 10_000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
  };

  const endKey = dateKey(getMs(data[j]));
  let anchor = j;
  while (anchor > 0) {
    const prevKey = dateKey(getMs(data[anchor - 1]));
    if (prevKey !== endKey) break;
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
  const anchor = dayAnchorIndexAt(data15, i, 96);
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
  const now = Date.now();
  const scanRun = await tryStartScanRun(preset, MAX_SCAN_MS);
  if (!scanRun) {
    console.log('[scan] skip: another scan is already running');
    return [];
  }
  currentScan = scanRun;

  const signalsByCategory: Record<string, number> = {
    WATCH: 0,
    EARLY_READY: 0,
    READY_TO_BUY: 0,
    BEST_ENTRY: 0,
  };
  const gateStats = initGateStats();
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
  const shouldAbort = Boolean(errorMessage && symbols.length === 0);
  for (const sym of (shouldAbort ? [] : symbols)) {
    if (isStableVsStable(sym)) continue;
    if (LEVERAGED_SUFFIXES.test(sym)) continue;

    if (Date.now() - t0 > MAX_SCAN_MS) {
      console.warn(`[scan] max duration reached (${MAX_SCAN_MS}ms), stopping early`);
      break;
    }

    processed++;

    try {
      let d5 = await klines(sym, '5m', 300);
      d5 = sliceToLastClosed(d5, 5 * 60_000, now);
      if (d5.length < 210) continue;

      const last5 = d5[d5.length - 1];
      if (!last5 || !Number.isFinite(last5.close) || !Number.isFinite(last5.high) || !Number.isFinite(last5.low) || !Number.isFinite(last5.volume)) continue;
      if (last5.close < MIN_PRICE_USDT) continue;

      const closes5 = d5.map(d => d.close);
      const highs5 = d5.map(d => d.high);
      const lows5 = d5.map(d => d.low);
      const atr5 = atrPct(highs5, lows5, closes5, 14);
      const rsi5 = rsi(closes5, 9);
      const i5 = closes5.length - 1;
      const atrNow = atr5[i5];
      const rsiNow = rsi5[i5];

      if (!Number.isFinite(atrNow) || !Number.isFinite(rsiNow)) continue;
      if (atrNow < MIN_ATR_PCT_PRECHECK) continue;
      if (rsiNow < RSI_PRECHECK_MIN || rsiNow > RSI_PRECHECK_MAX) continue;

      // 5m prefilter: only pull 15m if price is near VWAP/EMA200 window
      const ema200_5 = ema(closes5, 200);
      const emaNow = ema200_5[i5];
      if (!Number.isFinite(emaNow) || emaNow <= 0) continue;
      const emaSoftOk =
        last5.close >= emaNow ||
        (((emaNow - last5.close) / emaNow) * 100 <= PRECHECK_EMA_SOFT_PCT);

      const vols5 = d5.map(d => d.volume);
      const tp5 = d5.map(d => (d.high + d.low + d.close) / 3);
      const { cumPV, cumV } = buildCum(tp5, vols5);
      const a0 = dayAnchorIndexAt(d5, i5, 288);
      const vwap5 = anchoredVwapAt(cumPV, cumV, a0, i5);
      if (!Number.isFinite(vwap5) || vwap5 <= 0) continue;
      const distToVwapPct = ((last5.close - vwap5) / vwap5) * 100;
      const nearVwapPre = Math.abs(distToVwapPct) <= Math.max(thresholds.vwapDistancePct, PRECHECK_VWAP_MAX_PCT);

      if (!emaSoftOk || !nearVwapPre) continue;
      precheckPassed++;

      let d15 = await klines(sym, '15m', 260);
      d15 = sliceToLastClosed(d15, 15 * 60_000, now);
      if (d15.length < 210) continue;
      fetchedOk++;

      const sig = analyzeSymbol(sym, d5, d15, thresholds, market ?? undefined);
      if (sig) {
        const candleCloseMs = getCandleCloseMs(last5, 5 * 60_000);
        const withTime = { ...sig, time: candleCloseMs };
        outs.push(withTime);
        if (withTime?.category) {
          const key = String(withTime.category);
          signalsByCategory[key] = (signalsByCategory[key] ?? 0) + 1;
        }

        const snap = withTime.gateSnapshot;
        if (snap) {
          const ready = snap.ready;
          const best = snap.best;

          if (ready.core) gateStats.readyCandidates += 1;
          if (best.core) gateStats.bestCandidates += 1;

          if (!ready.nearVwap) gateStats.ready.failed_near_vwap += 1;
          if (!ready.confirm15) gateStats.ready.failed_confirm15 += 1;
          if (!ready.trend) gateStats.ready.failed_trend += 1;
          if (!ready.volSpike) gateStats.ready.failed_volSpike += 1;
          if (!ready.atr) gateStats.ready.failed_atr += 1;
          if (!ready.sweep) gateStats.ready.failed_sweep += 1;
          if (ready.core && !ready.btc) gateStats.ready.failed_btc_gate += 1;

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
            rsiReadyOk: Boolean(ready.rsiReadyOk),
            readyTrendOk: Boolean(ready.trend),
          };

          if (ready.confirm15Strict) gateStats.ready.ready_confirm15_strict_true += 1;
          if (ready.nearVwap && ready.confirm15Strict) {
            gateStats.ready.ready_priceAboveVwap_relaxed_eligible += 1;
            if (ready.priceAboveVwap) gateStats.ready.ready_priceAboveVwap_relaxed_true += 1;
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
            'rsiReadyOk',
            'readyTrendOk',
          ];

          const firstFailed = coreOrder.find((k) => !coreFlags[k]);
          if (firstFailed) {
            gateStats.ready.ready_core_first_failed[firstFailed] =
              (gateStats.ready.ready_core_first_failed[firstFailed] ?? 0) + 1;
          }

          for (const k of coreOrder) {
            if (coreFlags[k]) {
              gateStats.ready.ready_core_flag_true[k] =
                (gateStats.ready.ready_core_flag_true[k] ?? 0) + 1;
            }
          }

          const shadowRelaxReclaim = !coreFlags.reclaimOrTap
            && coreOrder.filter(k => k !== 'reclaimOrTap').every((k) => coreFlags[k]);
          if (shadowRelaxReclaim) gateStats.ready.ready_shadow_if_reclaim_relaxed += 1;

          const relaxVolCond = Boolean(coreFlags.nearVwapReady && coreFlags.reclaimOrTap);
          const shadowRelaxVol = !coreFlags.readyVolOk
            && relaxVolCond
            && coreOrder.filter(k => k !== 'readyVolOk').every((k) => coreFlags[k])
            && Number(withTime.volSpike) >= 1.2;
          if (shadowRelaxVol) gateStats.ready.ready_shadow_if_volSpike_1_2 += 1;

          if (!best.nearVwap) gateStats.best.failed_near_vwap += 1;
          if (!best.confirm15) gateStats.best.failed_confirm15 += 1;
          if (!best.trend) gateStats.best.failed_trend += 1;
          if (!best.volSpike) gateStats.best.failed_volSpike += 1;
          if (!best.atr) gateStats.best.failed_atr += 1;
          if (!best.sweep) gateStats.best.failed_sweep += 1;
          if (!best.rr) gateStats.best.failed_rr += 1;
          if (best.core && !best.btc) gateStats.best.failed_btc_gate += 1;
        }

        if (['BEST_ENTRY','READY_TO_BUY','EARLY_READY'].includes(withTime.category)) {
          const title = withTime.category === 'BEST_ENTRY' ? '⭐ Best Entry'
            : withTime.category === 'READY_TO_BUY' ? '✅ Ready to BUY'
            : '⚡ Early Ready (½ size)';

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
      await pushToAll({
        title: n.title,
        body: n.body,
        data: { symbol: n.sym, price: n.sig.price, category: n.sig.category, preset, time: n.sig.time }
      });
    } catch (err) { console.error('notify error', err); }
  }

  const dtMs = Date.now() - t0;
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



