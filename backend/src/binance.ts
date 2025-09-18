import fetch from 'node-fetch';
import type { Candle, OHLCV } from './types.js';

const BASE = process.env.BINANCE_BASE || 'https://api.binance.com';

export async function topUSDTByQuoteVolume(
  minQuoteVolUsd: number = 50_000_000,
  limit: number = 80
): Promise<string[]> {
  const res = await fetch(`${BASE}/api/v3/ticker/24hr`);
  // TS: res.json() is `unknown` under strict; cast to array of any
  const data = (await res.json()) as unknown as any[];

  const filtered = data
    .filter((d) => d.symbol?.endsWith('USDT') && !d.symbol?.includes('UP') && !d.symbol?.includes('DOWN'))
    .map((d) => ({ symbol: String(d.symbol), quoteVolume: parseFloat(String(d.quoteVolume)) }))
    .filter((d) => Number.isFinite(d.quoteVolume) && d.quoteVolume >= minQuoteVolUsd)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit)
    .map((d) => d.symbol);

  return filtered;
}

export async function klines(symbol: string, interval: string, limit: number = 300): Promise<OHLCV[]> {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  // TS: cast JSON to Candle[] (tuple type) explicitly
  const json = (await res.json()) as unknown as Candle[];

  return json.map((c) => ({
    time: c[0],
    open: parseFloat(c[1] as unknown as string),
    high: parseFloat(c[2] as unknown as string),
    low: parseFloat(c[3] as unknown as string),
    close: parseFloat(c[4] as unknown as string),
    volume: parseFloat(c[5] as unknown as string),
  }));
}
