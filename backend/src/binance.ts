import fetch from 'node-fetch';
import type { Candle, OHLCV } from './types.js';

const BASE = process.env.BINANCE_BASE || 'https://api.binance.com';

async function fetchJson(url: string) {
  const timeoutMs = parseInt(process.env.BINANCE_HTTP_TIMEOUT_MS || '8000', 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: any;
  let text = '';
  try {
    res = await fetch(url, { signal: controller.signal });
    text = await res.text();
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`BINANCE_TIMEOUT_${timeoutMs}`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }

  if (!res.ok) {
    const msg = json?.msg || json?.message || text || `HTTP ${res.status}`;
    throw new Error(`BINANCE_HTTP_${res.status}: ${msg}`);
  }

  return json;
}

export async function topUSDTByQuoteVolume(
  minQuoteVolUsd: number = 50_000_000,
  limit: number = 80
): Promise<string[]> {
  const data = (await fetchJson(`${BASE}/api/v3/ticker/24hr`)) as any[];
  const stableBases = new Set(['USDT','USDC','BUSD','FDUSD','TUSD','DAI','USDD','USDJ']);

  return data
    .filter((d) => {
      const sym = String(d.symbol || '');
      if (!sym.endsWith('USDT')) return false;
      if (/(UP|DOWN|BULL|BEAR)USDT$/i.test(sym)) return false;
      const base = sym.slice(0, -4);
      if (stableBases.has(base.toUpperCase())) return false;
      return true;
    })
    .map((d) => ({ symbol: String(d.symbol), quoteVolume: Number(d.quoteVolume) }))
    .filter((d) => Number.isFinite(d.quoteVolume) && d.quoteVolume >= minQuoteVolUsd)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit)
    .map((d) => d.symbol);
}

export async function listAllUSDTMarkets(): Promise<string[]> {
  const data = (await fetchJson(`${BASE}/api/v3/exchangeInfo`)) as any;
  const stableBases = new Set(['USDT','USDC','BUSD','FDUSD','TUSD','DAI','USDD','USDJ']);
  const symbols = Array.isArray(data?.symbols) ? data.symbols : [];
  return symbols
    .filter((s: any) => s && s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s: any) => String(s.symbol))
    .filter((sym: string) => {
      if (!sym.endsWith('USDT')) return false;
      if (/(UP|DOWN|BULL|BEAR)USDT$/i.test(sym)) return false;
      const base = sym.slice(0, -4);
      if (stableBases.has(base.toUpperCase())) return false;
      return true;
    });
}

function mapKlines(json: Candle[]): OHLCV[] {
  return json.map((c) => {
    const openTime = Number(c[0]);
    const closeTime = Number(c[6]);
    return {
      time: closeTime,
      openTime,
      closeTime,
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
    };
  });
}

export async function klines(symbol: string, interval: string, limit: number = 300): Promise<OHLCV[]> {
  const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const json = (await fetchJson(url)) as Candle[];
  return mapKlines(json);
}

export async function klinesFrom(
  symbol: string,
  interval: string,
  startTime: number,
  limit: number
): Promise<OHLCV[]> {
  const maxLimit = Math.max(1, Math.min(1000, limit));
  const url =
    `${BASE}/api/v3/klines?symbol=${symbol}` +
    `&interval=${interval}` +
    `&startTime=${startTime}` +
    `&limit=${maxLimit}`;
  const json = (await fetchJson(url)) as Candle[];
  return mapKlines(json);
}

export async function klinesRange(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  limit: number = 1000
): Promise<OHLCV[]> {
  const out: OHLCV[] = [];
  const maxLimit = Math.max(1, Math.min(1000, limit));
  let start = startTime;
  let guard = 0;

  while (start < endTime && guard < 25) {
    const url =
      `${BASE}/api/v3/klines?symbol=${symbol}` +
      `&interval=${interval}` +
      `&startTime=${start}` +
      `&endTime=${endTime}` +
      `&limit=${maxLimit}`;
    const json = (await fetchJson(url)) as Candle[];

    if (!json.length) break;

    out.push(...mapKlines(json));

    const lastOpenTime = json[json.length - 1]?.[0];
    if (!Number.isFinite(lastOpenTime) || lastOpenTime <= start) break;
    start = lastOpenTime + 1;
    guard++;
  }

  return out;
}
