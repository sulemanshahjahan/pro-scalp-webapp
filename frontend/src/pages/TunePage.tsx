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

function parseJsonObject(text: string): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Overrides must be a JSON object.' };
    }
    return { ok: true, value: parsed as Record<string, any> };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || 'Invalid JSON') };
  }
}

function makeId() {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function topGateLabel(obj: Record<string, number> | null | undefined) {
  const top = sortEntries(obj)[0];
  return top ? `${top.key} (${top.val})` : '--';
}

const SWEEP_KEYS = [
  'THRESHOLD_VOL_SPIKE_X',
  'THRESHOLD_VWAP_DISTANCE_PCT',
  'THRESHOLD_ATR_GUARD_PCT',
  'READY_VWAP_MAX_PCT',
  'READY_VWAP_EPS_PCT',
  'READY_EMA_EPS_PCT',
  'READY_BODY_PCT',
  'READY_CLOSE_POS_MIN',
  'READY_UPPER_WICK_MAX',
  'VWAP_WATCH_MIN_PCT',
  'WATCH_EMA_EPS_PCT',
  'RSI_EARLY_MIN',
  'RSI_EARLY_MAX',
  'RSI_READY_MIN',
  'RSI_READY_MAX',
  'RSI_BEST_MIN',
  'RSI_BEST_MAX',
  'RR_MIN_BEST',
  'READY_MIN_RR',
  'READY_MIN_RISK_PCT',
  'READY_VOL_SPIKE_MAX',
];

const BOOLEAN_GATES = [
  'READY_BTC_REQUIRED',
  'READY_CONFIRM15_REQUIRED',
  'READY_TREND_REQUIRED',
  'READY_VOL_SPIKE_REQUIRED',
  'READY_RECLAIM_REQUIRED',
  'READY_SWEEP_REQUIRED',
  'BEST_BTC_REQUIRED',
];

export default function TunePage() {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [scanRuns, setScanRuns] = useState<any[]>([]);
  const [runId, setRunId] = useState('');
  const [useLatest, setUseLatest] = useState(true);
  const [batchSource, setBatchSource] = useState<'latest' | 'runId' | 'lastN' | 'range'>('latest');
  const [batchLastN, setBatchLastN] = useState(25);
  const [batchRangeStart, setBatchRangeStart] = useState(0);
  const [batchRangeEnd, setBatchRangeEnd] = useState(24);
  const [preset, setPreset] = useState<Preset>('BALANCED');
  const [limit, setLimit] = useState(500);
  const [symbolsText, setSymbolsText] = useState('');
  const [overridesText, setOverridesText] = useState('');
  const [baseOverridesText, setBaseOverridesText] = useState('');
  const [lockGuardrails, setLockGuardrails] = useState(true);
  const [variants, setVariants] = useState<Array<{ id: string; name: string; overridesText: string }>>([
    { id: makeId(), name: 'base', overridesText: '{}' },
  ]);
  const [diffSymbolsLimit, setDiffSymbolsLimit] = useState(200);
  const [sweepKey, setSweepKey] = useState('THRESHOLD_VOL_SPIKE_X');
  const [sweepStart, setSweepStart] = useState(1.2);
  const [sweepEnd, setSweepEnd] = useState(1.8);
  const [sweepSteps, setSweepSteps] = useState(5);
  const [sweepIncludeBooleans, setSweepIncludeBooleans] = useState(false);
  const [includeExamples, setIncludeExamples] = useState(true);
  const [examplesPerGate, setExamplesPerGate] = useState(5);

  const [simResult, setSimResult] = useState<any | null>(null);
  const [batchResult, setBatchResult] = useState<any | null>(null);
  const [histResult, setHistResult] = useState<any | null>(null);
  const [loadingSim, setLoadingSim] = useState(false);
  const [loadingBatch, setLoadingBatch] = useState(false);
  const [loadingHist, setLoadingHist] = useState(false);
  const [error, setError] = useState<string>('');
  const [selectedVariantName, setSelectedVariantName] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('ps_admin_token') ?? '');
  const [bundleHours, setBundleHours] = useState(6);
  const [bundleLimit, setBundleLimit] = useState(20);
  const [bundleLatest, setBundleLatest] = useState<any | null>(null);
  const [bundleRecent, setBundleRecent] = useState<any[]>([]);
  const [bundleSelected, setBundleSelected] = useState<any | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [bundleError, setBundleError] = useState('');
  const [showBundleJson, setShowBundleJson] = useState(false);

  useEffect(() => {
    localStorage.setItem('ps_admin_token', adminToken);
  }, [adminToken]);

  useEffect(() => {
    const load = async () => {
      try {
        const resp = await fetch(API('/api/scanRuns?limit=100')).then(r => r.json());
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

  const selectedVariant = useMemo(() => {
    if (!batchResult?.variants?.length || !selectedVariantName) return null;
    return batchResult.variants.find((v: any) => v?.name === selectedVariantName) ?? null;
  }, [batchResult, selectedVariantName]);

  const rangeRunIds = useMemo(() => {
    if (batchSource !== 'range') return [];
    const maxIdx = Math.max(0, scanRuns.length - 1);
    const start = Math.max(0, Math.min(maxIdx, Number(batchRangeStart) || 0));
    const end = Math.max(start, Math.min(maxIdx, Number(batchRangeEnd) || 0));
    return scanRuns.slice(start, end + 1).map((r) => r.runId).filter(Boolean);
  }, [batchSource, batchRangeStart, batchRangeEnd, scanRuns]);

  function authHeaders() {
    return adminToken.trim() ? { 'x-admin-token': adminToken.trim() } : {};
  }

  async function loadBundleLatest() {
    setBundleError('');
    setBundleLoading(true);
    try {
      const qs = new URLSearchParams();
      if (Number.isFinite(bundleHours)) qs.set('hours', String(bundleHours));
      const resp = await fetch(API(`/api/tuning/bundles/latest?${qs.toString()}`), {
        headers: authHeaders(),
      }).then(r => r.json());
      if (resp?.ok === false) {
        setBundleError(resp?.error || 'Failed to load latest bundle');
        return;
      }
      setBundleLatest(resp.bundle ?? null);
      setBundleSelected(resp.bundle ?? null);
    } catch (e: any) {
      setBundleError(String(e?.message || e));
    } finally {
      setBundleLoading(false);
    }
  }

  async function loadBundleRecent() {
    setBundleError('');
    setBundleLoading(true);
    try {
      const qs = new URLSearchParams();
      if (Number.isFinite(bundleLimit)) qs.set('limit', String(bundleLimit));
      const resp = await fetch(API(`/api/tuning/bundles/recent?${qs.toString()}`), {
        headers: authHeaders(),
      }).then(r => r.json());
      if (resp?.ok === false) {
        setBundleError(resp?.error || 'Failed to load recent bundles');
        return;
      }
      setBundleRecent(resp.bundles ?? []);
    } catch (e: any) {
      setBundleError(String(e?.message || e));
    } finally {
      setBundleLoading(false);
    }
  }

  async function loadBundleById(id: number) {
    if (!Number.isFinite(id)) return;
    setBundleError('');
    setBundleLoading(true);
    try {
      const resp = await fetch(API(`/api/tuning/bundles/${id}`), {
        headers: authHeaders(),
      }).then(r => r.json());
      if (resp?.ok === false) {
        setBundleError(resp?.error || 'Failed to load bundle');
        return;
      }
      setBundleSelected(resp.bundle ?? null);
    } catch (e: any) {
      setBundleError(String(e?.message || e));
    } finally {
      setBundleLoading(false);
    }
  }

  function copyBundleMarkdown() {
    const md = bundleSelected?.reportMd ?? '';
    if (!md) return;
    navigator.clipboard.writeText(md).catch(() => {});
  }

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
    setBatchResult(null);
    try {
      const parsed = parseJsonObject(overridesText);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      const overrides = parsed.value;
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
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
      const resp = await fetch(API(`/api/tune/hist?${qs.toString()}`), {
        headers: authHeaders(),
      }).then(r => r.json());
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

  function updateVariant(id: string, patch: Partial<{ name: string; overridesText: string }>) {
    setVariants((items) => items.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }

  function addVariant() {
    setVariants((items) => [...items, { id: makeId(), name: `variant_${items.length + 1}`, overridesText: '{}' }]);
  }

  function duplicateVariant(id: string) {
    setVariants((items) => {
      const found = items.find((v) => v.id === id);
      if (!found) return items;
      return [...items, { id: makeId(), name: `${found.name}_copy`, overridesText: found.overridesText }];
    });
  }

  function deleteVariant(id: string) {
    setVariants((items) => items.filter((v) => v.id !== id));
  }

  function generateVariants() {
    const steps = Math.max(1, Math.min(60, Number.isFinite(sweepSteps) ? sweepSteps : 5));
    const start = Number(sweepStart);
    const end = Number(sweepEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setError('Sweep start/end must be numbers.');
      return;
    }
    const span = end - start;
    const stepSize = steps === 1 ? 0 : span / (steps - 1);
    const next: Array<{ id: string; name: string; overridesText: string }> = [];
    for (let i = 0; i < steps; i += 1) {
      const value = start + stepSize * i;
      const rounded = Number.isFinite(value) ? Number(value.toFixed(4)) : value;
      const name = `${sweepKey}_${rounded}`;
      next.push({ id: makeId(), name, overridesText: JSON.stringify({ [sweepKey]: rounded }, null, 2) });
    }
    if (sweepIncludeBooleans) {
      const baseParsed = parseJsonObject(baseOverridesText);
      const base = baseParsed.ok ? baseParsed.value : {};
      for (const key of BOOLEAN_GATES) {
        const cur = base[key];
        const flipped = typeof cur === 'boolean' ? !cur : false;
        next.push({ id: makeId(), name: `${key}_${String(flipped)}`, overridesText: JSON.stringify({ [key]: flipped }, null, 2) });
      }
    }
    setVariants((items) => [...items, ...next]);
  }

  async function runBatch(onlyId?: string) {
    setError('');
    setLoadingBatch(true);
    setBatchResult(null);
    setSimResult(null);
    try {
      const baseParsed = parseJsonObject(baseOverridesText);
      if (!baseParsed.ok) {
        setError(baseParsed.error);
        return;
      }
      const guardKeys = new Set(Object.keys(baseParsed.value));
      const targetVariants = onlyId ? variants.filter((v) => v.id === onlyId) : variants;
      if (!targetVariants.length) {
        setError('No variants to run.');
        return;
      }
      const parsedVariants = targetVariants.map((v) => {
        const parsed = parseJsonObject(v.overridesText);
        if (!parsed.ok) throw new Error(`Variant "${v.name}" overrides: ${parsed.error}`);
        const filtered = lockGuardrails
          ? Object.fromEntries(Object.entries(parsed.value).filter(([k]) => !guardKeys.has(k)))
          : parsed.value;
        return {
          name: v.name?.trim() || v.id,
          overrides: filtered,
        };
      });

      if (batchSource === 'range' && !rangeRunIds.length) {
        setError('No scan runs found in range.');
        return;
      }

      const body = {
        preset,
        runId: batchSource === 'runId' ? runId.trim() : '',
        useLatestFinishedIfMissing: batchSource !== 'runId',
        baseOverrides: baseParsed.value,
        variants: parsedVariants,
        scope: {
          limit,
          symbols,
        },
        includeExamples,
        examplesPerGate,
        diffSymbolsLimit,
        source: batchSource === 'lastN'
          ? { mode: 'lastN', limit: batchLastN }
          : batchSource === 'range'
            ? { mode: 'runIds', runIds: rangeRunIds }
            : { mode: batchSource === 'latest' ? 'lastScan' : 'runId', runId: runId.trim() },
      };
      const resp = await fetch(API('/api/tune/simBatch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (resp?.ok === false) {
        setError(resp?.error || 'Batch sim failed');
        return;
      }
      setBatchResult(resp);
      if (resp?.variants?.length) setSelectedVariantName(resp.variants[0].name);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoadingBatch(false);
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
        <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 p-1 text-xs">
          <button
            onClick={() => setMode('single')}
            className={`px-3 py-1 rounded-full ${mode === 'single' ? 'bg-emerald-400/20 text-white' : 'text-white/70 hover:text-white'}`}
          >
            Single Sim
          </button>
          <button
            onClick={() => setMode('batch')}
            className={`px-3 py-1 rounded-full ${mode === 'batch' ? 'bg-emerald-400/20 text-white' : 'text-white/70 hover:text-white'}`}
          >
            Batch Sim
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
          <div className="text-white/70">Admin token (for tuning + bundles)</div>
          <input
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            className="mt-2 w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
            placeholder="x-admin-token (optional)"
          />
          <div className="mt-1 text-white/50">Stored in localStorage. Leave blank if ADMIN_TOKEN is not set.</div>
        </div>

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3 text-sm">
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-xs text-white/60">Run</div>
            {mode === 'single' ? (
              <>
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
              </>
            ) : (
              <>
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-xs text-white/60">Source</label>
                  <select
                    value={batchSource}
                    onChange={(e) => setBatchSource(e.target.value as any)}
                    className="bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                  >
                    <option value="latest">Latest finished run</option>
                    <option value="runId">Specific run</option>
                    <option value="lastN">Last N runs</option>
                    <option value="range">Range (index)</option>
                  </select>
                </div>
                {batchSource === 'runId' ? (
                  <>
                    <select
                      className="mt-2 w-full px-2 py-1 rounded bg-white/10 border border-white/10 text-sm"
                      value={runId}
                      onChange={(e) => onPickRun(e.target.value)}
                    >
                      <option value="">Select runId</option>
                      {scanRuns.map((r) => (
                        <option key={r.runId} value={r.runId}>
                          {r.runId} | {r.preset} | {dt(r.startedAt)}
                        </option>
                      ))}
                    </select>
                    <input
                      className="mt-2 w-full px-2 py-1 rounded bg-white/10 border border-white/10 text-sm"
                      placeholder="Or paste runId"
                      value={runId}
                      onChange={(e) => setRunId(e.target.value)}
                    />
                  </>
                ) : null}
                {batchSource === 'lastN' ? (
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-xs text-white/60">Last N runs</label>
                    <input
                      type="number"
                      value={batchLastN}
                      onChange={(e) => setBatchLastN(Math.max(1, Math.min(400, Number(e.target.value))))}
                      className="w-24 bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                    />
                  </div>
                ) : null}
                {batchSource === 'range' ? (
                  <div className="mt-2 space-y-2 text-xs">
                    <div className="flex items-center gap-2">
                      <label className="text-white/60">Start index</label>
                      <input
                        type="number"
                        value={batchRangeStart}
                        onChange={(e) => setBatchRangeStart(Math.max(0, Number(e.target.value)))}
                        className="w-24 bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                      />
                      <label className="text-white/60">End index</label>
                      <input
                        type="number"
                        value={batchRangeEnd}
                        onChange={(e) => setBatchRangeEnd(Math.max(0, Number(e.target.value)))}
                        className="w-24 bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                      />
                    </div>
                    <div className="text-white/50">
                      Uses scanRuns list (index 0 = newest). Selected: {rangeRunIds.length}
                    </div>
                  </div>
                ) : null}
              </>
            )}
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
              <label className="text-xs text-white/60">
                {mode === 'batch' && batchSource === 'lastN' ? 'Limit / run' : 'Limit'}
              </label>
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
            {mode === 'batch' ? (
              <div className="mt-2 flex items-center gap-2">
                <label className="text-xs text-white/60">Diff symbols limit</label>
                <input
                  type="number"
                  value={diffSymbolsLimit}
                  onChange={(e) => setDiffSymbolsLimit(Math.max(0, Math.min(2000, Number(e.target.value))))}
                  className="w-24 bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
                />
              </div>
            ) : null}
            <div className="mt-4 flex items-center gap-2">
              {mode === 'single' ? (
                <>
                  <button onClick={runSim} className="px-3 py-1 rounded-xl bg-emerald-400/20 hover:bg-emerald-400/30">
                    {loadingSim ? 'Running...' : 'Run Sim'}
                  </button>
                  <button onClick={loadHist} className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/15">
                    {loadingHist ? 'Loading...' : 'Load Hist'}
                  </button>
                </>
              ) : (
                <button onClick={() => runBatch()} className="px-3 py-1 rounded-xl bg-emerald-400/20 hover:bg-emerald-400/30">
                  {loadingBatch ? 'Running...' : 'Run Batch'}
                </button>
              )}
            </div>
          </div>
        </div>

        {mode === 'single' ? (
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
        ) : (
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-white/60">Base Overrides (Guardrails)</div>
                <label className="text-[11px] text-white/60 flex items-center gap-2">
                  <input type="checkbox" checked={lockGuardrails} onChange={(e) => setLockGuardrails(e.target.checked)} />
                  Lock guardrails
                </label>
              </div>
              <textarea
                value={baseOverridesText}
                onChange={(e) => setBaseOverridesText(e.target.value)}
                rows={8}
                className="mt-2 w-full bg-black/30 border border-white/10 rounded p-2 font-mono text-[11px]"
                placeholder='{"READY_BTC_REQUIRED": true, "READY_CONFIRM15_REQUIRED": true}'
              />
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between">
                <div className="text-xs text-white/60">Variants</div>
                <button onClick={addVariant} className="px-2 py-1 rounded bg-white/10 text-[10px]">
                  Add Variant
                </button>
              </div>
              <div className="mt-2 space-y-3">
                {variants.map((variant) => (
                  <div key={variant.id} className="rounded-lg border border-white/10 bg-white/5 p-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={variant.name}
                        onChange={(e) => updateVariant(variant.id, { name: e.target.value })}
                        className="flex-1 bg-white/10 border border-white/10 rounded px-2 py-1 text-[11px]"
                        placeholder="variant name"
                      />
                      <button
                        onClick={() => runBatch(variant.id)}
                        className="px-2 py-1 rounded bg-emerald-400/20 text-[10px]"
                      >
                        Run
                      </button>
                      <button
                        onClick={() => duplicateVariant(variant.id)}
                        className="px-2 py-1 rounded bg-white/10 text-[10px]"
                      >
                        Duplicate
                      </button>
                      <button
                        onClick={() => deleteVariant(variant.id)}
                        className="px-2 py-1 rounded bg-white/10 text-[10px]"
                      >
                        Delete
                      </button>
                    </div>
                    <textarea
                      value={variant.overridesText}
                      onChange={(e) => updateVariant(variant.id, { overridesText: e.target.value })}
                      rows={4}
                      className="mt-2 w-full bg-black/30 border border-white/10 rounded p-2 font-mono text-[11px]"
                      placeholder='{"THRESHOLD_VOL_SPIKE_X": 1.35}'
                    />
                  </div>
                ))}
                {!variants.length ? (
                  <div className="text-[11px] text-white/50">No variants yet.</div>
                ) : null}
              </div>
            </div>
            <div className="lg:col-span-2 rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Sweep Generator</div>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-5 gap-2 text-xs">
                <div className="md:col-span-2">
                  <div className="text-white/60 mb-1">Key</div>
                  <select
                    value={sweepKey}
                    onChange={(e) => setSweepKey(e.target.value)}
                    className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-[11px]"
                  >
                    {SWEEP_KEYS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-white/60 mb-1">Start</div>
                  <input
                    type="number"
                    value={sweepStart}
                    onChange={(e) => setSweepStart(Number(e.target.value))}
                    className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-[11px]"
                  />
                </div>
                <div>
                  <div className="text-white/60 mb-1">End</div>
                  <input
                    type="number"
                    value={sweepEnd}
                    onChange={(e) => setSweepEnd(Number(e.target.value))}
                    className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-[11px]"
                  />
                </div>
                <div>
                  <div className="text-white/60 mb-1">Steps</div>
                  <input
                    type="number"
                    value={sweepSteps}
                    onChange={(e) => setSweepSteps(Math.max(1, Math.min(60, Number(e.target.value))))}
                    className="w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-[11px]"
                  />
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <label className="text-[11px] text-white/60 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={sweepIncludeBooleans}
                    onChange={(e) => setSweepIncludeBooleans(e.target.checked)}
                  />
                  Also add required-gate flips
                </label>
                <button onClick={generateVariants} className="px-3 py-1 rounded bg-white/10 text-[11px]">
                  Generate Variants
                </button>
              </div>
              {sweepIncludeBooleans ? (
                <div className="mt-2 text-[11px] text-white/50">
                  Boolean flips: {BOOLEAN_GATES.join(', ')}
                </div>
              ) : null}
            </div>
          </div>
        )}

        {error ? (
          <div className="mt-3 text-xs text-rose-200 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1">
            {error}
          </div>
        ) : null}
      </section>

      {mode === 'single' && simResult ? (
        <section className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">Sim Results</div>
            <div className="text-xs text-white/60">
              Run {simResult?.meta?.runId || '--'} | {dt(simResult?.meta?.startedAt)}
            </div>
          </div>

          {simResult?.meta?.notes?.length ? (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100">
              {simResult.meta.notes.join(' ')}
            </div>
          ) : null}

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

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
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
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">ReadyS / BestS</div>
              <div className="text-xl font-semibold">
                {simResult?.counts?.readyShort ?? 0} / {simResult?.counts?.bestShort ?? 0}
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
                <div>ready_short_final_true: {simResult?.funnel?.ready_short_final_true ?? simResult?.counts?.readyShort ?? 0}</div>
                <div>best_short_final_true: {simResult?.funnel?.best_short_final_true ?? simResult?.counts?.bestShort ?? 0}</div>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/60">Diff vs Actual</div>
              <div className="mt-2 text-sm text-white/80 space-y-1">
                <div>watch: {simResult?.diffVsActual?.watch ?? '--'}</div>
                <div>early: {simResult?.diffVsActual?.early ?? '--'}</div>
                <div>ready: {simResult?.diffVsActual?.ready ?? '--'}</div>
                <div>best: {simResult?.diffVsActual?.best ?? '--'}</div>
                <div>readyShort: {simResult?.diffVsActual?.readyShort ?? '--'}</div>
                <div>bestShort: {simResult?.diffVsActual?.bestShort ?? '--'}</div>
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

          {simResult?.postCoreFailed ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
              {(['ready', 'best'] as const).map((stage) => (
                <div key={`${stage}-post`} className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-white/60">Post-Core Failed: {stage}</div>
                  <div className="mt-2 text-sm text-white/80 space-y-1">
                    {sortEntries(simResult?.postCoreFailed?.[stage]).map((r) => (
                      <div key={`${stage}-post-${r.key}`} className="flex items-center justify-between">
                        <span className="text-white/70">{r.key}</span>
                        <span>{r.val}</span>
                      </div>
                    ))}
                    {!sortEntries(simResult?.postCoreFailed?.[stage]).length ? (
                      <div className="text-white/50">None</div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

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

      {mode === 'batch' && batchResult ? (
        <section className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">Batch Results</div>
            <div className="text-xs text-white/60">
              {batchResult?.meta?.runCount && batchResult.meta.runCount > 1
                ? `Runs ${batchResult.meta.runCount}`
                : `Run ${batchResult?.meta?.runId || '--'}`}
              {' | '}
              {batchResult?.meta?.runCount && batchResult.meta.runCount > 1 && batchResult?.meta?.startedAtRange
                ? `${dt(batchResult.meta.startedAtRange.min)} → ${dt(batchResult.meta.startedAtRange.max)}`
                : dt(batchResult?.meta?.startedAt)}
            </div>
          </div>

          {batchResult?.meta?.notes?.length ? (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100">
              {batchResult.meta.notes.join(' ')}
            </div>
          ) : null}

          {batchResult?.meta?.baseOverrides ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/80 space-y-2">
              <div className="text-white/60">Base Overrides</div>
              <div>
                <span className="text-white/60">Applied:</span>{' '}
                {Object.keys(batchResult.meta.baseOverrides.applied || {}).length
                  ? JSON.stringify(batchResult.meta.baseOverrides.applied)
                  : 'None'}
              </div>
              {batchResult.meta.baseOverrides.unknownKeys?.length ? (
                <div className="text-amber-200">
                  Unknown keys: {batchResult.meta.baseOverrides.unknownKeys.join(', ')}
                </div>
              ) : null}
              {batchResult.meta.baseOverrides.typeErrors && Object.keys(batchResult.meta.baseOverrides.typeErrors).length ? (
                <div className="text-amber-200">
                  Type errors: {JSON.stringify(batchResult.meta.baseOverrides.typeErrors)}
                </div>
              ) : null}
              <details className="mt-1">
                <summary className="cursor-pointer text-white/60">Effective config</summary>
                <pre className="mt-2 whitespace-pre-wrap text-[11px] bg-black/30 border border-white/10 rounded p-2">
{JSON.stringify(batchResult.meta.baseOverrides.effectiveConfig ?? {}, null, 2)}
                </pre>
              </details>
            </div>
          ) : null}

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-xs text-white/60">Base Summary</div>
            <div className="mt-3 grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Evaluated</div>
                <div className="text-xl font-semibold">{batchResult?.meta?.evaluated ?? 0}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Watch</div>
                <div className="text-xl font-semibold">{batchResult?.base?.counts?.watch ?? 0}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Early</div>
                <div className="text-xl font-semibold">{batchResult?.base?.counts?.early ?? 0}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Ready / Best</div>
                <div className="text-xl font-semibold">
                  {batchResult?.base?.counts?.ready ?? 0} / {batchResult?.base?.counts?.best ?? 0}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">ReadyS / BestS</div>
                <div className="text-xl font-semibold">
                  {batchResult?.base?.counts?.readyShort ?? 0} / {batchResult?.base?.counts?.bestShort ?? 0}
                </div>
              </div>
            </div>
            {batchResult?.base?.actualCounts ? (
              <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-2 text-xs text-white/80 space-y-1">
                <div>
                  <span className="text-white/60">Actual (scan_runs): </span>
                  Ready / Best {batchResult.base.actualCounts.ready ?? 0} / {batchResult.base.actualCounts.best ?? 0}
                  {' | '}ReadyS / BestS {batchResult.base.actualCounts.readyShort ?? 0} / {batchResult.base.actualCounts.bestShort ?? 0}
                </div>
                <div>
                  <span className="text-white/60">Sim - Actual: </span>
                  Ready / Best {batchResult?.base?.diffVsActual?.ready ?? '--'} / {batchResult?.base?.diffVsActual?.best ?? '--'}
                  {' | '}ReadyS / BestS {batchResult?.base?.diffVsActual?.readyShort ?? '--'} / {batchResult?.base?.diffVsActual?.bestShort ?? '--'}
                </div>
              </div>
            ) : (
              <div className="mt-3 text-xs text-white/50">
                Actual signal counts were not available for the selected runs.
              </div>
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-xs text-white/60 mb-2">Variants Table</div>
            <div className="overflow-auto">
              <table className="w-full text-xs text-white/80">
                <thead className="text-white/60">
                  <tr className="text-left">
                    <th className="py-1 pr-2">Variant</th>
                    <th className="py-1 pr-2">Ready / Best (+Short)</th>
                    <th className="py-1 pr-2">ΔReady / ΔBest (+Short)</th>
                    <th className="py-1 pr-2">Added / Removed (Ready)</th>
                    <th className="py-1 pr-2">Added / Removed (Best)</th>
                    <th className="py-1 pr-2">Top Bottleneck</th>
                  </tr>
                </thead>
                <tbody>
                  {(batchResult?.variants ?? []).map((v: any) => {
                    const readyAdded = v?.diffVsBase?.addedReadySymbols?.length ?? 0;
                    const readyRemoved = v?.diffVsBase?.removedReadySymbols?.length ?? 0;
                    const bestAdded = v?.diffVsBase?.addedBestSymbols?.length ?? 0;
                    const bestRemoved = v?.diffVsBase?.removedBestSymbols?.length ?? 0;
                    const selected = selectedVariantName === v?.name;
                    return (
                      <tr
                        key={`variant-${v?.name}`}
                        onClick={() => setSelectedVariantName(v?.name)}
                        className={`cursor-pointer border-t border-white/5 ${selected ? 'bg-white/5' : 'hover:bg-white/5'}`}
                      >
                        <td className="py-2 pr-2 font-medium">{v?.name}</td>
                        <td className="py-2 pr-2">
                          {v?.counts?.ready ?? 0} / {v?.counts?.best ?? 0}
                          <div className="text-[10px] text-white/60">{v?.counts?.readyShort ?? 0} / {v?.counts?.bestShort ?? 0}</div>
                        </td>
                        <td className="py-2 pr-2">
                          {v?.diffVsBase?.counts?.ready ?? 0} / {v?.diffVsBase?.counts?.best ?? 0}
                          <div className="text-[10px] text-white/60">{v?.diffVsBase?.counts?.readyShort ?? 0} / {v?.diffVsBase?.counts?.bestShort ?? 0}</div>
                        </td>
                        <td className="py-2 pr-2">{readyAdded} / {readyRemoved}</td>
                        <td className="py-2 pr-2">{bestAdded} / {bestRemoved}</td>
                        <td className="py-2 pr-2">
                          <div>ready: {topGateLabel(v?.firstFailed?.ready)}</div>
                          <div>best: {topGateLabel(v?.firstFailed?.best)}</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {selectedVariant ? (
            <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Variant Details: {selectedVariant?.name}</div>
                <div className="text-xs text-white/60">
                  Ready / Best: {selectedVariant?.counts?.ready ?? 0} / {selectedVariant?.counts?.best ?? 0}
                  {' '}| Short: {selectedVariant?.counts?.readyShort ?? 0} / {selectedVariant?.counts?.bestShort ?? 0}
                </div>
              </div>

              {selectedVariant?.notes?.length ? (
                <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100">
                  {selectedVariant.notes.join(' ')}
                </div>
              ) : null}

              {selectedVariant?.overrides ? (
                <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/80 space-y-2">
                  <div className="text-white/60">Overrides</div>
                  <div>
                    <span className="text-white/60">Applied:</span>{' '}
                    {Object.keys(selectedVariant.overrides.applied || {}).length
                      ? JSON.stringify(selectedVariant.overrides.applied)
                      : 'None'}
                  </div>
                  {selectedVariant.overrides.unknownKeys?.length ? (
                    <div className="text-amber-200">
                      Unknown keys: {selectedVariant.overrides.unknownKeys.join(', ')}
                    </div>
                  ) : null}
                  {selectedVariant.overrides.typeErrors && Object.keys(selectedVariant.overrides.typeErrors).length ? (
                    <div className="text-amber-200">
                      Type errors: {JSON.stringify(selectedVariant.overrides.typeErrors)}
                    </div>
                  ) : null}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-white/60">Effective config</summary>
                    <pre className="mt-2 whitespace-pre-wrap text-[11px] bg-black/30 border border-white/10 rounded p-2">
{JSON.stringify(selectedVariant.overrides.effectiveConfig ?? {}, null, 2)}
                    </pre>
                  </details>
                </div>
              ) : null}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-white/60">Funnel</div>
                  <div className="mt-2 text-sm text-white/80 space-y-1">
                    <div>candidate_evaluated: {selectedVariant?.funnel?.candidate_evaluated ?? 0}</div>
                    <div>watch_created: {selectedVariant?.funnel?.watch_created ?? 0}</div>
                    <div>early_created: {selectedVariant?.funnel?.early_created ?? 0}</div>
                    <div>ready_core_true: {selectedVariant?.funnel?.ready_core_true ?? 0}</div>
                    <div>best_core_true: {selectedVariant?.funnel?.best_core_true ?? 0}</div>
                    <div>ready_final_true: {selectedVariant?.funnel?.ready_final_true ?? selectedVariant?.counts?.ready ?? 0}</div>
                    <div>best_final_true: {selectedVariant?.funnel?.best_final_true ?? selectedVariant?.counts?.best ?? 0}</div>
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-white/60">Diff vs Base</div>
                  <div className="mt-2 text-sm text-white/80 space-y-1">
                    <div>watch: {selectedVariant?.diffVsBase?.counts?.watch ?? '--'}</div>
                    <div>early: {selectedVariant?.diffVsBase?.counts?.early ?? '--'}</div>
                    <div>ready: {selectedVariant?.diffVsBase?.counts?.ready ?? '--'}</div>
                    <div>best: {selectedVariant?.diffVsBase?.counts?.best ?? '--'}</div>
                    <div>readyShort: {selectedVariant?.diffVsBase?.counts?.readyShort ?? '--'}</div>
                    <div>bestShort: {selectedVariant?.diffVsBase?.counts?.bestShort ?? '--'}</div>
                  </div>
                </div>
              </div>

              {selectedVariant?.diffVsActual ? (
                <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
                  <div className="text-xs text-white/60">Diff vs Actual</div>
                  <div className="mt-2 text-sm text-white/80 space-y-1">
                    <div>watch: {selectedVariant?.diffVsActual?.watch ?? '--'}</div>
                    <div>early: {selectedVariant?.diffVsActual?.early ?? '--'}</div>
                    <div>ready: {selectedVariant?.diffVsActual?.ready ?? '--'}</div>
                    <div>best: {selectedVariant?.diffVsActual?.best ?? '--'}</div>
                    <div>readyShort: {selectedVariant?.diffVsActual?.readyShort ?? '--'}</div>
                    <div>bestShort: {selectedVariant?.diffVsActual?.bestShort ?? '--'}</div>
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
                {(['ready', 'best'] as const).map((stage) => (
                  <div key={`vf-${stage}`} className="rounded-xl border border-white/10 bg-white/5 p-3">
                    <div className="text-xs text-white/60">First Failed: {stage}</div>
                    <div className="mt-2 text-sm text-white/80 space-y-1">
                      {sortEntries(selectedVariant?.firstFailed?.[stage]).slice(0, 8).map((r) => (
                        <div key={`vf-${stage}-${r.key}`} className="flex items-center justify-between">
                          <span className="text-white/70">{r.key}</span>
                          <span>{r.val}</span>
                        </div>
                      ))}
                      {!sortEntries(selectedVariant?.firstFailed?.[stage]).length ? (
                        <div className="text-white/50">No failures</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
                {(['ready', 'best'] as const).map((stage) => (
                  <div key={`vg-${stage}`} className="rounded-xl border border-white/10 bg-white/5 p-3">
                    <div className="text-xs text-white/60">Gate True: {stage}</div>
                    <div className="mt-2 text-sm text-white/80 space-y-1">
                      {sortEntries(selectedVariant?.gateTrue?.[stage]).slice(0, 8).map((r) => (
                        <div key={`vg-${stage}-${r.key}`} className="flex items-center justify-between">
                          <span className="text-white/70">{r.key}</span>
                          <span>{r.val}</span>
                        </div>
                      ))}
                      {!sortEntries(selectedVariant?.gateTrue?.[stage]).length ? (
                        <div className="text-white/50">No data</div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-white/60">Added / Removed Ready</div>
                  <div className="mt-2 text-[11px] text-white/80 space-y-2">
                    <div>
                      <div className="text-white/60">Added</div>
                      <div>{(selectedVariant?.diffVsBase?.addedReadySymbols ?? []).join(', ') || '--'}</div>
                    </div>
                    <div>
                      <div className="text-white/60">Removed</div>
                      <div>{(selectedVariant?.diffVsBase?.removedReadySymbols ?? []).join(', ') || '--'}</div>
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-white/60">Added / Removed Best</div>
                  <div className="mt-2 text-[11px] text-white/80 space-y-2">
                    <div>
                      <div className="text-white/60">Added</div>
                      <div>{(selectedVariant?.diffVsBase?.addedBestSymbols ?? []).join(', ') || '--'}</div>
                    </div>
                    <div>
                      <div className="text-white/60">Removed</div>
                      <div>{(selectedVariant?.diffVsBase?.removedBestSymbols ?? []).join(', ') || '--'}</div>
                    </div>
                  </div>
                </div>
              </div>

              {selectedVariant?.examples ? (
                <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xs text-white/60">Examples</div>
                  <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-3 text-sm text-white/80">
                    {Object.entries(selectedVariant.examples).map(([stage, gates]: any) => (
                      <div key={`ex-b-${stage}`} className="rounded-lg border border-white/10 bg-white/5 p-2">
                        <div className="text-white/70">{stage}</div>
                        <div className="mt-2 space-y-1">
                          {Object.entries(gates as Record<string, string[]>).slice(0, 6).map(([k, v]) => (
                            <div key={`ex-b-${stage}-${k}`} className="flex items-center justify-between text-[11px]">
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
            </div>
          ) : null}
        </section>
      ) : null}

      {mode === 'single' && histResult ? (
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

      <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-lg font-semibold">Tuning Bundles</div>
            <div className="text-xs text-white/60">Periodic snapshots for fast review.</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-white/60">Hours</span>
              <input
                type="number"
                value={bundleHours}
                onChange={(e) => setBundleHours(Math.max(1, Math.min(168, Number(e.target.value))))}
                className="w-20 bg-white/10 border border-white/10 rounded px-2 py-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-white/60">Limit</span>
              <input
                type="number"
                value={bundleLimit}
                onChange={(e) => setBundleLimit(Math.max(1, Math.min(200, Number(e.target.value))))}
                className="w-20 bg-white/10 border border-white/10 rounded px-2 py-1"
              />
            </div>
            <button onClick={loadBundleLatest} className="px-2 py-1 rounded bg-white/10 hover:bg-white/15">
              {bundleLoading ? 'Loading...' : 'Load latest'}
            </button>
            <button onClick={loadBundleRecent} className="px-2 py-1 rounded bg-white/10 hover:bg-white/15">
              Load recent
            </button>
            <button onClick={copyBundleMarkdown} className="px-2 py-1 rounded bg-emerald-400/20 hover:bg-emerald-400/30">
              Copy report
            </button>
          </div>
        </div>

        {bundleError ? (
          <div className="mt-3 text-xs text-amber-200">{bundleError}</div>
        ) : null}

        <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-3 text-xs">
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-white/60">Latest bundle</div>
            <div className="mt-2 text-white/80">ID: {bundleLatest?.id ?? '--'}</div>
            <div className="text-white/60">Created: {dt(bundleLatest?.createdAt)}</div>
            <div className="text-white/60">Window: {bundleLatest?.windowHours ?? '--'}h</div>
            <div className="text-white/60">Git: {bundleLatest?.buildGitSha ?? '--'}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-3 lg:col-span-2">
            <div className="text-white/60 mb-2">Recent bundles</div>
            <div className="max-h-56 overflow-auto">
              {(bundleRecent ?? []).map((b) => (
                <button
                  key={`bundle-${b.id}`}
                  onClick={() => loadBundleById(b.id)}
                  className={`w-full flex items-center justify-between px-2 py-1 rounded border border-white/10 text-left ${
                    bundleSelected?.id === b.id ? 'bg-white/10' : 'hover:bg-white/5'
                  }`}
                >
                  <span>#{b.id} · {dt(b.createdAt)}</span>
                  <span className="text-white/50">{b.windowHours}h</span>
                </button>
              ))}
              {!bundleRecent?.length ? <div className="text-white/50">No bundles loaded.</div> : null}
            </div>
          </div>
        </div>

        {bundleSelected ? (
          <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-white/60">Summary</div>
              <div className="mt-2 text-white/80 space-y-1">
                <div>Created: {dt(bundleSelected.createdAt)}</div>
                <div>Window: {bundleSelected.windowHours}h</div>
                <div>Run: {bundleSelected.scanRunId ?? '--'}</div>
                <div>Git: {bundleSelected.buildGitSha ?? '--'}</div>
              </div>
              <div className="mt-3 text-white/70">Top drivers</div>
              <div className="mt-1 space-y-1">
                {(bundleSelected.payload?.failureDrivers ?? []).slice(0, 5).map((d: any, i: number) => (
                  <div key={`driver-${i}`} className="flex items-center justify-between">
                    <span>{d.key}</span>
                    <span>{d.n}</span>
                  </div>
                ))}
                {!(bundleSelected.payload?.failureDrivers ?? []).length ? (
                  <div className="text-white/50">No failure drivers.</div>
                ) : null}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-white/60 flex items-center justify-between">
                Report (Markdown)
                <button
                  onClick={() => setShowBundleJson((v) => !v)}
                  className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/15"
                >
                  {showBundleJson ? 'Show report' : 'Show JSON'}
                </button>
              </div>
              <pre className="mt-2 whitespace-pre-wrap text-[11px] bg-black/30 border border-white/10 rounded p-2 max-h-80 overflow-auto">
{showBundleJson
  ? JSON.stringify(bundleSelected.payload ?? {}, null, 2)
  : (bundleSelected.reportMd ?? '')}
              </pre>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
