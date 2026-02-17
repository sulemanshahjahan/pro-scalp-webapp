import { apiUrl as API } from '../config/apiBase';

export async function getVapidKey(): Promise<string> {
  const r = await fetch(API('/api/vapidPublicKey'));
  const j = await r.json();
  return j.publicKey;
}
// ✅ UPDATED: include title/body/tag + duplicate category inside data
export async function debugPush(
  symbol = 'DEMOUSDT',
  category: 'WATCH' | 'READY_TO_BUY' | 'BEST_ENTRY' | 'READY_TO_SELL' | 'BEST_SHORT_ENTRY' = 'BEST_ENTRY',
  price = 1.2345
) {
  await fetch(API('/api/debug/push'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `${category} ${symbol}`,
      body: `@ ${price}`,
      category,                  // SW reads this (payload.category)
      tag: `sig-${symbol}`,
      data: { symbol, price, category } // also inside data (handy for clicks)
    })
  });
}

// ---- CHANGE: add Preset type + pass preset as query to /api/scan ----
type Preset = 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

export async function scanNow(preset: Preset = 'BALANCED') {
  const r = await fetch(API(`/api/scan?async=1&preset=${encodeURIComponent(preset)}`));
  return r.json();
}
// --------------------------------------------------------------------

export async function getBtcMarket() {
  const r = await fetch(API('/api/market/btc'), { cache: 'no-store' });
  return r.json();
}

export async function getReadyGateDebug(limit = 50) {
  const r = await fetch(API(`/api/debug/readyGate?limit=${encodeURIComponent(String(limit))}`), { cache: 'no-store' });
  return r.json();
}

export async function getSystemHealth() {
  const r = await fetch(API('/api/system/health'), { cache: 'no-store' });
  return r.json();
}

export async function subscribePush(sub: PushSubscription) {
  await fetch(API('/api/subscribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub)
  });
}

export async function unsubscribePush(sub: PushSubscription) {
  await fetch(API('/api/unsubscribe'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub)
  });
}
