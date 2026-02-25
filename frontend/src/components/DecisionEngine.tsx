/**
 * Decision Engine Components
 * 
 * Implements the entry filter UI:
 * - Filter config toggle (LIVE/OFF)
 * - Symbol tier management
 * - Signal rejection reasoning
 * - Momentum Quality Score (MQS) display
 */

import { useEffect, useMemo, useState } from 'react';
import { apiUrl as API } from '../config/apiBase';

// ============================================================================
// TYPES
// ============================================================================

type SymbolTier = 'GREEN' | 'YELLOW' | 'RED';
type MQSClass = 'bad' | 'weak' | 'good';

interface FilterConfig {
  enabled: boolean;
  blockRedSymbols: boolean;
  yellowRequiresStrictFilter: boolean;
  minMfe30mPct: number;
  yellowMinMfe30mPct: number;
  redMinMfe30mPct: number;
  minMfeMaeRatio30m: number;
  requireTp1Within45Min: boolean;
  allowedCategories: string[];
}

interface FilterResult {
  allowed: boolean;
  reason: string;
  message: string;
  details: {
    symbol?: string;
    category?: string;
    direction?: string;
    tier?: SymbolTier;
    mfe30mPct?: number;
    mae30mPct?: number;
    mqs?: number;
    mqsLabel?: string;
    mqsClass?: MQSClass;
    requiredMfe?: number;
    actualMfe?: number;
    requiredRatio?: number;
    actualRatio?: number;
    passedChecks?: string[];
  };
  tier?: SymbolTier;
  mqs?: number;
}

interface SymbolTierRecord {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  tier: SymbolTier;
  winRate: number;
  totalSignals: number;
  avgRealizedR: number | null;
  computedAt: number;
  updatedAt: number;
  manualOverride: boolean;
  reason?: string;
}

// ============================================================================
// UTILITIES
// ============================================================================

