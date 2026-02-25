/**
 * Outcome Analysis Components
 * 
 * Implements Steps 2-4 from the action plan:
 * - Step 2: Bucket Analysis (proper stats by direction+bucket)
 * - Step 3: Symbol Tier Section (GREEN/YELLOW/RED)
 * - Step 4: Filter Simulator (A/B/C backtest)
 */

import { useEffect, useMemo, useState } from 'react';
import { apiUrl as API } from '../config/apiBase';

// ============================================================================
// UTILITIES
// ============================================================================

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

// ============================================================================
// TYPES
// ============================================================================

interface Range { start: number; end: number }

interface BucketStats {
  bucket: 'WIN' | 'LOSS' | 'BE';
  direction: 'LONG' | 'SHORT';
  count: number;
  avgTimeToTp1Seconds: number | null;
  medianTimeToTp1Seconds: number | null;
  q1TimeToTp1Seconds: number | null;
  q3TimeToTp1Seconds: number | null;
  avgTimeToStopSeconds: number | null;
  medianTimeToStopSeconds: number | null;
  avgMfePct: number | null;
  medianMfePct: number | null;
  avgMaePct: number | null;
  medianMaePct: number | null;
  avgMfe30mPct: number | null;
  medianMfe30mPct: number | null;
  avgMae30mPct: number | null;
  medianMae30mPct: number | null;
}

interface BucketAnalysisData {
  longWin: BucketStats;
  longLoss: BucketStats;
  longBe: BucketStats;
  shortWin: BucketStats;
  shortLoss: BucketStats;
  shortBe: BucketStats;
  statusCounts: Record<string, number>;
  managedStatusCounts: Record<string, number>;
  rates: {
    longStopBeforeTp1Pct: number;
    longTp1AchievedPct: number;
    longTp1ToBePct: number;
    longTp1ToTp2Pct: number;
    shortStopBeforeTp1Pct: number;
    shortTp1AchievedPct: number;
    shortTp1ToBePct: number;
    shortTp1ToTp2Pct: number;
  };
}

interface SymbolStat {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  totalSignals: number;
  wins: number;
  losses: number;
  breakeven: number;
  pending: number;
  winRate: number;
  avgRealizedR: number | null;
  medianRealizedR: number | null;
  tier: 'GREEN' | 'YELLOW' | 'RED';
}

interface BacktestResult {
  filterId: 'A' | 'B' | 'C';
  filterName: string;
  totalSignals: number;
  signalsKept: number;
  signalsFiltered: number;
  keepRate: number;
  winRateBefore: number;
  winRateAfter: number;
  avgRealizedRBefore: number;
  avgRealizedRAfter: number;
  medianRealizedRBefore: number;
  medianRealizedRAfter: number;
  maxLossStreakBefore: number;
  maxLossStreakAfter: number;
}

// ============================================================================
// STEP 2: BUCKET ANALYSIS SECTION
// ============================================================================

