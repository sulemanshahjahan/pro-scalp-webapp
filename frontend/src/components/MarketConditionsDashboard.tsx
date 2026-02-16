// frontend/src/components/MarketConditionsDashboard.tsx
// Market Conditions Dashboard - side + timeframe health metrics

import { useCallback, useEffect, useState } from 'react';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '') ||
  (import.meta.env.PROD ? 'https://pro-scalp-backend-production.up.railway.app' : '');

const API = (path: string) => API_BASE + path;

type TimeFrame = '1h' | '4h';
type MarketSide = 'long' | 'short';

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

type SidePayload = Partial<Record<TimeFrame, MarketHealthMetrics>>;

type MarketConditionsResponse = {
  ok: boolean;
  long?: SidePayload;
  short?: SidePayload;
  '1h'?: MarketHealthMetrics;
  '4h'?: MarketHealthMetrics;
  error?: string;
};

const REGIME_COLORS = {
  DORMANT: { bg: 'bg-rose-500', text: 'text-rose-100', border: 'border-rose-400', label: 'DORMANT' },
  WARMING: { bg: 'bg-amber-500', text: 'text-amber-100', border: 'border-amber-400', label: 'WARMING' },
  ACTIVE: { bg: 'bg-emerald-500', text: 'text-emerald-100', border: 'border-emerald-400', label: 'ACTIVE' },
};

function getStatusBadge(value: number): { color: string; text: string } {
  if (value >= 100) return { color: 'text-emerald-400', text: 'Excellent' };
  if (value >= 60) return { color: 'text-amber-400', text: 'Good' };
  return { color: 'text-rose-400', text: 'Poor' };
}

function ProgressBar({ value, colorClass }: { value: number; colorClass: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-white/10">
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
  details,
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
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-white/60">{title}</span>
        <span className={`text-xs ${status.color}`}>{status.text}</span>
      </div>
      <div className="text-2xl font-semibold text-white/90">{value}%</div>
      <div className="mt-2">
        <ProgressBar value={value} colorClass={barColor} />
      </div>
      <div className="mt-2 text-[10px] text-white/40">{threshold}</div>
      {details ? <div className="mt-1 text-[10px] text-white/30">{details}</div> : null}
    </div>
  );
}

function ReadinessScore({ score, regime }: { score: number; regime: 'DORMANT' | 'WARMING' | 'ACTIVE' }) {
  const regimeConfig = REGIME_COLORS[regime];
  const circumference = 2 * Math.PI * 45;
  const strokeDashoffset = circumference - (score / 100) * circumference;

  return (
    <div className="flex flex-col items-center justify-center p-4">
      <div className="relative h-32 w-32">
        <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100">
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="8"
          />
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
      <div className={`mt-3 rounded-full border px-4 py-1.5 text-sm font-medium ${regimeConfig.border} ${regimeConfig.bg}/20 ${regimeConfig.text}`}>
        {regimeConfig.label}
      </div>
    </div>
  );
}

function SmartInsights({
  side,
  blockingGate,
  metrics,
}: {
  side: MarketSide;
  blockingGate: string | null;
  metrics: MarketHealthMetrics;
}) {
  const insights: string[] = [];

  if (blockingGate) {
    insights.push(`${blockingGate} is currently the main bottleneck.`);
  }
  if (metrics.volatilityHealth < 60) {
    insights.push(`Volatility health is low (${metrics.volatilityHealth}%).`);
  }
  if (metrics.volumeHealth < 60) {
    insights.push(
      side === 'long'
        ? `Volume spikes are scarce (${metrics.volumeHealth}%). Consider easing long volume gates.`
        : `Volume spikes are scarce (${metrics.volumeHealth}%). Consider easing short volume gates.`
    );
  }
  if (metrics.vwapHealth < 60) {
    insights.push(
      side === 'long'
        ? `Price/VWAP alignment is weak (${metrics.vwapHealth}%). Consider widening READY_VWAP_MAX_PCT.`
        : `Price/VWAP alignment is weak (${metrics.vwapHealth}%). Consider widening SHORT_VWAP_MAX_PCT.`
    );
  }
  if (metrics.trendHealth < 60) {
    insights.push(
      side === 'long'
        ? `Bullish 15m confirmation rate is weak (${metrics.trendHealth}%).`
        : `Bearish 15m confirmation rate is weak (${metrics.trendHealth}%).`
    );
  }
  if (insights.length === 0) {
    insights.push('All core gates look healthy for this side.');
  }

  insights.push(`Based on ${metrics.scanCount} scans, ${metrics.details.evaluated} candidates were evaluated.`);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="mb-2 text-xs uppercase tracking-widest text-white/60">Smart Insights</div>
      <div className="space-y-2">
        {insights.map((insight, idx) => (
          <div key={idx} className="text-xs text-white/80">
            {insight}
          </div>
        ))}
      </div>
    </div>
  );
}

