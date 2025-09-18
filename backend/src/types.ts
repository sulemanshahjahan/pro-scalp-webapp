export type Candle = [number, string, string, string, string, string, number, string, number, string, string, string]; // Binance kline tuple
export type OHLCV = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type ScanCategory = | 'EARLY_READY' | 'BEST_ENTRY' | 'READY_TO_BUY' | 'WATCH';
export interface Signal {
  symbol: string;
  category: ScanCategory;
  price: number;
  vwap: number;
  ema200: number;
  rsi9: number;
  volSpike: number;
  atrPct: number;
  confirm15m: boolean;
  deltaVwapPct: number;
  reasons: string[];
}
