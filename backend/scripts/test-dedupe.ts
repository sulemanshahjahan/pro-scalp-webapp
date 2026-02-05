import { recordSignal, listSignals } from '../src/signalStore.js';

process.env.DB_PATH = ':memory:';

const now = Date.now();
const baseSignal = {
  symbol: 'TESTUSDT',
  category: 'READY_TO_BUY' as const,
  time: now,
  price: 1.2345,
  vwap: 1.23,
  ema200: 1.2,
  rsi9: 60,
  volSpike: 1.8,
  atrPct: 0.5,
  confirm15m: true,
  deltaVwapPct: 0.1,
  stop: 1.2,
  target: 1.3,
  rr: 2.0,
  riskPct: 2.5,
  reasons: ['test'],
};

recordSignal(baseSignal as any, 'BALANCED');
recordSignal({ ...baseSignal, vwap: 1.231, rsi9: 61 } as any, 'BALANCED');

const res = listSignals({ days: 1, limit: 10 });
if (res.total !== 1) {
  throw new Error(`Expected 1 row after upsert, got ${res.total}`);
}

const row = res.rows[0];
if (!row.updated_at || row.updated_at < row.created_at) {
  throw new Error(`Expected updated_at >= created_at, got ${row.updated_at} vs ${row.created_at}`);
}

console.log('OK: dedupe upsert works');
