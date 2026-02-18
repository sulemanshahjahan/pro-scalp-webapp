import React from 'react';
import RiskCalc from './RiskCalc';

// Hold time config from env (build-time only)
const HOLD_MINUTES = Number(import.meta.env.VITE_SIGNAL_HOLD_MINUTES || 120);
const HOLD_MAX_HOURS = Number(import.meta.env.VITE_SIGNAL_HOLD_MAX_HOURS || 4);
const WIN_RATE_SHORT = import.meta.env.VITE_SIGNAL_WIN_RATE_SHORT || '7%';
const WIN_RATE_LONG = import.meta.env.VITE_SIGNAL_WIN_RATE_LONG || '37-44%';

function HoldTimeRecommendation({ category }: { category: string }) {
  const holdHours = (HOLD_MINUTES / 60).toFixed(1);
  const isBest = category?.toUpperCase().includes('BEST');
  
  return (
    <div className="mt-2 text-xs bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 text-emerald-300/90">
      <span className="font-semibold">⏱️ Hold Time:</span>{' '}
      {isBest ? (
        <>
          Hold {holdHours}-{HOLD_MAX_HOURS}h for optimal R.{' '}
          <span className="text-emerald-300/60">
            (Data: {WIN_RATE_LONG} win rate at {holdHours}-{HOLD_MAX_HOURS}h vs {WIN_RATE_SHORT} at 15m)
          </span>
        </>
      ) : (
        <>
          Consider {holdHours}-{HOLD_MAX_HOURS}h hold.{' '}
          <span className="text-emerald-300/60">(Longer horizons outperform)</span>
        </>
      )}
    </div>
  );
}

type Props = {
  s: any;
  onFav?: (symbol: string) => void;
};

function isShortCategory(cat: string) {
  return cat === 'READY_TO_SELL' || cat === 'BEST_SHORT_ENTRY' || cat === 'EARLY_READY_SHORT';
}

function badgeLabel(cat: string) {
  if (cat === 'BEST_ENTRY') return '[BEST] Long';
  if (cat === 'READY_TO_BUY') return '[READY] Long';
  if (cat === 'EARLY_READY') return '[EARLY] Long';
  if (cat === 'BEST_SHORT_ENTRY') return '[BEST] Short';
  if (cat === 'READY_TO_SELL') return '[READY] Short';
  if (cat === 'EARLY_READY_SHORT') return '[EARLY] Short';
  return '[WATCH]';
}

function badgeColor(cat: string) {
  if (cat === 'BEST_ENTRY') return 'bg-yellow-500/20 text-yellow-300';
  if (cat === 'READY_TO_BUY') return 'bg-green-500/20 text-green-300';
  if (cat === 'EARLY_READY') return 'bg-blue-500/20 text-blue-300';
  if (cat === 'BEST_SHORT_ENTRY') return 'bg-rose-500/20 text-rose-300';
  if (cat === 'READY_TO_SELL') return 'bg-orange-500/20 text-orange-300';
  if (cat === 'EARLY_READY_SHORT') return 'bg-fuchsia-500/20 text-fuchsia-300';
  return 'bg-cyan-500/20 text-cyan-300';
}