function normalizeByTimeframe(payload: SidePayload | undefined): SidePayload {
  return {
    '1h': payload?.['1h'],
    '4h': payload?.['4h'],
  };
}

export default function MarketConditionsDashboard() {
  const [activeSide, setActiveSide] = useState<MarketSide>('long');
  const [activeTimeframe, setActiveTimeframe] = useState<TimeFrame>('1h');
  const [data, setData] = useState<Record<MarketSide, SidePayload>>({
    long: {},
    short: {},
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const resp = await fetch(API('/api/market/conditions'));
      const json = await resp.json() as MarketConditionsResponse;

      if (json.ok === false) {
        setError(json.error || 'Failed to fetch');
        return;
      }

      const longPayload = normalizeByTimeframe(
        json.long ?? { '1h': json['1h'], '4h': json['4h'] }
      );
      const shortPayload = normalizeByTimeframe(json.short ?? {});

      setData({
        long: longPayload,
        short: shortPayload,
      });
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Network error');
    } finally {
      setLoading(false);
      setLastRefresh(Date.now());
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const current = data[activeSide]?.[activeTimeframe];

  if (loading && !current) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex h-40 items-center justify-center">
          <span className="text-white/60">Loading market conditions...</span>
        </div>
      </div>
    );
  }

  if (error && !current) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="text-sm text-rose-400">Error: {error}</div>
        <button
          onClick={fetchData}
          className="mt-2 rounded bg-white/10 px-3 py-1 text-xs text-white/80 hover:bg-white/20"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="text-sm text-white/60">
          No {activeSide} market-condition data yet for {activeTimeframe}. Run a fresh scan to populate this tab.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-slate-900/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Market Conditions</h2>
          <p className="text-xs text-white/50">Real-time scalp readiness metrics by side and timeframe</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-white/10 bg-white/5 p-1">
            {(['long', 'short'] as MarketSide[]).map((side) => (
              <button
                key={side}
                onClick={() => setActiveSide(side)}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  activeSide === side
                    ? side === 'long'
                      ? 'border border-cyan-500/30 bg-cyan-500/20 text-cyan-100'
                      : 'border border-rose-500/30 bg-rose-500/20 text-rose-100'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                {side === 'long' ? 'Long' : 'Short'}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border border-white/10 bg-white/5 p-1">
            {(['1h', '4h'] as TimeFrame[]).map((tf) => (
              <button
                key={tf}
                onClick={() => setActiveTimeframe(tf)}
                className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                  activeTimeframe === tf
                    ? 'border border-cyan-500/30 bg-cyan-500/20 text-cyan-100'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                {tf === '1h' ? '1H' : '4H'}
              </button>
            ))}
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-sm text-white/60 hover:text-white disabled:opacity-50"
            title="Refresh"
          >
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="text-white/50">Last updated:</span>
          <span className="text-white/70">
            {new Date(current.lastUpdated || lastRefresh).toLocaleTimeString()}
          </span>
          <span className="text-white/40">({current.scanCount} scans analyzed)</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="grid grid-cols-2 gap-3 lg:col-span-2">
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
            details={`${current.details.failedVolSpike} volume failures`}
          />
          <MetricCard
            title="Trend Health"
            value={current.trendHealth}
            threshold="confirm15_pass / processedSymbols"
            details={`${current.details.confirm15Pass} passed / ${current.details.processedSymbols} symbols`}
          />
          <MetricCard
            title="VWAP Health"
            value={current.vwapHealth}
            threshold="nearVWAP / processedSymbols"
            details={`${current.details.nearVwapReady} near VWAP`}
          />
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5">
          <ReadinessScore score={current.readinessScore} regime={current.regime} />
        </div>
      </div>

      <SmartInsights side={activeSide} blockingGate={current.blockingGate} metrics={current} />

      <details className="text-xs">
        <summary className="cursor-pointer text-white/40 hover:text-white/60">
          Raw Metrics
        </summary>
        <pre className="mt-2 overflow-auto rounded bg-black/30 p-2 text-white/50">
          {JSON.stringify({
            side: activeSide,
            timeframe: activeTimeframe,
            metrics: current,
          }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
