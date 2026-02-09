import { useEffect, useMemo, useState } from 'react';

const rawApiBase = (import.meta.env.VITE_API_BASE ?? '').trim();
const fallbackApiBase = import.meta.env.PROD
  ? 'https://pro-scalp-backend-production.up.railway.app'
  : '';
const apiBase = (rawApiBase || fallbackApiBase).replace(/\/+$/, '');
const API = (path: string) => apiBase + path;

type Preset = 'BALANCED' | 'CONSERVATIVE' | 'AGGRESSIVE';

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
function dt(ms: number | string | null | undefined) {
  const v = num(ms);
  if (!Number.isFinite(v) || v <= 0) return '--';
  try { return new Date(v).toLocaleString(); } catch { return String(ms); }
}

function sortEntries(obj: Record<string, number> | null | undefined) {
  return Object.entries(obj ?? {})
    .map(([k, v]) => ({ key: k, val: Number(v) }))
    .filter((x) => Number.isFinite(x.val))
    .sort((a, b) => b.val - a.val);
}

export default function TunePage() {
  const [scanRuns, setScanRuns] = useState<any[]>([]);
  const [runId, setRunId] = useState('');
  const [useLatest, setUseLatest] = useState(true);
  const [preset, setPreset] = useState<Preset>('BALANCED');
  const [limit, setLimit] = useState(500);
  const [symbolsText, setSymbolsText] = useState('');
  const [overridesText, setOverridesText] = useState('');
  const [includeExamples, setIncludeExamples] = useState(true);
  const [examplesPerGate, setExamplesPerGate] = useState(5);

  const [simResult, setSimResult] = useState<any | null>(null);
  const [histResult, setHistResult] = useState<any | null>(null);
  const [loadingSim, setLoadingSim] = useState(false);
  const [loadingHist, setLoadingHist] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const load = async () => {
      try {
        const resp = await fetch(API('/api/scanRuns?limit=25')).then(r => r.json());
        if (resp?.ok) setScanRuns(resp.rows ?? []);
      } catch {
        // ignore
      }
    };
    load();
  }, []);

  const symbols = useMemo(() => {
    const items = symbolsText.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    return items.length ? items : null;
  }, [symbolsText]);

  function applyExampleOverrides() {
    setOverridesText(JSON.stringify({
      RSI_EARLY_MIN: 30,
      RSI_EARLY_MAX: 90,
      VWAP_WATCH_MIN_PCT: 1.0,
      READY_VWAP_MAX_PCT: 0.6,
      READY_VWAP_EPS_PCT: 0.6,
      READY_VWAP_TOUCH_PCT: 1.0,
      READY_VWAP_TOUCH_BARS: 30,
      READY_EMA_EPS_PCT: 0.8,
      WATCH_EMA_EPS_PCT: 1.0,
      READY_BODY_PCT: 0.08,
      READY_CLOSE_POS_MIN: 0.55,
      READY_UPPER_WICK_MAX: 0.5,
    }, null, 2));
  }

  async function runSim() {
    setError('');
    setLoadingSim(true);
    setSimResult(null);
    try {
      let overrides = {};
      if (overridesText.trim()) {
        overrides = JSON.parse(overridesText);
      }
      const body = {
        preset,
        runId: useLatest ? '' : runId.trim(),
        useLatestFinishedIfMissing: useLatest,
        overrides,
        scope: {
          limit,
          symbols,
        },
        includeExamples,
        examplesPerGate,
      };
      const resp = await fetch(API('/api/tune/sim'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (resp?.ok === false) {
        setError(resp?.error || 'Tune sim failed');
        return;
      }
      setSimResult(resp);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoadingSim(false);
    }
  }

  async function loadHist() {
    setError('');
    setLoadingHist(true);
    setHistResult(null);
    try {
      const qs = new URLSearchParams();
      if (!useLatest && runId.trim()) qs.set('runId', runId.trim());
      if (useLatest) qs.set('useLatestFinishedIfMissing', 'true');
      qs.set('preset', preset);
      qs.set('limit', String(Math.min(10000, Math.max(100, limit))));
      const resp = await fetch(API(`/api/tune/hist?${qs.toString()}`)).then(r => r.json());
      if (resp?.ok === false) {
        setError(resp?.error || 'Hist load failed');
        return;
      }
      setHistResult(resp);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoadingHist(false);
    }
  }

  function onPickRun(value: string) {
    setRunId(value);
    const r = scanRuns.find((x) => x.runId === value);
    if (r?.preset && ['BALANCED', 'CONSERVATIVE', 'AGGRESSIVE'].includes(String(r.preset))) {
      setPreset(r.preset);
    }
  }

  return (
    <div className="mt-4 space-y-6">
      <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-lg font-semibold">Tune Simulator</div>
        <div className="text-xs text-white/60 mt-1">
          Replay gates against stored snapshots to test thresholds in seconds.
        </div>

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-xs text-white/60">Run</div>
            <label className="mt-2 flex items-center gap-2 text-xs text-white/70">
              <input type="checkbox" checked={useLatest} onChange={(e) => setUseLatest(e.target.checked)} />
              Use latest finished run
            </label>
            <select
              className="mt-2 w-full px-2 py-1 rounded bg-white/10 border border-white/10 text-sm"
              value={useLatest ? '' : runId}
              onChange={(e) => onPickRun(e.target.value)}
              disabled={useLatest}
            >
              <option value="">Select runId</option>
              {scanRuns.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} | {r.preset} | {dt(r.startedAt)}
                </option>
              ))}
            </select>
            {!useLatest ? (
              <input
                className="mt-2 w-full px-2 py-1 rounded bg-white/10 border border-white/10 text-sm"
                placeholder="Or paste runId"
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
              />
            ) : null}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-xs text-white/60">Scope</div>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-white/60">Preset</label>
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as Preset)}
                className="bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
              >
                <option value="BALANCED">BALANCED</option>
                <option value="CONSERVATIVE">CONSERVATIVE</option>
                <option value="AGGRESSIVE">AGGRESSIVE</option>
              </select>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-white/60">Limit</label>
              <input
                type="number"
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(5000, Number(e.target.value))))}
                className="w-28 bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
              />
            </div>
            <div className="mt-2">
              <div className="text-xs text-white/60">Symbols (comma-separated)</div>
              <input
                value={symbolsText}
                onChange={(e) => setSymbolsText(e.target.value)}
                className="mt-1 w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                placeholder="ETHUSDT,SOLUSDT"
              />
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-xs text-white/60">Output</div>
            <label className="mt-2 flex items-center gap-2 text-xs text-white/70">
              <input type="checkbox" checked={includeExamples} onChange={(e) => setIncludeExamples(e.target.checked)} />
              Include examples
            </label>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-xs text-white/60">Examples per gate</label>
              <input
                type="number"
                value={examplesPerGate}
                onChange={(e) => setExamplesPerGate(Math.max(1, Math.min(50, Number(e.target.value))))}
                className="w-20 bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
              />
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button onClick={runSim} className="px-3 py-1 rounded-xl bg-emerald-400/20 hover:bg-emerald-400/30">
                {loadingSim ? 'Running...' : 'Run Sim'}
              </button>
              <button onClick={loadHist} className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15">
                {loadingHist ? 'Loading...' : 'Load Hist'}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-white/60">Overrides JSON</div>
            <button onClick={applyExampleOverrides} className="px-2 py-1 rounded bg-white/10 text-[10px]">
              Load Example
            </button>
          </div>
          <textarea
            value={overridesText}
            onChange={(e) => setOverridesText(e.target.value)}
            rows={10}
            className="mt-2 w-full bg-black/30 border border-white/10 rounded p-2 font-mono text-[11px]"
            placeholder='{"RSI_EARLY_MIN": 30}'
          />
        </div>

        {error ? (
          <div className="mt-3 text-xs text-rose-200 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1">
            {error}
          </div>
        ) : null}
      </section>

      {simResult ? (
        <section className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">Sim Results</div>
            <div className="text-xs text-white/60">
              Run {simResult?.meta?.runId || '--'} | {dt(simResult?.meta?.startedAt)}
            </div>
          </div>

          {simResult?.meta?.overrides ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/80 space-y-2">
              <div className="text-white/60">Overrides</div>
              <div>
                <span className="text-white/60">Applied:</span>{' '}
                {Object.keys(simResult.meta.overrides.applied || {}).length
                  ? JSON.stringify(simResult.meta.overrides.applied)
                  : 'None'}
              </div>
              {simResult.meta.overrides.unknownKeys?.length ? (
                <div className="text-amber-200">
                  Unknown keys: {simResult.meta.overrides.unknownKeys.join(', ')}
                </div>
              ) : null}
              {simResult.meta.overrides.typeErrors && Object.keys(simResult.meta.overrides.typeErrors).length ? (
                <div className="text-amber-200">
                  Type errors: {JSON.stringify(simResult.meta.overrides.typeErrors)}
                </div>
              ) : null}
              <details className="mt-1">
                <summary className="cursor-pointer text-white/60">Effective config</summary>
                <pre className="mt-2 whitespace-pre-wrap text-[11px] bg-black/30 border border-white/10 rounded p-2">
{JSON.stringify(simResult.meta.overrides.effectiveConfig ?? {}, null, 2)}
                </pre>
              </details>
            </div>
          ) : null}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Evaluated</div>
              <div className="text-xl font-semibold">{simResult?.meta?.evaluated ?? 0}</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Watch</div>
              <div className="text-xl font-semibold">{simResult?.counts?.watch ?? 0}</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Early</div>
              <div className="text-xl font-semibold">{simResult?.counts?.early ?? 0}</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Ready / Best</div>
              <div className="text-xl font-semibold">
                {simResult?.counts?.ready ?? 0} / {simResult?.counts?.best ?? 0}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Funnel</div>
              <div className="mt-2 text-sm text-white/80 space-y-1">
                <div>candidate_evaluated: {simResult?.funnel?.candidate_evaluated ?? 0}</div>
                <div>watch_created: {simResult?.funnel?.watch_created ?? 0}</div>
                <div>early_created: {simResult?.funnel?.early_created ?? 0}</div>
                <div>ready_core_true: {simResult?.funnel?.ready_core_true ?? 0}</div>
                <div>best_core_true: {simResult?.funnel?.best_core_true ?? 0}</div>
                <div>ready_final_true: {simResult?.funnel?.ready_final_true ?? simResult?.counts?.ready ?? 0}</div>
                <div>best_final_true: {simResult?.funnel?.best_final_true ?? simResult?.counts?.best ?? 0}</div>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Diff vs Actual</div>
              <div className="mt-2 text-sm text-white/80 space-y-1">
                <div>watch: {simResult?.diffVsActual?.watch ?? '--'}</div>
                <div>early: {simResult?.diffVsActual?.early ?? '--'}</div>
                <div>ready: {simResult?.diffVsActual?.ready ?? '--'}</div>
                <div>best: {simResult?.diffVsActual?.best ?? '--'}</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
            {(['watch', 'early', 'ready', 'best'] as const).map((stage) => (
              <div key={stage} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">First Failed: {stage}</div>
                <div className="mt-2 text-sm text-white/80 space-y-1">
                  {sortEntries(simResult?.firstFailed?.[stage]).slice(0, 6).map((r) => (
                    <div key={`${stage}-ff-${r.key}`} className="flex items-center justify-between">
                      <span className="text-white/70">{r.key}</span>
                      <span>{r.val}</span>
                    </div>
                  ))}
                  {!sortEntries(simResult?.firstFailed?.[stage]).length ? (
                    <div className="text-white/50">No failures</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
            {(['watch', 'early', 'ready', 'best'] as const).map((stage) => (
              <div key={`${stage}-true`} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Gate True: {stage}</div>
                <div className="mt-2 text-sm text-white/80 space-y-1">
                  {sortEntries(simResult?.gateTrue?.[stage]).slice(0, 6).map((r) => (
                    <div key={`${stage}-gt-${r.key}`} className="flex items-center justify-between">
                      <span className="text-white/70">{r.key}</span>
                      <span>{r.val}</span>
                    </div>
                  ))}
                  {!sortEntries(simResult?.gateTrue?.[stage]).length ? (
                    <div className="text-white/50">No data</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {simResult?.examples ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Examples</div>
              <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm text-white/80">
                {Object.entries(simResult.examples).map(([stage, gates]: any) => (
                  <div key={`ex-${stage}`} className="rounded-lg border border-white/10 bg-white/5 p-2">
                    <div className="text-white/70">{stage}</div>
                    <div className="mt-2 space-y-1">
                      {Object.entries(gates as Record<string, string[]>).slice(0, 6).map(([k, v]) => (
                        <div key={`ex-${stage}-${k}`} className="flex items-center justify-between text-[11px]">
                          <span className="text-white/60">{k}</span>
                          <span className="text-white/80">{(v ?? []).slice(0, 5).join(', ')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {histResult ? (
        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">Histograms</div>
            <div className="text-xs text-white/60">
              {histResult?.meta?.runId || '--'} | {dt(histResult?.meta?.startedAt)}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            {(['rsi', 'vwapAbs', 'emaAbs', 'bodyPct', 'atrPct'] as const).map((k) => (
              <div key={`hist-${k}`} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">{k}</div>
                <div className="mt-2 text-[11px] text-white/80 space-y-1">
                  {Object.entries(histResult?.[k] ?? {}).map(([p, v]) => (
                    <div key={`${k}-${p}`} className="flex items-center justify-between">
                      <span className="text-white/60">{p}</span>
                      <span>{fmt(Number(v), 2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