export function BucketAnalysisSection({ range }: { range: Range }) {
  const [data, setData] = useState<BucketAnalysisData | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(API(`/api/stats/ext24/by-bucket?start=${range.start}&end=${range.end}`))
      .then(r => r.json())
      .then(d => {
        if (d.ok) setData(d);
      })
      .finally(() => setLoading(false));
  }, [range.start, range.end]);

  const bucketCards = useMemo(() => {
    if (!data) return [];
    return [
      { key: 'shortWin', label: 'SHORT Wins', stats: data.shortWin, color: 'emerald' },
      { key: 'shortLoss', label: 'SHORT Losses', stats: data.shortLoss, color: 'rose' },
      { key: 'shortBe', label: 'SHORT BE', stats: data.shortBe, color: 'amber' },
      { key: 'longWin', label: 'LONG Wins', stats: data.longWin, color: 'emerald' },
      { key: 'longLoss', label: 'LONG Losses', stats: data.longLoss, color: 'rose' },
      { key: 'longBe', label: 'LONG BE', stats: data.longBe, color: 'amber' },
    ];
  }, [data]);

  if (loading) {
    return (
      <section className="rounded-2xl border border-indigo-500/20 bg-indigo-950/20 p-4">
        <div className="text-xs text-indigo-400/80 uppercase tracking-widest mb-3">Bucket Analysis (Step 2)</div>
        <div className="text-white/50">Loading...</div>
      </section>
    );
  }

  if (!data) return null;

  return (
    <section className="rounded-2xl border border-indigo-500/20 bg-indigo-950/20 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-indigo-400/80 uppercase tracking-widest">Bucket Analysis (Step 2)</div>
        <button 
          onClick={() => setShowDetails(!showDetails)}
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
        >
          {showDetails ? 'Hide Details' : 'Show Details'}
        </button>
      </div>

      {/* Rates Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/50">SHORT Stop Before TP1</div>
          <div className="text-lg font-semibold text-rose-300">{fmt(data.rates.shortStopBeforeTp1Pct, 1)}%</div>
          <div className="text-[10px] text-white/40">Immediate losses</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/50">SHORT TP1 Achieved</div>
          <div className="text-lg font-semibold text-emerald-300">{fmt(data.rates.shortTp1AchievedPct, 1)}%</div>
          <div className="text-[10px] text-white/40">Touch TP1 rate</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/50">SHORT TP1→BE</div>
          <div className="text-lg font-semibold text-amber-300">{fmt(data.rates.shortTp1ToBePct, 1)}%</div>
          <div className="text-[10px] text-white/40">Saved by BE</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <div className="text-xs text-white/50">SHORT TP1→TP2</div>
          <div className="text-lg font-semibold text-emerald-300">{fmt(data.rates.shortTp1ToTp2Pct, 1)}%</div>
          <div className="text-[10px] text-white/40">Full winner rate</div>
        </div>
      </div>

      {/* Bucket Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {bucketCards.map(card => (
          <div key={card.key} className={`rounded-xl border border-${card.color}-500/20 bg-${card.color}-500/10 p-3`}>
            <div className={`text-xs text-${card.color}-300`}>{card.label}</div>
            <div className={`text-lg font-semibold text-${card.color}-200`}>{card.stats.count}</div>
            <div className="text-[10px] text-white/40">
              {card.stats.medianTimeToTp1Seconds !== null 
                ? `Med TT TP1: ${fmtDuration(card.stats.medianTimeToTp1Seconds)}`
                : card.stats.medianTimeToStopSeconds !== null
                ? `Med TT Stop: ${fmtDuration(card.stats.medianTimeToStopSeconds)}`
                : 'No timing data'}
            </div>
            {showDetails && (
              <div className="mt-2 pt-2 border-t border-white/10 space-y-1 text-[10px] text-white/50">
                <div>MFE: {fmt(card.stats.medianMfePct, 1)}%</div>
                <div>MAE: {fmt(card.stats.medianMaePct, 1)}%</div>
                <div>Q1 TT: {fmtDuration(card.stats.q1TimeToTp1Seconds)}</div>
                <div>Q3 TT: {fmtDuration(card.stats.q3TimeToTp1Seconds)}</div>
              </div>
            )}
          </div>
        ))}
      </div>

      {showDetails && (
        <div className="mt-4 pt-4 border-t border-white/10">
          <div className="text-xs text-white/60 uppercase tracking-widest mb-2">Status Sanity Check</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            {Object.entries(data.statusCounts).map(([status, count]) => (
              <div key={status} className="flex justify-between bg-white/5 rounded px-2 py-1">
                <span className="text-white/60">{status}</span>
                <span className="text-white/80">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ============================================================================
// STEP 3: SYMBOL TIER SECTION
// ============================================================================

export function SymbolTierSection({ range }: { range: Range }) {
  const [symbols, setSymbols] = useState<SymbolStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [minSignals, setMinSignals] = useState(10);
  const [filterTier, setFilterTier] = useState<'ALL' | 'GREEN' | 'YELLOW' | 'RED'>('ALL');

  useEffect(() => {
    setLoading(true);
    fetch(API(`/api/stats/ext24/by-symbol?start=${range.start}&end=${range.end}&minSignals=${minSignals}`))
      .then(r => r.json())
      .then(d => {
        if (d.ok) setSymbols(d.symbols || []);
      })
      .finally(() => setLoading(false));
  }, [range.start, range.end, minSignals]);

  const filteredSymbols = useMemo(() => {
    if (filterTier === 'ALL') return symbols;
    return symbols.filter(s => s.tier === filterTier);
  }, [symbols, filterTier]);

  const tierColors = {
    GREEN: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30',
    YELLOW: 'bg-amber-500/20 text-amber-200 border-amber-500/30',
    RED: 'bg-rose-500/20 text-rose-200 border-rose-500/30',
  };

  if (loading) {
    return (
      <section className="rounded-2xl border border-violet-500/20 bg-violet-950/20 p-4">
        <div className="text-xs text-violet-400/80 uppercase tracking-widest mb-3">Symbol Gates (Step 3)</div>
        <div className="text-white/50">Loading...</div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-violet-500/20 bg-violet-950/20 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs text-violet-400/80 uppercase tracking-widest">Symbol Gates (Step 3)</div>
        <div className="flex items-center gap-2">
          <select 
            className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            value={minSignals} 
            onChange={(e) => setMinSignals(Number(e.target.value))}
          >
            <option value={5}>Min 5 signals</option>
            <option value={10}>Min 10 signals</option>
            <option value={20}>Min 20 signals</option>
          </select>
          <select 
            className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            value={filterTier} 
            onChange={(e) => setFilterTier(e.target.value as any)}
          >
            <option value="ALL">All Tiers</option>
            <option value="GREEN">Green Only</option>
            <option value="YELLOW">Yellow Only</option>
            <option value="RED">Red Only</option>
          </select>
        </div>
      </div>

      {/* Tier Legend */}
      <div className="flex gap-3 mb-3 text-xs">
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-emerald-500/30 border border-emerald-500/50"></span>
          <span className="text-emerald-300">Green ≥30% win rate</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-amber-500/30 border border-amber-500/50"></span>
          <span className="text-amber-300">Yellow 15-30%</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-rose-500/30 border border-rose-500/50"></span>
          <span className="text-rose-300">Red &lt;15% (avoid)</span>
        </div>
      </div>

      {/* Symbol Table */}
      <div className="overflow-x-auto max-h-96">
        <table className="w-full text-xs">
          <thead className="text-white/60 sticky top-0 bg-violet-950/90">
            <tr className="border-b border-white/10">
              <th className="text-left px-2 py-2">Symbol</th>
              <th className="text-left px-2 py-2">Dir</th>
              <th className="text-left px-2 py-2">Tier</th>
              <th className="text-right px-2 py-2">Total</th>
              <th className="text-right px-2 py-2">Wins</th>
              <th className="text-right px-2 py-2">Losses</th>
              <th className="text-right px-2 py-2">Win Rate</th>
              <th className="text-right px-2 py-2">Avg R</th>
              <th className="text-right px-2 py-2">Med R</th>
            </tr>
          </thead>
          <tbody>
            {filteredSymbols.map(s => (
              <tr key={`${s.symbol}_${s.direction}`} className="border-b border-white/5 hover:bg-white/5">
                <td className="px-2 py-1.5 font-medium">{s.symbol}</td>
                <td className="px-2 py-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.direction === 'LONG' ? 'bg-emerald-400/20 text-emerald-200' : 'bg-rose-400/20 text-rose-200'}`}>
                    {s.direction}
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  <span className={`inline-flex px-2 py-0.5 rounded border ${tierColors[s.tier]}`}>
                    {s.tier}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right">{s.totalSignals}</td>
                <td className="px-2 py-1.5 text-right text-emerald-300">{s.wins}</td>
                <td className="px-2 py-1.5 text-right text-rose-300">{s.losses}</td>
                <td className="px-2 py-1.5 text-right font-medium">{fmtRate(s.winRate, 1)}</td>
                <td className="px-2 py-1.5 text-right">{fmt(s.avgRealizedR, 2)}</td>
                <td className="px-2 py-1.5 text-right">{fmt(s.medianRealizedR, 2)}</td>
              </tr>
            ))}
            {filteredSymbols.length === 0 && (
              <tr>
                <td colSpan={9} className="px-2 py-4 text-white/50 text-center">
                  No symbols with ≥{minSignals} signals found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ============================================================================
// STEP 4: FILTER SIMULATOR SECTION
// ============================================================================

export function FilterSimulatorSection({ range }: { range: Range }) {
  const [backtestResults, setBacktestResults] = useState<BacktestResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState<'ALL' | 'A' | 'B' | 'C'>('ALL');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(API(`/api/stats/ext24/backtest?start=${range.start}&end=${range.end}&filter=A`)).then(r => r.json()),
      fetch(API(`/api/stats/ext24/backtest?start=${range.start}&end=${range.end}&filter=B`)).then(r => r.json()),
      fetch(API(`/api/stats/ext24/backtest?start=${range.start}&end=${range.end}&filter=C`)).then(r => r.json()),
    ])
      .then(results => {
        const valid = results.filter(r => r.ok).map(r => ({
          filterId: r.filterId,
          filterName: r.filterName,
          totalSignals: r.totalSignals,
          signalsKept: r.signalsKept,
          signalsFiltered: r.signalsFiltered,
          keepRate: r.keepRate,
          winRateBefore: r.winRateBefore,
          winRateAfter: r.winRateAfter,
          avgRealizedRBefore: r.avgRealizedRBefore,
          avgRealizedRAfter: r.avgRealizedRAfter,
          medianRealizedRBefore: r.medianRealizedRBefore,
          medianRealizedRAfter: r.medianRealizedRAfter,
          maxLossStreakBefore: r.maxLossStreakBefore,
          maxLossStreakAfter: r.maxLossStreakAfter,
        }));
        setBacktestResults(valid);
      })
      .finally(() => setLoading(false));
  }, [range.start, range.end]);

  const filteredResults = useMemo(() => {
    if (selectedFilter === 'ALL') return backtestResults;
    return backtestResults.filter(r => r.filterId === selectedFilter);
  }, [backtestResults, selectedFilter]);

  if (loading) {
    return (
      <section className="rounded-2xl border border-fuchsia-500/20 bg-fuchsia-950/20 p-4">
        <div className="text-xs text-fuchsia-400/80 uppercase tracking-widest mb-3">Filter Simulator (Step 4)</div>
        <div className="text-white/50">Loading...</div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-fuchsia-500/20 bg-fuchsia-950/20 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs text-fuchsia-400/80 uppercase tracking-widest">Filter Simulator (Step 4)</div>
        <div className="flex items-center gap-2">
          <select 
            className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            value={selectedFilter} 
            onChange={(e) => setSelectedFilter(e.target.value as any)}
          >
            <option value="ALL">All Filters</option>
            <option value="A">Filter A (Momentum)</option>
            <option value="B">Filter B (Speed)</option>
            <option value="C">Filter C (Symbol-Adaptive)</option>
          </select>
        </div>
      </div>

      {/* Filter Descriptions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4 text-xs">
        <div className="rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="font-medium text-fuchsia-300">Filter A: Momentum</div>
          <div className="text-white/50 mt-1">MFE30m ≥ 0.30% AND MFE/MAE ratio ≥ 0.20</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="font-medium text-fuchsia-300">Filter B: Speed</div>
          <div className="text-white/50 mt-1">TP1 hit within 35 minutes</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="font-medium text-fuchsia-300">Filter C: Symbol-Adaptive</div>
          <div className="text-white/50 mt-1">Tier-based: Green 0.25%, Yellow 0.30%, Red 0.50%</div>
        </div>
      </div>

      {/* Backtest Results */}
      <div className="space-y-3">
        {filteredResults.map(result => (
          <div key={result.filterId} className="rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium text-fuchsia-300">Filter {result.filterId}: {result.filterName}</div>
              <div className="text-xs text-white/50">{result.signalsKept} / {result.totalSignals} kept ({fmtRate(result.keepRate, 0)})</div>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="rounded bg-white/5 p-2">
                <div className="text-white/50">Win Rate Before</div>
                <div className="text-white/80">{fmtRate(result.winRateBefore, 1)}</div>
              </div>
              <div className="rounded bg-emerald-500/10 p-2">
                <div className="text-emerald-300">Win Rate After</div>
                <div className="text-emerald-200 font-medium">{fmtRate(result.winRateAfter, 1)}</div>
                <div className="text-[10px] text-emerald-300/60">
                  {result.winRateAfter > result.winRateBefore ? '↑' : '↓'} {fmtRate(Math.abs(result.winRateAfter - result.winRateBefore), 1)}
                </div>
              </div>
              <div className="rounded bg-white/5 p-2">
                <div className="text-white/50">Avg R Before</div>
                <div className="text-white/80">{fmt(result.avgRealizedRBefore, 2)}</div>
              </div>
              <div className="rounded bg-emerald-500/10 p-2">
                <div className="text-emerald-300">Avg R After</div>
                <div className="text-emerald-200 font-medium">{fmt(result.avgRealizedRAfter, 2)}</div>
                <div className="text-[10px] text-emerald-300/60">
                  {result.avgRealizedRAfter > result.avgRealizedRBefore ? '↑' : '↓'} {fmt(Math.abs(result.avgRealizedRAfter - result.avgRealizedRBefore), 2)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2 text-xs">
              <div className="rounded bg-white/5 p-2">
                <div className="text-white/50">Med R Before</div>
                <div className="text-white/80">{fmt(result.medianRealizedRBefore, 2)}</div>
              </div>
              <div className="rounded bg-emerald-500/10 p-2">
                <div className="text-emerald-300">Med R After</div>
                <div className="text-emerald-200 font-medium">{fmt(result.medianRealizedRAfter, 2)}</div>
              </div>
              <div className="rounded bg-rose-500/10 p-2">
                <div className="text-rose-300">Max Loss Streak Before</div>
                <div className="text-rose-200">{result.maxLossStreakBefore}</div>
              </div>
              <div className="rounded bg-emerald-500/10 p-2">
                <div className="text-emerald-300">Max Loss Streak After</div>
                <div className="text-emerald-200 font-medium">{result.maxLossStreakAfter}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
