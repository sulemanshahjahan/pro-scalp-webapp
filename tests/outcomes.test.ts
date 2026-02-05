import { describe, it, expect } from 'vitest';
import { calcOutcomeFromCandles, evaluateOutcomeWindow } from '../backend/src/signalStore';

function makeCandle(time: number, open: number, high: number, low: number, close: number) {
  return { time, open, high, low, close };
}

describe('outcomes', () => {
  it('TP1 hit first -> WIN/TP1', () => {
    const entryTime = 0;
    const candles = [
      makeCandle(300000, 100, 104, 99, 103),
      makeCandle(600000, 103, 106, 102, 105),
      makeCandle(900000, 105, 107, 104, 106),
    ];

    const out = calcOutcomeFromCandles({
      entry: 100,
      stop: 95,
      tp1: 105,
      tp2: 110,
      entryTime,
      candles,
    });

    expect(out.result).toBe('WIN');
    expect(out.exitReason).toBe('TP1');
    expect(out.hitTP1).toBe(1);
    expect(out.hitSL).toBe(0);
    expect(out.timeToFirstHitMs).toBe(600000);
  });

  it('Stop hit first -> LOSS/STOP', () => {
    const entryTime = 0;
    const candles = [
      makeCandle(300000, 100, 102, 94, 95),
      makeCandle(600000, 95, 99, 94, 98),
    ];

    const out = calcOutcomeFromCandles({
      entry: 100,
      stop: 95,
      tp1: 105,
      tp2: 110,
      entryTime,
      candles,
    });

    expect(out.result).toBe('LOSS');
    expect(out.exitReason).toBe('STOP');
    expect(out.hitSL).toBe(1);
    expect(out.timeToFirstHitMs).toBe(300000);
  });

  it('Both TP1 and SL in same candle -> conservative LOSS', () => {
    const entryTime = 0;
    const candles = [
      makeCandle(300000, 100, 106, 94, 102),
    ];

    const out = calcOutcomeFromCandles({
      entry: 100,
      stop: 95,
      tp1: 105,
      tp2: 110,
      entryTime,
      candles,
    });

    expect(out.result).toBe('LOSS');
    expect(out.exitReason).toBe('STOP');
    expect(out.ambiguous).toBe(1);
  });

  it('Coverage math: complete/partial/invalid', () => {
    const intervalMs = 5 * 60_000;
    const startTime = 300000;
    const endTime = 1800000; // 30m window (6 candles)
    const needed = 6;

    const aligned = Array.from({ length: 6 }, (_, i) =>
      makeCandle(startTime + i * intervalMs, 100, 101, 99, 100)
    );

    const complete = evaluateOutcomeWindow({
      startTime,
      endTime,
      intervalMs,
      needed,
      minCoveragePct: 95,
      candles: aligned,
    });
    expect(complete.windowStatus).toBe('COMPLETE');

    const partial = evaluateOutcomeWindow({
      startTime,
      endTime,
      intervalMs,
      needed,
      minCoveragePct: 95,
      candles: aligned.slice(0, 4),
    });
    expect(partial.windowStatus).toBe('PARTIAL');
    expect(partial.invalidReason).toBe('NOT_ENOUGH_BARS');

    const misaligned = aligned.slice();
    misaligned[2] = makeCandle(startTime + 4 * intervalMs, 100, 101, 99, 100);

    const invalid = evaluateOutcomeWindow({
      startTime,
      endTime,
      intervalMs,
      needed,
      minCoveragePct: 95,
      candles: misaligned,
    });
    expect(invalid.windowStatus).toBe('PARTIAL');
    expect(invalid.invalidReason).toBe('BAD_ALIGN');
  });
});
