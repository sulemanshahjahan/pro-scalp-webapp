import { useEffect, useMemo, useRef, useState } from 'react';
import { getReadyGateDebug } from '../services/api';

const HORIZONS = [15, 30, 60, 120, 240] as const;
const CATEGORIES = ['BEST_ENTRY', 'READY_TO_BUY', 'EARLY_READY', 'WATCH'] as const;
const PRESETS = ['ALL', 'BALANCED', 'CONSERVATIVE', 'AGGRESSIVE'] as const;
const BTC_STATES = ['ALL', 'BULL', 'NEUTRAL', 'BEAR'] as const;
const BUCKET_LABELS: Record<'deltaVwapPct' | 'rsi9' | 'atrPct' | 'volSpike' | 'rr', string> = {
  deltaVwapPct: 'Price vs VWAP',
  rsi9: 'RSI',
  atrPct: 'Price Movement',
  volSpike: 'Volume Spike',
  rr: 'Risk/Reward',
};

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (v == null) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function fmt(n: number | null | undefined, digits = 2) {
  const v = num(n);
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(digits);
}
function fmtRate(n: number | null | undefined, digits = 1) {
  const v = num(n);
  if (!Number.isFinite(v)) return '--';
  return `${(v * 100).toFixed(digits)}%`;
}
function fmtMs(ms: number | null | undefined) {
  const v = num(ms);
  if (!Number.isFinite(v) || v <= 0) return '--';
  const mins = Math.floor(v / 60000);
  const secs = Math.floor((v % 60000) / 1000);
  return `${mins}m ${secs}s`;
}
function dt(ms: number) {
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}
function toDateInputValue(d: Date) {
  return d.toLocaleDateString('en-CA');
}
function btcStateLabel(market: any) {
  if (!market) return '--';
  if (market.btcBull15m) return 'Bull';
  if (market.btcBear15m) return 'Bear';
  return 'Neutral';
}
function outcomeStatusClass(status: string) {
  if (status === 'COMPLETE') return 'bg-emerald-400/15 text-emerald-200 border-emerald-400/30';
  if (status === 'INVALID') return 'bg-rose-400/15 text-rose-200 border-rose-400/30';
  return 'bg-amber-400/15 text-amber-200 border-amber-400/30';
}
function categoryPill(cat: string) {
  if (cat === 'BEST_ENTRY') return 'bg-amber-400/15 text-amber-200 border-amber-400/30';
  if (cat === 'READY_TO_BUY') return 'bg-emerald-400/15 text-emerald-200 border-emerald-400/30';
  if (cat === 'EARLY_READY') return 'bg-cyan-400/15 text-cyan-200 border-cyan-400/30';
  return 'bg-white/10 text-white/80 border-white/10';
}
function btcStateFromRow(row: any) {
  if (row.btcBull) return 'BULL';
  if (row.btcBear) return 'BEAR';
  return 'NEUTRAL';
}

function hasDebugPayload(row: any) {
  return Number.isFinite(Number(row?.gateScore)) || (Array.isArray(row?.blockedReasons) && row.blockedReasons.length > 0);
}

function shortGateLabel(label: string | null | undefined) {
  if (!label) return '--';
  return label.replace(/_/g, ' ');
}

function MiniSpark(props: {
  entry: number;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  minLow: number;
  maxHigh: number;
  close: number;
}) {
  const { entry, stop, tp1, tp2, minLow, maxHigh, close } = props;
  const min = Math.min(minLow, stop ?? minLow, entry);
  const max = Math.max(maxHigh, tp2 ?? maxHigh, tp1 ?? maxHigh, entry);
  const span = max - min || 1;
  const scaleY = (v: number) => 40 - ((v - min) / span) * 40;
  const points = [
    { x: 0, y: scaleY(entry) },
    { x: 20, y: scaleY(maxHigh) },
    { x: 40, y: scaleY(minLow) },
    { x: 60, y: scaleY(close) },
  ];
  const line = points.map(p => `${p.x},${p.y}`).join(' ');
  return (
    <svg viewBox="0 0 60 44" className="w-20 h-10">
      <rect x="0" y="0" width="60" height="44" rx="6" fill="rgba(255,255,255,0.04)" />
      {stop != null ? <line x1="0" y1={scaleY(stop)} x2="60" y2={scaleY(stop)} stroke="rgba(244,63,94,0.5)" strokeWidth="1" /> : null}
      {tp1 != null ? <line x1="0" y1={scaleY(tp1)} x2="60" y2={scaleY(tp1)} stroke="rgba(16,185,129,0.45)" strokeWidth="1" /> : null}
      {tp2 != null ? <line x1="0" y1={scaleY(tp2)} x2="60" y2={scaleY(tp2)} stroke="rgba(34,197,94,0.6)" strokeWidth="1" /> : null}
      <polyline points={line} fill="none" stroke="rgba(56,189,248,0.85)" strokeWidth="1.5" />
      <circle cx={points[3].x} cy={points[3].y} r="2" fill="rgba(56,189,248,0.9)" />
    </svg>
  );
}

