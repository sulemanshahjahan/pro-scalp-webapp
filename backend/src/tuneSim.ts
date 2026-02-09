import type { Thresholds } from './logic.js';

export type TuneConfig = {
  thresholds: Thresholds;
  RSI_BEST_MIN: number;
  RSI_BEST_MAX: number;
  RSI_READY_MIN: number;
  RSI_READY_MAX: number;
  RSI_EARLY_MIN: number;
  RSI_EARLY_MAX: number;
  RSI_DELTA_STRICT: number;
  MIN_BODY_PCT: number;
  READY_BODY_PCT: number;
  READY_CLOSE_POS_MIN: number;
  READY_UPPER_WICK_MAX: number;
  VWAP_WATCH_MIN_PCT: number;
  READY_VWAP_MAX_PCT: number | null;
  READY_VWAP_EPS_PCT: number;
  READY_VWAP_TOUCH_PCT: number;
  READY_VWAP_TOUCH_BARS: number;
  READY_EMA_EPS_PCT: number;
  WATCH_EMA_EPS_PCT: number;
  EMA5_WATCH_SOFT_TOL: number;
  RR_MIN_BEST: number;
  READY_NO_SWEEP_VWAP_CAP: number;
  READY_RECLAIM_REQUIRED: boolean;
  READY_CONFIRM15_REQUIRED: boolean;
  READY_TREND_REQUIRED: boolean;
  READY_VOL_SPIKE_REQUIRED: boolean;
  BEST_VWAP_MAX_PCT: number | null;
  BEST_VWAP_EPS_PCT: number;
  BEST_EMA_EPS_PCT: number;
};

export type EvalResult = {
  watchOk: boolean;
  earlyOk: boolean;
  readyOk: boolean;
  bestOk: boolean;
  readyCore: boolean;
  bestCore: boolean;
  readySweepOk: boolean;
  readyBtcOk: boolean;
  bestBtcOk: boolean;
  watchFlags: Record<string, boolean>;
  earlyFlags: Record<string, boolean>;
  readyFlags: Record<string, boolean>;
  bestFlags: Record<string, boolean>;
};

export type CandidateFeatureInput = {
  metrics: Record<string, any>;
  computed: Record<string, any>;
};

export type OverrideReport = {
  config: TuneConfig;
  appliedOverrides: Record<string, number | boolean>;
  unknownOverrideKeys: string[];
  overrideTypeErrors: Record<string, string>;
};

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function parseBool(v: any): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n'].includes(s)) return false;
  }
  return null;
}

export function getTuneConfigFromEnv(thresholds: Thresholds): TuneConfig {
  const READY_VWAP_MAX_PCT = parseFloat(process.env.READY_VWAP_MAX_PCT || '');
  const BEST_VWAP_MAX_PCT = parseFloat(process.env.BEST_VWAP_MAX_PCT || '');
  return {
    thresholds,
    RSI_BEST_MIN: parseFloat(process.env.RSI_BEST_MIN || '55'),
    RSI_BEST_MAX: parseFloat(process.env.RSI_BEST_MAX || '72'),
    RSI_READY_MIN: parseFloat(process.env.RSI_READY_MIN || '52'),
    RSI_READY_MAX: parseFloat(process.env.RSI_READY_MAX || '78'),
    RSI_EARLY_MIN: parseFloat(process.env.RSI_EARLY_MIN || '48'),
    RSI_EARLY_MAX: parseFloat(process.env.RSI_EARLY_MAX || '80'),
    RSI_DELTA_STRICT: parseFloat(process.env.RSI_DELTA_STRICT || '0.2'),
    MIN_BODY_PCT: parseFloat(process.env.MIN_BODY_PCT || '0.15'),
    READY_BODY_PCT: parseFloat(process.env.READY_BODY_PCT || '0.10'),
    READY_CLOSE_POS_MIN: parseFloat(process.env.READY_CLOSE_POS_MIN || '0.60'),
    READY_UPPER_WICK_MAX: parseFloat(process.env.READY_UPPER_WICK_MAX || '0.40'),
    VWAP_WATCH_MIN_PCT: parseFloat(process.env.VWAP_WATCH_MIN_PCT || '0.80'),
    READY_VWAP_MAX_PCT: Number.isFinite(READY_VWAP_MAX_PCT) ? READY_VWAP_MAX_PCT : null,
    READY_VWAP_EPS_PCT: parseFloat(process.env.READY_VWAP_EPS_PCT || '0.02'),
    READY_VWAP_TOUCH_PCT: parseFloat(process.env.READY_VWAP_TOUCH_PCT || '0.20'),
    READY_VWAP_TOUCH_BARS: parseInt(process.env.READY_VWAP_TOUCH_BARS || '5', 10),
    READY_EMA_EPS_PCT: parseFloat(process.env.READY_EMA_EPS_PCT || '0'),
    WATCH_EMA_EPS_PCT: parseFloat(process.env.WATCH_EMA_EPS_PCT || '0'),
    EMA5_WATCH_SOFT_TOL: 0.25,
    RR_MIN_BEST: parseFloat(process.env.RR_MIN_BEST || '2.0'),
    READY_NO_SWEEP_VWAP_CAP: 0.20,
    READY_RECLAIM_REQUIRED: (process.env.READY_RECLAIM_REQUIRED ?? 'true').toLowerCase() !== 'false',
    READY_CONFIRM15_REQUIRED: (process.env.READY_CONFIRM15_REQUIRED ?? 'true').toLowerCase() !== 'false',
    READY_TREND_REQUIRED: (process.env.READY_TREND_REQUIRED ?? 'true').toLowerCase() !== 'false',
    READY_VOL_SPIKE_REQUIRED: (process.env.READY_VOL_SPIKE_REQUIRED ?? 'true').toLowerCase() !== 'false',
    BEST_VWAP_MAX_PCT: Number.isFinite(BEST_VWAP_MAX_PCT) ? BEST_VWAP_MAX_PCT : null,
    BEST_VWAP_EPS_PCT: parseFloat(process.env.BEST_VWAP_EPS_PCT || '0'),
    BEST_EMA_EPS_PCT: parseFloat(process.env.BEST_EMA_EPS_PCT || '0'),
  };
}

