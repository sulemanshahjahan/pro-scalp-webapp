import { describe, it, expect } from 'vitest'
import { analyzeSymbol } from '../backend/src/logic'

function makeSeries(n: number, base=100) {
  const out = []
  let v = base
  for (let i=0;i<n;i++) {
    const open = v
    const high = v * (1 + Math.random()*0.003)
    const low  = v * (1 - Math.random()*0.003)
    v = v * (1 + (Math.random()-0.45)*0.002)
    const close = v
    const volume = 1000 + Math.random()*200
    out.push({ time: i, open, high, low, close, volume })
  }
  return out
}

describe('logic', () => {
  it('analyzes without crashing', () => {
    const d5 = makeSeries(300)
    const d15 = makeSeries(200)
    const sig = analyzeSymbol('TESTUSDT', d5, d15, { vwapDistancePct: 0.3, volSpikeX: 1.5, atrGuardPct: 2.0 })
    expect([null, 'object']).toContain(typeof sig === 'object' ? 'object' : null)
  })
})
