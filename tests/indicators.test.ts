import { describe, it, expect } from 'vitest'

// Simple smoke tests of the formulas
import { ema, rsi, vwap, atrPct, volumeSpike } from '../backend/src/indicators'

describe('indicators', () => {
  const series = Array.from({length: 50}, (_,i)=> i+1)
  it('ema monotonic', () => {
    const e = ema(series, 10)
    expect(e.length).toBe(series.length)
    expect(e[0]).toBe(series[0])
    expect(e.at(-1)).toBeGreaterThan(e[0]!)
  })
  it('rsi sane', () => {
    const r = rsi(series, 9)
    expect(r.length).toBe(series.length)
    expect(r.at(-1)).toBeGreaterThan(50)
  })
  it('vwap sane', () => {
    const tp = series.map(x=>x)
    const vol = series.map(()=>100)
    const v = vwap(tp, vol)
    expect(v.at(-1)).toBeCloseTo((tp.reduce((a,b)=>a+b,0))/tp.length, 3)
  })
  it('atrPct non-negative', () => {
    const high = series.map(s=>s+2)
    const low = series.map(s=>s-2)
    const close = series.map(s=>s)
    const a = atrPct(high, low, close, 14)
    expect(a.every(x=>x>=0)).toBe(true)
  })
  it('volumeSpike >= 0', () => {
    const vol = Array.from({length:50}, ()=>100)
    const vs = volumeSpike(vol, 20)
    expect(vs.every(x=>x>=0)).toBe(true)
  })
})