export function applyOverrides(cfg: TuneConfig, overrides?: Record<string, any>): OverrideReport {
  const out: TuneConfig = { ...cfg, thresholds: { ...cfg.thresholds } };
  const appliedOverrides: Record<string, number | boolean> = {};
  const unknownOverrideKeys: string[] = [];
  const overrideTypeErrors: Record<string, string> = {};

  if (!overrides || typeof overrides !== 'object') {
    return { config: out, appliedOverrides, unknownOverrideKeys, overrideTypeErrors };
  }

  for (const [key, raw] of Object.entries(overrides)) {
    if (key in out) {
      const current = (out as any)[key];
      if (typeof current === 'boolean') {
        const b = parseBool(raw);
        if (b == null) {
          overrideTypeErrors[key] = `Expected boolean, got ${typeof raw}`;
          continue;
        }
        (out as any)[key] = b;
        appliedOverrides[key] = b;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        overrideTypeErrors[key] = `Expected number, got ${typeof raw}`;
        continue;
      }
      (out as any)[key] = n;
      appliedOverrides[key] = n;
      continue;
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) {
      overrideTypeErrors[key] = `Expected number, got ${typeof raw}`;
      continue;
    }
    if (key === 'THRESHOLD_VWAP_DISTANCE_PCT') {
      out.thresholds.vwapDistancePct = n;
      appliedOverrides[key] = n;
      continue;
    }
    if (key === 'THRESHOLD_VOL_SPIKE_X') {
      out.thresholds.volSpikeX = n;
      appliedOverrides[key] = n;
      continue;
    }
    if (key === 'THRESHOLD_ATR_GUARD_PCT') {
      out.thresholds.atrGuardPct = n;
      appliedOverrides[key] = n;
      continue;
    }
    unknownOverrideKeys.push(key);
  }

  return { config: out, appliedOverrides, unknownOverrideKeys, overrideTypeErrors };
}

