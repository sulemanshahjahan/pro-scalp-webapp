// backend/src/logic.ts
import { ema, rsi, atrPct, volumeSpike } from './indicators.js';
import type { MarketInfo, OHLCV, Signal } from './types.js';

export interface Thresholds {
  vwapDistancePct: number; // e.g. 0.30  => ±0.30%
  volSpikeX: number;       // e.g. 1.5   => 1.5x recent avg
  atrGuardPct: number;     // e.g. 2.5   => ATR% must be ≤ 2.5
}

/** =================== Tunables & Env =================== */
const RSI_MIN = 55;          // 15m strict confirm floor
const RSI_MAX = 80;          // cap to avoid chasing overbought
const RSI_BEST_MIN = 55;
const RSI_BEST_MAX = 72;
const RSI_READY_MIN = 52;
const RSI_READY_MAX = 78;
const RSI_EARLY_MIN = 48;
const RSI_EARLY_MAX = 80;
const RSI_DELTA_STRICT = 0.2;
const MIN_BODY_PCT = 0.15;   // candle body filter (%) for BEST
const READY_BODY_PCT = 0.10; // READY body filter (%)
const READY_CLOSE_POS_MIN = 0.60; // close in top 40% of candle range
const READY_UPPER_WICK_MAX = 0.40; // upper wick <= 40% of range
const MIN_ATR_PCT = 0.10;    // skip when 5m ATR% < 0.10% (too dead)
const MIN_RISK_PCT = parseFloat(process.env.MIN_RISK_PCT || '0.2');

const EMA15_SOFT_TOL = 0.10; // % below EMA200 allowed on 15m soft confirm
const RSI15_FLOOR_SOFT = 50; // 15m RSI soft floor

// ✅ Make WATCH easier than BUY without changing preset thresholds
const VWAP_WATCH_MIN_PCT = 0.80;   // WATCH near-VWAP minimum window
const EMA5_WATCH_SOFT_TOL = 0.25;  // allow up to 0.25% below EMA200 on WATCH
const RSI_WATCH_FLOOR = 48;        // WATCH can start earlier

const LIQ_LOOKBACK = parseInt(process.env.LIQ_LOOKBACK || '20', 10);
const RR_MIN_BEST  = parseFloat(process.env.RR_MIN_BEST || '2.0');
const BEAR_GATE_ENABLED = (process.env.BEAR_GATE_ENABLED ?? 'true').toLowerCase() !== 'false';
const BEAR_GATE_HOLD_CANDLES = parseInt(process.env.BEAR_GATE_HOLD_CANDLES || '2', 10);
const BEAR_GATE_VOL_MULT = parseFloat(process.env.BEAR_GATE_VOL_MULT || '1.2');
const BEAR_GATE_RSI_MIN = parseFloat(process.env.BEAR_GATE_RSI_MIN || String(RSI_READY_MIN));

const SESSION_FILTER_ENABLED = (process.env.SESSION_FILTER_ENABLED ?? 'true').toLowerCase() !== 'false';
// Default UTC windows (approx London & NY opens). Format: "start-end,start-end" 24h UTC
const SESSIONS_UTC = process.env.SESSIONS_UTC || '07-11,13-20';
/** ===================================================== */

/** ----- Helpers: daily-anchored VWAP (fallback = last N bars) ----- */
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
type Gate = { key: string; ok: boolean; reason: string };

function buildGateDebug(gates: Gate[]) {
  const failed = gates.filter(g => !g.ok);
  const passed = gates.length - failed.length;
  return {
    blockedReasons: failed.map(g => g.reason),
    firstFailedGate: failed[0]?.key ?? null,
    gateScore: gates.length ? Math.round((passed / gates.length) * 100) : 0,
  };
}
/** ----------------------------------------------------------------- */

