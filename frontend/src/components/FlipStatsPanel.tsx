import { useEffect, useState } from 'react';
import { apiUrl as API } from '../config/apiBase';

interface FlipStatsResponse {
  ok: boolean;
  window?: { fromMs: number | null; toMs: number | null };
  totals?: {
    totalPaper: number;
    totalExecuted: number;
    totalPaired: number;
    missingPaper: number;
    missingExecuted: number;
  };
  flips?: {
    flipWinToLoss: number;
    missedWinners: number;
    savedLosses: number;
    flipLossToWin: number;
  };
  rates?: {
    flipWinToLossPct: number;
    missedWinnersPct: number;
    savedLossesPct: number;
    flipLossToWinPct: number;
  };
  summary?: {
    netWinnersAvoided: number;
    netLossesAvoided: number;
    executionCost: number;
  };
  error?: string;
}

interface FlipStatsPanelProps {
  fromMs: number;
  toMs: number;
}

export function FlipStatsPanel({ fromMs, toMs }: FlipStatsPanelProps) {
  const [data, setData] = useState<FlipStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(API(`/api/extended-outcomes/flip-stats?fromMs=${fromMs}&toMs=${toMs}`))
      .then((r) => r.json())
      .then((data: FlipStatsResponse) => {
        if (cancelled) return;
        if (data?.ok) {
          setData(data);
        } else {
          setError(data?.error || 'Failed to load flip stats');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || 'Network error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fromMs, toMs]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 animate-pulse">
        <div className="h-4 bg-white/10 rounded w-1/3 mb-4" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 bg-white/5 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-xs text-white/40">Execution vs Signal Impact</div>
        <div className="text-sm text-amber-300/80 mt-1">{error}</div>
      </div>
    );
  }

  const totals = data?.totals;
  const flips = data?.flips;
  const summary = data?.summary;
  const rates = data?.rates;

  if (!totals || !flips || totals.totalPaired === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-xs text-white/40">Execution vs Signal Impact</div>
        <div className="text-sm text-white/60 mt-1">
          No paired PAPER/EXECUTED data available. Run backfill to generate PAPER outcomes for comparison.
        </div>
      </div>
    );
  }

  const executionCost = summary?.executionCost ?? 0;
  const isPositive = executionCost < 0; // Negative execution cost is good (saved more than lost)
  const isNeutral = Math.abs(executionCost) < 0.01;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xs text-white/60 uppercase tracking-widest">Execution vs Signal Impact</div>
          <div className="text-[10px] text-white/40 mt-0.5">
            Comparing {totals.totalPaired} paired signals (PAPER vs EXECUTED)
          </div>
        </div>
        <div
          className={[
            'px-3 py-1.5 rounded-xl text-sm font-semibold',
            isNeutral
              ? 'bg-gray-500/20 text-gray-300'
              : isPositive
              ? 'bg-emerald-500/20 text-emerald-300'
              : 'bg-rose-500/20 text-rose-300',
          ].join(' ')}
          title="Net execution impact: (Win→Loss + Missed Winners - Saved Losses - Loss→Win) / Total Paired"
        >
          {executionCost > 0 ? '+' : ''}
          {(executionCost * 100).toFixed(1)}% net
        </div>
      </div>

      {/* Flip breakdown */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-rose-300">Win → Loss</span>
            {rates && (
              <span className="text-[10px] text-rose-300/60">{(rates.flipWinToLossPct * 100).toFixed(1)}%</span>
            )}
          </div>
          <div className="text-lg font-semibold text-rose-200">{flips.flipWinToLoss}</div>
          <div className="text-[10px] text-rose-300/60">Delayed entry hurt</div>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-emerald-300">Saved Losses</span>
            {rates && (
              <span className="text-[10px] text-emerald-300/60">{(rates.savedLossesPct * 100).toFixed(1)}%</span>
            )}
          </div>
          <div className="text-lg font-semibold text-emerald-200">{flips.savedLosses}</div>
          <div className="text-[10px] text-emerald-300/60">Avoided bad trades</div>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-amber-300">Missed Winners</span>
            {rates && (
              <span className="text-[10px] text-amber-300/60">{(rates.missedWinnersPct * 100).toFixed(1)}%</span>
            )}
          </div>
          <div className="text-lg font-semibold text-amber-200">{flips.missedWinners}</div>
          <div className="text-[10px] text-amber-300/60">Never confirmed</div>
        </div>
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-cyan-300">Loss → Win</span>
            {rates && (
              <span className="text-[10px] text-cyan-300/60">{(rates.flipLossToWinPct * 100).toFixed(1)}%</span>
            )}
          </div>
          <div className="text-lg font-semibold text-cyan-200">{flips.flipLossToWin}</div>
          <div className="text-[10px] text-cyan-300/60">Delayed entry helped</div>
        </div>
      </div>

      {/* Summary stats */}
      {(summary?.netWinnersAvoided || summary?.netLossesAvoided) && (
        <div className="mt-4 pt-3 border-t border-white/10 grid grid-cols-2 gap-3">
          <div className="text-xs">
            <span className="text-white/50">Net winners avoided:</span>{' '}
            <span className="font-medium text-rose-300">{summary?.netWinnersAvoided ?? 0}</span>
            <span className="text-white/40 ml-1">(W→L + Missed)</span>
          </div>
          <div className="text-xs">
            <span className="text-white/50">Net losses avoided:</span>{' '}
            <span className="font-medium text-emerald-300">{summary?.netLossesAvoided ?? 0}</span>
          </div>
        </div>
      )}

      {/* Data availability note */}
      {(totals.missingPaper > 0 || totals.missingExecuted > 0) && (
        <div className="mt-3 text-[10px] text-amber-300/60">
          ⚠ Missing data: {totals.missingPaper} missing PAPER, {totals.missingExecuted} missing EXECUTED.{' '}
          Run backfill to generate missing PAPER outcomes.
        </div>
      )}

      {/* Interpretation hint */}
      <div className="mt-3 text-[10px] text-white/40 flex items-start gap-2">
        <span className="text-white/60">ℹ</span>
        <span>
          <strong className="text-white/60">Execution cost</strong> measures whether delayed entry helps or hurts.
          Negative is good (saved losses outweigh missed winners). Positive means too many good trades are being
          filtered out.
        </span>
      </div>
    </div>
  );
}