export function evalFromFeatures(f: CandidateFeatureInput, cfg: TuneConfig): EvalResult {
  const metrics = f.metrics ?? ({} as any);
  const computed = f.computed ?? ({} as any);

  const price = num(metrics.price);
  const vwap = num(metrics.vwap);
  const ema = num(metrics.ema200);
  const vwapDistPct = Number.isFinite(num(metrics.vwapDistPct))
    ? num(metrics.vwapDistPct)
    : (Number.isFinite(price) && Number.isFinite(vwap) && vwap !== 0)
      ? ((price - vwap) / vwap) * 100
      : NaN;
  const emaDistPct = Number.isFinite(num(metrics.emaDistPct))
    ? num(metrics.emaDistPct)
    : (Number.isFinite(price) && Number.isFinite(ema) && ema !== 0)
      ? ((price - ema) / ema) * 100
      : NaN;

  const rsi = num(metrics.rsi);
  const rsiPrev = Number.isFinite(num(metrics.rsiPrev))
    ? num(metrics.rsiPrev)
    : Number.isFinite(num(metrics.rsiDelta))
      ? rsi - num(metrics.rsiDelta)
      : NaN;
  const rsiDelta = Number.isFinite(num(metrics.rsiDelta))
    ? num(metrics.rsiDelta)
    : Number.isFinite(rsiPrev) && Number.isFinite(rsi)
      ? rsi - rsiPrev
      : NaN;

  const atrPct = num(metrics.atrPct);
  const volSpike = num(metrics.volSpike);
  const bodyPct = num(metrics.bodyPct);
  const closePos = num(metrics.closePos);
  const upperWickPct = num(metrics.upperWickPct);

  const sessionOk = Boolean(computed.sessionOk);
  const reclaimOrTap = Boolean(computed.reclaimOrTap);
  const trendOk = Boolean(computed.trendOk);
  const readyTrendOk = computed.readyTrendOk == null ? trendOk : Boolean(computed.readyTrendOk);
  const confirm15Strict = Boolean(computed.confirm15Strict);
  const confirm15Soft = Boolean(computed.confirm15Soft);
  const confirm15Ok = computed.confirm15Ok == null ? (confirm15Strict || confirm15Soft) : Boolean(computed.confirm15Ok);
  const sweepOk = Boolean(computed.sweepOk);
  const rrOk = Boolean(computed.rrOk);
  const hasMarket = Boolean(computed.hasMarket);
  const btcBull = Boolean(computed.btcBull);
  const btcBear = Boolean(computed.btcBear);
  const bullish = computed.bullish == null ? true : Boolean(computed.bullish);

  const readyVwapMax = Number.isFinite(cfg.READY_VWAP_MAX_PCT) ? (cfg.READY_VWAP_MAX_PCT as number) : cfg.thresholds.vwapDistancePct;
  const bestVwapMax = Number.isFinite(cfg.BEST_VWAP_MAX_PCT) ? (cfg.BEST_VWAP_MAX_PCT as number) : cfg.thresholds.vwapDistancePct;
  const nearVwapBuy = Math.abs(vwapDistPct) <= bestVwapMax;
  const nearVwapWatch = Math.abs(vwapDistPct) <= Math.max(cfg.thresholds.vwapDistancePct, cfg.VWAP_WATCH_MIN_PCT);

  const nearVwapReadyDist = Math.abs(vwapDistPct) <= readyVwapMax;
  const touchBarsRaw = Number(cfg.READY_VWAP_TOUCH_BARS);
  const touchBars = Number.isFinite(touchBarsRaw)
    ? Math.max(1, Math.min(200, Math.floor(touchBarsRaw)))
    : 1;
  const lowDistSeries = Array.isArray(metrics.vwapLowDistPctLast) ? metrics.vwapLowDistPctLast : [];
  const tail = lowDistSeries.length > touchBars
    ? lowDistSeries.slice(-touchBars)
    : lowDistSeries;
  const touchedVwapRecently = tail.length
    ? tail.some((d: any) => Number.isFinite(num(d)) && num(d) <= cfg.READY_VWAP_TOUCH_PCT)
    : Boolean(metrics.touchedVwapWithinPctLastNBars);
  const nearVwapReady = nearVwapReadyDist && touchedVwapRecently;

  const priceAboveEma = emaDistPct >= -cfg.READY_EMA_EPS_PCT;
  const bestPriceAboveEma = emaDistPct >= -cfg.BEST_EMA_EPS_PCT;
  const emaWatchOk =
    emaDistPct >= -cfg.WATCH_EMA_EPS_PCT ||
    emaDistPct >= -cfg.EMA5_WATCH_SOFT_TOL;

  const rsiBestOk = rsi >= cfg.RSI_BEST_MIN && rsi <= cfg.RSI_BEST_MAX && rsiDelta >= cfg.RSI_DELTA_STRICT;
  const rsiReadyOk = rsi >= cfg.RSI_READY_MIN && rsi <= cfg.RSI_READY_MAX && rsiDelta >= cfg.RSI_DELTA_STRICT;
  const rsiWatchOk =
    rsi >= cfg.RSI_EARLY_MIN &&
    rsi <= cfg.RSI_EARLY_MAX &&
    (Number.isFinite(rsiPrev) ? rsi >= (rsiPrev - 0.2) : true);

  const strongBodyBest = bullish && bodyPct >= cfg.MIN_BODY_PCT && upperWickPct <= 0.5;
  const strongBodyReady = bullish &&
    bodyPct >= cfg.READY_BODY_PCT &&
    closePos >= cfg.READY_CLOSE_POS_MIN &&
    upperWickPct <= cfg.READY_UPPER_WICK_MAX;

  const priceAboveVwapStrict = vwapDistPct > 0;
  const priceAboveVwapEarly = vwapDistPct >= 0;
  const readyPriceAboveVwapRelaxedEligible = !priceAboveVwapStrict && nearVwapReady;
  const readyPriceAboveVwapRelaxedTrue =
    readyPriceAboveVwapRelaxedEligible &&
    vwapDistPct >= -cfg.READY_VWAP_EPS_PCT;
  const readyPriceAboveVwap = priceAboveVwapStrict || readyPriceAboveVwapRelaxedTrue;
  const bestPriceAboveVwap =
    vwapDistPct > 0 ||
    (nearVwapBuy && vwapDistPct >= -cfg.BEST_VWAP_EPS_PCT);

  const volBestMin = Math.max(cfg.thresholds.volSpikeX, 1.4);
  const bestVolOk = volSpike >= Math.max(1.2, volBestMin);

  const atrOkReady = atrPct <= cfg.thresholds.atrGuardPct * 1.2;
  const atrOkBest = atrPct <= cfg.thresholds.atrGuardPct;

  const isBalancedPreset =
    cfg.thresholds.volSpikeX === 1.5 &&
    cfg.thresholds.vwapDistancePct === 0.30 &&
    cfg.thresholds.atrGuardPct === 2.5;
  const readyVolMinBase = isBalancedPreset ? 1.3 : Math.max(1.2, cfg.thresholds.volSpikeX);
  const readyVolMin =
    isBalancedPreset && nearVwapReady && reclaimOrTap
      ? 1.2
      : readyVolMinBase;
  const readyVolOk = volSpike >= readyVolMin;

  const readyNoSweepVwapCap = cfg.READY_NO_SWEEP_VWAP_CAP;
  const nearVwapReadyNoSweep = Math.abs(vwapDistPct) <= readyNoSweepVwapCap;

  const readyReclaimOk = cfg.READY_RECLAIM_REQUIRED ? reclaimOrTap : true;
  const readyConfirmOk = cfg.READY_CONFIRM15_REQUIRED ? confirm15Ok : true;
  const readyTrendOkReq = cfg.READY_TREND_REQUIRED ? readyTrendOk : true;
  const readyVolOkReq = cfg.READY_VOL_SPIKE_REQUIRED ? readyVolOk : true;

  const readyCore =
    sessionOk &&
    readyPriceAboveVwap &&
    priceAboveEma &&
    rsiReadyOk &&
    nearVwapReady &&
    readyReclaimOk &&
    readyVolOkReq &&
    atrOkReady &&
    readyConfirmOk &&
    strongBodyReady &&
    readyTrendOkReq;

  const readyBtcOk = hasMarket && (
    btcBull ||
    (!btcBear && confirm15Strict) ||
    (btcBear && confirm15Strict && trendOk && strongBodyReady && readyVolOk)
  );
  const readySweepFallbackOk = reclaimOrTap && confirm15Strict && readyTrendOk && nearVwapReadyNoSweep;
  const readySweepOk = sweepOk || readySweepFallbackOk;
  const readyOk = readyCore && readySweepOk && readyBtcOk;

  const bestCorePreSweep =
    bestPriceAboveEma &&
    bestPriceAboveVwap &&
    nearVwapBuy &&
    rsiBestOk &&
    strongBodyBest &&
    atrOkBest &&
    trendOk &&
    sessionOk &&
    confirm15Ok &&
    reclaimOrTap &&
    bestVolOk &&
    hasMarket;
  const bestCore =
    bestCorePreSweep &&
    sweepOk &&
    rrOk;
  const bestBtcOk = hasMarket && btcBull;
  const bestOk = bestCore && bestBtcOk;

  return {
    watchOk: nearVwapWatch && rsiWatchOk && emaWatchOk,
    earlyOk:
      sessionOk &&
      nearVwapWatch &&
      rsiWatchOk &&
      emaWatchOk &&
      atrOkReady &&
      reclaimOrTap &&
      priceAboveVwapEarly,
    readyOk,
    bestOk,
    readyCore,
    bestCore,
    readySweepOk,
    readyBtcOk,
    bestBtcOk,
    watchFlags: {
      nearVwapWatch,
      rsiWatchOk,
      emaWatchOk,
    },
    earlyFlags: {
      sessionOK: sessionOk,
      nearVwapWatch,
      rsiWatchOk,
      emaWatchOk,
      atrOkReady,
      reclaimOrTap,
      priceAboveVwap: priceAboveVwapEarly,
    },
    readyFlags: {
      sessionOK: sessionOk,
      priceAboveVwap: readyPriceAboveVwap,
      priceAboveEma,
      nearVwapReady,
      reclaimOrTap: readyReclaimOk,
      readyVolOk: readyVolOkReq,
      atrOkReady,
      confirm15mOk: readyConfirmOk,
      strongBody: strongBodyReady,
      rsiReadyOk,
      readyTrendOk: readyTrendOkReq,
    },
    bestFlags: {
      priceAboveVwap: bestPriceAboveVwap,
      priceAboveEma: bestPriceAboveEma,
      nearVwapBuy,
      rsiBestOk,
      strongBody: strongBodyBest,
      atrOkBest,
      trendOk,
      sessionOK: sessionOk,
      confirm15mOk: confirm15Ok,
      sweepOk,
      reclaimOrTap,
      bestVolOk,
      rrOk,
      hasMarket,
    },
  };
}
