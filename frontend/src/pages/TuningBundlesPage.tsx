import { useEffect, useMemo, useState } from 'react';

const rawApiBase = (import.meta.env.VITE_API_BASE ?? '').trim();
const fallbackApiBase = import.meta.env.PROD
  ? 'https://pro-scalp-backend-production.up.railway.app'
  : '';
const apiBase = (rawApiBase || fallbackApiBase).replace(/\/+$/, '');
const API = (path: string) => apiBase + path;

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (v == null) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function dt(ms: number | string | null | undefined) {
  const v = num(ms);
  if (!Number.isFinite(v) || v <= 0) return '--';
  try { return new Date(v).toLocaleString(); } catch { return String(ms); }
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TuningBundlesPage() {
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

  const stats = useMemo(() => {
    const totals = bundleSelected?.payload?.outcomes?.report?.totals ?? {};
    const winN = Number(totals.winN ?? 0);
    const lossN = Number(totals.lossN ?? 0);
    const noneN = Number(totals.noneN ?? 0);
    const total = Number(totals.total ?? (winN + lossN + noneN));
    return { winN, lossN, noneN, total };
  }, [bundleSelected]);

  return (
    <div className="mt-4 space-y-6">
      <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-lg font-semibold">Tuning Bundles</div>
        <div className="text-xs text-white/60">Snapshots for monitoring + tuning every few hours.</div>

        <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
          <div className="text-white/70">Admin token</div>
          <input
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            className="mt-2 w-full bg-white/10 border border-white/10 rounded px-2 py-1 text-sm"
            placeholder="x-admin-token (optional)"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
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
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Total</div>
                <div className="text-xl font-semibold">{stats.total}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Win</div>
                <div className="text-xl font-semibold">{stats.winN}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Stop</div>
                <div className="text-xl font-semibold">{stats.lossN}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/60">Timeout</div>
                <div className="text-xl font-semibold">{stats.noneN}</div>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
              <div className="text-white/60">Top failure drivers</div>
              <div className="mt-2 space-y-1">
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

            <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-xs">
              <div className="flex items-center justify-between">
                <div className="text-white/60">Report</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowBundleJson((v) => !v)}
                    className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/15"
                  >
                    {showBundleJson ? 'Show report' : 'Show JSON'}
                  </button>
                  <button
                    onClick={() => downloadText(
                      `tuning_bundle_${bundleSelected.id}.md`,
                      bundleSelected.reportMd ?? '',
                      'text/markdown'
                    )}
                    className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/15"
                  >
                    Download MD
                  </button>
                  <button
                    onClick={() => downloadText(
                      `tuning_bundle_${bundleSelected.id}.json`,
                      JSON.stringify(bundleSelected.payload ?? {}, null, 2),
                      'application/json'
                    )}
                    className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/15"
                  >
                    Download JSON
                  </button>
                </div>
              </div>
              <pre className="mt-2 whitespace-pre-wrap text-[11px] bg-black/30 border border-white/10 rounded p-2 max-h-96 overflow-auto">
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

