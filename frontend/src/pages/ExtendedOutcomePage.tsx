import { useEffect, useMemo, useState } from 'react';
import { apiUrl as API } from '../config/apiBase';

// New analysis components
import {
  BucketAnalysisSection,
  SymbolTierSection,
  FilterSimulatorSection,
} from '../components/OutcomeAnalysis';
import {
  FilterConfigSection,
  SymbolTierManagement,
  FilterTester,
  SignalGateStats,
  SignalQualityBadge,
} from '../components/DecisionEngine';
import {
  GateBacktestComparison,
  GateQuickSettings,
  DeleteEarlyReadyShort,
} from '../components/GateBacktest';

const CATEGORIES = [
  'BEST_ENTRY',
  'READY_TO_BUY',
  'EARLY_READY',
  'WATCH',
  'BEST_SHORT_ENTRY',
  'READY_TO_SELL',
  'EARLY_READY_SHORT',
] as const;

const STATUSES = [
  'PENDING',
  'ACHIEVED_TP1',
  'LOSS_STOP',
  'WIN_TP1',
  'WIN_TP2',
  'FLAT_TIMEOUT_24H',
] as const;

const DIRECTIONS = ['LONG', 'SHORT'] as const;

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-amber-400/15 text-amber-200 border-amber-400/30',
  ACHIEVED_TP1: 'bg-cyan-400/15 text-cyan-200 border-cyan-400/30',
  LOSS_STOP: 'bg-rose-400/15 text-rose-200 border-rose-400/30',
  WIN_TP1: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/30',
  WIN_TP2: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
  FLAT_TIMEOUT_24H: 'bg-gray-400/15 text-gray-200 border-gray-400/30',
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'PENDING (24h)',
  ACHIEVED_TP1: 'ACHIEVED TP1 (waiting)',
  LOSS_STOP: 'LOSS STOP (24h)',
  WIN_TP1: 'WIN TP1 (24h)',
  WIN_TP2: 'WIN TP2 (24h)',
  FLAT_TIMEOUT_24H: 'FLAT TIMEOUT (24h)',
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

