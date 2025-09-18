import { create } from 'zustand'

type Preset = 'Conservative' | 'Balanced' | 'Aggressive'

type State = {
  lastScanAt?: number
  onlyBest: boolean
  minQuoteVolume: number
  vwapDistancePct: number
  volSpikeX: number
  atrGuardPct: number
  preset: Preset
  set: (p: Partial<State>) => void
}

export const useStore = create<State>((set) => ({
  onlyBest: false,
  minQuoteVolume: 50_000_000,
  vwapDistancePct: 0.3,
  volSpikeX: 1.5,
  atrGuardPct: 2.0,
  preset: 'Balanced',
  set: (p) => set(p)
}))
