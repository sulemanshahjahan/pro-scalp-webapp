// backend/src/logic.ts
import { ema, rsi, vwap, atrPct, volumeSpike } from './indicators.js';
import type { OHLCV, Signal } from './types.js';

export interface Thresholds {
  vwapDistancePct: number; // e.g. 0.30  => ±0.30%
  volSpikeX: number;       // e.g. 1.5   => 1.5x recent avg
  atrGuardPct: number;     // e.g. 2.5   => ATR% must be ≤ 2.5
}

/** =================== Tunables & Env =================== */
const RSI_MIN = 55;          // sweet-spot floor for longs
const RSI_MAX = 80;          // cap to avoid chasing overbought
const MIN_BODY_PCT = 0.15;   // candle body filter (%)
const MIN_ATR_PCT = 0.10;    // skip when 5m ATR% < 0.10% (too dead)
const EMA15_SOFT_TOL = 0.10; // % below EMA200 allowed on 15m soft confirm
const RSI15_FLOOR_SOFT = 50; // 15m RSI soft floor (align w/ higher-TF bias)

const LIQ_LOOKBACK = parseInt(process.env.LIQ_LOOKBACK || '20', 10);
const RR_MIN_BEST  = parseFloat(process.env.RR_MIN_BEST || '2.0');
const SESSION_FILTER_ENABLED = (process.env.SESSION_FILTER_ENABLED ?? 'true').toLowerCase() !== 'false';
// Default UTC windows (approx London & NY opens). Format: "start-end,start-end" 24h UTC
// e.g. "07-11,13-20" => 07:00–10:59 and 13:00–19:59 UTC
const SESSIONS_UTC = process.env.SESSIONS_UTC || '07-11,13-20';
/** ===================================================== */

/** ----- Helpers: daily-anchored VWAP on 5m (fallback = last 24h) ----- */
function dayAnchorIndex5m(data5: OHLCV[]): number {
  const i = data5.length - 1;
  const hasTime = (data5[i] as any).time != null || (data5[i] as any).openTime != null;
  if (!hasTime) return Math.max(0, data5.length - 288);
  const getMs = (d: any) => (d.time ?? d.openTime) as number;
  const endUTCDate = new Date(getMs(data5[i])).getUTCDate();
  let anchor = i;
  while (anchor > 0) {
    const prevUTCDate = new Date(getMs(data5[anchor - 1])).getUTCDate();
    if (prevUTCDate !== endUTCDate) break;
    anchor--;
  }
  return anchor;
}
function anchoredVwapAt(tp: number[], vol: number[], start: number, j: number): number {
  let num = 0, den = 0;
  for (let k = start; k <= j; k++) { num += tp[k] * vol[k]; den += vol[k]; }
  return den ? num / den : tp[j];
}
/** ------------------------------------------------------------------- */

/** ---------- 15m confirmations (proxy for higher-TF alignment) ------ */
function confirm15_strict(data15: OHLCV[]): boolean {
  if (data15.length < 30) return false;
  const closes = data15.map(d => d.close);
  const vols   = data15.map(d => d.volume);
  const tp     = data15.map(d => (d.high + d.low + d.close) / 3);
  const v = vwap(tp, vols);
  const e = ema(closes, 200);
  const r = rsi(closes, 9);
  const i = closes.length - 1;
  const rsiOk = r[i] > 55 && r[i] < 80 && r[i] >= r[i - 1];
  return closes[i] > v[i] && closes[i] > e[i] && rsiOk;
}

