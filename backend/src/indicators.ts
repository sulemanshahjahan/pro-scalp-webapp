// Exact indicator formulas per spec

export function ema(series: number[], period: number): number[] {
  if (series.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = series[0];
  out.push(prev);
  for (let i = 1; i < series.length; i++) {
    const v = series[i] * k + prev * (1 - k);
    out.push(v);
    prev = v;
  }
  return out;
}

// RSI 9 using EMA of up/down moves
export function rsi(series: number[], period: number = 9): number[] {
  if (series.length < 2) return series.map(() => 50);
  const ups: number[] = [0];
  const downs: number[] = [0];
  for (let i = 1; i < series.length; i++) {
    const ch = series[i] - series[i-1];
    ups.push(Math.max(ch, 0));
    downs.push(Math.max(-ch, 0));
  }
  const avgUp = ema(ups, period);
  const avgDown = ema(downs, period);
  const rsiOut: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const rs = avgDown[i] === 0 ? 1000 : avgUp[i] / avgDown[i];
    const rsi = 100 - (100 / (1 + rs));
    rsiOut.push(rsi);
  }
  return rsiOut;
}

// VWAP (rolling intraday) from OHLCV arrays
export function vwap(typicalPrice: number[], volume: number[]): number[] {
  const out: number[] = [];
  let cumPV = 0;
  let cumVol = 0;
  for (let i = 0; i < typicalPrice.length; i++) {
    cumPV += typicalPrice[i] * volume[i];
    cumVol += volume[i];
    out.push(cumPV / Math.max(cumVol, 1e-9));
  }
  return out;
}

// ATR% (EMA of TR 14, divided by close)
export function atrPct(high: number[], low: number[], close: number[], period: number = 14): number[] {
  const tr: number[] = [];
  for (let i = 0; i < close.length; i++) {
    if (i === 0) {
      tr.push(high[i] - low[i]);
    } else {
      tr.push(Math.max(
        high[i] - low[i],
        Math.abs(high[i] - close[i-1]),
        Math.abs(low[i] - close[i-1])
      ));
    }
  }
  const atr = ema(tr, period);
  return atr.map((a, i) => (a / close[i]) * 100);
}

// SMA for volume
export function sma(series: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= period) sum -= series[i - period];
    out.push(i+1 < period ? sum / (i+1) : sum / period);
  }
  return out;
}

export function volumeSpike(vol: number[], period: number = 20): number[] {
  const base = sma(vol, period);
  return vol.map((v, i) => (base[i] === 0 ? 0 : v / base[i]));
}