/** ---------- 15m confirmations (higher-TF alignment) ------ */
function confirm15_strict(data15: OHLCV[]): boolean {
  if (data15.length < 210) return false;

  const closes = data15.map(d => d.close);
  const vols   = data15.map(d => d.volume);
  const tp     = data15.map(d => (d.high + d.low + d.close) / 3);
  const { cumPV, cumV } = buildCum(tp, vols);

  const e = ema(closes, 200);
  const r = rsi(closes, 9);

  const i = closes.length - 1;
  if (i < 2) return false;

  // ✅ use daily-anchored VWAP on 15m (fallback 96 bars ~ 1 day)
  const anchor = dayAnchorIndexAt(data15, i, 96);
  const v_i = anchoredVwapAt(cumPV, cumV, anchor, i);

  const rsiOk = r[i] > 55 && r[i] < 80 && r[i] >= r[i - 1];
  return closes[i] > v_i && closes[i] > e[i] && rsiOk;
}

function confirm15_soft(data15: OHLCV[]): boolean {
  if (data15.length < 210) return false;

  if (confirm15_strict(data15)) return true;

  const closes = data15.map(d => d.close);
  const vols   = data15.map(d => d.volume);
  const tp     = data15.map(d => (d.high + d.low + d.close) / 3);
  const { cumPV, cumV } = buildCum(tp, vols);

  const e = ema(closes, 200);
  const r = rsi(closes, 9);

  const i = closes.length - 1;
  if (i < 2) return false;

  const a0 = dayAnchorIndexAt(data15, i, 96);
  const a1 = dayAnchorIndexAt(data15, i - 1, 96);
  const v_i  = anchoredVwapAt(cumPV, cumV, a0, i);
  const v_i1 = anchoredVwapAt(cumPV, cumV, a1, i - 1);

  // “recent strict” (previous candle had it)
  const hadRecentStrict =
    closes[i - 1] > v_i1 &&
    closes[i - 1] > e[i - 1] &&
    r[i - 1] > 55 && r[i - 1] < 80 &&
    r[i - 1] >= r[i - 2];

  if (hadRecentStrict) return true;

  const aboveVwap = closes[i] > v_i;
  const nearOrAboveEma =
    closes[i] > e[i] ||
    (((e[i] - closes[i]) / e[i]) * 100 <= EMA15_SOFT_TOL);

  const rsiSoftOk =
    r[i] >= RSI15_FLOOR_SOFT &&
    r[i] < RSI_MAX &&
    r[i] >= (r[i - 1] - 0.3);

  return aboveVwap && nearOrAboveEma && rsiSoftOk;
}
/** ------------------------------------------------------------------- */

/** -------------------- Liquidity & R:R utilities -------------------- */
function swingLow(data: OHLCV[], from: number, to: number): { idx: number; price: number } {
  let idx = from, p = data[from].low;
  for (let i = from + 1; i <= to; i++) if (data[i].low < p) { p = data[i].low; idx = i; }
  return { idx, price: p };
}
function swingHigh(data: OHLCV[], from: number, to: number): { idx: number; price: number } {
  let idx = from, p = data[from].high;
  for (let i = from + 1; i <= to; i++) if (data[i].high > p) { p = data[i].high; idx = i; }
  return { idx, price: p };
}

/** Long-side sweep & reclaim */
function detectLiquiditySweepLong(data5: OHLCV[], vwap_i: number, atrPctNow: number, lookback = LIQ_LOOKBACK) {
  const i = data5.length - 1;
  const start = Math.max(0, i - 1 - lookback);
  const prior = swingLow(data5, start, i - 1);
  const sweepWindow = Math.min(3, i + 1);
  let swept = false;
  let sweptLow = Infinity;
  for (let k = i; k >= Math.max(0, i - sweepWindow + 1); k--) {
    const low = data5[k].low;
    if (low < prior.price) {
      swept = true;
      if (low < sweptLow) sweptLow = low;
    }
  }
  const lastClose = data5[i].close;
  const sweepDepthPct = swept ? ((prior.price - sweptLow) / prior.price) * 100 : 0;
  const minDepthPct = Math.max(0.03, atrPctNow * 0.15);
  const reclaimed = lastClose > prior.price && lastClose > vwap_i;
  const ok = swept && sweepDepthPct >= minDepthPct && reclaimed;
  return { ok, sweptLow, priorLow: prior.price, sweepDepthPct, minDepthPct };
}

function nearestUpsideLiquidity(data5: OHLCV[], lookback = LIQ_LOOKBACK) {
  const i = data5.length - 1;
  const start = Math.max(0, i - lookback);
  return swingHigh(data5, start, i - 1).price;
}

