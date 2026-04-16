import { useEffect, useState, useCallback } from 'react';
import { apiUrl as API } from '../config/apiBase';

// ============================================================================
// TYPES
// ============================================================================

interface ExtendedOutcome {
  id: number;
  signalId: number;
  symbol: string;
  category: string;
  direction: 'LONG' | 'SHORT';
  signalTime: number;
  startedAt: number;
  expiresAt: number;
  completedAt: number | null;
  entryPrice: number;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  status: string;
  firstTp1At: number | null;
  tp2At: number | null;
  stopAt: number | null;
  timeToFirstHitSeconds: number | null;
  timeToTp1Seconds: number | null;
  timeToTp2Seconds: number | null;
  timeToStopSeconds: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  coveragePct: number;
  ext24ManagedStatus?: string | null;
  ext24ManagedR?: number | null;
  ext24ManagedPnlUsd?: number | null;
  ext24RealizedR?: number | null;
  ext24UnrealizedRunnerR?: number | null;
  ext24LiveManagedR?: number | null;
  ext24RunnerExitReason?: string | null;
  confluenceScore?: number | null;
  // Live data (merged from live-pending API)
  currentPrice?: number | null;
  currentMovePct?: number | null;
  liveMfe?: number | null;
  liveMae?: number | null;
}

interface ManagedStats {
  totalClosed: number;
  wins: number;
  losses: number;
  beSaves: number;
  tp1OnlyExits: number;
  tp2Hits: number;
  timeoutExits: number;
  totalManagedR: number;
  avgManagedR: number;
  maxWinR: number;
  maxLossR: number;
  totalManagedPnlUsd: number;
  avgManagedPnlUsd: number;
  managedWinRate: number;
  tp1TouchRate: number;
  tp2ConversionRate: number;
  riskPerTradeUsd: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '--';
  return n.toFixed(digits);
}

function fmtR(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '--';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}R`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '--';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toFixed(2)}`;
}

function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const QA_TZ = 'Asia/Qatar'; // UTC+3

function fmtQatarTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '--';
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: QA_TZ,
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
    hour12: true,
  });
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeRemaining(expiresAt: number): string {
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'expired';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m left`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'WIN_TP2': return 'text-emerald-400';
    case 'WIN_TP1': return 'text-emerald-300';
    case 'ACHIEVED_TP1': return 'text-cyan-300';
    case 'LOSS_STOP': return 'text-rose-400';
    case 'FLAT_TIMEOUT_24H': return 'text-gray-400';
    case 'PENDING': return 'text-amber-300';
    default: return 'text-gray-300';
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case 'WIN_TP2': return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    case 'WIN_TP1': return 'bg-emerald-400/20 text-emerald-200 border border-emerald-400/30';
    case 'ACHIEVED_TP1': return 'bg-cyan-400/20 text-cyan-200 border border-cyan-400/30';
    case 'LOSS_STOP': return 'bg-rose-500/20 text-rose-300 border border-rose-500/30';
    case 'FLAT_TIMEOUT_24H': return 'bg-gray-500/20 text-gray-300 border border-gray-500/30';
    case 'PENDING': return 'bg-amber-500/20 text-amber-200 border border-amber-500/30';
    default: return 'bg-gray-600/20 text-gray-300 border border-gray-600/30';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'WIN_TP2': return 'WIN TP2';
    case 'WIN_TP1': return 'WIN TP1';
    case 'ACHIEVED_TP1': return 'TP1 HIT';
    case 'LOSS_STOP': return 'STOP';
    case 'FLAT_TIMEOUT_24H': return 'TIMEOUT';
    case 'PENDING': return 'LIVE';
    default: return status;
  }
}

function rColor(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return 'text-gray-400';
  if (r > 0.5) return 'text-emerald-400';
  if (r > 0) return 'text-emerald-300';
  if (r === 0) return 'text-gray-400';
  if (r > -0.5) return 'text-rose-300';
  return 'text-rose-400';
}

function exitLabel(reason: string | null | undefined): string {
  if (!reason) return '--';
  switch (reason) {
    case 'TP2': return 'TP2';
    case 'BREAK_EVEN': return 'BE';
    case 'TIMEOUT_MARKET': return 'TIMEOUT';
    case 'STOP_BEFORE_TP1': return 'STOP';
    default: return reason;
  }
}

function exitBadge(reason: string | null | undefined): string {
  switch (reason) {
    case 'TP2': return 'bg-emerald-500/20 text-emerald-300';
    case 'BREAK_EVEN': return 'bg-blue-500/20 text-blue-300';
    case 'TIMEOUT_MARKET': return 'bg-gray-500/20 text-gray-300';
    case 'STOP_BEFORE_TP1': return 'bg-rose-500/20 text-rose-300';
    default: return 'bg-gray-600/20 text-gray-400';
  }
}

function dirBadge(dir: string): string {
  return dir === 'LONG'
    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25'
    : 'bg-rose-500/15 text-rose-300 border border-rose-500/25';
}

// ============================================================================
// COMPONENTS
// ============================================================================

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-800/60 rounded-lg p-4 border border-gray-700/50">
      <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color || 'text-white'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function LiveTradeCard({ o }: { o: ExtendedOutcome }) {
  const isLong = o.direction === 'LONG';
  const entry = o.entryPrice;
  const stop = o.stopPrice;
  const tp1 = o.tp1Price;
  const tp2 = o.tp2Price;
  const risk = stop && entry ? Math.abs(entry - stop) : 0;
  const riskPct = entry ? (risk / entry) * 100 : 0;
  const currentPrice = o.currentPrice;
  const pnlPct = currentPrice && entry
    ? isLong ? ((currentPrice - entry) / entry) * 100 : ((entry - currentPrice) / entry) * 100
    : null;

  return (
    <div className="bg-gray-800/80 rounded-lg p-4 border border-gray-700/50 hover:border-gray-600/70 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-white">{o.symbol}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${dirBadge(o.direction)}`}>{o.direction}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(o.status)}`}>{statusLabel(o.status)}</span>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500">{fmtQatarTime(o.signalTime)}</div>
          <div className="text-xs text-gray-600">{timeAgo(o.signalTime)}</div>
        </div>
      </div>

      {/* Current price bar */}
      {currentPrice != null && (
        <div className="flex items-center justify-between bg-gray-900/60 rounded px-3 py-2 mb-3">
          <span className="text-xs text-gray-400">Now</span>
          <span className="text-lg font-bold font-mono text-white">{fmt(currentPrice, 6)}</span>
          <span className={`text-sm font-bold ${pnlPct != null && pnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : '--'}
          </span>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3 text-sm mb-3">
        <div>
          <div className="text-xs text-gray-500">Entry</div>
          <div className="text-white font-mono">{fmt(entry, 6)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Stop</div>
          <div className="text-rose-400 font-mono">{fmt(stop, 6)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">TP1</div>
          <div className="text-emerald-400 font-mono">{fmt(tp1, 6)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">TP2</div>
          <div className="text-emerald-300 font-mono">{fmt(tp2, 6)}</div>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <div className="flex gap-4">
          <span className="text-gray-500">Risk: <span className="text-rose-300">{fmt(riskPct, 2)}%</span></span>
          <span className="text-gray-500">MFE: <span className="text-emerald-300">{fmt(o.liveMfe ?? o.maxFavorableExcursionPct, 2)}%</span></span>
          <span className="text-gray-500">MAE: <span className="text-rose-300">{fmt(o.liveMae ?? o.maxAdverseExcursionPct, 2)}%</span></span>
        </div>
        <span className="text-gray-500">{timeRemaining(o.expiresAt)}</span>
      </div>

      <div className="mt-2 pt-2 border-t border-gray-700/50 flex items-center gap-3 text-xs">
        <span className="text-gray-500">Live R:</span>
        <span className={`font-bold ${rColor(o.ext24LiveManagedR)}`}>{fmtR(o.ext24LiveManagedR)}</span>
        {o.confluenceScore != null && (
          <>
            <span className="text-gray-600">|</span>
            <span className="text-gray-500">Score: <span className="text-white">{o.confluenceScore}</span></span>
          </>
        )}
      </div>
    </div>
  );
}

function CompletedTradeRow({ o }: { o: ExtendedOutcome }) {
  return (
    <tr className="border-b border-gray-800/50 hover:bg-gray-800/30">
      <td className="py-2 px-3 text-xs text-gray-500">{fmtQatarTime(o.signalTime)}</td>
      <td className="py-2 px-3 font-bold text-white">{o.symbol}</td>
      <td className="py-2 px-3"><span className={`text-xs px-2 py-0.5 rounded-full ${dirBadge(o.direction)}`}>{o.direction}</span></td>
      <td className="py-2 px-3"><span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(o.status)}`}>{statusLabel(o.status)}</span></td>
      <td className={`py-2 px-3 font-bold font-mono ${rColor(o.ext24ManagedR)}`}>{fmtR(o.ext24ManagedR)}</td>
      <td className={`py-2 px-3 font-mono ${rColor(o.ext24ManagedPnlUsd)}`}>{fmtUsd(o.ext24ManagedPnlUsd)}</td>
      <td className="py-2 px-3"><span className={`text-xs px-1.5 py-0.5 rounded ${exitBadge(o.ext24RunnerExitReason)}`}>{exitLabel(o.ext24RunnerExitReason)}</span></td>
      <td className="py-2 px-3 text-xs text-gray-400 font-mono">{fmt(o.entryPrice, 6)}</td>
      <td className="py-2 px-3 text-xs">
        <span className="text-emerald-400">{fmt(o.maxFavorableExcursionPct, 2)}%</span>
        <span className="text-gray-600 mx-1">/</span>
        <span className="text-rose-400">{fmt(o.maxAdverseExcursionPct, 2)}%</span>
      </td>
      <td className="py-2 px-3 text-xs text-gray-400">{fmtDuration(o.timeToFirstHitSeconds)}</td>
    </tr>
  );
}

function CumulativeRBar({ trades }: { trades: ExtendedOutcome[] }) {
  // Build cumulative R from oldest to newest
  const sorted = [...trades]
    .filter(t => t.ext24ManagedR != null && Number.isFinite(t.ext24ManagedR))
    .sort((a, b) => a.signalTime - b.signalTime);

  if (sorted.length === 0) return null;

  let cumR = 0;
  const points = sorted.map(t => {
    cumR += t.ext24ManagedR!;
    return { time: t.signalTime, cumR, symbol: t.symbol, r: t.ext24ManagedR! };
  });

  const maxR = Math.max(...points.map(p => p.cumR), 0);
  const minR = Math.min(...points.map(p => p.cumR), 0);
  const range = Math.max(maxR - minR, 1);

  const W = 600;
  const H = 120;
  const PAD = 20;

  const toX = (i: number) => PAD + (i / Math.max(points.length - 1, 1)) * (W - PAD * 2);
  const toY = (r: number) => PAD + ((maxR - r) / range) * (H - PAD * 2);

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p.cumR).toFixed(1)}`).join(' ');
  const zeroY = toY(0);

  return (
    <div className="bg-gray-800/60 rounded-lg p-4 border border-gray-700/50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400 uppercase tracking-wider">Cumulative R</span>
        <span className={`text-sm font-bold ${cumR >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtR(cumR)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 120 }}>
        {/* Zero line */}
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="#374151" strokeWidth="1" strokeDasharray="4,4" />
        {/* R curve */}
        <path d={pathD} fill="none" stroke={cumR >= 0 ? '#34d399' : '#fb7185'} strokeWidth="2" />
        {/* Dots for each trade */}
        {points.map((p, i) => (
          <circle key={i} cx={toX(i)} cy={toY(p.cumR)} r="3"
            fill={p.r >= 0 ? '#34d399' : '#fb7185'} opacity={0.7} />
        ))}
        {/* Labels */}
        <text x={PAD} y={12} fontSize="10" fill="#6b7280">{fmt(maxR, 1)}R</text>
        <text x={PAD} y={H - 4} fontSize="10" fill="#6b7280">{fmt(minR, 1)}R</text>
      </svg>
      <div className="text-xs text-gray-500 mt-1">{points.length} completed trades</div>
    </div>
  );
}

// ============================================================================
// MAIN PAGE
// ============================================================================

export default function DashboardPage() {
  const [active, setActive] = useState<ExtendedOutcome[]>([]);
  const [completed, setCompleted] = useState<ExtendedOutcome[]>([]);
  const [stats, setStats] = useState<ManagedStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [days, setDays] = useState(30);

  const fetchData = useCallback(async () => {
    try {
      const start = Date.now() - days * 24 * 60 * 60 * 1000;

      const [outcomeRes, statsRes, liveRes] = await Promise.all([
        fetch(API(`/api/extended-outcomes?sort=time_desc&limit=200&start=${start}&mode=EXECUTED`)),
        fetch(API(`/api/extended-outcomes/managed-stats?start=${start}&mode=EXECUTED`)),
        fetch(API('/api/extended-outcomes/live-pending')),
      ]);

      const outcomeData = await outcomeRes.json();
      const statsData = await statsRes.json();
      const liveData = await liveRes.json();

      // Build live price map from live-pending API
      const liveMap = new Map<number, { currentPrice: number; currentMovePct: number; liveMfe: number; liveMae: number; liveManagedR: number | null }>();
      if (liveData.ok && liveData.signals) {
        for (const s of liveData.signals) {
          liveMap.set(s.signalId, {
            currentPrice: s.currentPrice,
            currentMovePct: s.currentMovePct,
            liveMfe: s.liveMfe,
            liveMae: s.liveMae,
            liveManagedR: s.liveManagedR,
          });
        }
      }

      if (outcomeData.ok && outcomeData.rows) {
        const rows = outcomeData.rows as ExtendedOutcome[];
        // Merge live data into active trades
        const activeRows = rows
          .filter(r => r.status === 'PENDING' || r.status === 'ACHIEVED_TP1')
          .map(r => {
            const live = liveMap.get(r.signalId);
            if (live) {
              return { ...r, currentPrice: live.currentPrice, currentMovePct: live.currentMovePct, liveMfe: live.liveMfe, liveMae: live.liveMae, ext24LiveManagedR: live.liveManagedR };
            }
            return r;
          });
        setActive(activeRows);
        setCompleted(rows.filter(r => r.completedAt != null).sort((a, b) => b.signalTime - a.signalTime));
      }

      if (statsData.ok) {
        setStats(statsData as ManagedStats);
      }

      setError(null);
    } catch (e: any) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
      setLastRefresh(Date.now());
    }
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh every 60s
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchData, 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchData]);

  const winRate = stats && stats.totalClosed > 0
    ? (stats.managedWinRate * 100).toFixed(1)
    : '--';

  const totalR = stats?.totalManagedR ?? 0;
  const totalUsd = stats?.totalManagedPnlUsd ?? 0;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 p-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-white">Trade Dashboard</h1>
        <div className="flex items-center gap-3">
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="bg-gray-800 text-sm text-gray-300 rounded px-2 py-1 border border-gray-700">
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)}
              className="rounded bg-gray-800 border-gray-600" />
            Auto-refresh
          </label>
          <button onClick={fetchData}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1 rounded border border-gray-700">
            Refresh
          </button>
          <span className="text-xs text-gray-600">{new Date(lastRefresh).toLocaleTimeString()}</span>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 px-4 py-2 rounded mb-4 text-sm">{error}</div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        <StatCard label="Total R" value={fmtR(totalR)} color={totalR >= 0 ? 'text-emerald-400' : 'text-rose-400'} sub={fmtUsd(totalUsd)} />
        <StatCard label="Win Rate" value={winRate !== '--' ? `${winRate}%` : '--'} color={Number(winRate) >= 50 ? 'text-emerald-400' : Number(winRate) > 0 ? 'text-amber-400' : 'text-gray-400'} sub={stats ? `${stats.wins}W / ${stats.losses}L / ${stats.beSaves}BE` : undefined} />
        <StatCard label="Avg R" value={fmtR(stats?.avgManagedR)} color={rColor(stats?.avgManagedR)} sub={stats ? `$${stats.riskPerTradeUsd}/trade` : undefined} />
        <StatCard label="Trades" value={String(stats?.totalClosed ?? 0)} sub={`${active.length} active`} />
        <StatCard label="Best" value={fmtR(stats?.maxWinR)} color="text-emerald-400" sub={stats ? `TP2: ${stats.tp2Hits}` : undefined} />
        <StatCard label="Worst" value={fmtR(stats?.maxLossR)} color="text-rose-400" sub={stats ? `TP1 touch: ${(stats.tp1TouchRate * 100).toFixed(0)}%` : undefined} />
      </div>

      {/* Cumulative R Chart */}
      {completed.length > 0 && <CumulativeRBar trades={completed} />}

      {/* Active Trades */}
      {active.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
            Active Trades ({active.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {active.map(o => <LiveTradeCard key={o.id} o={o} />)}
          </div>
        </div>
      )}

      {/* Completed Trades Table */}
      <div className="mt-6">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
          Completed ({completed.length})
        </h2>
        {loading ? (
          <div className="text-gray-500 text-sm py-8 text-center">Loading...</div>
        ) : completed.length === 0 ? (
          <div className="text-gray-500 text-sm py-8 text-center">No completed trades in the last {days} days</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 uppercase border-b border-gray-800">
                  <th className="py-2 px-3 text-left">Time</th>
                  <th className="py-2 px-3 text-left">Symbol</th>
                  <th className="py-2 px-3 text-left">Dir</th>
                  <th className="py-2 px-3 text-left">Status</th>
                  <th className="py-2 px-3 text-left">Managed R</th>
                  <th className="py-2 px-3 text-left">PnL</th>
                  <th className="py-2 px-3 text-left">Exit</th>
                  <th className="py-2 px-3 text-left">Entry</th>
                  <th className="py-2 px-3 text-left">MFE / MAE</th>
                  <th className="py-2 px-3 text-left">Time to Hit</th>
                </tr>
              </thead>
              <tbody>
                {completed.map(o => <CompletedTradeRow key={o.id} o={o} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
