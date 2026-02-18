// Hold time recommendation based on outcome analysis
// 120m/240m show 37-44% win rate vs 6-20% for shorter horizons
const DEFAULT_HOLD_MIN = Number(process.env.SIGNAL_HOLD_MINUTES || 120);

function getHoldRecommendation(category: string): string {
  const holdMin = DEFAULT_HOLD_MIN;
  const holdHours = (holdMin / 60).toFixed(1);
  
  const c = String(category || '').toUpperCase();
  if (c.includes('BEST')) {
    return `⏱️ Hold ${holdHours}-4h for optimal R (data: 37-44% win rate at 2-4h vs 7% at 15m)`;
  }
  if (c.includes('READY')) {
    return `⏱️ Consider ${holdHours}-4h hold (data: longer horizons significantly outperform)`;
  }
  return `⏱️ Watch for ${holdHours}m+ for full move development`;
}

type AnySignal = {
  symbol: string;
  category:
    | 'WATCH'
    | 'EARLY_READY'
    | 'READY_TO_BUY'
    | 'BEST_ENTRY'
    | 'EARLY_READY_SHORT'
    | 'BEST_SHORT_ENTRY'
    | 'READY_TO_SELL'
    | string;
  price?: number;
  ema200?: number;
  volume?: number;
  vwapDistancePct?: number;
  chartUrl?: string;
  [k: string]: any;
};

export function subjectFor(signal: AnySignal) {
  const tag = categoryTag(signal.category);
  const tf = pickTF(signal);
  return `${tag} - ${signal.symbol} @ ${fmtPrice(signal.price)} (${tf})`;
}

export function htmlFor(signal: AnySignal) {
  const tag = categoryTag(signal.category);

  const rows: Array<[string, string | number | undefined]> = [
    ['Symbol', signal.symbol],
    ['Category', tag],
    ['Price', fmtPrice(signal.price)],
    ['Timeframe', pickTF(signal)],
    ['RSI-9', pickRSI(signal)],
    ['VWAP Dist %', pct(signal.vwapDistancePct)],
    ['EMA200', fmtPrice(signal.ema200)],
    ['Volume (last)', signal.volume],
    ['When', new Date().toLocaleString('en-GB', { hour12: false })],
  ];

  const table = rows.map(([k, v]) => `
    <tr><td style="padding:6px 10px;color:#666;">${k}</td>
    <td style="padding:6px 10px;font-weight:600;color:#111;">${v ?? '-'}</td></tr>
  `).join('');

  const holdRec = getHoldRecommendation(signal.category);

  return `
  <div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #eee;border-radius:12px;overflow:hidden">
    <div style="background:#111;color:#fff;padding:14px 16px;font-size:16px"><strong>Pro Scalp Scanner</strong></div>
    <div style="padding:16px">
      <h2 style="margin:0 0 8px 0;font-size:18px">${tag}: ${signal.symbol}</h2>
      <p style="margin:0 0 12px 0;color:#333">Triggered at <b>${fmtPrice(signal.price)}</b>. This email is informational, not financial advice.</p>
      
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px;margin:12px 0;font-size:13px;color:#166534">
        <strong>${holdRec}</strong>
      </div>
      
      <table style="border-collapse:collapse;width:100%;font-size:14px">${table}</table>
      <div style="margin-top:16px">
        <a href="${signal.chartUrl ?? '#'}" style="display:inline-block;padding:10px 14px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px">Open Chart</a>
      </div>
    </div>
    <div style="background:#fafafa;color:#888;padding:10px 16px;font-size:12px">You are receiving this because you enabled email alerts.</div>
  </div>`;
}

export function textFor(signal: AnySignal) {
  const tag = categoryTag(signal.category);
  const holdRec = getHoldRecommendation(signal.category);
  return [
    `Pro Scalp Scanner - ${tag}`,
    `Symbol: ${signal.symbol}`,
    `Price: ${fmtPrice(signal.price)}`,
    `TF: ${pickTF(signal)}`,
    `RSI-9: ${pickRSI(signal) ?? '-'}`,
    `VWAP Dist %: ${pct(signal.vwapDistancePct)}`,
    `EMA200: ${fmtPrice(signal.ema200)}`,
    `When: ${new Date().toISOString()}`,
    `---`,
    holdRec,
    signal.chartUrl ? `Chart: ${signal.chartUrl}` : '',
  ].filter(Boolean).join('\n');
}

function fmtPrice(v?: number) {
  if (v == null || Number.isNaN(v)) return '-';
  return v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6);
}

function pct(v?: number) {
  if (v == null || Number.isNaN(v)) return '-';
  return `${Number(v).toFixed(2)}%`;
}

function pickTF(s: AnySignal): string {
  return s.tf || s.timeframe || s.interval || '5m';
}

function pickRSI(s: AnySignal): string | undefined {
  const r = s.rsi9 ?? s.rsi ?? s.rsiFast ?? s.rsi_9;
  if (r == null) return undefined;
  const n = Number(r);
  return Number.isFinite(n) ? n.toFixed(2) : String(r);
}

function categoryTag(category: string) {
  const c = String(category || '').toUpperCase();
  if (c === 'BEST_ENTRY') return 'Best Entry';
  if (c === 'READY_TO_BUY') return 'Ready to BUY';
  if (c === 'BEST_SHORT_ENTRY') return 'Best Short Entry';
  if (c === 'READY_TO_SELL') return 'Ready to SELL';
  if (c === 'EARLY_READY_SHORT') return 'Early Ready Short';
  if (c === 'EARLY_READY') return 'Early Ready';
  if (c === 'WATCH') return 'Watch';
  return category || 'Signal';
}