/** Session filter using UTC hour windows */
function sessionActiveUTC(now = new Date()): boolean {
  if (!SESSION_FILTER_ENABLED) return true;
  const h = now.getUTCHours();
  const ranges = SESSIONS_UTC.split(',').map(r => r.trim()).filter(Boolean);
  for (const r of ranges) {
    const [a, b] = r.split('-').map(x => parseInt(x, 10));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      if (h >= a && h < b) return true;
    }
  }
  return false;
}
/** ------------------------------------------------------------------- */

/** ------------------------- Main analyzer --------------------------- */
export function analyzeSymbol(
  symbol: string,
  data5: OHLCV[],
  data15: OHLCV[],
  thresholds: Thresholds,
  market?: MarketInfo
): Omit<Signal, 'time'> | null {
  if (data5.length < 210 || data15.length < 210) return null;

  // ----- 5m series -----
  const closes5 = data5.map(d => d.close);
  const highs5  = data5.map(d => d.high);
  const lows5   = data5.map(d => d.low);
  const vols5   = data5.map(d => d.volume);
  const notional5 = data5.map(d => d.volume * d.close);
  const tp5     = data5.map(d => (d.high + d.low + d.close) / 3);
  const { cumPV: cumPV5, cumV: cumV5 } = buildCum(tp5, vols5);

  const ema200_5   = ema(closes5, 200);
  const ema50_5    = ema(closes5, 50);
  const rsi9_5     = rsi(closes5, 9);
  const atrp_5     = atrPct(highs5, lows5, closes5, 14);
  const volspike_5 = volumeSpike(notional5, 20);

  const i  = data5.length - 1;
  const i1 = i - 1;
  const i2 = i - 2;

  // ✅ daily-anchored VWAP on 5m (fallback 288 bars ~ 1 day)
  const a2 = dayAnchorIndexAt(data5, i2, 288);
  const a1 = dayAnchorIndexAt(data5, i1, 288);
  const a0 = dayAnchorIndexAt(data5, i, 288);
  const vwap_i2 = anchoredVwapAt(cumPV5, cumV5, a2, i2);
  const vwap_i1 = anchoredVwapAt(cumPV5, cumV5, a1, i1);
  const vwap_i  = anchoredVwapAt(cumPV5, cumV5, a0, i);

  const price       = closes5[i];
  const emaNow      = ema200_5[i];
  const ema50Now    = ema50_5[i];
  const rsiNow      = rsi9_5[i];
  const rsiPrev     = rsi9_5[i - 1];
  const rsiDelta    = rsiNow - rsiPrev;
  const atrNow      = atrp_5[i];
  const volSpikeNow = volspike_5[i];
  const ema200Up    = ema200_5[i] >= ema200_5[Math.max(0, i - 3)];
  const ema50Up     = ema50_5[i] >= ema50_5[Math.max(0, i - 3)];
  const trendOk     = ema50Now > emaNow && ema50Up && ema200Up;
  const hasMarket   = Boolean(market);
  const btcBull     = market?.btcBull15m === true;
  const btcBear     = market?.btcBear15m === true;

  // Hard skip for very dead markets (keeps signal quality)
  if (atrNow < MIN_ATR_PCT) return null;
  if (!Number.isFinite(vwap_i) || vwap_i <= 0) return null;
  if (!Number.isFinite(vwap_i1) || !Number.isFinite(vwap_i2)) return null;
  if (!Number.isFinite(emaNow) || emaNow <= 0) return null;

  const distToVwapPct = ((price - vwap_i) / vwap_i) * 100;

  // BUY window = preset threshold (e.g. 0.30%)
  const nearVwapBuy = Math.abs(distToVwapPct) <= thresholds.vwapDistancePct;
  const readyVwapMax = thresholds.vwapDistancePct;
  const READY_VWAP_TOUCH_PCT = 0.20;
  const READY_VWAP_TOUCH_BARS = 5;
  const touchStart = Math.max(0, i - READY_VWAP_TOUCH_BARS + 1);
  const touchedVwapRecently = lows5
    .slice(touchStart, i + 1)
    .some((low) => low <= vwap_i * (1 + READY_VWAP_TOUCH_PCT / 100));
  const nearVwapReadyDist = Math.abs(distToVwapPct) <= readyVwapMax;
  const nearVwapReady = nearVwapReadyDist && touchedVwapRecently;

  // WATCH window = max(preset, 0.80%) so you actually see setups
  const nearVwapWatch = Math.abs(distToVwapPct) <= Math.max(thresholds.vwapDistancePct, VWAP_WATCH_MIN_PCT);

  // Reclaim / bounce patterns around VWAP (useful for WATCH too)
  const sameDay01 = a0 === a1;
  const sameDay12 = a1 === a2;
  const reclaim =
    sameDay01 && sameDay12 &&
    (closes5[i1] > vwap_i1) &&
    (closes5[i2] <= vwap_i2 || Math.abs(((closes5[i2] - vwap_i2) / vwap_i2) * 100) <= thresholds.vwapDistancePct);

  const tappedVwapPrev =
    sameDay01 &&
    lows5[i1] <= vwap_i1 * (1 + thresholds.vwapDistancePct / 100) &&
    closes5[i1] >= vwap_i1;
  const reclaimDayBlocked = !(sameDay01 && sameDay12);
  const reclaimOk = reclaim || tappedVwapPrev;

  const priceAboveEma = price > emaNow;
  const emaWatchOk =
    priceAboveEma ||
    (((emaNow - price) / emaNow) * 100 <= EMA5_WATCH_SOFT_TOL);

  const rsiBestOk  = rsiNow >= RSI_BEST_MIN && rsiNow <= RSI_BEST_MAX && rsiDelta >= RSI_DELTA_STRICT;
  const rsiReadyOk = rsiNow >= RSI_READY_MIN && rsiNow <= RSI_READY_MAX && rsiDelta >= RSI_DELTA_STRICT;
  const rsiWatchOk = rsiNow >= RSI_EARLY_MIN && rsiNow <= RSI_EARLY_MAX && rsiNow >= (rsiPrev - 0.2);

  const openNow = data5[i].open;
  const bodyPct = (openNow && openNow > 0) ? (Math.abs((closes5[i] - openNow) / openNow) * 100) : 0;
  const bullish = openNow != null ? closes5[i] > openNow : false;

  const rangeNow = highs5[i] - lows5[i];
  const closePos = rangeNow > 0 ? (closes5[i] - lows5[i]) / rangeNow : 0;
  const upperWickPct = rangeNow > 0 ? (highs5[i] - closes5[i]) / rangeNow : 1;

  const strongBodyBest =
    bullish &&
    bodyPct >= MIN_BODY_PCT &&
    upperWickPct <= 0.5;

  const strongBodyReady =
    bullish &&
    bodyPct >= READY_BODY_PCT &&
    closePos >= READY_CLOSE_POS_MIN &&
    upperWickPct <= READY_UPPER_WICK_MAX;

  const confirm15mStrict = confirm15_strict(data15);
  const confirm15mSoft   = confirm15_soft(data15);
  const confirm15mOk = confirm15mStrict || confirm15mSoft;

  const READY_VWAP_EPS_PCT = 0.02;
  const priceAboveVwapStrict = price > vwap_i;
  const readyPriceAboveVwap = priceAboveVwapStrict || (
    nearVwapReady &&
    confirm15mStrict &&
    price >= vwap_i * (1 - READY_VWAP_EPS_PCT / 100)
  );

  const volBestMin  = Math.max(thresholds.volSpikeX, 1.4);

  const atrOkReady = atrNow <= thresholds.atrGuardPct * 1.2;
  const atrOkBest  = atrNow <= thresholds.atrGuardPct;

  const sessionOK = sessionActiveUTC();

  const liq = detectLiquiditySweepLong(data5, vwap_i, atrNow, LIQ_LOOKBACK);

  let rrOK = false;
  let rrVal = 0;
  if (liq.ok) {
    const stop = liq.sweptLow;
    const target = nearestUpsideLiquidity(data5, LIQ_LOOKBACK);
    const risk = Math.max(1e-12, price - stop);
    const reward = Math.max(0, target - price);
    rrVal = reward / risk;
    rrOK = rrVal >= RR_MIN_BEST;
  }

  const reasons: string[] = [];
  let category: Signal['category'] | null = null;

  /** ===================== BEST ENTRY ===================== */
  const bestVolOk = volSpikeNow >= Math.max(1.2, volBestMin);
  const bestCore =
    priceAboveEma &&
    readyPriceAboveVwap &&
    nearVwapBuy &&
    rsiBestOk &&
    strongBodyBest &&
    atrOkBest &&
    trendOk &&
    sessionOK &&
    confirm15mOk &&
    liq.ok &&
    (reclaim || tappedVwapPrev) &&
    bestVolOk &&
    rrOK &&
    hasMarket;
  const bestBtcOk = hasMarket && btcBull;
  const bestOk = bestCore && bestBtcOk;

  if (bestOk) {
    category = 'BEST_ENTRY';
    reasons.push(
      'Higher-TF aligned (15m confirm)',
      'Liquidity sweep & reclaim',
      'Price > EMA200 & anchored VWAP (near VWAP)',
      `ΔVWAP ${distToVwapPct.toFixed(2)}%`,
      `RSI-9 rising (${RSI_BEST_MIN}–${RSI_BEST_MAX})`,
      'Trend up (EMA50 > EMA200)',
      'Strong-bodied close',
      `ATR% ≤ ${thresholds.atrGuardPct.toFixed(2)}`,
      'Session active',
      'BTC bullish (15m)',
      `R:R ${rrVal.toFixed(2)}≥${RR_MIN_BEST.toFixed(2)}`
    );
  }

  /** ===================== READY TO BUY ===================== */
  const isBalancedPreset =
    thresholds.volSpikeX === 1.5 &&
    thresholds.vwapDistancePct === 0.30 &&
    thresholds.atrGuardPct === 2.5;
  const readyVolMinBase = isBalancedPreset ? 1.3 : Math.max(1.2, thresholds.volSpikeX);
  const readyVolMin =
    isBalancedPreset && nearVwapReady && reclaimOk
      ? 1.2
      : readyVolMinBase;
  const readyVolOk = volSpikeNow >= readyVolMin;
  const readyNoSweepVwapCap = 0.20;
  const nearVwapReadyNoSweep = Math.abs(distToVwapPct) <= readyNoSweepVwapCap;
  const readyTrendOk = ema50Now > emaNow && ema200Up;
  const readyCore =
    sessionOK &&
    price > vwap_i &&
    priceAboveEma &&
    rsiReadyOk &&
    nearVwapReady &&
    (reclaim || tappedVwapPrev) &&
    readyVolOk &&
    atrOkReady &&
    confirm15mOk &&
    strongBodyReady &&
    readyTrendOk;

  const readyBtcOk = hasMarket && (
    btcBull ||
    (!btcBear && confirm15mStrict) ||
    // Allow READY during BTC bear only if symbol is exceptionally strong
    (btcBear && confirm15mStrict && trendOk && strongBodyReady && readyVolOk)
  );
  const readySweepFallbackOk = reclaimOk && confirm15mStrict && readyTrendOk && nearVwapReadyNoSweep;
  const readySweepOk = liq.ok || readySweepFallbackOk;
  const readyOk = readyCore && readySweepOk && readyBtcOk;
  const blockedByBtc = readyCore && readySweepOk && !readyBtcOk;

  const readyGates: Gate[] = [
    { key: 'sessionOK', ok: sessionOK, reason: 'Session not active' },
    { key: 'price>VWAP', ok: readyPriceAboveVwap, reason: 'Price not above VWAP' },
    { key: 'priceAboveEma', ok: priceAboveEma, reason: 'Price not above EMA200' },
    {
      key: 'nearVwapReady',
      ok: nearVwapReady,
      reason: !nearVwapReadyDist
        ? `Too far from VWAP (>${readyVwapMax.toFixed(2)}%)`
        : `No VWAP touch in last ${READY_VWAP_TOUCH_BARS} candles (<=${READY_VWAP_TOUCH_PCT.toFixed(2)}%)`,
    },
    { key: 'rsiReadyOk', ok: rsiReadyOk, reason: `RSI not in ${RSI_READY_MIN}–${RSI_READY_MAX} rising window` },
    {
      key: 'reclaimOrTap',
      ok: reclaimOk,
      reason: reclaimDayBlocked ? 'Reclaim/tap blocked by UTC day boundary' : 'No reclaim/tap pattern',
    },
    { key: 'readyVolOk', ok: readyVolOk, reason: 'Volume spike not met' },
    { key: 'atrOkReady', ok: atrOkReady, reason: 'ATR too high' },
    { key: 'confirm15mOk', ok: confirm15mOk, reason: '15m confirmation not satisfied' },
    { key: 'strongBody', ok: strongBodyReady, reason: 'No strong bullish body candle' },
    { key: 'trendOk', ok: readyTrendOk, reason: 'Trend not OK (EMA50>EMA200 + EMA200 rising)' },
    { key: 'readySweep', ok: readySweepOk, reason: `Sweep missing (alt requires strict 15m + trend + ≤${readyNoSweepVwapCap.toFixed(2)}% VWAP)` },
    { key: 'hasMarket', ok: hasMarket, reason: 'BTC market data missing' },
    {
      key: 'btcOkReady',
      ok: readyBtcOk,
      reason: 'BTC regime gate failed (bearish or neutral without strict confirm)',
    },
  ];
  const readyDebug = buildGateDebug(readyGates);

  if (!category && readyOk) {
    let ok = true;
    if (liq.ok) {
      const stop = liq.sweptLow;
      const target = nearestUpsideLiquidity(data5, LIQ_LOOKBACK);
      const risk = Math.max(1e-12, price - stop);
      const reward = Math.max(0, target - price);
      const rr = reward / risk;
      ok = rr >= Math.max(1.5, RR_MIN_BEST * 0.75);
      if (!ok) reasons.push(`R:R ${rr.toFixed(2)} < 1.5 (Ready guard)`);
    }
    if (ok) {
      category = 'READY_TO_BUY';
      reasons.push(
        'Price > (anchored) VWAP & EMA200',
        `RSI-9 rising (${RSI_READY_MIN}–${RSI_READY_MAX})`,
        `Near VWAP (≤${readyVwapMax.toFixed(2)}%)`,
        (reclaim ? 'VWAP reclaim' : 'VWAP tap & hold'),
        'Trend up (EMA50 > EMA200)',
        'Strong-bodied close',
        (confirm15mStrict ? '15m confirm' : '15m soft-confirm'),
        `VolSpike ${volSpikeNow.toFixed(2)}x`,
        `ATR% ≤ ${(thresholds.atrGuardPct * 1.2).toFixed(2)}`,
        'Session active',
        (btcBull ? 'BTC bullish (15m)'
          : btcBear ? 'BTC bearish (strict+trend+vol override)'
          : 'BTC neutral (strict 15m)')
      );
    }
  }

  /** ===================== EARLY READY ===================== */
  const earlyOk =
    sessionOK &&
    nearVwapWatch &&
    rsiWatchOk &&
    emaWatchOk &&
    atrOkReady &&
    (reclaim || tappedVwapPrev) &&
    price >= vwap_i;

  if (!category && earlyOk) {
    category = 'EARLY_READY';
    reasons.push(
      `Near VWAP (≤${Math.max(thresholds.vwapDistancePct, VWAP_WATCH_MIN_PCT).toFixed(2)}%)`,
      (reclaim ? 'VWAP reclaim' : 'VWAP tap & hold'),
      (emaWatchOk ? 'EMA200 ok (soft)' : ''),
      'RSI rising (early)',
      `ATR% ≤ ${(thresholds.atrGuardPct * 1.2).toFixed(2)}`,
      (confirm15mSoft || confirm15mStrict) ? '15m bias ok' : '15m not required for Early'
    );
  }

  /** ===================== WATCH ===================== */
  const watchOk =
    nearVwapWatch &&
    rsiWatchOk &&
    emaWatchOk;

  if (!category && watchOk) {
    category = 'WATCH';
    const watchReasons: string[] = [
      `Near VWAP (≤${Math.max(thresholds.vwapDistancePct, VWAP_WATCH_MIN_PCT).toFixed(2)}%)`,
      (emaWatchOk ? 'EMA200 ok (soft)' : ''),
      `RSI rising (≥${RSI_EARLY_MIN})`,
      (confirm15mSoft || confirm15mStrict) ? '15m bias ok' : '15m bias not required'
    ];
    if (reclaim) watchReasons.splice(1, 0, 'VWAP reclaim');
    else if (tappedVwapPrev) watchReasons.splice(1, 0, 'VWAP tap & hold');
    reasons.push(...watchReasons.filter(Boolean));
  }

  if (category && (category === 'EARLY_READY' || category === 'WATCH') && market && !btcBull) {
    reasons.push(btcBear ? 'BTC bearish (15m)' : 'BTC not supportive (15m)');
  }

  if (!category) return null;

  // Trade plan (spot-friendly)
  let stop: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let target: number | null = null;
  let rr: number | null = null;
  let riskPct: number | null = null;

  const ATR_STOP_MULT = parseFloat(process.env.STOP_ATR_MULT || '1.5');

  // Prefer sweep wick as stop
  const stopCandidate = liq.ok ? liq.sweptLow : null;
  if (stopCandidate != null && Number.isFinite(stopCandidate) && price > stopCandidate) {
    stop = stopCandidate;
  } else {
    // Fallback to recent lowest low
    const recentLow = swingLow(data5, Math.max(0, i - LIQ_LOOKBACK), i).price;
    if (Number.isFinite(recentLow) && price > recentLow) {
      stop = recentLow;
    } else {
      // Final fallback: ATR-based stop
      const atrPrice = price * (atrNow / 100);
      const atrStop = price - (atrPrice * ATR_STOP_MULT);
      if (Number.isFinite(atrStop) && atrStop > 0 && price > atrStop) {
        stop = atrStop;
      }
    }
  }

  if (stop != null && price > stop) {
    const risk = price - stop;
    riskPct = (risk / price) * 100;
    tp1 = price + risk;
    tp2 = price + risk * 2;
    target = tp2;

    // Prefer real upside liquidity only if above price; otherwise keep 2R target.
    const targetCandidate = nearestUpsideLiquidity(data5, LIQ_LOOKBACK);
    if (Number.isFinite(targetCandidate) && targetCandidate > price) {
      target = targetCandidate;
    }

    const reward = (target ?? tp2) - price;
    if (reward > 0) rr = reward / risk;
  }

  const planOk =
    stop != null &&
    riskPct != null &&
    (MIN_RISK_PCT <= 0 || riskPct >= MIN_RISK_PCT) &&
    (category !== 'BEST_ENTRY' || rr != null);

  if ((category === 'BEST_ENTRY' || category === 'READY_TO_BUY') && !planOk) {
    reasons.push('Downgraded: no valid trade plan');
    if (earlyOk) category = 'EARLY_READY';
    else if (watchOk) category = 'WATCH';
    else return null;
  }

  if (riskPct != null && MIN_RISK_PCT > 0 && riskPct < MIN_RISK_PCT) return null;

  let wouldBeCategory: Signal['category'] | null = blockedByBtc ? 'READY_TO_BUY' : null;
  let btcGate: string | null = null;
  let btcGateReason: string | null = null;

  if (BEAR_GATE_ENABLED && btcBear && category && category !== 'WATCH') {
    const holdN = Math.max(1, BEAR_GATE_HOLD_CANDLES);
    const holdStart = Math.max(0, closes5.length - holdN);
    const heldAboveVwap = Number.isFinite(vwap_i)
      && closes5.slice(holdStart).length === holdN
      && closes5.slice(holdStart).every((c) => c > vwap_i);
    const passReclaim = heldAboveVwap && price > vwap_i;
    const passRsi = Number.isFinite(rsiNow) && rsiNow >= BEAR_GATE_RSI_MIN;
    const passVol = Number.isFinite(volSpikeNow)
      && volSpikeNow >= (thresholds.volSpikeX * BEAR_GATE_VOL_MULT)
      && price > vwap_i;

    if (passReclaim) {
      btcGate = 'PASS_RECLAIM';
      btcGateReason = 'PASS_RECLAIM';
      reasons.push('BTC bear gate: pass reclaim');
    } else if (passRsi) {
      btcGate = 'PASS_RSI';
      btcGateReason = 'PASS_RSI';
      reasons.push('BTC bear gate: pass RSI');
    } else if (passVol) {
      btcGate = 'PASS_VOL';
      btcGateReason = 'PASS_VOL';
      reasons.push('BTC bear gate: pass vol');
    } else {
      btcGate = 'FAIL_BEAR';
      btcGateReason = 'FAIL_BEAR';
      if (!wouldBeCategory) wouldBeCategory = category;
      category = 'WATCH';
      reasons.push('BTC bear gate failed -> WATCH');
    }
  }

  const bestGates: Gate[] = [
    { key: 'price>VWAP', ok: price > vwap_i, reason: 'Price not above VWAP' },
    { key: 'priceAboveEma', ok: priceAboveEma, reason: 'Price not above EMA200' },
    { key: 'nearVwapBuy', ok: nearVwapBuy, reason: 'Too far from VWAP (extended)' },
    { key: 'rsiBestOk', ok: rsiBestOk, reason: `RSI not in ${RSI_BEST_MIN}–${RSI_BEST_MAX} rising window` },
    { key: 'strongBody', ok: strongBodyBest, reason: 'No strong bullish body candle' },
    { key: 'atrOkBest', ok: atrOkBest, reason: 'ATR too high' },
    { key: 'trendOk', ok: trendOk, reason: 'Trend not OK (EMA50>EMA200 + both rising)' },
    { key: 'sessionOK', ok: sessionOK, reason: 'Session not active' },
    { key: 'confirm15mOk', ok: confirm15mOk, reason: '15m confirmation not satisfied' },
    { key: 'liqSweep', ok: liq.ok, reason: 'Liquidity sweep not detected' },
    { key: 'reclaimOrTap', ok: reclaimOk, reason: reclaimDayBlocked ? 'Reclaim/tap blocked by UTC day boundary' : 'No reclaim/tap pattern' },
    { key: 'bestVolOk', ok: bestVolOk, reason: 'Volume spike not met' },
    { key: 'rrOk', ok: rrOK, reason: `R:R below ${RR_MIN_BEST.toFixed(2)}` },
    { key: 'hasMarket', ok: hasMarket, reason: 'BTC market data missing' },
    { key: 'btcBull', ok: bestBtcOk, reason: 'BTC not bullish (15m)' },
  ];
  const bestDebug = buildGateDebug(bestGates);

  const cleanedReasons = reasons.filter(Boolean);
  const gateSnapshot = {
    ready: {
      sessionOk: sessionOK,
      priceAboveVwap: readyPriceAboveVwap,
      priceAboveEma,
      nearVwap: nearVwapReady,
      confirm15: confirm15mOk,
      confirm15Strict: confirm15mStrict,
      trend: readyTrendOk,
      volSpike: readyVolOk,
      atr: atrOkReady,
      sweep: liq.ok,
      sweepFallback: readySweepFallbackOk,
      strongBody: strongBodyReady,
      reclaimOrTap: reclaimOk,
      rsiReadyOk,
      hasMarket,
      btc: readyBtcOk,
      core: readyCore,
    },
    best: {
      nearVwap: nearVwapBuy,
      confirm15: confirm15mOk,
      trend: trendOk,
      volSpike: bestVolOk,
      atr: atrOkBest,
      sweep: liq.ok,
      btc: bestBtcOk,
      rr: rrOK,
      core: bestCore,
    },
  };
  return {
    symbol,
    category,
    price,
    vwap: vwap_i,
    ema200: emaNow,
    rsi9: rsiNow,
    volSpike: volSpikeNow,
    atrPct: atrNow,
    confirm15m: confirm15mOk,
    deltaVwapPct: distToVwapPct,
    stop,
    tp1,
    tp2,
    target,
    rr,
    riskPct,
    market,
    reasons: cleanedReasons,
    thresholdVwapDistancePct: thresholds.vwapDistancePct,
    thresholdVolSpikeX: thresholds.volSpikeX,
    thresholdAtrGuardPct: thresholds.atrGuardPct,
    confirm15mStrict,
    confirm15mSoft,
    sessionOk: sessionOK,
    sweepOk: liq.ok,
    trendOk,
    rrEstimate: liq.ok ? rrVal : null,
    blockedByBtc,
    wouldBeCategory,
    btcGate,
    btcGateReason,
    gateSnapshot,
    blockedReasons: readyDebug.blockedReasons,
    firstFailedGate: readyDebug.firstFailedGate,
    gateScore: readyDebug.gateScore,
    readyDebug,
    bestDebug
  };
}