function fmtRate(n: number | null | undefined, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '--';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmt(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '--';
  return n.toFixed(digits);
}

function getTierColor(tier: SymbolTier) {
  switch (tier) {
    case 'GREEN': return 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30';
    case 'YELLOW': return 'bg-amber-500/20 text-amber-200 border-amber-500/30';
    case 'RED': return 'bg-rose-500/20 text-rose-200 border-rose-500/30';
  }
}

function getMQSColor(mqsClass: MQSClass) {
  switch (mqsClass) {
    case 'bad': return 'bg-rose-500/20 text-rose-200';
    case 'weak': return 'bg-amber-500/20 text-amber-200';
    case 'good': return 'bg-emerald-500/20 text-emerald-200';
  }
}

// ============================================================================
// FILTER CONFIG SECTION (Live Toggle)
// ============================================================================

export function FilterConfigSection() {
  const [config, setConfig] = useState<FilterConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(API('/api/filter/config'))
      .then(r => r.json())
      .then(d => {
        if (d.ok) setConfig(d.config);
      })
      .finally(() => setLoading(false));
  }, []);

  // Note: Config is read-only from env vars for now
  // In future, this could be saved to database

  if (loading || !config) {
    return (
      <section className="rounded-2xl border border-orange-500/20 bg-orange-950/20 p-4">
        <div className="text-xs text-orange-400/80 uppercase tracking-widest mb-3">Entry Filter Config</div>
        <div className="text-white/50">Loading...</div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-orange-500/20 bg-orange-950/20 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-orange-400/80 uppercase tracking-widest">Entry Filter Config (Step 2)</div>
        <div className={`px-2 py-0.5 rounded text-xs font-medium ${config.enabled ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200'}`}>
          {config.enabled ? '🔴 LIVE' : '⚪ OFF'}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div className="rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="text-white/50">Status</div>
          <div className={config.enabled ? 'text-emerald-300 font-medium' : 'text-rose-300 font-medium'}>
            {config.enabled ? 'ACTIVE' : 'DISABLED'}
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="text-white/50">Block RED</div>
          <div className={config.blockRedSymbols ? 'text-emerald-300' : 'text-amber-300'}>
            {config.blockRedSymbols ? 'YES' : 'NO'}
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="text-white/50">Min MFE30m</div>
          <div className="text-white/80">{(config.minMfe30mPct * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="text-white/50">Min MQS</div>
          <div className="text-white/80">{config.minMfeMaeRatio30m}</div>
        </div>
      </div>

      <div className="mt-3 text-xs text-white/40">
        Set via environment variables: ENTRY_FILTER_ENABLED, ENTRY_FILTER_MIN_MFE30M, etc.
      </div>
    </section>
  );
}

// ============================================================================
// SYMBOL TIER MANAGEMENT SECTION
// ============================================================================

export function SymbolTierManagement() {
  const [tiers, setTiers] = useState<SymbolTierRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTier, setFilterTier] = useState<SymbolTier | 'ALL'>('ALL');
  const [newTier, setNewTier] = useState<{ symbol: string; direction: 'LONG' | 'SHORT'; tier: SymbolTier; reason: string }>({
    symbol: '', direction: 'SHORT', tier: 'RED', reason: '',
  });

  useEffect(() => {
    loadTiers();
  }, []);

  async function loadTiers() {
    setLoading(true);
    const params = filterTier !== 'ALL' ? `?tier=${filterTier}` : '';
    fetch(API(`/api/symbol-tiers${params}`))
      .then(r => r.json())
      .then(d => {
        if (d.ok) setTiers(d.tiers || []);
      })
      .finally(() => setLoading(false));
  }

  async function setManualTier() {
    if (!newTier.symbol) return;
    const res = await fetch(API(`/api/symbol-tiers/${newTier.symbol}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction: newTier.direction,
        tier: newTier.tier,
        reason: newTier.reason,
      }),
    });
    if (res.ok) {
      setNewTier({ symbol: '', direction: 'SHORT', tier: 'RED', reason: '' });
      loadTiers();
    }
  }

  async function computeTiers() {
    if (!confirm('Compute tiers from historical data? This will overwrite auto-computed tiers.')) return;
    const res = await fetch(API('/api/symbol-tiers/compute'), { method: 'POST' });
    if (res.ok) {
      loadTiers();
    }
  }

  return (
    <section className="rounded-2xl border border-pink-500/20 bg-pink-950/20 p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs text-pink-400/80 uppercase tracking-widest">Symbol Tier Management (Step 4)</div>
        <div className="flex items-center gap-2">
          <select 
            className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            value={filterTier} 
            onChange={(e) => { setFilterTier(e.target.value as any); loadTiers(); }}
          >
            <option value="ALL">All Tiers</option>
            <option value="GREEN">Green</option>
            <option value="YELLOW">Yellow</option>
            <option value="RED">Red</option>
          </select>
          <button 
            onClick={computeTiers}
            className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 hover:bg-white/20"
          >
            Compute from History
          </button>
        </div>
      </div>

      {/* Add manual override */}
      <div className="flex flex-wrap gap-2 mb-4 p-2 rounded-lg border border-white/10 bg-white/5">
        <input 
          type="text" 
          placeholder="BTCUSDT"
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 w-28"
          value={newTier.symbol}
          onChange={(e) => setNewTier({ ...newTier, symbol: e.target.value.toUpperCase() })}
        />
        <select 
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          value={newTier.direction}
          onChange={(e) => setNewTier({ ...newTier, direction: e.target.value as any })}
        >
          <option value="SHORT">SHORT</option>
          <option value="LONG">LONG</option>
        </select>
        <select 
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          value={newTier.tier}
          onChange={(e) => setNewTier({ ...newTier, tier: e.target.value as any })}
        >
          <option value="RED">RED (Block)</option>
          <option value="YELLOW">YELLOW (Strict)</option>
          <option value="GREEN">GREEN (Normal)</option>
        </select>
        <input 
          type="text" 
          placeholder="Reason (optional)"
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10 flex-1 min-w-[100px]"
          value={newTier.reason}
          onChange={(e) => setNewTier({ ...newTier, reason: e.target.value })}
        />
        <button 
          onClick={setManualTier}
          disabled={!newTier.symbol}
          className="text-xs px-3 py-1 rounded bg-pink-500/20 text-pink-200 border border-pink-500/30 disabled:opacity-50"
        >
          Set Tier
        </button>
      </div>

      {/* Tier list */}
      {loading ? (
        <div className="text-white/50 text-xs">Loading...</div>
      ) : (
        <div className="overflow-x-auto max-h-64">
          <table className="w-full text-xs">
            <thead className="text-white/60 sticky top-0 bg-pink-950/90">
              <tr className="border-b border-white/10">
                <th className="text-left px-2 py-2">Symbol</th>
                <th className="text-left px-2 py-2">Dir</th>
                <th className="text-left px-2 py-2">Tier</th>
                <th className="text-right px-2 py-2">Win Rate</th>
                <th className="text-right px-2 py-2">Signals</th>
                <th className="text-center px-2 py-2">Type</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map(t => (
                <tr key={`${t.symbol}_${t.direction}`} className="border-b border-white/5 hover:bg-white/5">
                  <td className="px-2 py-1.5 font-medium">{t.symbol}</td>
                  <td className="px-2 py-1.5">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.direction === 'LONG' ? 'bg-emerald-400/20 text-emerald-200' : 'bg-rose-400/20 text-rose-200'}`}>
                      {t.direction}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`inline-flex px-2 py-0.5 rounded border text-[10px] ${getTierColor(t.tier)}`}>
                      {t.tier}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right">{fmtRate(t.winRate, 1)}</td>
                  <td className="px-2 py-1.5 text-right">{t.totalSignals}</td>
                  <td className="px-2 py-1.5 text-center">
                    {t.manualOverride ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-200">Manual</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50">Auto</span>
                    )}
                  </td>
                </tr>
              ))}
              {tiers.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-white/50 text-center">
                    No tiers found. Click "Compute from History" to generate.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ============================================================================
// MOMENTUM QUALITY SCORE (MQS) DISPLAY
// ============================================================================

interface MQSProps {
  mqs: number;
  size?: 'sm' | 'md' | 'lg';
}

export function MomentumQualityScore({ mqs, size = 'md' }: MQSProps) {
  const interpretation = useMemo(() => {
    if (mqs < 0.1) return { label: 'BAD', class: 'bad', color: 'text-rose-400' };
    if (mqs < 0.3) return { label: 'WEAK', class: 'weak', color: 'text-amber-400' };
    return { label: 'GOOD', class: 'good', color: 'text-emerald-400' };
  }, [mqs]);

  const sizeClasses = {
    sm: 'text-xs px-1.5 py-0.5',
    md: 'text-sm px-2 py-1',
    lg: 'text-base px-3 py-1.5',
  };

  return (
    <div className={`inline-flex items-center gap-2 rounded-lg border ${getMQSColor(interpretation.class as MQSClass)} ${sizeClasses[size]}`}>
      <span className="font-medium">MQS: {mqs.toFixed(2)}</span>
      <span className="opacity-75">({interpretation.label})</span>
    </div>
  );
}

// ============================================================================
// SIGNAL REJECTION REASONING
// ============================================================================

interface RejectionReasonProps {
  result: FilterResult;
}

export function SignalRejectionReason({ result }: RejectionReasonProps) {
  if (result.allowed) {
    return (
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400 text-lg">✓</span>
          <span className="text-emerald-200 font-medium">Accepted</span>
        </div>
        <div className="text-xs text-emerald-300/70 mt-1">{result.message}</div>
        {result.details.mqs !== undefined && (
          <div className="mt-2">
            <MomentumQualityScore mqs={result.details.mqs} size="sm" />
          </div>
        )}
        {result.details.passedChecks && (
          <div className="mt-2 flex flex-wrap gap-1">
            {result.details.passedChecks.map(check => (
              <span key={check} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200">
                {check.replace('_', ' ')}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  const rejectionColors: Record<string, string> = {
    SYMBOL_BLOCKED_RED_TIER: 'border-rose-500/30 bg-rose-500/10',
    SYMBOL_BLOCKED_YELLOW_TIER: 'border-amber-500/30 bg-amber-500/10',
    MFE30M_TOO_LOW: 'border-orange-500/30 bg-orange-500/10',
    MFE_MAE_RATIO_TOO_LOW: 'border-amber-500/30 bg-amber-500/10',
    CATEGORY_NOT_ALLOWED: 'border-gray-500/30 bg-gray-500/10',
    SPEED_REQUIREMENT_FAILED: 'border-blue-500/30 bg-blue-500/10',
  };

  const borderColor = rejectionColors[result.reason] || 'border-rose-500/30 bg-rose-500/10';

  return (
    <div className={`rounded-lg border ${borderColor} p-3`}>
      <div className="flex items-center gap-2">
        <span className="text-rose-400 text-lg">✗</span>
        <span className="text-rose-200 font-medium">Rejected</span>
      </div>
      <div className="text-xs text-rose-300/70 mt-1">{result.message}</div>
      
      {/* Details */}
      <div className="mt-2 space-y-1 text-xs">
        {result.details.tier && (
          <div className="flex justify-between">
            <span className="text-white/50">Symbol Tier:</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] ${getTierColor(result.details.tier)}`}>
              {result.details.tier}
            </span>
          </div>
        )}
        {result.details.mfe30mPct !== undefined && (
          <div className="flex justify-between">
            <span className="text-white/50">MFE 30m:</span>
            <span className={result.details.mfe30mPct < 0.3 ? 'text-rose-300' : 'text-emerald-300'}>
              {fmt(result.details.mfe30mPct, 2)}%
              {result.details.requiredMfe && ` (need ${(result.details.requiredMfe * 100).toFixed(0)}%)`}
            </span>
          </div>
        )}
        {result.details.mqs !== undefined && (
          <div className="flex justify-between items-center">
            <span className="text-white/50">MQS:</span>
            <MomentumQualityScore mqs={result.details.mqs} size="sm" />
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// FILTER TESTER (for debugging)
// ============================================================================

export function FilterTester() {
  const [signal, setSignal] = useState({
    symbol: 'BTCUSDT',
    category: 'READY_TO_SELL',
    mfe30mPct: 0.25,
    mae30mPct: 0.15,
    tp1Within45m: false,
  });
  const [result, setResult] = useState<FilterResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function testFilter() {
    setLoading(true);
    const shortCategories = ['READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT'];
    const direction = shortCategories.includes(signal.category) ? 'SHORT' : 'LONG';
    
    const res = await fetch(API('/api/filter/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signal: {
          ...signal,
          direction,
        },
      }),
    });
    const data = await res.json();
    if (data.ok) setResult(data.result);
    setLoading(false);
  }

  return (
    <section className="rounded-2xl border border-teal-500/20 bg-teal-950/20 p-4">
      <div className="text-xs text-teal-400/80 uppercase tracking-widest mb-3">Filter Tester</div>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <input 
          type="text"
          value={signal.symbol}
          onChange={(e) => setSignal({ ...signal, symbol: e.target.value.toUpperCase() })}
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          placeholder="Symbol"
        />
        <select 
          value={signal.category}
          onChange={(e) => setSignal({ ...signal, category: e.target.value })}
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
        >
          <option value="READY_TO_SELL">READY_TO_SELL</option>
          <option value="BEST_SHORT_ENTRY">BEST_SHORT_ENTRY</option>
          <option value="READY_TO_BUY">READY_TO_BUY</option>
          <option value="BEST_ENTRY">BEST_ENTRY</option>
        </select>
        <input 
          type="number"
          step="0.01"
          value={signal.mfe30mPct}
          onChange={(e) => setSignal({ ...signal, mfe30mPct: parseFloat(e.target.value) })}
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          placeholder="MFE 30m %"
        />
        <input 
          type="number"
          step="0.01"
          value={signal.mae30mPct}
          onChange={(e) => setSignal({ ...signal, mae30mPct: parseFloat(e.target.value) })}
          className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          placeholder="MAE 30m %"
        />
      </div>

      <button 
        onClick={testFilter}
        disabled={loading}
        className="text-xs px-3 py-1.5 rounded bg-teal-500/20 text-teal-200 border border-teal-500/30 disabled:opacity-50"
      >
        {loading ? 'Testing...' : 'Test Signal'}
      </button>

      {result && (
        <div className="mt-3">
          <SignalRejectionReason result={result} />
        </div>
      )}
    </section>
  );
}


// ============================================================================
// SIGNAL GATE STATS (Real-time blocking metrics)
// ============================================================================

interface GateStats {
  totalChecked: number;
  totalBlocked: number;
  blockedByRed: number;
  blockedByScore: number;
  blockedBy15m: number;
  passedHigh: number;
  passedMedium: number;
  passedLow: number;
}

export function SignalGateStats() {
  const [stats, setStats] = useState<GateStats | null>(null);
  const [config, setConfig] = useState<{ enabled: boolean } | null>(null);

  useEffect(() => {
    // Fetch both stats and config
    Promise.all([
      fetch(API('/api/gate/stats')).then(r => r.json()),
      fetch(API('/api/gate/config')).then(r => r.json()),
    ]).then(([statsRes, configRes]) => {
      if (statsRes.ok) setStats(statsRes.stats);
      if (configRes.ok) setConfig(configRes.config);
    });

    // Refresh every 10 seconds
    const interval = setInterval(() => {
      fetch(API('/api/gate/stats'))
        .then(r => r.json())
        .then(d => { if (d.ok) setStats(d.stats); });
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  if (!stats || !config) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-3">
        <div className="text-xs text-white/50">Loading gate stats...</div>
      </div>
    );
  }

  const blockedPct = stats.totalChecked > 0 
    ? (stats.totalBlocked / stats.totalChecked * 100).toFixed(1) 
    : '0.0';

  const passedTotal = stats.passedHigh + stats.passedMedium + stats.passedLow;

  return (
    <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-red-400 font-medium">Signal Gate (HARD FILTER)</div>
        <div className={`text-xs px-2 py-0.5 rounded ${config.enabled ? 'bg-emerald-500/20 text-emerald-200' : 'bg-rose-500/20 text-rose-200'}`}>
          {config.enabled ? '🔴 LIVE' : '⚪ OFF'}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-xs">
        <div className="rounded bg-white/5 p-2 text-center">
          <div className="text-white/50">Checked</div>
          <div className="text-white font-medium">{stats.totalChecked}</div>
        </div>
        <div className="rounded bg-rose-500/10 p-2 text-center">
          <div className="text-rose-300">Blocked</div>
          <div className="text-rose-200 font-medium">{stats.totalBlocked} ({blockedPct}%)</div>
        </div>
        <div className="rounded bg-emerald-500/10 p-2 text-center">
          <div className="text-emerald-300">Passed</div>
          <div className="text-emerald-200 font-medium">{passedTotal}</div>
        </div>
        <div className="rounded bg-amber-500/10 p-2 text-center">
          <div className="text-amber-300">RED Block</div>
          <div className="text-amber-200 font-medium">{stats.blockedByRed}</div>
        </div>
      </div>

      {passedTotal > 0 && (
        <div className="mt-2 text-xs">
          <div className="text-white/50 mb-1">Quality Distribution:</div>
          <div className="flex gap-2">
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-200 text-[10px]">
              HIGH: {stats.passedHigh}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-200 text-[10px]">
              MEDIUM: {stats.passedMedium}
            </span>
            <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200 text-[10px]">
              LOW: {stats.passedLow}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SIGNAL QUALITY BADGE
// ============================================================================

interface SignalQualityProps {
  quality: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECTED';
  score?: number;
  size?: 'sm' | 'md' | 'lg';
}

export function SignalQualityBadge({ quality, score, size = 'md' }: SignalQualityProps) {
  const colors = {
    HIGH: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30',
    MEDIUM: 'bg-blue-500/20 text-blue-200 border-blue-500/30',
    LOW: 'bg-amber-500/20 text-amber-200 border-amber-500/30',
    REJECTED: 'bg-rose-500/20 text-rose-200 border-rose-500/30',
  };

  const sizeClasses = {
    sm: 'text-[10px] px-1.5 py-0.5',
    md: 'text-xs px-2 py-1',
    lg: 'text-sm px-3 py-1.5',
  };

  return (
    <span className={`inline-flex items-center gap-1 rounded border ${colors[quality]} ${sizeClasses[size]}`}>
      <span className="font-medium">{quality}</span>
      {score !== undefined && <span className="opacity-75">({score}/5)</span>}
    </span>
  );
}