function confirm15_soft(data15: OHLCV[]): boolean {
  if (data15.length < 30) return false;
  const closes = data15.map(d => d.close);
  const vols   = data15.map(d => d.volume);
  const tp     = data15.map(d => (d.high + d.low + d.close) / 3);
  const v = vwap(tp, vols);
  const e = ema(closes, 200);
  const r = rsi(closes, 9);
  const i = closes.length - 1;

  if (confirm15_strict(data15)) return true;

  const hadRecentStrict =
    i >= 1 && closes[i - 1] > v[i - 1] && closes[i - 1] > e[i - 1] &&
    r[i - 1] > 55 && r[i - 1] < 80 && r[i - 1] >= r[i - 2];

  if (hadRecentStrict) return true;

  const aboveVwap = closes[i] > v[i];
  const nearOrAboveEma = closes[i] > e[i] || (((e[i] - closes[i]) / e[i]) * 100 <= EMA15_SOFT_TOL);
  const rsiSoftOk = r[i] >= RSI15_FLOOR_SOFT && r[i] < 80 && r[i] >= r[i - 1] - 0.3;

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

/** Long-side sweep & reclaim:
 *  - last candle makes a lower low than any of the prior LIQ_LOOKBACK bars (stop-hunt),
 *  - then closes back above that prior swing and above VWAP (reclaim).
 */
function detectLiquiditySweepLong(data5: OHLCV[], vwap_i: number, lookback = LIQ_LOOKBACK) {
  const i = data5.length - 1;
  const start = Math.max(0, i - 1 - lookback);
  const prior = swingLow(data5, start, i - 1);
  const lastLow = data5[i].low;
  const lastClose = data5[i].close;
  const swept = lastLow < prior.price;
  const reclaimed = lastClose > prior.price && lastClose > vwap_i;
  return { ok: swept && reclaimed, sweptLow: prior.price };
}

/** Nearest upside liquidity (target) = highest high over last lookback */
function nearestUpsideLiquidity(data5: OHLCV[], lookback = LIQ_LOOKBACK) {
  const i = data5.length - 1;
  const start = Math.max(0, i - lookback);
  return swingHigh(data5, start, i - 1).price;
}

/** Simple session filter using UTC hour windows (configurable) */
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
  thresholds: Thresholds
): Signal | null {
  if (data5.length < 210 || data15.length < 30) return null;

  // ----- 5m series -----
  const closes5 = data5.map(d => d.close);
  const highs5  = data5.map(d => d.high);
  const lows5   = data5.map(d => d.low);
  const vols5   = data5.map(d => d.volume);
  const tp5     = data5.map(d => (d.high + d.low + d.close) / 3);

  const ema200_5   = ema(closes5, 200);
  const rsi9_5     = rsi(closes5, 9);
  const atrp_5     = atrPct(highs5, lows5, closes5, 14);
  const volspike_5 = volumeSpike(vols5, 20);

  const i  = data5.length - 1;
  const i1 = i - 1;
  const i2 = i - 2;

  const anchor = dayAnchorIndex5m(data5);
  const vwap_i2 = anchoredVwapAt(tp5, vols5, anchor, i2);
  const vwap_i1 = anchoredVwapAt(tp5, vols5, anchor, i1);
  const vwap_i  = anchoredVwapAt(tp5, vols5, anchor, i);

  const price       = closes5[i];
  const emaNow      = ema200_5[i];
  const rsiNow      = rsi9_5[i];
  const rsiPrev     = rsi9_5[i - 1];
  const atrNow      = atrp_5[i];
  const volSpikeNow = volspike_5[i];

  if (atrNow < MIN_ATR_PCT) return null;

  // Distance to anchored VWAP
  const distToVwapPct = ((price - vwap_i) / vwap_i) * 100;
  const nearVwapAdaptive = Math.abs(price - vwap_i) / vwap_i <= (thresholds.vwapDistancePct / 100);

  // Reclaim / bounce patterns around VWAP
  const reclaim =
    (closes5[i1] > vwap_i1) && (closes5[i2] <= vwap_i2 || Math.abs((closes5[i2] - vwap_i2) / vwap_i2) <= (thresholds.vwapDistancePct / 100));
  const tappedVwapPrev =
    lows5[i1] <= vwap_i1 * (1 + thresholds.vwapDistancePct / 100) && closes5[i1] >= vwap_i1;

  const priceAboveEma = price > emaNow;
  const risingRSI     = rsiNow >= RSI_MIN && rsiNow < RSI_MAX && rsiNow >= rsiPrev;

  const openNow   = (data5[i] as any).open;
  const bodyPct   = Math.abs((closes5[i] - openNow) / openNow) * 100;
  const strongBody = bodyPct >= MIN_BODY_PCT &&
    (highs5[i] - closes5[i]) <= (highs5[i] - lows5[i]) * 0.5;

  const confirm15mStrict = confirm15_strict(data15);
  const confirm15mSoft   = confirm15_soft(data15);

  // Volume thresholds
  const volReadyMin = Math.max(1.2, thresholds.volSpikeX - 0.2);
  const volBestMin  = Math.max(thresholds.volSpikeX, 1.4);

  // ATR guards
  const atrOkReady = atrNow <= thresholds.atrGuardPct * 1.2;
  const atrOkBest  = atrNow <= thresholds.atrGuardPct;

  // New: Session filter
  const sessionOK = sessionActiveUTC();

  // New: Liquidity sweep & reclaim (long side)
  const liq = detectLiquiditySweepLong(data5, vwap_i, LIQ_LOOKBACK);

  // New: R:R gate — use swept swing as SL, nearest upside liquidity as TP1
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

  /** ===================== BEST ENTRY (All 9 checks) =====================
   *  1) Higher TF aligned -> 15m strict/soft confirm
   *  2) Liquidity sweep & reclaim (long)
   *  3) VWAP + EMA200 reclaim (near VWAP)
   *  4) Volume > 1.2x (and >= volBestMin)
   *  5) RSI in sweet spot & rising
   *  6) Strong close (body filter)
   *  7) ATR within guard
   *  8) Session active
   *  9) R:R ≥ 1:2 (configurable via RR_MIN_BEST)
   */
  if (
    priceAboveEma &&
    price > vwap_i &&
    nearVwapAdaptive &&
    risingRSI &&
    strongBody &&
    atrOkBest &&
    sessionOK &&
    (confirm15mStrict || confirm15mSoft) &&
    liq.ok &&
    (volSpikeNow >= Math.max(1.2, volBestMin)) &&
    rrOK
  ) {
    category = 'BEST_ENTRY';
    reasons.push(
      'Higher-TF aligned (15m confirm)',
      'Liquidity sweep & reclaim',
      'Price > EMA200 & anchored VWAP (near VWAP)',
      `ΔVWAP ${distToVwapPct.toFixed(2)}%`,
      `RSI-9 rising (${RSI_MIN}–${RSI_MAX})`,
      'Strong-bodied close',
      `ATR% ≤ ${thresholds.atrGuardPct.toFixed(2)}`,
      'Session active',
      `R:R ${rrVal.toFixed(2)}≥${RR_MIN_BEST.toFixed(2)}`
    );
  }

  // READY_TO_BUY (looser; still enforces session + decent volume + R:R ≥ 1.5)
  if (
    !category &&
    sessionOK &&
    price > vwap_i &&
    priceAboveEma &&
    risingRSI &&
    nearVwapAdaptive &&
    atrOkReady &&
    (confirm15mSoft || volSpikeNow >= volReadyMin) &&
    strongBody
  ) {
    // quick R:R sanity, but a bit looser for Ready
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
        'RSI-9 rising',
        'Near VWAP',
        'Strong-bodied close',
        (confirm15mStrict ? '15m confirm' : (confirm15mSoft ? '15m soft-confirm' : '')),
        `VolSpike ${volSpikeNow.toFixed(2)}x`,
        `ATR% ≤ ${(thresholds.atrGuardPct * 1.2).toFixed(2)}`,
        'Session active'
      );
    }
  }

  // EARLY_READY (structure ok, session required; half-size idea kept)
  if (
    !category &&
    sessionOK &&
    price > vwap_i &&
    priceAboveEma &&
    risingRSI &&
    atrOkReady &&
    nearVwapAdaptive
  ) {
    category = 'EARLY_READY';
  }

  // WATCH (early setup; session not required)
  if (
    !category &&
    nearVwapAdaptive &&
    priceAboveEma &&
    rsiNow >= 50 && rsiNow < RSI_MAX && rsiNow >= rsiPrev &&
    (confirm15mSoft || confirm15mStrict)
  ) {
    category = 'WATCH';
    reasons.push('Near VWAP', 'Price ≥ EMA200', 'RSI-9 ≥ 50 & rising', '15m soft/strict confirm');
  }

  if (!category) return null;

  return {
    symbol,
    category,
    price,
    vwap: vwap_i,
    ema200: emaNow,
    rsi9: rsiNow,
    volSpike: volSpikeNow,
    atrPct: atrNow,
    confirm15m: confirm15mStrict || confirm15mSoft,
    deltaVwapPct: distToVwapPct,
    reasons
  };
}