function fmtDuration(seconds: number | null | undefined) {
  const v = num(seconds);
  if (!Number.isFinite(v) || v <= 0) return '--';
  const hours = Math.floor(v / 3600);
  const mins = Math.floor((v % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function dt(ms: number | string | null | undefined) {
  const v = num(ms);
  if (!Number.isFinite(v) || v <= 0) return '--';
  try { return new Date(v).toLocaleString(); } catch { return String(ms); }
}

function toDateInputValue(d: Date) {
  return d.toLocaleDateString('en-CA');
}

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
  nCandlesEvaluated: number;
  nCandlesExpected: number;
  // Managed PnL fields
  ext24ManagedStatus?: string | null;
  ext24ManagedR?: number | null;
  ext24ManagedPnlUsd?: number | null;
  ext24RealizedR?: number | null;
  ext24UnrealizedRunnerR?: number | null;
  ext24LiveManagedR?: number | null;
  ext24Tp1PartialAt?: number | null;
  ext24RunnerExitReason?: string | null;
}

interface StatsData {
  totalSignals: number;
  completed: number;
  pending: number;
  winTp2: number;
  winTp1: number;
  lossStop: number;
  flatTimeout: number;
  achievedTp1: number;
  winRate: number;
  avgTimeToTp1Seconds: number | null;
  avgTimeToTp2Seconds: number | null;
  avgTimeToStopSeconds: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
}

interface ManagedPnlStats {
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

// Self-verifying stats with counts + denominators (Step 2)
interface RateWithDenom {
  pct: number;
  num: number;
  den: number;
  label: string;
}

// Outcome breakdown item for Step 4
interface BreakdownItem {
  key: string;
  label: string;
  count: number;
  den: number;
  pctOfTotal: number;
  category: 'win' | 'loss' | 'neutral' | 'pending';
}

interface VerifiableStats {
  ok: boolean;
  totals: {
    totalSignals: number;
    completedSignals: number;
    activeSignals: number;
  };
  signalCounts: {
    winTp1: number;
    winTp2: number;
    lossStop: number;
    flatTimeout: number;
    noTrade: number;
    achievedTp1: number;
  };
  signalRates: {
    winRate: RateWithDenom;
    tp1TouchRate: RateWithDenom;
    tp2Conversion: RateWithDenom;
  };
  managedCounts: {
    closed: number;
    wins: number;
    losses: number;
    breakeven: number;
    beSaves: number;
    timeoutExits: number;
    tp2Hits: number;
  };
  managedRates: {
    winRate: RateWithDenom;
    beRate: RateWithDenom;
  };
  performance: {
    totalManagedR: number;
    avgManagedR: number;  // Average of all closed (includes BE at 0)
    avgManagedRPnL: number;  // Average of trades with P&L only (excludes BE)
    managedTradesWithPnL: number;
    managedClosed: number;
    avgTimeToTp1Seconds: number | null;
    avgMfePct: number | null;
    avgMaePct: number | null;
  };
  // Outcome breakdown (Step 4)
  breakdown?: {
    bySignal: BreakdownItem[];
    completedDen: number;
    totalDen: number;
    winRateDefinition: string;
  };
  // Verification checksums (Step 4)
  verification: {
    completedCheck: number;
    sumOfOutcomes: number;
    completedMatches: boolean;
    totalCheck: number;
    sumCompletedAndActive: number;
    totalMatches: boolean;
    sumAllBuckets?: number;
    allBucketsMatch?: boolean;
    allMatch: boolean;
  };
}

export default function ExtendedOutcomePage() {
  // Filters
  const [datePreset, setDatePreset] = useState<'today' | '24h' | '7d' | '30d' | 'custom'>('7d');
  const [customStart, setCustomStart] = useState(toDateInputValue(new Date()));
  const [customEnd, setCustomEnd] = useState(toDateInputValue(new Date()));
  const [symbol, setSymbol] = useState('');
  const [category, setCategory] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [direction, setDirection] = useState<string>('');
  const [completed, setCompleted] = useState<string>('');

  // Data
  const [outcomes, setOutcomes] = useState<Array<ExtendedOutcome & { horizon240mResult?: string | null; improved?: boolean }>>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [managedStats, setManagedStats] = useState<ManagedPnlStats | null>(null);
  const [verifiableStats, setVerifiableStats] = useState<VerifiableStats | null>(null);
  const [improvementStats, setImprovementStats] = useState<{ noHitAt240m: number; laterHitTp1: number; laterHitTp2: number; laterHitStop: number; improvedWinRate: number } | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(100);
  const [sort, setSort] = useState<'time_desc' | 'time_asc' | 'completed_desc'>('time_desc');
  const [actionMsg, setActionMsg] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [showImprovementsOnly, setShowImprovementsOnly] = useState(false);
  const [showComparison, setShowComparison] = useState(true);
  const [showManagedStats, setShowManagedStats] = useState(true);
  
  // Live pending data for real-time updates
  const [livePendingData, setLivePendingData] = useState<Map<number, {
    currentPrice: number;
    currentMovePct: number;
    liveMfe: number;
    liveMae: number;
    liveManagedR?: number | null;
    isConfirmed: boolean;
    lastUpdated: string;
  }>>(new Map());

  // Date range
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
    if (datePreset === '30d') {
      return { start: now.getTime() - 30 * 24 * 60 * 60_000, end: now.getTime() };
    }
    const start = new Date(`${customStart}T00:00:00`);
    const end = new Date(`${customEnd}T23:59:59`);
    return { start: start.getTime(), end: end.getTime() };
  }, [datePreset, customStart, customEnd]);

  function buildParams(includePagination = false, options?: { improvementsOnly?: boolean }) {
    const qs = new URLSearchParams();
    qs.set('start', String(range.start));
    qs.set('end', String(range.end));
    if (symbol.trim()) qs.set('symbol', symbol.trim().toUpperCase());
    if (category) qs.set('category', category);
    if (status) qs.set('status', status);
    if (direction) qs.set('direction', direction);
    if (completed) qs.set('completed', completed);
    if (options?.improvementsOnly) qs.set('improvementsOnly', 'true');
    if (includePagination) {
      qs.set('limit', String(limit));
      qs.set('offset', String(page * limit));
      qs.set('sort', sort);
    }
    return qs.toString();
  }

  async function loadStats() {
    setStatsLoading(true);
    try {
      const qs = buildParams(false);
      const [resp, improvResp, managedResp, verifiableResp] = await Promise.all([
        fetch(API(`/api/extended-outcomes/stats?${qs}`)).then(r => r.json()),
        fetch(API(`/api/extended-outcomes/improvements?${qs}`)).then(r => r.json()),
        fetch(API(`/api/extended-outcomes/managed-stats?${qs}`)).then(r => r.json()),
        fetch(API(`/api/stats/verifiable?${qs}`)).then(r => r.json()),
      ]);
      if (resp?.ok) {
        setStats(resp);
      }
      if (improvResp?.ok) {
        setImprovementStats(improvResp);
      }
      if (managedResp?.ok) {
        setManagedStats(managedResp);
      }
      if (verifiableResp?.ok) {
        setVerifiableStats(verifiableResp);
      }
    } finally {
      setStatsLoading(false);
    }
  }

  async function loadOutcomes() {
    setLoading(true);
    try {
      // Use comparison endpoint if showing comparison or improvements only
      const useComparison = showComparison || showImprovementsOnly;
      const qs = buildParams(true, { improvementsOnly: showImprovementsOnly });
      const endpoint = useComparison
        ? '/api/extended-outcomes/comparison'
        : '/api/extended-outcomes';
      const resp = await fetch(API(`${endpoint}?${qs}`)).then(r => r.json());
      if (resp?.ok) {
        setOutcomes(resp.rows || []);
        setTotal(resp.total || 0);
      }
    } finally {
      setLoading(false);
    }
  }

  async function triggerBackfill() {
    setActionLoading(true);
    setActionMsg('');
    try {
      const resp = await fetch(API('/api/extended-outcomes/backfill?days=7&batchSize=50'), { method: 'POST' }).then(r => r.json());
      if (resp?.ok) {
        setActionMsg(`Backfilled ${resp.processed} signals, ${resp.errors} errors`);
        await Promise.all([loadStats(), loadOutcomes()]);
      } else {
        setActionMsg('Backfill failed');
      }
    } catch {
      setActionMsg('Backfill failed');
    } finally {
      setActionLoading(false);
    }
  }

  async function triggerReevaluate() {
    setActionLoading(true);
    setActionMsg('');
    try {
      const resp = await fetch(API('/api/extended-outcomes/reevaluate?limit=25'), { method: 'POST' }).then(r => r.json());
      if (resp?.ok) {
        setActionMsg(`Re-evaluated ${resp.evaluated}, completed ${resp.completed}, errors ${resp.errors}`);
        await Promise.all([loadStats(), loadOutcomes()]);
      } else {
        setActionMsg('Re-evaluate failed');
      }
    } catch {
      setActionMsg('Re-evaluate failed');
    } finally {
      setActionLoading(false);
    }
  }

  useEffect(() => { loadStats().catch(() => {}); }, [range.start, range.end, symbol, category, direction]);
  useEffect(() => { setPage(0); }, [range.start, range.end, symbol, category, status, direction, completed, showImprovementsOnly]);
  useEffect(() => { loadOutcomes().catch(() => {}); }, [range.start, range.end, symbol, category, status, direction, completed, page, limit, sort, showComparison, showImprovementsOnly]);
  
  // Live polling for pending signals - updates every 5 seconds automatically
  useEffect(() => {
    let intervalId: NodeJS.Timeout;
    
    async function pollLivePending() {
      try {
        const resp = await fetch(API('/api/extended-outcomes/live-pending')).then(r => r.json());
        if (resp?.ok && resp.signals) {
          const newMap = new Map();
          resp.signals.forEach((s: any) => {
            if (s.signalId != null) {
              newMap.set(s.signalId, {
                currentPrice: s.currentPrice ?? 0,
                currentMovePct: s.currentMovePct ?? 0,
                liveMfe: s.liveMfe ?? 0,
                liveMae: s.liveMae ?? 0,
                liveManagedR: s.liveManagedR ?? null,
                isConfirmed: s.isConfirmed ?? false,
                lastUpdated: s.lastUpdated ?? new Date().toISOString()
              });
            }
          });
          setLivePendingData(newMap);
        }
      } catch (e) {
        // Silently fail - don't disrupt user experience
      }
    }
    
    // Initial poll
    pollLivePending();
    
    // Poll every 5 seconds
    intervalId = setInterval(pollLivePending, 5000);
    
    return () => clearInterval(intervalId);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Stats breakdown
  const statsBreakdown = useMemo(() => {
    if (!stats) return [];
    return [
      { label: 'WIN TP2', value: stats.winTp2, color: 'bg-emerald-500' },
      { label: 'WIN TP1', value: stats.winTp1, color: 'bg-emerald-400' },
      { label: 'STOP LOSS', value: stats.lossStop, color: 'bg-rose-400' },
      { label: 'FLAT TIMEOUT', value: stats.flatTimeout, color: 'bg-gray-400' },
      { label: 'PENDING', value: stats.pending, color: 'bg-amber-400' },
      { label: 'ACHIEVED TP1', value: stats.achievedTp1, color: 'bg-cyan-400' },
    ];
  }, [stats]);

  const maxStatValue = useMemo(() => {
    return Math.max(1, ...statsBreakdown.map(s => s.value));
  }, [statsBreakdown]);

  return (
    <div className="mt-4 space-y-6">
      {/* Header */}
      <section className="sticky top-0 z-20 bg-bg/80 backdrop-blur border-b border-white/5">
        <div className="py-3 space-y-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-2xl font-display font-semibold tracking-tight">Extended Outcome (24h)</div>
              <div className="text-xs text-white/60">
                Track signal performance over 24h: TP1, TP2, and Stop Loss hits
              </div>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
                <span className="text-white/60">Date</span>
                <select className="bg-transparent text-white/90" value={datePreset} onChange={(e) => setDatePreset(e.target.value as any)}>
                  <option value="today">Today</option>
                  <option value="24h">24h</option>
                  <option value="7d">7d</option>
                  <option value="30d">30d</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {datePreset === 'custom' ? (
                <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
                  <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="bg-transparent text-white/90" />
                  <span className="text-white/40">→</span>
                  <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="bg-transparent text-white/90" />
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              <span className="text-white/60">Symbol</span>
              <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="bg-transparent text-white/90 w-24" placeholder="BTCUSDT" />
            </div>
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              <span className="text-white/60">Category</span>
              <select className="bg-transparent text-white/90" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              <span className="text-white/60">Status</span>
              <select className="bg-transparent text-white/90" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              <span className="text-white/60">Direction</span>
              <select className="bg-transparent text-white/90" value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="">All</option>
                {DIRECTIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1">
              <span className="text-white/60">Completed</span>
              <select className="bg-transparent text-white/90" value={completed} onChange={(e) => setCompleted(e.target.value)}>
                <option value="">All</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={triggerBackfill}
              disabled={actionLoading}
              className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 disabled:opacity-50"
            >
              {actionLoading ? 'Processing...' : 'Backfill Signals'}
            </button>
            <button
              onClick={triggerReevaluate}
              disabled={actionLoading}
              className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 disabled:opacity-50"
            >
              {actionLoading ? 'Processing...' : 'Re-evaluate Pending'}
            </button>
            <label className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1 cursor-pointer">
              <input 
                type="checkbox" 
                checked={showComparison} 
                onChange={(e) => setShowComparison(e.target.checked)} 
              />
              Show 240m Comparison
            </label>
            <label className="flex items-center gap-2 text-xs bg-accent/10 border border-accent/20 rounded-xl px-2 py-1 cursor-pointer">
              <input 
                type="checkbox" 
                checked={showImprovementsOnly} 
                onChange={(e) => setShowImprovementsOnly(e.target.checked)} 
              />
              Improvements Only
            </label>
            {actionMsg ? <span className="text-xs text-white/50">{actionMsg}</span> : null}
          </div>
        </div>
      </section>

      {/* Stats Cards - Self-verifying with counts/denominators (Step 2) */}
      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard 
          label="Total Signals" 
          value={verifiableStats?.totals.totalSignals ?? stats?.totalSignals ?? '--'} 
          sub="24h extended window" 
          loading={statsLoading}
        />
        <KpiCard 
          label="Completed" 
          value={verifiableStats?.totals.completedSignals ?? stats?.completed ?? '--'} 
          sub={verifiableStats 
            ? `${verifiableStats.totals.completedSignals} / ${verifiableStats.totals.totalSignals} total` 
            : `${stats?.completed && stats?.totalSignals ? fmtRate(stats.completed / stats.totalSignals, 0) : '--'} of total`}
          loading={statsLoading}
        />
        <KpiCard 
          label="Win Rate (P&L)" 
          value={verifiableStats 
            ? `${verifiableStats.signalRates.winRate.pct.toFixed(1)}%` 
            : stats ? fmtRate(stats.winRate, 1) : '--'} 
          sub={verifiableStats?.signalRates.winRate.label ?? "Excludes NO_TRADE"}
          loading={statsLoading}
        />
        <KpiCard 
          label="Pending / Active" 
          value={verifiableStats?.totals.activeSignals ?? stats?.pending ?? '--'} 
          sub="Within 24h window"
          loading={statsLoading}
        />
        <KpiCard 
          label="TP1 Touch Rate" 
          value={verifiableStats 
            ? `${verifiableStats.signalRates.tp1TouchRate.pct.toFixed(1)}%` 
            : '--'} 
          sub={verifiableStats?.signalRates.tp1TouchRate.label ?? "Any TP1 touch / total"}
          loading={statsLoading}
        />
        <KpiCard 
          label="TP2 Conversion" 
          value={verifiableStats 
            ? `${verifiableStats.signalRates.tp2Conversion.pct.toFixed(1)}%` 
            : '--'} 
          sub={verifiableStats?.signalRates.tp2Conversion.label ?? "TP2 / touched TP1"}
          loading={statsLoading}
        />
      </section>

      {/* Outcome Breakdown (Step 4) - Full distribution with verification */}
      {verifiableStats?.breakdown && (
        <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-white/60 uppercase tracking-widest">Outcome Breakdown (24h)</div>
            {/* Verification status badge */}
            {verifiableStats.verification.allMatch ? (
              <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
                ✓ Verified
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px]">
                ✗ Verification Failed
              </span>
            )}
          </div>
          
          {/* Stacked progress bar */}
          <div className="h-4 bg-white/5 rounded-full overflow-hidden flex mb-3">
            {verifiableStats.breakdown.bySignal
              .filter(item => item.count > 0)
              .map((item) => {
                const width = (item.count / verifiableStats.breakdown!.totalDen) * 100;
                const colors = {
                  win: 'bg-emerald-500',
                  loss: 'bg-rose-500', 
                  neutral: 'bg-gray-500',
                  pending: 'bg-amber-500'
                };
                return (
                  <div
                    key={item.key}
                    className={`h-full ${colors[item.category]} transition-all`}
                    style={{ width: `${width}%` }}
                    title={`${item.label}: ${item.count} (${item.pctOfTotal}%)`}
                  />
                );
              })}
          </div>
          
          {/* Breakdown list */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            {verifiableStats.breakdown.bySignal
              .filter(item => item.count > 0 || item.key === 'pending')
              .map((item) => {
                const colors = {
                  win: 'text-emerald-300',
                  loss: 'text-rose-300',
                  neutral: 'text-gray-300',
                  pending: 'text-amber-300'
                };
                return (
                  <div key={item.key} className="flex items-center justify-between rounded bg-white/5 px-2 py-1.5">
                    <span className="text-xs text-white/60">{item.label}</span>
                    <div className="text-right">
                      <span className={`text-sm font-medium ${colors[item.category]}`}>{item.count}</span>
                      <span className="text-xs text-white/40 ml-1">({item.pctOfTotal}%)</span>
                    </div>
                  </div>
                );
              })}
          </div>
          
          {/* Verification details */}
          <div className="text-[10px] text-white/40 border-t border-white/10 pt-2 flex flex-wrap gap-4">
            <span>Completed denominator: <strong className="text-white/60">{verifiableStats.breakdown.completedDen}</strong></span>
            <span>Win-rate: <strong className="text-white/60">{verifiableStats.breakdown.winRateDefinition}</strong></span>
            {!verifiableStats.verification.completedMatches && (
              <span className="text-rose-400">⚠ Completed check failed</span>
            )}
            {!verifiableStats.verification.totalMatches && (
              <span className="text-rose-400">⚠ Total check failed</span>
            )}
          </div>
        </section>
      )}

      {/* 240m vs 24h Comparison Stats - Only show if there's meaningful data */}
      {improvementStats && (improvementStats.noHitAt240m > 0 || improvementStats.laterHitTp1 > 0 || improvementStats.laterHitTp2 > 0 || improvementStats.laterHitStop > 0) && (
        <section className="rounded-2xl border border-accent/20 bg-accent/5 p-4">
          <div className="text-xs text-accent/80 uppercase tracking-widest mb-3">240m Horizon vs 24h Extended Comparison</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs text-white/50">No Hit at 240m</div>
              <div className="text-lg font-semibold">{improvementStats.noHitAt240m}</div>
              <div className="text-[10px] text-white/40">Timed out at 4h horizon</div>
            </div>
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
              <div className="text-xs text-emerald-300">Later Hit TP1</div>
              <div className="text-lg font-semibold text-emerald-200">{improvementStats.laterHitTp1}</div>
              <div className="text-[10px] text-emerald-300/60">After 4h, within 24h</div>
            </div>
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-3">
              <div className="text-xs text-emerald-300">Later Hit TP2</div>
              <div className="text-lg font-semibold text-emerald-200">{improvementStats.laterHitTp2}</div>
              <div className="text-[10px] text-emerald-300/60">Full target reached</div>
            </div>
            <div className="rounded-xl border border-rose-400/20 bg-rose-400/10 p-3">
              <div className="text-xs text-rose-300">Later Hit Stop</div>
              <div className="text-lg font-semibold text-rose-200">{improvementStats.laterHitStop}</div>
              <div className="text-[10px] text-rose-300/60">Stop after 4h window</div>
            </div>
          </div>
          {improvementStats.noHitAt240m > 0 && (
            <div className="mt-3 text-xs">
              <span className="text-white/60">Of signals that showed "no hit" at 240m:</span>
              <span className="ml-2 text-emerald-300 font-semibold">
                {fmtRate(improvementStats.improvedWinRate, 1)} later became wins within 24h
              </span>
              <span className="text-white/40"> (TP1 or TP2 hit after hour 4)</span>
            </div>
          )}
        </section>
      )}

      {/* Managed Performance (Option B) */}
      <section className="rounded-2xl border border-cyan-500/20 bg-cyan-950/20 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-cyan-400/80 uppercase tracking-widest">Managed Performance (Option B: 50% TP1 + BE Runner)</div>
          <label className="flex items-center gap-2 text-xs bg-white/5 border border-white/10 rounded-xl px-2 py-1 cursor-pointer">
            <input 
              type="checkbox" 
              checked={showManagedStats} 
              onChange={(e) => setShowManagedStats(e.target.checked)} 
            />
            Show Managed Stats
          </label>
        </div>
        {showManagedStats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-4">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/50">Risk / Trade</div>
                <div className="text-lg font-semibold">${managedStats?.riskPerTradeUsd ?? 15}</div>
                <div className="text-[10px] text-white/40">Configurable</div>
              </div>
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                <div className="text-xs text-emerald-300">Managed Net R</div>
                <div className={`text-lg font-semibold ${(managedStats?.totalManagedR ?? 0) >= 0 ? 'text-emerald-200' : 'text-rose-200'}`}>
                  {managedStats ? `${managedStats.totalManagedR >= 0 ? '+' : ''}${fmt(managedStats.totalManagedR, 2)}R` : '--'}
                </div>
                <div className="text-[10px] text-emerald-300/60">Closed trades only</div>
              </div>
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                <div className="text-xs text-emerald-300">Managed Net $</div>
                <div className={`text-lg font-semibold ${(managedStats?.totalManagedPnlUsd ?? 0) >= 0 ? 'text-emerald-200' : 'text-rose-200'}`}>
                  {managedStats ? `${managedStats.totalManagedPnlUsd >= 0 ? '+' : ''}$${fmt(managedStats.totalManagedPnlUsd, 0)}` : '--'}
                </div>
                <div className="text-[10px] text-emerald-300/60">Based on risk/trade</div>
              </div>
              <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
                <div className="text-xs text-cyan-300">Managed Win Rate</div>
                <div className="text-lg font-semibold text-cyan-200">
                  {verifiableStats 
                    ? `${verifiableStats.managedRates.winRate.pct.toFixed(1)}%` 
                    : managedStats ? fmtRate(managedStats.managedWinRate, 1) : '--'}
                </div>
                <div className="text-[10px] text-cyan-300/60">
                  {verifiableStats?.managedRates.winRate.label ?? "managed_r > 0 / closed"}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/50">Avg R / Trade</div>
                <div className={`text-lg font-semibold ${(verifiableStats?.performance.avgManagedRPnL ?? 0) >= 0 ? 'text-emerald-200' : 'text-rose-200'}`}>
                  {verifiableStats ? `${verifiableStats.performance.avgManagedRPnL >= 0 ? '+' : ''}${fmt(verifiableStats.performance.avgManagedRPnL, 2)}R` : '--'}
                </div>
                <div className="text-[10px] text-white/40">
                  P&L trades only ({verifiableStats?.performance.managedTradesWithPnL ?? '--'})
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/50">BE Rate</div>
                <div className="text-lg font-semibold text-white/90">
                  {verifiableStats 
                    ? `${verifiableStats.managedRates.beRate.pct.toFixed(1)}%` 
                    : '--'}
                </div>
                <div className="text-[10px] text-white/40">
                  {verifiableStats?.managedRates.beRate.label ?? "managed_r = 0 / closed"}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/50">Avg R (All Closed)</div>
                <div className={`text-lg font-semibold ${(verifiableStats?.performance.avgManagedR ?? 0) >= 0 ? 'text-emerald-200/70' : 'text-rose-200/70'}`}>
                  {verifiableStats ? `${verifiableStats.performance.avgManagedR >= 0 ? '+' : ''}${fmt(verifiableStats.performance.avgManagedR, 2)}R` : '--'}
                </div>
                <div className="text-[10px] text-white/40">
                  Includes BE ({verifiableStats?.performance.managedClosed ?? '--'} total)
                </div>
              </div>
            </div>
            
            {/* Additional managed stats row */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                <div className="text-xs text-amber-300">BE Saves</div>
                <div className="text-lg font-semibold text-amber-200">
                  {verifiableStats?.managedCounts.beSaves ?? managedStats?.beSaves ?? '--'}
                </div>
                <div className="text-[10px] text-amber-300/60">TP1 → BE exits</div>
              </div>
              <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 p-3">
                <div className="text-xs text-blue-300">Timeout Exits</div>
                <div className="text-lg font-semibold text-blue-200">
                  {verifiableStats?.managedCounts.timeoutExits ?? managedStats?.timeoutExits ?? '--'}
                </div>
                <div className="text-[10px] text-blue-300/60">24h market close</div>
              </div>
              <div className="rounded-xl border border-purple-500/20 bg-purple-500/10 p-3">
                <div className="text-xs text-purple-300">TP1 Touch Rate</div>
                <div className="text-lg font-semibold text-purple-200">
                  {verifiableStats 
                    ? `${verifiableStats.signalRates.tp1TouchRate.pct.toFixed(1)}%` 
                    : managedStats ? fmtRate(managedStats.tp1TouchRate, 1) : '--'}
                </div>
                <div className="text-[10px] text-purple-300/60">Any TP1 hit</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/50">Max Win R</div>
                <div className="text-lg font-semibold text-emerald-200">{managedStats ? `+${fmt(managedStats.maxWinR, 2)}R` : '--'}</div>
                <div className="text-[10px] text-white/40">Best outcome</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="text-xs text-white/50">Max Loss R</div>
                <div className="text-lg font-semibold text-rose-200">{managedStats ? `${fmt(managedStats.maxLossR, 2)}R` : '--'}</div>
                <div className="text-[10px] text-white/40">Worst outcome</div>
              </div>
            </div>
            
            {/* Win rate comparison note - Self-verifying (Step 2) */}
            <div className="mt-3 text-xs">
              <div className="flex gap-4 text-white/60 flex-wrap">
                <span>A) Signal Win Rate: <strong className="text-white">{verifiableStats ? `${verifiableStats.signalRates.winRate.pct.toFixed(1)}%` : stats ? fmtRate(stats.winRate, 1) : '--'}</strong> <span className="text-white/40">({verifiableStats?.signalRates.winRate.label})</span></span>
                <span>B) Managed Win Rate: <strong className="text-cyan-300">{verifiableStats ? `${verifiableStats.managedRates.winRate.pct.toFixed(1)}%` : managedStats ? fmtRate(managedStats.managedWinRate, 1) : '--'}</strong> <span className="text-white/40">({verifiableStats?.managedRates.winRate.label})</span></span>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Bucket Analysis Section (Step 2) */}
      <BucketAnalysisSection range={range} />

      {/* Symbol Tier Section (Step 3) */}
      <SymbolTierSection range={range} />

      {/* Filter Simulator Section (Step 4) */}
      <FilterSimulatorSection range={range} />

      {/* Decision Engine Sections */}
      <div className="rounded-2xl border border-red-500/30 bg-red-950/20 p-4">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-lg">🚨</span>
          <span className="text-sm font-semibold text-red-200">SIGNAL GATE (HARD EXECUTION FILTER)</span>
        </div>
        
        <div className="space-y-4">
          <SignalGateStats />
          <GateQuickSettings />
          <FilterConfigSection />
          <SymbolTierManagement />
          <FilterTester />
        </div>
        
        <div className="mt-4 pt-4 border-t border-red-500/20 text-xs text-red-300/70">
          <div className="font-medium mb-1">Hard Gate Rules (Active when LIVE):</div>
          <ul className="space-y-1 list-disc list-inside">
            <li>RED tier symbols = BLOCKED</li>
            <li>MFE30m &lt; 0.3% = BLOCKED (0.5% for YELLOW)</li>
            <li>MQS &lt; 0.2 = BLOCKED</li>
            <li>Need 2+ confluence points (score-based)</li>
          </ul>
        </div>
      </div>

      {/* Gate Backtest Comparison */}
      <GateBacktestComparison />

      {/* Detailed Outcomes Table */}
      <section className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
        <div className="p-3 border-b border-white/10 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="text-sm font-semibold">Extended Outcomes</div>
            <span className="text-xs text-white/60">Total {total}</span>
            {loading ? <span className="text-xs text-white/40">Loading...</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select className="px-2 py-1 rounded bg-white/10 border border-white/10" value={sort} onChange={(e) => setSort(e.target.value as any)}>
              <option value="time_desc">Time (newest)</option>
              <option value="time_asc">Time (oldest)</option>
              <option value="completed_desc">Completed first</option>
            </select>
            <select className="px-2 py-1 rounded bg-white/10 border border-white/10" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[50, 100, 200, 500].map(n => <option key={n} value={n}>{n} rows</option>)}
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
                <th className="text-left px-3 py-2">Dir</th>
                <th className="text-left px-3 py-2">Entry / Stop / TP1 / TP2</th>
                {showComparison && <th className="text-left px-3 py-2">240m Result</th>}
                <th className="text-left px-3 py-2">Status (24h)</th>
                <th className="text-left px-3 py-2 text-red-400">Quality</th>
                {showManagedStats && <th className="text-left px-3 py-2 text-cyan-400">Managed R</th>}
                {showManagedStats && <th className="text-left px-3 py-2 text-cyan-400">Runner Exit</th>}
                <th className="text-left px-3 py-2">TP1 At</th>
                <th className="text-left px-3 py-2">TP2 At</th>
                <th className="text-left px-3 py-2">Stop At</th>
                <th className="text-left px-3 py-2">Time to Hit</th>
                <th className="text-left px-3 py-2">MFE / MAE</th>
                <th className="text-left px-3 py-2">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o) => {
                // Merge live data for pending signals
                const liveData = livePendingData.get(o.signalId);
                const isPending = o.status === 'PENDING' || o.status === 'ACHIEVED_TP1' || !o.completedAt;
                
                // Use live values when available for pending signals
                const displayMfe = isPending && liveData ? liveData.liveMfe : o.maxFavorableExcursionPct;
                const displayMae = isPending && liveData ? liveData.liveMae : o.maxAdverseExcursionPct;
                const displayManagedR = isPending && liveData && liveData.liveManagedR != null 
                  ? liveData.liveManagedR 
                  : o.ext24ManagedR;
                const isLive = isPending && !!liveData;
                
                return (
                <tr key={o.id} className={`border-b border-white/5 hover:bg-white/5 ${o.improved ? 'bg-emerald-500/5' : ''}`}>
                  <td className="px-3 py-2 text-white/70">{dt(o.signalTime)}</td>
                  <td className="px-3 py-2 font-semibold">{o.symbol}</td>
                  <td className="px-3 py-2">
                    <span className="text-white/80">{o.category.replace('_', ' ')}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${o.direction === 'LONG' ? 'bg-emerald-400/20 text-emerald-200' : 'bg-rose-400/20 text-rose-200'}`}>
                      {o.direction}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-white/70">
                    {fmt(o.entryPrice, 6)} / {fmt(o.stopPrice, 6)} / {fmt(o.tp1Price, 6)} / {fmt(o.tp2Price, 6)}
                  </td>
                  {showComparison && (
                    <td className="px-3 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${o.horizon240mResult === 'NONE' ? 'bg-amber-400/20 text-amber-200' : 'bg-white/10 text-white/60'}`}>
                        {o.horizon240mResult === 'NONE' ? 'NO HIT (240m)' : o.horizon240mResult || 'N/A'}
                      </span>
                      {o.improved && (
                        <span className="ml-1 text-[10px] text-emerald-400">→ Improved!</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-lg border ${STATUS_COLORS[o.status] || 'bg-white/10 border-white/20'}`}>
                      {STATUS_LABELS[o.status] || o.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {o.ext24ManagedR != null && o.ext24ManagedR > 0 ? (
                      <SignalQualityBadge quality="HIGH" size="sm" />
                    ) : o.ext24ManagedR != null && o.ext24ManagedR >= 0 ? (
                      <SignalQualityBadge quality="MEDIUM" size="sm" />
                    ) : o.ext24ManagedR != null ? (
                      <SignalQualityBadge quality="REJECTED" size="sm" />
                    ) : (
                      <span className="text-white/30 text-xs">--</span>
                    )}
                  </td>
                  {showManagedStats && (
                    <td className="px-3 py-2">
                      {displayManagedR !== null && displayManagedR !== undefined ? (
                        <span className={`font-medium ${displayManagedR >= 0 ? 'text-emerald-400' : 'text-rose-400'} ${isLive ? 'animate-pulse' : ''}`}>
                          {displayManagedR >= 0 ? '+' : ''}{fmt(displayManagedR, 2)}R
                          {isLive && (
                            <span className="text-[10px] text-cyan-400 ml-1">● LIVE</span>
                          )}
                          {!isLive && o.ext24ManagedPnlUsd !== null && (
                            <span className="text-white/50 ml-1">(${fmt(o.ext24ManagedPnlUsd, 0)})</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-white/30">--</span>
                      )}
                    </td>
                  )}
                  {showManagedStats && (
                    <td className="px-3 py-2">
                      {o.ext24RunnerExitReason ? (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          o.ext24RunnerExitReason === 'TP2' ? 'bg-emerald-500/20 text-emerald-200' :
                          o.ext24RunnerExitReason === 'BREAK_EVEN' ? 'bg-amber-500/20 text-amber-200' :
                          o.ext24RunnerExitReason === 'TIMEOUT_MARKET' ? 'bg-blue-500/20 text-blue-200' :
                          'bg-rose-500/20 text-rose-200'
                        }`}>
                          {o.ext24RunnerExitReason.replace('_', ' ')}
                        </span>
                      ) : o.ext24ManagedStatus ? (
                        <span className="text-[10px] text-white/50">{o.ext24ManagedStatus.replace('_', ' ')}</span>
                      ) : (
                        <span className="text-white/30">--</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-white/70">{o.firstTp1At ? dt(o.firstTp1At) : '--'}</td>
                  <td className="px-3 py-2 text-white/70">{o.tp2At ? dt(o.tp2At) : '--'}</td>
                  <td className="px-3 py-2 text-white/70">{o.stopAt ? dt(o.stopAt) : '--'}</td>
                  <td className="px-3 py-2 text-white/70">
                    {o.timeToFirstHitSeconds ? fmtDuration(o.timeToFirstHitSeconds) : '--'}
                  </td>
                  <td className="px-3 py-2 text-white/70">
                    {isLive ? (
                      <span className="text-cyan-400">
                        {fmt(displayMfe, 2)}% / {fmt(displayMae, 2)}%
                        <span className="text-[10px] text-white/40 ml-1">●</span>
                      </span>
                    ) : (
                      <span>{fmt(displayMfe, 2)}% / {fmt(displayMae, 2)}%</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-white/70">
                    {fmt(o.coveragePct, 0)}%
                  </td>
                </tr>
              )})}
              {!loading && outcomes.length === 0 && (
                <tr>
                  <td colSpan={showComparison ? (showManagedStats ? 16 : 14) : (showManagedStats ? 15 : 13)} className="px-3 py-4 text-white/50">
                    {showImprovementsOnly 
                      ? 'No improved signals found. These are signals that were "no hit" at 240m but hit within 24h.' 
                      : 'No extended outcomes in range. Try backfilling signals or adjusting filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="p-3 border-t border-white/10 flex items-center justify-between text-xs text-white/60">
          <div>Page {page + 1} / {Math.max(1, totalPages)} {showImprovementsOnly && <span className="ml-2 text-emerald-400">(Showing improvements only)</span>}</div>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} className="px-2 py-1 rounded bg-white/10">Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} className="px-2 py-1 rounded bg-white/10">Next</button>
          </div>
        </div>
      </section>

      {/* Legend / Help */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-xs text-white/60 uppercase tracking-widest mb-3">Status Guide</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-200 border border-emerald-500/30">WIN TP2 (24h)</span>
            <span className="text-white/50">Hit TP2 within 24h</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-emerald-400/20 text-emerald-200 border border-emerald-400/30">WIN TP1 (24h)</span>
            <span className="text-white/50">Hit TP1 but not TP2</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-rose-400/20 text-rose-200 border border-rose-400/30">LOSS STOP (24h)</span>
            <span className="text-white/50">Hit Stop Loss</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-gray-400/20 text-gray-200 border border-gray-400/30">FLAT TIMEOUT (24h)</span>
            <span className="text-white/50">No hits within 24h</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-cyan-400/20 text-cyan-200 border border-cyan-400/30">ACHIEVED TP1</span>
            <span className="text-white/50">TP1 hit, tracking for TP2</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-amber-400/20 text-amber-200 border border-amber-400/30">PENDING (24h)</span>
            <span className="text-white/50">Within 24h window</span>
          </div>
        </div>
        <div className="mt-4 text-xs text-white/40">
          <strong>Note:</strong> Extended outcomes use a 24-hour evaluation window starting from signal time. 
          If both Stop and TP are hit in the same candle, Stop wins (conservative). 
          TP1 can upgrade to TP2 if hit before 24h expires.
        </div>
        
        {/* Managed PnL Guide */}
        <div className="mt-4 pt-4 border-t border-white/10">
          <div className="text-xs text-cyan-400/80 uppercase tracking-widest mb-3">Managed PnL (Option B) Guide</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-white/60">
            <div>
              <strong className="text-white">Option B Trade Management:</strong>
              <ul className="mt-1 space-y-1 list-disc list-inside">
                <li>At TP1 hit: Take 50% partial profit (+0.5R)</li>
                <li>Move stop on remaining 50% to break-even (entry)</li>
                <li>Runner exits at: TP2 (+1.5R total), BE (+0.5R), or 24h timeout</li>
              </ul>
            </div>
            <div>
              <strong className="text-white">Managed R Values:</strong>
              <ul className="mt-1 space-y-1 list-disc list-inside">
                <li>STOP before TP1: -1.0R (full loss)</li>
                <li>TP1 → TP2: +1.5R (50% @ TP1 + 50% @ TP2)</li>
                <li>TP1 → BE: +0.5R (50% @ TP1, rest at BE)</li>
                <li>Timeout (no TP1): Market exit price converted to R</li>
              </ul>
            </div>
          </div>
          <div className="mt-2 text-xs text-white/40">
            <strong>Same-Candle Policy:</strong> Before TP1, STOP wins if both hit in same candle. 
            After TP1, BE wins if both TP2 and BE hit in same candle (conservative).
            Timeout exits use last available price in 24h window.
          </div>
        </div>
      </section>
    </div>
  );
}

function KpiCard(props: { label: string; value: any; sub?: string; loading?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <div className="text-xs text-white/60 uppercase tracking-widest">{props.label}</div>
      <div className="mt-2 text-xl font-semibold">
        {props.loading ? <span className="text-white/30">...</span> : (props.value ?? '--')}
      </div>
      {props.sub ? <div className="text-[11px] text-white/50 mt-1">{props.sub}</div> : null}
    </div>
  );
}
