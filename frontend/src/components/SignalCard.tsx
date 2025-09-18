import React from 'react'
import RiskCalc from './RiskCalc'

type Props = {
  s: any
  onFav?: (symbol: string) => void
}

export default function SignalCard({ s }: Props) {
  // ---- BADGE & COLOR (unchanged) ----
  const badge =
    s.category === 'BEST_ENTRY' ? '⭐ Best Entry' :
    s.category === 'READY_TO_BUY' ? '✅ Ready to BUY' :
    s.category === 'EARLY_READY' ? '⚡ Early Ready (½ size)' :
    '👀 Watch';

  const badgeColor =
    s.category === 'BEST_ENTRY' ? 'bg-yellow-500/20 text-yellow-300' :
    s.category === 'READY_TO_BUY' ? 'bg-green-500/20 text-green-300' :
    s.category === 'EARLY_READY' ? 'bg-blue-500/20 text-blue-300' :
    'bg-cyan-500/20 text-cyan-300';

  // ---- Thresholds mirror (unchanged) ----
  const T = {
    RSI_MIN: 55,
    RSI_MAX: 80,
    VOL_SPIKE_X: 1.5,
    ATR_MAX: 2.0,
    VWAP_DIST_PCT: 0.3,
  };

  // ---- AGE (unchanged) ----
  const firstSeenAt = s.__firstSeenAt as number | undefined;
  let ageText = '';
  if (firstSeenAt) {
    const diff = Date.now() - firstSeenAt;
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    ageText = mins >= 1 ? `${mins}m ago` : `${secs}s ago`;
  }

  // ---- Quality snapshot: positives (✓) ----
  const positives: string[] = [];
  if (s.confirm15m) positives.push('15m confirm ✓');
  if (s.price > s.vwap) positives.push('Price > VWAP');
  if (s.price > s.ema200) positives.push('Price > EMA200');
  if (Math.abs(s.deltaVwapPct) <= T.VWAP_DIST_PCT) positives.push('Near VWAP');
  if (s.rsi9 >= T.RSI_MIN && s.rsi9 < T.RSI_MAX) positives.push('RSI in sweet spot');
  if (s.atrPct <= T.ATR_MAX) positives.push('ATR within guard');
  if (s.volSpike >= T.VOL_SPIKE_X) positives.push(`Vol× ≥ ${T.VOL_SPIKE_X}x`);

  // ---- NEW: Quality snapshot negatives (✗) — always computed ----
  const negatives: string[] = [];
  if (!(s.price > s.vwap)) negatives.push('Price ≤ VWAP');
  if (!(s.price > s.ema200)) negatives.push('Price ≤ EMA200');
  if (Math.abs(s.deltaVwapPct) > T.VWAP_DIST_PCT) negatives.push(`ΔVWAP > ${T.VWAP_DIST_PCT}%`);
  if (!s.confirm15m) negatives.push('No 15m confirm');
  if (s.rsi9 < T.RSI_MIN) negatives.push(`RSI < ${T.RSI_MIN}`);
  if (s.rsi9 >= T.RSI_MAX) negatives.push(`RSI ≥ ${T.RSI_MAX}`);
  if (s.volSpike < T.VOL_SPIKE_X) negatives.push(`Vol× < ${T.VOL_SPIKE_X}x`);
  if (s.atrPct > T.ATR_MAX) negatives.push(`ATR% > ${T.ATR_MAX}`);

  // ---- Chart links (Bitget first, Binance fallback) ----
  const tvSymbol = `${String(s.symbol || '').toUpperCase()}`;
  const tvBitget = `https://www.tradingview.com/chart/?symbol=BITGET:${tvSymbol}`;
  const tvBinance = `https://www.tradingview.com/chart/?symbol=BINANCE:${tvSymbol}`;

  return (
    <div className="bg-card rounded-2xl p-4 shadow-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="text-lg font-semibold">{s.symbol}</div>
        <span className={`text-xs px-2 py-1 rounded ${badgeColor}`}>{badge}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>Price: <span className="text-white/90">{s.price.toFixed(6)}</span></div>
        <div>VWAP: <span className="text-white/90">{s.vwap.toFixed(6)}</span></div>
        <div>EMA200: <span className="text-white/90">{s.ema200.toFixed(6)}</span></div>
        <div>RSI-9: <span className="text-white/90">{s.rsi9.toFixed(1)}</span></div>
        <div>Vol×: <span className="text-white/90">{s.volSpike.toFixed(2)}</span></div>
        <div>ATR%: <span className="text-white/90">{s.atrPct.toFixed(2)}</span></div>
      </div>

      {/* Small execution hint for EARLY_READY (unchanged) */}
      {s.category === 'EARLY_READY' && (
        <div className="mt-2 text-xs text-blue-300/90">
          Hint: enter <b>½ size</b> now; add the other ½ on confirmation (next candle strong-body or Vol× ≥ 1.5x).
        </div>
      )}

      <div className="mt-2 text-xs text-white/70">
        15m confirm: <b>{s.confirm15m ? 'Yes' : 'No'}</b> • ΔVWAP: {s.deltaVwapPct.toFixed(2)}%
        {ageText && <span> • age: {ageText}</span>}
      </div>

      {/* Quality snapshot: ✓ greens and ✗ reds */}
      <div className="mt-2 text-xs">
        {positives.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {positives.map((p: string, i: number) => (
              <span
                key={`pos-${i}`}
                className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300"
              >
                ✓ {p}
              </span>
            ))}
          </div>
        )}
        {negatives.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {negatives.map((n: string, i: number) => (
              <span
                key={`neg-${i}`}
                className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-300"
              >
                ✗ {n}
              </span>
            ))}
          </div>
        )}
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
          defaultStop={Math.min(s.vwap, s.ema200) * 0.997} // ~0.3% below VWAP/EMA as a starting idea
        />
      </details>

      <div className="mt-3 flex gap-2 items-center">
        <button className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15">☆ Favorite</button>
        <button className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15">Copy plan</button>

        {/* Primary Bitget link */}
        <a
          className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15"
          target="_blank"
          href={tvBitget}
        >
          Open chart
        </a>

        {/* Fallback Binance link (small secondary) */}
        <a
          className="text-xs text-white/50 hover:text-white/70 underline"
          target="_blank"
          href={tvBinance}
        >
          Binance fallback
        </a>
      </div>
    </div>
  )
}
