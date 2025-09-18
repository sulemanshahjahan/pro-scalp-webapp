// backend/src/scanner.ts
import { topUSDTByQuoteVolume, klines } from './binance.js';
import { analyzeSymbol } from './logic.js';
import { pushToAll } from './notifier.js';
import { emailNotify } from './emailNotifier.js';

// Configuration
const TOP_N = parseInt(process.env.TOP_N || '300', 10);
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '30000', 10);

// ---- Liquidity / quality guardrails ---------------------------------
const MIN_QUOTE_USDT = parseFloat(process.env.MIN_QUOTE_USDT || '10000000'); // 10M
const MIN_PRICE_USDT = parseFloat(process.env.MIN_PRICE_USDT || '0.0001');   // $0.0001
const STABLE_BASES = new Set(['USDT','USDC','BUSD','FDUSD','TUSD','DAI','USDD','USDJ']);
const LEVERAGED_SUFFIXES = /(UP|DOWN|BULL|BEAR)USDT$/i;

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

// ---- Push rate limit & batch send -----------------------------------
const lastPushAt = new Map<string, number>();
const PUSH_COOLDOWN_MS = 3 * 60_000; // 3 min
function shouldPushNow(key: string, now = Date.now()): boolean {
  const prev = lastPushAt.get(key) ?? 0;
  if (now - prev < PUSH_COOLDOWN_MS) return false;
  lastPushAt.set(key, now); return true;
}
// ---------------------------------------------------------------------

export async function scanOnce(preset: Preset = 'BALANCED') {
  const thresholds = thresholdsForPreset(preset);
  const symbols = await topUSDTByQuoteVolume(MIN_QUOTE_USDT, TOP_N);

  const outs: any[] = [];
  const toNotify: Array<{ sym: string; title: string; body: string; sig: any; dedupeKey: string; }> = [];

  for (const sym of symbols) {
    if (isStableVsStable(sym)) continue;
    if (LEVERAGED_SUFFIXES.test(sym)) continue;

    try {
      const [d5, d15] = await Promise.all([ klines(sym, '5m', 300), klines(sym, '15m', 200) ]);
      const last5 = d5[d5.length - 1];
      if (!last5 || last5.close < MIN_PRICE_USDT) continue;

      const sig = analyzeSymbol(sym, d5, d15, thresholds);
      if (sig) {
        outs.push(sig);
        if (['BEST_ENTRY','READY_TO_BUY','EARLY_READY'].includes(sig.category)) {
          const title = sig.category === 'BEST_ENTRY' ? '⭐ Best Entry'
                     : sig.category === 'READY_TO_BUY' ? '✅ Ready to BUY'
                     : '⚡ Early Ready (½ size)';
          const body = `${sym} @ ${sig.price.toFixed(6)} | ΔVWAP ${sig.deltaVwapPct.toFixed(2)}% | RSI ${sig.rsi9.toFixed(1)} | Vol× ${sig.volSpike.toFixed(2)}`;
          const dedupeKey = `${sym}|${sig.category}`;
          toNotify.push({ sym, title, body, sig, dedupeKey });
        }
      }
      await new Promise(r => setTimeout(r, 120));
    } catch { /* continue */ }
  }

  setTimeout(async () => {
    const seen = new Set<string>();
    for (const n of toNotify) {
      if (seen.has(n.dedupeKey)) continue;
      seen.add(n.dedupeKey);
      if (!shouldPushNow(n.dedupeKey)) continue;

      try { await emailNotify(undefined, n.sig); } catch (e) { console.error('emailNotify error', e); }
      try {
        await pushToAll({ title: n.title, body: n.body, data: { symbol: n.sym, price: n.sig.price, category: n.sig.category, preset } });
      } catch (err) { console.error('notify error', err); }
    }
  }, 1500);

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
