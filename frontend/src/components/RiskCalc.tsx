import React, { useMemo, useState } from 'react';

type Props = {
  defaultEntry: number;
  defaultStop?: number;
};

export default function RiskCalc({ defaultEntry, defaultStop }: Props) {
  const [side, setSide] = useState<'LONG'|'SHORT'>('LONG');
  const [account, setAccount] = useState<number>(500);
  const [riskPct, setRiskPct] = useState<number>(1);
  const [entry, setEntry] = useState<number>(Number(defaultEntry?.toFixed(6)));
  const [stop, setStop] = useState<number>(Number((defaultStop ?? defaultEntry * 0.997).toFixed(6)));
  const [leverage, setLeverage] = useState<number>(5);

  const riskPerUnit = useMemo(() => {
    const v = side === 'LONG' ? entry - stop : stop - entry;
    return Math.max(v, 0);
  }, [entry, stop, side]);

  const riskAmount = account * (riskPct / 100);
  const qty = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
  const notional = qty * entry;
  const margin = leverage > 0 ? notional / leverage : notional;

  const tp1 = side === 'LONG' ? entry * 1.01 : entry * 0.99;
  const tp2 = side === 'LONG' ? entry * 1.02 : entry * 0.98;

  const rr1 = riskPerUnit > 0 ? Math.abs(tp1 - entry) / riskPerUnit : 0;
  const rr2 = riskPerUnit > 0 ? Math.abs(tp2 - entry) / riskPerUnit : 0;

  return (
    <div className="mt-2 grid gap-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2">
          <span className="w-24">Side</span>
          <select value={side} onChange={e=>setSide(e.target.value as any)} className="bg-white/10 rounded px-2 py-1">
            <option>LONG</option>
            <option>SHORT</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-24">Leverage</span>
          <input type="number" min={1} step={1} value={leverage} onChange={e=>setLeverage(Number(e.target.value))} className="bg-white/10 rounded px-2 py-1 w-full" />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-24">Account $</span>
          <input type="number" min={0} step="0.01" value={account} onChange={e=>setAccount(Number(e.target.value))} className="bg-white/10 rounded px-2 py-1 w-full" />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-24">Risk %</span>
          <input type="number" min={0} step="0.1" value={riskPct} onChange={e=>setRiskPct(Number(e.target.value))} className="bg-white/10 rounded px-2 py-1 w-full" />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-24">Entry</span>
          <input type="number" step="0.000001" value={entry} onChange={e=>setEntry(Number(e.target.value))} className="bg-white/10 rounded px-2 py-1 w-full" />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-24">Stop</span>
          <input type="number" step="0.000001" value={stop} onChange={e=>setStop(Number(e.target.value))} className="bg-white/10 rounded px-2 py-1 w-full" />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs text-white/80">
        <div>Risk $: <b>{riskAmount.toFixed(2)}</b></div>
        <div>Risk/Unit: <b>{riskPerUnit.toFixed(6)}</b></div>
        <div>Qty: <b>{qty.toFixed(6)}</b></div>
        <div>Notional $: <b>{notional.toFixed(2)}</b></div>
        <div>Est. Margin $: <b>{margin.toFixed(2)}</b> (at {leverage}×)</div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs text-white/80">
        <div>TP1 (±1%): <b>{tp1.toFixed(6)}</b> • R:R <b>{rr1.toFixed(2)}</b></div>
        <div>TP2 (±2%): <b>{tp2.toFixed(6)}</b> • R:R <b>{rr2.toFixed(2)}</b></div>
      </div>
    </div>
  );
}
