// frontend/src/components/MarketConditionsDashboard.tsx
// Market Conditions Dashboard - dual timeframe health metrics

import { useEffect, useState, useCallback } from 'react';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '') || 
  (import.meta.env.PROD ? 'https://pro-scalp-backend-production.up.railway.app' : '');

const API = (path: string) => API_BASE + path;

type MarketHealthMetrics = {
  volatilityHealth: number;
  volumeHealth: number;
  trendHealth: number;
  vwapHealth: number;
  readinessScore: number;
  regime: 'DORMANT' | 'WARMING' | 'ACTIVE';
  blockingGate: string | null;
  scanCount: number;
  lastUpdated: number;
  details: {
    failedAtr: number;
    evaluated: number;
    failedVolSpike: number;
    confirm15Pass: number;
    processedSymbols: number;
    nearVwapReady: number;
  };
};

type TimeFrame = '1h' | '4h';

const REGIME_COLORS = {
  DORMANT: { bg: 'bg-rose-500', text: 'text-rose-100', border: 'border-rose-400', label: '🔴 DORMANT' },
  WARMING: { bg: 'bg-amber-500', text: 'text-amber-100', border: 'border-amber-400', label: '🟡 WARMING' },
  ACTIVE: { bg: 'bg-emerald-500', text: 'text-emerald-100', border: 'border-emerald-400', label: '🟢 ACTIVE' },
};

function getStatusBadge(value: number): { emoji: string; color: string; text: string } {
  if (value >= 100) return { emoji: '🟢', color: 'text-emerald-400', text: 'Excellent' };
  if (value >= 60) return { emoji: '🟡', color: 'text-amber-400', text: 'Good' };
  return { emoji: '🔴', color: 'text-rose-400', text: 'Poor' };
}