export default function StatsPage() {
  const [preset, setPreset] = useState<typeof PRESETS[number]>('ALL');
  const [horizon, setHorizon] = useState<typeof HORIZONS[number]>(30);
  const [datePreset, setDatePreset] = useState<'today' | '24h' | '7d' | 'custom'>('7d');
  const [customStart, setCustomStart] = useState(toDateInputValue(new Date()));
  const [customEnd, setCustomEnd] = useState(toDateInputValue(new Date()));
  const [version, setVersion] = useState<string>('latest');
  const [versions, setVersions] = useState<any | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [symbol, setSymbol] = useState('');
  const [btcStateFilter, setBtcStateFilter] = useState<typeof BTC_STATES[number]>('ALL');
  const [showBtcBlocked, setShowBtcBlocked] = useState(false);

  const [summary, setSummary] = useState<any | null>(null);
  const [matrix, setMatrix] = useState<any | null>(null);
  const [buckets, setBuckets] = useState<any | null>(null);
  const [invalids, setInvalids] = useState<any | null>(null);
  const [health, setHealth] = useState<any | null>(null);
  const [loadingTop, setLoadingTop] = useState(false);
  const [readyGate, setReadyGate] = useState<any | null>(null);
  const [readyGateLoading, setReadyGateLoading] = useState(false);

  const [outcomes, setOutcomes] = useState<any | null>(null);
  const [outcomesLoading, setOutcomesLoading] = useState(false);
  const [recomputeLoading, setRecomputeLoading] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState('');
  const [clearLoading, setClearLoading] = useState(false);
  const [clearMsg, setClearMsg] = useState('');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(200);
  const [sort, setSort] = useState('time_desc');
  const [windowStatus, setWindowStatus] = useState<'ALL' | 'COMPLETE' | 'PARTIAL' | 'INVALID'>('ALL');
  const [resultFilter, setResultFilter] = useState<'ALL' | 'WIN' | 'LOSS' | 'NONE'>('ALL');
  const [invalidReasonFilter, setInvalidReasonFilter] = useState('');
  const [bucketTab, setBucketTab] = useState<'deltaVwapPct' | 'rsi9' | 'atrPct' | 'volSpike' | 'rr'>('deltaVwapPct');

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const signalCacheRef = useRef<Record<number, any>>({});
  const [showGateSnapshot, setShowGateSnapshot] = useState(false);

  const latestVersion = versions?.latest ?? null;
  const resolvedVersion = version === 'latest' ? latestVersion : version;

  const range = useMemo(() => {
    const now = new Date();
    if (datePreset === 'today') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { start: start.getTime(), end: now.getTime() };
    }
    if (datePreset === '24h') {
      return { start: now.getTime() - 24 * 60 * 60_000, end: now.getTime() };
    }
    if (datePreset === '7d') {
      return { start: now.getTime() - 7 * 24 * 60 * 60_000, end: now.getTime() };
    }
    const start = new Date(`${customStart}T00:00:00`);
    const end = new Date(`${customEnd}T23:59:59`);
    return { start: start.getTime(), end: end.getTime() };
  }, [datePreset, customStart, customEnd]);

  function buildParams(opts: { includeHorizon?: boolean; includePagination?: boolean; includeSort?: boolean } = {}) {
    const { includeHorizon = true, includePagination = false, includeSort = false } = opts;
    const qs = new URLSearchParams();
    qs.set('start', String(range.start));
    qs.set('end', String(range.end));
    if (preset !== 'ALL') qs.set('preset', preset);
    if (resolvedVersion) qs.set('version', resolvedVersion);
    if (categories.length) qs.set('categories', categories.join(','));
    if (symbol.trim()) qs.set('symbol', symbol.trim().toUpperCase());
    if (btcStateFilter !== 'ALL') qs.set('btcState', btcStateFilter);
    if (showBtcBlocked) qs.set('blockedByBtc', '1');
    if (includeHorizon) qs.set('horizonMin', String(horizon));
    if (includeSort) qs.set('sort', sort);
    if (windowStatus !== 'ALL') qs.set('windowStatus', windowStatus);
    if (resultFilter !== 'ALL') qs.set('result', resultFilter);
    if (invalidReasonFilter) qs.set('invalidReason', invalidReasonFilter);
    if (includePagination) {
      qs.set('limit', String(limit));
      qs.set('offset', String(page * limit));
    }
    return qs.toString();
  }

  async function loadTop() {
    setLoadingTop(true);
    try {
      const qs = buildParams({ includeHorizon: true });
      const [a, b, c, d] = await Promise.all([
        fetch(`/api/stats/summary?${qs}`).then(r => r.json()),
        fetch(`/api/stats/matrix/btc?${qs}`).then(r => r.json()),
        fetch(`/api/stats/buckets?${qs}`).then(r => r.json()),
        fetch(`/api/stats/invalidReasons?${qs}`).then(r => r.json()),
      ]);
      setSummary(a);
      setMatrix(b);
      setBuckets(c);
      setInvalids(d);
    } finally {
      setLoadingTop(false);
    }
  }

  async function loadOutcomes() {
    setOutcomesLoading(true);
    try {
      const qs = buildParams({ includeHorizon: true, includePagination: true, includeSort: true });
      const resp = await fetch(`/api/outcomes?${qs}`).then(r => r.json());
      setOutcomes(resp);
    } finally {
      setOutcomesLoading(false);
    }
  }

  async function recomputeOutcomes() {
    setRecomputeLoading(true);
    setRecomputeMsg('');
    try {
      const qs = new URLSearchParams(buildParams({ includeHorizon: true }));
      qs.delete('windowStatus');
      qs.delete('invalidReason');
      const resp = await fetch(`/api/outcomes/rebuild?${qs.toString()}`, { method: 'POST' }).then(r => r.json());
      if (resp?.ok) {
        setRecomputeMsg(`Re-check queued for ${resp.rebuilt ?? 0} rows`);
        await Promise.all([loadTop(), loadOutcomes()]);
      } else {
        setRecomputeMsg('Re-check failed');
      }
    } catch {
      setRecomputeMsg('Re-check failed');
    } finally {
      setRecomputeLoading(false);
    }
  }

  async function clearAllSignals() {
    const ok = window.confirm('Delete all saved signals + outcomes? This cannot be undone.');
    if (!ok) return;
    setClearLoading(true);
    setClearMsg('');
    try {
      const resp = await fetch('/api/signals/clear', { method: 'POST' }).then(r => r.json());
      if (resp?.ok) {
        setClearMsg(`Cleared ${resp.signals ?? 0} signals, ${resp.outcomes ?? 0} outcomes`);
        setSelectedId(null);
        setPage(0);
        await Promise.all([loadTop(), loadOutcomes()]);
      } else {
        setClearMsg('Clear failed');
      }
    } catch {
      setClearMsg('Clear failed');
    } finally {
      setClearLoading(false);
    }
  }

  async function loadVersions() {
    const resp = await fetch('/api/stats/versions').then(r => r.json());
    if (resp?.ok) setVersions(resp);
  }

  async function loadHealth() {
    const resp = await fetch('/api/system/health').then(r => r.json());
    if (resp?.ok) setHealth(resp);
  }

  async function loadReadyGateDebug() {
    setReadyGateLoading(true);
    try {
      const resp = await getReadyGateDebug(50);
      if (resp?.ok) setReadyGate(resp);
      else setReadyGate({ error: resp?.error || 'Not available' });
    } catch (e: any) {
      setReadyGate({ error: String(e) });
    } finally {
      setReadyGateLoading(false);
    }
  }

  async function fetchSignal(id: number) {
    const cached = signalCacheRef.current[id];
    if (cached) return cached;
    const resp = await fetch(`/api/signal/${id}`).then(r => r.json());
    if (resp?.ok) {
      signalCacheRef.current[id] = resp.signal;
      return resp.signal;
    }
    return null;
  }

  function toggleCategory(cat: string) {
    setCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  }
  function resetInvalidFilter() {
    setInvalidReasonFilter('');
    setWindowStatus('ALL');
  }

  async function copyDebugJson() {
    if (!selected) return;
    const payload = {
      gateScore: selected.gateScore,
      firstFailedGate: selected.firstFailedGate,
      blockedReasons: selected.blockedReasons,
      blockedByBtc: selected.blockedByBtc,
      readyDebug: selected.readyDebug,
      bestDebug: selected.bestDebug,
      gateSnapshot: selected.gateSnapshot,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      // ignore
    }
  }

  async function copyReasonsText() {
    if (!selected) return;
    const lines = (selected.blockedReasons ?? []).map((r: string) => `- ${r}`);
    const text = lines.join('\n') || 'No blocked reasons.';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  useEffect(() => { loadVersions().catch(() => {}); }, []);
  useEffect(() => { loadTop().catch(() => {}); }, [range.start, range.end, preset, resolvedVersion, categories.join(','), symbol, horizon, btcStateFilter, showBtcBlocked]);
  useEffect(() => { setPage(0); }, [range.start, range.end, preset, resolvedVersion, categories.join(','), symbol, horizon, btcStateFilter, showBtcBlocked, windowStatus, resultFilter, invalidReasonFilter]);
  useEffect(() => { loadOutcomes().catch(() => {}); }, [range.start, range.end, preset, resolvedVersion, categories.join(','), symbol, horizon, btcStateFilter, showBtcBlocked, windowStatus, resultFilter, invalidReasonFilter, page, limit, sort]);
  useEffect(() => {
    loadHealth().catch(() => {});
    const t = setInterval(() => loadHealth().catch(() => {}), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    fetchSignal(selectedId).then(setSelected).catch(() => setSelected(null));
  }, [selectedId]);

  const summaryTotals = summary?.totals ?? [];
  const outcomeStats = summary?.outcomes;
  const totalSignals = summaryTotals.reduce((acc: number, r: any) => acc + (r?.n ?? 0), 0);
  const totalOutcomes = (outcomeStats?.completeN ?? 0) + (outcomeStats?.partialN ?? 0) + (outcomeStats?.invalidN ?? 0);
  const completePct = totalOutcomes ? ((outcomeStats?.completeN ?? 0) / totalOutcomes) : 0;
  const currentResolveVersion = summary?.currentResolveVersion ?? null;

  const btcMarket = health?.btc?.market ?? null;
  const btcAt = health?.btc?.at ?? 0;
  const btcAgeMin = btcAt ? (Date.now() - btcAt) / 60000 : NaN;
  const btcStale = Number.isFinite(btcAgeMin) && btcAgeMin > 20;

  const matrixMap = useMemo(() => {
    const map = new Map<string, any>();
    (matrix?.rows ?? []).forEach((r: any) => {
      map.set(`${r.btcState}|${r.category}`, r);
    });
    return map;
  }, [matrix]);

  const outcomesRows = outcomes?.rows ?? [];
  const totalPages = outcomes?.total ? Math.ceil(outcomes.total / limit) : 1;

  return (
    <div className="mt-4 space-y-6">
      <section className="sticky top-0 z-20 bg-bg/80 backdrop-blur border-b border-white/5">
        <div className="py-3 space-y-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-2xl font-display font-semibold tracking-tight">Stats + Outcomes</div>
              <div className="text-xs text-white/60">5m entries, 15m check, VWAP/EMA/RSI, sweep + BTC trend</div>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
                <span className="text-white/60">Preset</span>
                <select className="bg-transparent text-white/90" value={preset} onChange={(e) => setPreset(e.target.value as any)}>
                  {PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
                <span className="text-white/60">Version</span>
                <select className="bg-transparent text-white/90" value={version} onChange={(e) => setVersion(e.target.value)}>
                  <option value="latest">Latest</option>
                  {(versions?.versions ?? []).map((v: any) => (
                    <option key={v.version} value={v.version}>{v.version}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
                <span className="text-white/60">Date</span>
                <select className="bg-transparent text-white/90" value={datePreset} onChange={(e) => setDatePreset(e.target.value as any)}>
                  <option value="today">Today</option>
                  <option value="24h">24h</option>
                  <option value="7d">7d</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {datePreset === 'custom' ? (
                <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
                  <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="bg-transparent text-white/90" />
                  <span className="text-white/40"></span>
                  <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="bg-transparent text-white/90" />
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl bg-white/5 border border-white/10 px-2 py-1 text-xs">
              {HORIZONS.map(h => (
                <button key={h} onClick={() => setHorizon(h)} className={`px-2 py-1 rounded-lg ${h === horizon ? 'bg-cyan-400/20 text-cyan-100' : 'text-white/70 hover:text-white'}`}>
                  {h}m
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              <span className="text-white/60">BTC</span>
              <select className="bg-transparent text-white/90" value={btcStateFilter} onChange={(e) => setBtcStateFilter(e.target.value as any)}>
                {BTC_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              <span className="text-white/60">Symbol</span>
              <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="bg-transparent text-white/90 w-24" placeholder="BTCUSDT" />
            </div>
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showBtcBlocked} onChange={(e) => setShowBtcBlocked(e.target.checked)} />
                BTC-blocked only
              </label>
            </div>
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              {CATEGORIES.map(cat => (
                <button key={cat} onClick={() => toggleCategory(cat)} className={`px-2 py-1 rounded-lg border ${categories.includes(cat) ? 'bg-white/15 border-white/30' : 'border-white/10 text-white/60 hover:text-white'}`}>
                  {cat.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-4 fade-up">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs text-white/60 uppercase tracking-widest">BTC Trend</div>
            <div className="mt-1 flex items-center gap-3">
              <span className={`px-2 py-1 rounded-lg border text-xs ${btcMarket?.btcBull15m ? 'border-emerald-400/40 text-emerald-200 bg-emerald-400/10' : btcMarket?.btcBear15m ? 'border-rose-400/40 text-rose-200 bg-rose-400/10' : 'border-white/10 text-white/80 bg-white/5'}`}>
                BTC {btcStateLabel(btcMarket)}
              </span>
              <span className="text-xs text-white/60">
                Price vs VWAP {btcMarket ? fmt(btcMarket.btcDeltaVwapPct15m, 2) : '--'}% - RSI {btcMarket ? fmt(btcMarket.btcRsi9_15m, 1) : '--'}
              </span>
            </div>
          </div>
          <div className="text-xs text-white/60">
            BTC updated {btcAt ? dt(btcAt) : '--'}
            {btcStale ? <span className="ml-2 px-2 py-0.5 rounded-md border border-amber-400/40 text-amber-200 bg-amber-400/10">Stale</span> : null}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-6 gap-3 fade-up">
        <div className="lg:col-span-4 grid grid-cols-2 md:grid-cols-3 gap-3">
          <KpiCard label="Total Signals" value={totalSignals} sub="All categories" />
          <KpiCard label="Complete %" value={fmtRate(completePct, 1)} sub={`${outcomeStats?.completeN ?? 0}/${totalOutcomes}`} />
          <KpiCard label="Win / Loss / No Hit" value={`${outcomeStats?.winN ?? 0} / ${outcomeStats?.lossN ?? 0} / ${outcomeStats?.noneN ?? 0}`} sub="Complete only" />
          <KpiCard label="Net R (Risk)" value={fmt(outcomeStats?.netR, 2)} sub={`Avg ${fmt(outcomeStats?.avgR, 2)} - Median ${fmt(outcomeStats?.medianR, 2)}`} />
          <KpiCard label="Median Time to TP1" value={fmtMs(outcomeStats?.medianTimeToTp1Ms)} sub={`Horizon ${horizon}m`} />
          <KpiCard label="Avg Max Up / Down" value={`${fmt(outcomeStats?.avgMfePct, 2)}% / ${fmt(outcomeStats?.avgMaePct, 2)}%`} sub="Complete only" />
        </div>
        <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/60 uppercase tracking-widest">Signals Per Hour</div>
          <div className="mt-3 space-y-2">
            {(summary?.signalsPerHour ?? []).slice(-12).map((h: any) => (
              <div key={h.hourStart} className="flex items-center gap-3 text-xs">
                <div className="w-16 text-white/60">{new Date(h.hourStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="h-2 bg-cyan-400/60"
                    style={{ width: `${Math.min(100, (h.n / Math.max(1, Math.max(...(summary?.signalsPerHour ?? []).map((x: any) => x.n)))) * 100)}%` }}
                  />
                </div>
                <div className="w-10 text-right text-white/70">{h.n}</div>
              </div>
            ))}
            {!(summary?.signalsPerHour ?? []).length ? (
              <div className="text-xs text-white/50">No signal history for this range.</div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 fade-up">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/60 uppercase tracking-widest">BTC x Category</div>
          <div className="mt-3 grid grid-cols-5 gap-2 text-xs">
            <div></div>
            {CATEGORIES.map(cat => (
              <div key={cat} className="text-center text-white/60">{cat.replace('_', ' ')}</div>
            ))}
            {(['BULL', 'NEUTRAL', 'BEAR'] as const).map(state => (
              <div key={state} className="contents">
                <div className="text-white/70">{state}</div>
                {CATEGORIES.map(cat => {
                  const cell = matrixMap.get(`${state}|${cat}`) ?? { n: 0, winRate: 0, netR: 0 };
                  return (
                    <button
                      key={`${state}-${cat}`}
                      onClick={() => { setBtcStateFilter(state); setCategories([cat]); }}
                      className="rounded-lg border border-white/10 bg-white/5 p-2 hover:bg-white/10"
                    >
                      <div className="font-semibold">{cell.n}</div>
                      <div className="text-[10px] text-white/60">Win {fmtRate(cell.winRate, 0)}</div>
                      <div className="text-[10px] text-white/60">NetR {fmt(cell.netR, 1)}</div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="flex items-center justify-between">
          <div className="text-xs text-white/60 uppercase tracking-widest">Why It Was Skipped</div>
            <button onClick={resetInvalidFilter} className="text-[10px] text-white/50 hover:text-white">Reset</button>
          </div>
          <div className="mt-3 space-y-2 text-xs">
            {(invalids?.rows ?? []).map((r: any) => (
              <button
                key={`${r.status}-${r.reason}`}
                onClick={() => { setWindowStatus(r.status as any); setInvalidReasonFilter(r.reason); }}
                className="w-full flex items-center justify-between px-2 py-1 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10"
              >
                <span className="text-white/70">{r.status}</span>
                <span className="text-white/50">{r.reason || '--'}</span>
                <span className="text-white/80">{r.n}</span>
              </button>
            ))}
            {!(invalids?.rows ?? []).length ? <div className="text-xs text-white/50">No invalid/partial rows.</div> : null}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/60 uppercase tracking-widest">Performance Buckets</div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            {(['deltaVwapPct','rsi9','atrPct','volSpike','rr'] as const).map(key => (
              <button
                key={key}
                onClick={() => setBucketTab(key)}
                className={`px-2 py-1 rounded-lg border ${bucketTab === key ? 'bg-cyan-400/20 border-cyan-400/40 text-cyan-100' : 'border-white/10 text-white/60 hover:text-white'}`}
              >
                {BUCKET_LABELS[key]}
              </button>
            ))}
          </div>
          <div className="mt-3 space-y-2 text-xs max-h-[220px] overflow-auto pr-1">
            {(buckets?.buckets?.[bucketTab] ?? []).map((b: any) => (
              <div key={b.label} className="flex items-center gap-3">
                <div className="w-24 text-white/60">{b.label}</div>
                <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-2 bg-emerald-400/60" style={{ width: `${Math.min(100, b.winPct * 100)}%` }} />
                </div>
                <div className="w-10 text-right text-white/80">{b.count}</div>
                <div className="w-14 text-right text-white/60">{fmtRate(b.winPct, 0)}</div>
                <div className="w-14 text-right text-white/60">{fmt(b.netR, 1)}</div>
              </div>
            ))}
            {!(buckets?.buckets?.[bucketTab] ?? []).length ? <div className="text-xs text-white/50">No bucket data.</div> : null}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 fade-up">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/60 uppercase tracking-widest">System Health</div>
          <div className="mt-2 text-xs text-white/70 space-y-1">
            <div>Last scan: {health?.scan?.finishedAt ? dt(health.scan.finishedAt) : '--'}</div>
            <div>Scan duration: {health?.scan?.durationMs ? fmtMs(health.scan.durationMs) : '--'}</div>
            <div>Processed: {health?.scan?.processedSymbols ?? 0} - Precheck: {health?.scan?.precheckPassed ?? 0} - Fetched OK: {health?.scan?.fetchedOk ?? 0}</div>
            <div>429s: {health?.scan?.errors429 ?? 0} - Other errors: {health?.scan?.errorsOther ?? 0}</div>
            <div>Outcomes backlog: {health?.outcomes?.backlog ?? 0}</div>
            <div>Outcomes last run: {health?.outcomes?.lastRun?.finishedAt ? dt(health.outcomes.lastRun.finishedAt) : '--'}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/60 uppercase tracking-widest">Why Signals Failed (Last Scan)</div>
          <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-white/70">
            <div>
              <div className="text-white/60">READY failures</div>
              <div>BTC: {health?.scan?.gateStats?.ready?.failed_btc_gate ?? 0}</div>
              <div>Confirm15: {health?.scan?.gateStats?.ready?.failed_confirm15 ?? 0}</div>
              <div>Trend: {health?.scan?.gateStats?.ready?.failed_trend ?? 0}</div>
              <div>Near VWAP: {health?.scan?.gateStats?.ready?.failed_near_vwap ?? 0}</div>
              <div>VolSpike: {health?.scan?.gateStats?.ready?.failed_volSpike ?? 0}</div>
              <div>ATR: {health?.scan?.gateStats?.ready?.failed_atr ?? 0}</div>
              <div>Sweep: {health?.scan?.gateStats?.ready?.failed_sweep ?? 0}</div>
            </div>
            <div>
              <div className="text-white/60">BEST failures</div>
              <div>BTC: {health?.scan?.gateStats?.best?.failed_btc_gate ?? 0}</div>
              <div>Confirm15: {health?.scan?.gateStats?.best?.failed_confirm15 ?? 0}</div>
              <div>Trend: {health?.scan?.gateStats?.best?.failed_trend ?? 0}</div>
              <div>Near VWAP: {health?.scan?.gateStats?.best?.failed_near_vwap ?? 0}</div>
              <div>VolSpike: {health?.scan?.gateStats?.best?.failed_volSpike ?? 0}</div>
              <div>ATR: {health?.scan?.gateStats?.best?.failed_atr ?? 0}</div>
              <div>Sweep: {health?.scan?.gateStats?.best?.failed_sweep ?? 0}</div>
              <div>RR: {health?.scan?.gateStats?.best?.failed_rr ?? 0}</div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-white/60 uppercase tracking-widest">Ready Gate Debug</div>
            <button
              onClick={loadReadyGateDebug}
              disabled={readyGateLoading}
              className="text-[10px] px-2 py-1 rounded bg-white/10 border border-white/10 disabled:opacity-50"
            >
              {readyGateLoading ? 'Loading...' : 'Load'}
            </button>
          </div>
          {readyGate?.error ? (
            <div className="mt-2 text-xs text-rose-200">{String(readyGate.error)}</div>
          ) : null}
          {!readyGate?.error && readyGate?.counts ? (
            <div className="mt-2 grid grid-cols-1 gap-3 text-xs text-white/70 max-h-[200px] overflow-auto pr-1">
              <div>
                <div className="text-[10px] uppercase text-white/50 mb-1">All Signals</div>
                {Object.entries(readyGate.counts as Record<string, number>)
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .slice(0, 8)
                  .map(([reason, n]) => (
                    <div key={`all-${reason}`} className="flex items-center justify-between bg-white/5 border border-white/10 rounded px-2 py-1">
                      <span className="text-white/70">{reason}</span>
                      <span className="text-white/90">{n}</span>
                    </div>
                  ))}
              </div>
              <div>
                <div className="text-[10px] uppercase text-white/50 mb-1">EARLY_READY Only</div>
                {Object.entries((readyGate.countsEarly ?? {}) as Record<string, number>)
                  .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                  .slice(0, 8)
                  .map(([reason, n]) => (
                    <div key={`early-${reason}`} className="flex items-center justify-between bg-white/5 border border-white/10 rounded px-2 py-1">
                      <span className="text-white/70">{reason}</span>
                      <span className="text-white/90">{n}</span>
                    </div>
                  ))}
              </div>
              {Object.keys(readyGate.counts ?? {}).length === 0 ? (
                <div className="text-xs text-white/50">No gate failures in range.</div>
              ) : null}
            </div>
          ) : (
            <div className="mt-2 text-xs text-white/50">Load to see last 50 signals with failed gates.</div>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden fade-up">
        <div className="p-3 border-b border-white/10 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="text-sm font-semibold">Outcomes</div>
            <span className="text-xs text-white/60">Total {outcomes?.total ?? 0}</span>
            {loadingTop || outcomesLoading ? <span className="text-xs text-white/40">Loading...</span> : null}
            {recomputeMsg ? <span className="text-xs text-white/50">{recomputeMsg}</span> : null}
            {clearMsg ? <span className="text-xs text-white/50">{clearMsg}</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={() => clearAllSignals()}
              disabled={clearLoading}
              className="px-2 py-1 rounded bg-rose-500/20 border border-rose-400/30 text-rose-100 disabled:opacity-50"
            >
              {clearLoading ? 'Clearing...' : 'Delete all signals'}
            </button>
            <button
              onClick={() => recomputeOutcomes()}
              disabled={recomputeLoading}
              className="px-2 py-1 rounded bg-white/10 border border-white/10 disabled:opacity-50"
            >
              {recomputeLoading ? 'Re-checking...' : 'Re-check outcomes'}
            </button>
            <select className="px-2 py-1 rounded bg-white/10 border border-white/10" value={windowStatus} onChange={(e) => setWindowStatus(e.target.value as any)}>
              <option value="ALL">All status</option>
              <option value="COMPLETE">Complete</option>
              <option value="PARTIAL">Partial</option>
              <option value="INVALID">Invalid</option>
            </select>
            <select className="px-2 py-1 rounded bg-white/10 border border-white/10" value={resultFilter} onChange={(e) => setResultFilter(e.target.value as any)}>
              <option value="ALL">All results</option>
              <option value="WIN">Win</option>
              <option value="LOSS">Loss</option>
              <option value="NONE">No hit</option>
            </select>
            <select className="px-2 py-1 rounded bg-white/10 border border-white/10" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="time_desc">Time</option>
              <option value="r_desc">R</option>
              <option value="mfe_desc">MFE</option>
              <option value="mae_desc">MAE</option>
            </select>
            <select className="px-2 py-1 rounded bg-white/10 border border-white/10" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[100, 200, 400, 800].map(n => <option key={n} value={n}>{n} rows</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-white/60">
              <tr className="border-b border-white/5">
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="text-left px-3 py-2">Category</th>
                <th className="text-left px-3 py-2">Preset</th>
                <th className="text-left px-3 py-2">BTC</th>
                <th className="text-left px-3 py-2">Gates</th>
                <th className="text-left px-3 py-2">Entry/Stop/TP1/TP2</th>
                <th className="text-left px-3 py-2">Result</th>
                <th className="text-left px-3 py-2">R (Risk)</th>
                <th className="text-left px-3 py-2">Time to Hit</th>
                <th className="text-left px-3 py-2">Max Up/Down</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Spark</th>
              </tr>
            </thead>
            <tbody>
              {outcomesRows.map((o: any) => (
                <tr key={`${o.signalId}-${o.horizonMin}`} className="border-b border-white/5 hover:bg-white/5 cursor-pointer" onClick={() => setSelectedId(o.signalId)}>
                  <td className="px-3 py-2 text-white/70">{dt(o.time)}</td>
                  <td className="px-3 py-2 font-semibold">{o.symbol}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-lg border ${categoryPill(o.category)}`}>
                      {o.category.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-white/70">{o.preset ?? '--'}</td>
                  <td className="px-3 py-2 text-white/70">
                    <div className="flex items-center gap-2">
                      <span>{btcStateFromRow(o)}</span>
                      {o.category === 'READY_TO_BUY' && o.btcBear ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/10 text-amber-200">
                          BTC Bear Override
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {hasDebugPayload(o) ? (
                      <div className="relative group inline-flex items-center gap-2 text-[10px] text-white/70">
                        <span className="px-1.5 py-0.5 rounded border border-white/15 bg-white/5 text-white/80">
                          {Number.isFinite(Number(o.gateScore)) ? `${Number(o.gateScore)}%` : '--'}
                        </span>
                        <span className="text-white/60">{shortGateLabel(o.firstFailedGate)}</span>
                        {o.blockedByBtc ? (
                          <span className="px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/10 text-amber-200">BTC</span>
                        ) : null}
                        {Array.isArray(o.blockedReasons) && o.blockedReasons.length ? (
                          <div className="absolute left-0 top-full z-10 mt-1 hidden w-64 flex-wrap gap-1 rounded-lg border border-white/10 bg-[#111722] p-2 text-[10px] text-white/80 group-hover:flex">
                            {o.blockedReasons.slice(0, 3).map((r: string, idx: number) => (
                              <span key={`${o.signalId}-${idx}`} className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5">
                                {r}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-white/70">{fmt(o.entryPrice ?? o.price, 6)} / {fmt(o.stop, 6)} / {fmt(o.tp1, 6)} / {fmt(o.tp2, 6)}</td>
                  <td className="px-3 py-2 text-white/80">
                    {o.result === 'NONE' && o.exitReason === 'TIMEOUT' ? 'TIMEOUT EXIT' : (o.result === 'NONE' ? 'NO HIT' : o.result)}
                    <div className="text-[10px] text-white/50">{o.exitReason}</div>
                  </td>
                  <td className="px-3 py-2 text-white/80">{fmt(o.rClose ?? o.rRealized, 2)}</td>
                  <td className="px-3 py-2 text-white/70">{fmtMs(o.timeToFirstHitMs)}</td>
                  <td className="px-3 py-2 text-white/70">{fmt(o.mfePct, 2)}% / {fmt(o.maePct, 2)}%</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-lg border ${outcomeStatusClass(o.windowStatus)}`}>
                      {o.windowStatus}
                    </span>
                    {currentResolveVersion && o.resolveVersion && o.resolveVersion !== currentResolveVersion ? (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-lg border border-amber-400/30 text-amber-200 bg-amber-400/10">
                        STALE
                      </span>
                    ) : null}
                    {o.invalidReason ? <div className="text-[10px] text-white/50">{o.invalidReason}</div> : null}
                    <div className="text-[10px] text-white/40">{fmt(o.coveragePct, 0)}% coverage</div>
                  </td>
                  <td className="px-3 py-2">
                    <MiniSpark
                      entry={o.entryPrice ?? o.price}
                      stop={o.stop}
                      tp1={o.tp1}
                      tp2={o.tp2}
                      minLow={(o.entryPrice ?? o.price) * (1 + (o.maePct / 100))}
                      maxHigh={(o.entryPrice ?? o.price) * (1 + (o.mfePct / 100))}
                      close={(o.entryPrice ?? o.price) * (1 + (o.retPct / 100))}
                    />
                  </td>
                </tr>
              ))}
              {!outcomesLoading && outcomesRows.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-3 py-4 text-white/50">No outcomes in range.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="p-3 border-t border-white/10 flex items-center justify-between text-xs text-white/60">
          <div>Page {page + 1} / {Math.max(1, totalPages)}</div>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} className="px-2 py-1 rounded bg-white/10">Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} className="px-2 py-1 rounded bg-white/10">Next</button>
          </div>
        </div>
      </section>

      {selectedId ? (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSelectedId(null)} />
          <div className="absolute top-0 right-0 h-full w-full max-w-xl bg-[#0d1218] border-l border-white/10 overflow-auto">
            <div className="p-4 border-b border-white/10 flex items-center justify-between">
              <div className="text-lg font-display">Signal Detail</div>
              <button className="px-2 py-1 rounded bg-white/10" onClick={() => setSelectedId(null)}>Close</button>
            </div>
            {!selected ? (
              <div className="p-4 text-white/60">Loading...</div>
            ) : (
              <div className="p-4 space-y-4">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm text-white/60">Signal</div>
                  <div className="text-lg font-semibold">{selected.symbol}</div>
                  <div className="text-xs text-white/60">{selected.category} - {dt(selected.time)}</div>
                  <div className="mt-2 text-xs text-white/70">
                    Entry {fmt(selected.price, 6)} - Stop {fmt(selected.stop, 6)} - TP1 {fmt(selected.tp1, 6)} - TP2 {fmt(selected.tp2, 6)}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm text-white/60">Checks</div>
                  <div className="mt-2 text-xs text-white/80 space-y-1">
                    <div>15m check (strict): {selected.confirm15Strict ? 'YES' : 'NO'} - soft: {selected.confirm15Soft ? 'YES' : 'NO'}</div>
                    <div>Session OK: {selected.sessionOk ? 'YES' : 'NO'} - Sweep OK: {selected.sweepOk ? 'YES' : 'NO'}</div>
                    <div>Trend OK: {selected.trendOk ? 'YES' : 'NO'} - BTC Bull: {selected.market?.btcBull15m ? 'YES' : 'NO'} - BTC Bear: {selected.market?.btcBear15m ? 'YES' : 'NO'}</div>
                    {selected.blockedByBtc ? <div className="text-amber-200">Blocked by BTC (would be {selected.wouldBeCategory})</div> : null}
                    {selected.category === 'READY_TO_BUY' && selected.market?.btcBear15m ? (
                      <div className="text-amber-200">BTC Bear Override used for this READY</div>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-white/60">Debug</div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={copyDebugJson}
                        className="px-2 py-1 rounded bg-white/10 border border-white/10 text-[10px]"
                      >
                        Copy Debug JSON
                      </button>
                      <button
                        onClick={copyReasonsText}
                        className="px-2 py-1 rounded bg-white/10 border border-white/10 text-[10px]"
                      >
                        Copy Reasons
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-1 gap-3 text-xs text-white/80">
                    <div className="rounded-lg border border-white/10 bg-white/5 p-2">
                      <div className="text-white/60">READY</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5">
                          GateScore {Number.isFinite(Number(selected.gateScore)) ? `${selected.gateScore}%` : '--'}
                        </span>
                        <span className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5">
                          FirstFail {shortGateLabel(selected.firstFailedGate)}
                        </span>
                        {selected.blockedByBtc ? (
                          <span className="px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-400/10 text-amber-200">
                            BTC blocked
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(selected.blockedReasons ?? []).map((r: string, idx: number) => (
                          <span key={`ready-reason-${idx}`} className="px-2 py-0.5 rounded border border-white/10 bg-white/5 text-[10px]">
                            {r}
                          </span>
                        ))}
                        {!(selected.blockedReasons ?? []).length ? <span className="text-white/50">No blocked reasons.</span> : null}
                      </div>
                    </div>

                    <div className="rounded-lg border border-white/10 bg-white/5 p-2">
                      <div className="text-white/60">BEST</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5">
                          GateScore {Number.isFinite(Number(selected.bestDebug?.gateScore)) ? `${selected.bestDebug?.gateScore}%` : '--'}
                        </span>
                        <span className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5">
                          FirstFail {shortGateLabel(selected.bestDebug?.firstFailedGate)}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(selected.bestDebug?.blockedReasons ?? []).map((r: string, idx: number) => (
                          <span key={`best-reason-${idx}`} className="px-2 py-0.5 rounded border border-white/10 bg-white/5 text-[10px]">
                            {r}
                          </span>
                        ))}
                        {!(selected.bestDebug?.blockedReasons ?? []).length ? <span className="text-white/50">No blocked reasons.</span> : null}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3">
                    <button
                      onClick={() => setShowGateSnapshot(v => !v)}
                      className="text-[11px] px-2 py-1 rounded bg-white/10 border border-white/10"
                    >
                      {showGateSnapshot ? 'Hide Gate Snapshot' : 'Show Gate Snapshot'}
                    </button>
                  </div>

                  {showGateSnapshot && selected.gateSnapshot ? (
                    <div className="mt-2 space-y-3 text-[11px] text-white/80">
                      {(['ready', 'best'] as const).map((section) => (
                        <div key={section} className="rounded-lg border border-white/10 bg-white/5 p-2">
                          <div className="text-white/60 uppercase">{section}</div>
                          <div className="mt-1 grid grid-cols-2 gap-2">
                            {Object.entries(selected.gateSnapshot?.[section] ?? {}).map(([k, v]) => (
                              <div key={`${section}-${k}`} className="flex items-center justify-between px-2 py-1 rounded border border-white/10 bg-white/5">
                                <span className="text-white/70">{k}</span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] ${v ? 'bg-emerald-400/15 text-emerald-200 border border-emerald-400/30' : 'bg-rose-400/15 text-rose-200 border border-rose-400/30'}`}>
                                  {v ? 'PASS' : 'FAIL'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm text-white/60">Outcomes</div>
                  {(selected.outcomes ?? []).map((o: any) => (
                    <div key={o.horizonMin} className="mt-2 rounded-xl border border-white/10 bg-white/5 p-2 text-xs">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold">{o.horizonMin}m</div>
                        <div className={`px-2 py-0.5 rounded border ${outcomeStatusClass(o.windowStatus)}`}>{o.windowStatus}</div>
                      </div>
                      <div className="mt-2 text-white/70">
                        Result {o.result === 'NONE' && o.exitReason === 'TIMEOUT' ? 'TIMEOUT EXIT' : (o.result === 'NONE' ? 'NO HIT' : o.result)} - Exit {o.exitReason} - R {fmt(o.rClose ?? o.rRealized, 2)} - Max Up {fmt(o.mfePct, 2)}% - Max Down {fmt(o.maePct, 2)}%
                      </div>
                      <div className="mt-1 text-white/50 flex flex-wrap items-center gap-2">
                        <span>State {o.outcomeState || '--'}</span>
                        <span>- Bars to Exit {o.barsToExit ?? '--'}</span>
                        <span>- Resolved {o.resolvedAt ? dt(o.resolvedAt) : '--'}</span>
                        <span
                          className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5 font-mono text-[10px]"
                          title="Resolver logic version used to produce this outcome row"
                        >
                          Resolve v{o.resolveVersion || '--'}
                        </span>
                        {currentResolveVersion && o.resolveVersion && o.resolveVersion !== currentResolveVersion ? (
                          <span className="px-1.5 py-0.5 rounded border border-amber-400/30 text-amber-200 bg-amber-400/10 text-[10px]">
                            STALE
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 text-white/50">
                        Candles {o.nCandles}/{o.neededCandles} - Coverage {fmt(o.coveragePct, 0)}% - Reason {o.invalidReason || '--'}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-sm text-white/60">Reasons</div>
                  <div className="mt-2 text-xs text-white/80 space-y-1">
                    {(selected.reasons ?? []).map((r: string, idx: number) => (
                      <div key={idx}>- {r}</div>
                    ))}
                    {!(selected.reasons ?? []).length ? <div className="text-white/50">No reasons stored.</div> : null}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KpiCard(props: { label: string; value: any; sub?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="text-xs text-white/60 uppercase tracking-widest">{props.label}</div>
      <div className="mt-2 text-xl font-semibold">{props.value ?? '--'}</div>
      {props.sub ? <div className="text-[11px] text-white/50 mt-1">{props.sub}</div> : null}
    </div>
  );
}