export default function SignalCard({ s }: Props) {
  const cat = String(s.category || '');
  const shortSide = isShortCategory(cat);
  const badge = badgeLabel(cat);
  const color = badgeColor(cat);

  const btcBearOverride =
    s?.category === 'READY_TO_BUY' &&
    s?.market?.btcBear15m === true &&
    Array.isArray(s?.reasons) &&
    s.reasons.some((r: string) => r.toLowerCase().includes('btc bearish') && r.toLowerCase().includes('override'));

  const T = {
    LONG_RSI_MIN: 55,
    LONG_RSI_MAX: 80,
    SHORT_RSI_MIN: 30,
    SHORT_RSI_MAX: 60,
    VOL_SPIKE_X: 1.5,
    ATR_MAX: 2.0,
    VWAP_DIST_PCT: 0.3,
  };

  const firstSeenAt = s.__firstSeenAt as number | undefined;
  let ageText = '';
  if (firstSeenAt) {
    const diff = Date.now() - firstSeenAt;
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    ageText = mins >= 1 ? `${mins}m ago` : `${secs}s ago`;
  }

  const positives: string[] = [];
  if (s.confirm15m) positives.push('15m confirm');
  if (shortSide) {
    if (s.price < s.vwap) positives.push('Price < VWAP');
    if (s.price < s.ema200) positives.push('Price < EMA200');
    if (Math.abs(s.deltaVwapPct) <= T.VWAP_DIST_PCT) positives.push('Near VWAP');
    if (s.rsi9 >= T.SHORT_RSI_MIN && s.rsi9 <= T.SHORT_RSI_MAX) positives.push('RSI in short window');
  } else {
    if (s.price > s.vwap) positives.push('Price > VWAP');
    if (s.price > s.ema200) positives.push('Price > EMA200');
    if (Math.abs(s.deltaVwapPct) <= T.VWAP_DIST_PCT) positives.push('Near VWAP');
    if (s.rsi9 >= T.LONG_RSI_MIN && s.rsi9 < T.LONG_RSI_MAX) positives.push('RSI in long window');
  }
  if (s.atrPct <= T.ATR_MAX) positives.push('ATR within guard');
  if (s.volSpike >= T.VOL_SPIKE_X) positives.push(`Vol >= ${T.VOL_SPIKE_X}x`);

  const negatives: string[] = [];
  if (shortSide) {
    if (!(s.price < s.vwap)) negatives.push('Price >= VWAP');
    if (!(s.price < s.ema200)) negatives.push('Price >= EMA200');
    if (s.rsi9 < T.SHORT_RSI_MIN) negatives.push(`RSI < ${T.SHORT_RSI_MIN}`);
    if (s.rsi9 > T.SHORT_RSI_MAX) negatives.push(`RSI > ${T.SHORT_RSI_MAX}`);
  } else {
    if (!(s.price > s.vwap)) negatives.push('Price <= VWAP');
    if (!(s.price > s.ema200)) negatives.push('Price <= EMA200');
    if (s.rsi9 < T.LONG_RSI_MIN) negatives.push(`RSI < ${T.LONG_RSI_MIN}`);
    if (s.rsi9 >= T.LONG_RSI_MAX) negatives.push(`RSI >= ${T.LONG_RSI_MAX}`);
  }
  if (Math.abs(s.deltaVwapPct) > T.VWAP_DIST_PCT) negatives.push(`|dVWAP| > ${T.VWAP_DIST_PCT}%`);
  if (!s.confirm15m) negatives.push('No 15m confirm');
  if (s.volSpike < T.VOL_SPIKE_X) negatives.push(`Vol < ${T.VOL_SPIKE_X}x`);
  if (s.atrPct > T.ATR_MAX) negatives.push(`ATR > ${T.ATR_MAX}`);

  const tvSymbol = `${String(s.symbol || '').toUpperCase()}`;
  const tvBitget = `https://www.tradingview.com/chart/?symbol=BITGET:${tvSymbol}`;
  const tvBinance = `https://www.tradingview.com/chart/?symbol=BINANCE:${tvSymbol}`;

  return (
    <div className="bg-card rounded-2xl p-4 shadow-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="text-lg font-semibold">{s.symbol}</div>
        <div className="flex items-center gap-2">
          {btcBearOverride ? (
            <span className="text-[10px] px-2 py-1 rounded border border-amber-400/30 bg-amber-400/10 text-amber-200">
              BTC Bear Override
            </span>
          ) : null}
          <span className={`text-xs px-2 py-1 rounded ${color}`}>{badge}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>Price: <span className="text-white/90">{s.price.toFixed(6)}</span></div>
        <div>VWAP: <span className="text-white/90">{s.vwap.toFixed(6)}</span></div>
        <div>EMA200: <span className="text-white/90">{s.ema200.toFixed(6)}</span></div>
        <div>RSI-9: <span className="text-white/90">{s.rsi9.toFixed(1)}</span></div>
        <div>Vol: <span className="text-white/90">{s.volSpike.toFixed(2)}x</span></div>
        <div>ATR%: <span className="text-white/90">{s.atrPct.toFixed(2)}</span></div>
      </div>

      {s.category === 'EARLY_READY' ? (
        <div className="mt-2 text-xs text-blue-300/90">
          Hint: enter half size now; add remaining size on confirmation.
        </div>
      ) : null}
      {s.category === 'EARLY_READY_SHORT' ? (
        <div className="mt-2 text-xs text-fuchsia-300/90">
          Hint: short half size now; add remaining size on confirmation.
        </div>
      ) : null}
      {(s.category === 'BEST_ENTRY' || s.category === 'READY_TO_BUY' || s.category === 'BEST_SHORT_ENTRY' || s.category === 'READY_TO_SELL') ? (
        <HoldTimeRecommendation category={s.category} />
      ) : null}

      <div className="mt-2 text-xs text-white/70">
        15m confirm: <b>{s.confirm15m ? 'Yes' : 'No'}</b> - dVWAP: {s.deltaVwapPct.toFixed(2)}%
        {ageText && <span> - age: {ageText}</span>}
      </div>

      <div className="mt-2 text-xs">
        {positives.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {positives.map((p: string, i: number) => (
              <span key={`pos-${i}`} className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
                + {p}
              </span>
            ))}
          </div>
        ) : null}
        {negatives.length > 0 ? (
          <div className="flex flex-wrap gap-1 mt-1">
            {negatives.map((n: string, i: number) => (
              <span key={`neg-${i}`} className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-300">
                - {n}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-white/80">Why?</summary>
        <ul className="list-disc list-inside text-white/70">
          {s.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}
        </ul>
      </details>

      <details className="mt-2">
        <summary className="cursor-pointer text-white/80">Risk calculator</summary>
        <RiskCalc
          defaultEntry={s.price}
          defaultStop={shortSide
            ? Math.max(s.vwap, s.ema200) * 1.003
            : Math.min(s.vwap, s.ema200) * 0.997}
        />
      </details>

      <div className="mt-3 flex gap-2 items-center">
        <button className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15">Favorite</button>
        <button className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15">Copy plan</button>
        <a className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15" target="_blank" href={tvBitget}>
          Open chart
        </a>
        <a className="text-xs text-white/50 hover:text-white/70 underline" target="_blank" href={tvBinance}>
          Binance fallback
        </a>
      </div>
    </div>
  );
}