function ProgressBar({ value, colorClass }: { value: number; colorClass: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
      <div 
        className={`h-full ${colorClass} transition-all duration-500`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function MetricCard({ 
  title, 
  value, 
  threshold,
  details 
}: { 
  title: string; 
  value: number; 
  threshold: string;
  details?: string;
}) {
  const status = getStatusBadge(value);
  const barColor = value >= 60 ? 'bg-emerald-400/70' : value >= 40 ? 'bg-amber-400/70' : 'bg-rose-400/70';
  
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/60">{title}</span>
        <span className={`text-xs ${status.color}`}>{status.emoji} {status.text}</span>
      </div>
      <div className="text-2xl font-semibold text-white/90">{value}%</div>
      <div className="mt-2">
        <ProgressBar value={value} colorClass={barColor} />
      </div>
      <div className="mt-2 text-[10px] text-white/40">{threshold}</div>
      {details && <div className="mt-1 text-[10px] text-white/30">{details}</div>}
    </div>
  );
}

function ReadinessScore({ score, regime }: { score: number; regime: 'DORMANT' | 'WARMING' | 'ACTIVE' }) {
  const regimeConfig = REGIME_COLORS[regime];
  const circumference = 2 * Math.PI * 45;
  const strokeDashoffset = circumference - (score / 100) * circumference;
  
  return (
    <div className="flex flex-col items-center justify-center p-4">
      <div className="relative w-32 h-32">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          {/* Background circle */}
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="8"
          />
          {/* Progress circle */}
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className={`${regimeConfig.text} transition-all duration-700`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold text-white">{score}</span>
          <span className="text-[10px] text-white/50">/100</span>
        </div>
      </div>
      <div className={`mt-3 px-4 py-1.5 rounded-full border ${regimeConfig.border} ${regimeConfig.bg}/20 ${regimeConfig.text} text-sm font-medium`}>
        {regimeConfig.label}
      </div>
    </div>
  );
}

function SmartInsights({ 
  blockingGate, 
  metrics 
}: { 
  blockingGate: string | null; 
  metrics: MarketHealthMetrics;
}) {
  const insights: string[] = [];
  
  if (blockingGate) {
    insights.push(`🔧 <strong>${blockingGate}</strong> is your current bottleneck. Consider adjusting thresholds.`);
  }
  
  if (metrics.volatilityHealth < 60) {
    insights.push(`📊 Volatility is low (${metrics.volatilityHealth}%). Fewer ATR-based stops being hit.`);
  }
  
  if (metrics.volumeHealth < 60) {
    insights.push(`📈 Volume spikes are rare (${metrics.volumeHealth}%). Lower THRESHOLD_VOL_SPIKE_X to see more signals.`);
  }
  
  if (metrics.vwapHealth < 60) {
    insights.push(`🎯 Price is far from VWAP (${metrics.vwapHealth}%). Widen READY_VWAP_MAX_PCT for more entries.`);
  }
  
  if (metrics.trendHealth < 60) {
    insights.push(`📉 15m trend alignment is weak (${metrics.trendHealth}%). Consider soft confirm relaxation.`);
  }
  
  if (insights.length === 0) {
    insights.push('✅ All systems green. Market conditions are favorable for scalping.');
  }
  
  // Add scan stats
  insights.push(`📡 Based on ${metrics.scanCount} scans, ${metrics.details.evaluated} candidates evaluated.`);
  
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="text-xs text-white/60 uppercase tracking-widest mb-2">Smart Insights</div>
      <div className="space-y-2">
        {insights.map((insight, idx) => (
          <div 
            key={idx} 
            className="text-xs text-white/80"
            dangerouslySetInnerHTML={{ __html: insight }}
          />
        ))}
      </div>
    </div>
  );
}

export default function MarketConditionsDashboard() {
  const [activeTimeframe, setActiveTimeframe] = useState<TimeFrame>('1h');
  const [data, setData] = useState<{ '1h'?: MarketHealthMetrics; '4h'?: MarketHealthMetrics }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const resp = await fetch(API('/api/market/conditions'));
      const json = await resp.json();
      
      if (json.ok === false) {
        setError(json.error || 'Failed to fetch');
      } else {
        setData({ '1h': json['1h'], '4h': json['4h'] });
        setError(null);
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
      setLastRefresh(Date.now());
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const current = data[activeTimeframe];

  if (loading && !current) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center justify-center h-40">
          <span className="text-white/60">Loading market conditions...</span>
        </div>
      </div>
    );
  }

  if (error && !current) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="text-rose-400 text-sm">Error: {error}</div>
        <button 
          onClick={fetchData}
          className="mt-2 px-3 py-1 rounded bg-white/10 text-xs text-white/80 hover:bg-white/20"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="text-white/60 text-sm">No scan data available yet.</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/50 p-4 space-y-4">
      {/* Header with Timeframe Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Market Conditions</h2>
          <p className="text-xs text-white/50">Real-time scalp readiness metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-white/10 bg-white/5 p-1">
            {(['1h', '4h'] as TimeFrame[]).map((tf) => (
              <button
                key={tf}
                onClick={() => setActiveTimeframe(tf)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  activeTimeframe === tf 
                    ? 'bg-cyan-500/20 text-cyan-100 border border-cyan-500/30' 
                    : 'text-white/60 hover:text-white'
                }`}
              >
                {tf === '1h' ? '1H (Immediate)' : '4H (Primary)'}
              </button>
            ))}
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-2 rounded-lg border border-white/10 bg-white/5 text-white/60 hover:text-white disabled:opacity-50"
            title="Refresh"
          >
            {loading ? '⟳' : '↻'}
          </button>
        </div>
      </div>

      {/* Regime Badge & Last Updated */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="text-white/50">Last updated:</span>
          <span className="text-white/70">
            {new Date(lastRefresh).toLocaleTimeString()}
          </span>
          <span className="text-white/40">({current.scanCount} scans analyzed)</span>
        </div>
      </div>

      {/* Main Dashboard Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: Metric Cards (2x2) */}
        <div className="lg:col-span-2 grid grid-cols-2 gap-3">
          <MetricCard
            title="Volatility Health"
            value={current.volatilityHealth}
            threshold="1 - (failed_atr / evaluated)"
            details={`${current.details.failedAtr} ATR failures / ${current.details.evaluated} evaluated`}
          />
          <MetricCard
            title="Volume Health"
            value={current.volumeHealth}
            threshold="1 - (failed_volSpike / evaluated)"
            details={`${current.details.failedVolSpike} vol failures`}
          />
          <MetricCard
            title="Trend Health"
            value={current.trendHealth}
            threshold="(confirm15_pass) / processedSymbols"
            details={`${current.details.confirm15Pass} passed / ${current.details.processedSymbols} symbols`}
          />
          <MetricCard
            title="VWAP Health"
            value={current.vwapHealth}
            threshold="nearVwapReady / processedSymbols"
            details={`${current.details.nearVwapReady} near VWAP`}
          />
        </div>

        {/* Right: Readiness Score */}
        <div className="rounded-xl border border-white/10 bg-white/5">
          <ReadinessScore score={current.readinessScore} regime={current.regime} />
        </div>
      </div>

      {/* Smart Insights */}
      <SmartInsights blockingGate={current.blockingGate} metrics={current} />

      {/* Raw Data Toggle (for debugging) */}
      <details className="text-xs">
        <summary className="cursor-pointer text-white/40 hover:text-white/60">
          Raw Metrics
        </summary>
        <pre className="mt-2 p-2 rounded bg-black/30 text-white/50 overflow-auto">
          {JSON.stringify(current, null, 2)}
        </pre>
      </details>
    </div>
  );
}
