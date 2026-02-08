export type Candle = [
  number, string, string, string, string, string,
  number, string, number, string, string, string
]; // Binance kline tuple

export type OHLCV = {
  time: number;
  openTime?: number;
  closeTime?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ScanCategory = 'EARLY_READY' | 'BEST_ENTRY' | 'READY_TO_BUY' | 'WATCH';

export interface MarketInfo {
  btcBull15m: boolean;
  btcBear15m?: boolean;
  btcClose15m: number;
  btcVwap15m: number;
  btcEma200_15m: number;
  btcRsi9_15m: number;
  btcDeltaVwapPct15m: number;
}

export interface Signal {
  symbol: string;
  category: ScanCategory;

  // Time = close time of the 5m signal candle (ms)
  time: number;

  price: number;
  vwap: number;
  ema200: number;
  rsi9: number;
  volSpike: number;
  atrPct: number;
  confirm15m: boolean;
  deltaVwapPct: number;

  // Trade plan (spot-friendly)
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  target: number | null;
  rr: number | null;
  riskPct: number | null;

  // Market regime context (BTC)
  market?: MarketInfo;

  reasons: string[];

  // Snapshot metadata (frozen at signal time)
  preset?: string | null;
  strategyVersion?: string | null;
  thresholdVwapDistancePct?: number | null;
  thresholdVolSpikeX?: number | null;
  thresholdAtrGuardPct?: number | null;
  confirm15mStrict?: boolean;
  confirm15mSoft?: boolean;
  sessionOk?: boolean;
  sweepOk?: boolean;
  trendOk?: boolean;
  rrEstimate?: number | null;
  blockedByBtc?: boolean;
  wouldBeCategory?: ScanCategory | null;
  btcGate?: string | null;
  btcGateReason?: string | null;
  gateSnapshot?: {
    ready: {
      sessionOk?: boolean;
      priceAboveVwap?: boolean;
      priceAboveEma?: boolean;
      nearVwap: boolean;
      confirm15: boolean;
      confirm15Strict?: boolean;
      trend: boolean;
      volSpike: boolean;
      atr: boolean;
      sweep: boolean;
      sweepFallback?: boolean;
      strongBody?: boolean;
      reclaimOrTap?: boolean;
      rsiReadyOk?: boolean;
      hasMarket?: boolean;
      btc: boolean;
      core: boolean;
    };
    best: {
      corePreSweep?: boolean;
      corePreRr?: boolean;
      nearVwap: boolean;
      confirm15: boolean;
      trend: boolean;
      volSpike: boolean;
      atr: boolean;
      sweep: boolean;
      btc: boolean;
      rr: boolean;
      core: boolean;
    };
  };

  blockedReasons?: string[];
  firstFailedGate?: string | null;
  gateScore?: number;
  readyDebug?: {
    blockedReasons: string[];
    firstFailedGate: string | null;
    gateScore: number;
  };
  bestDebug?: {
    blockedReasons: string[];
    firstFailedGate: string | null;
    gateScore: number;
  };
}
