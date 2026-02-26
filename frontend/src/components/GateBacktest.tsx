/**
 * Gate Backtest - Compare filter configurations
 * 
 * Allows users to:
 * 1. Adjust thresholds (MFE, MQS)
 * 2. Set minimum score (2, 3, 4, 5)
 * 3. Toggle RED symbol blocking
 * 4. Run backtest on last N signals
 * 5. Compare results side-by-side
 */

import { useEffect, useMemo, useState } from 'react';
import { apiUrl as API } from '../config/apiBase';

// ============================================================================
// TYPES
// ============================================================================

interface GateConfig {
  enabled: boolean;
  blockRedTier: boolean;
  minMfe30mPct: number;
  yellowMinMfe30mPct: number;
  redMinMfe30mPct: number;
  minMqs: number;
  useCombinedScore: boolean;
  minCombinedScore: number;
  require15mConfirmation: boolean;
  minMfe15mPct: number;
  allowEarlyReady: boolean;
  name?: string;
}

interface BacktestResult {
  config: GateConfig;
  summary: {
    totalSignals: number;
    allowed: number;
    blocked: number;
    reductionPct: number;
    targetMet: boolean;
  };
  performance: {
    wins: number;
    losses: number;
    be: number;
    pending: number;
    winRate: number;
    totalR: number;
    avgR: number;
    medianR: number;
  };
  quality: {
    high: number;
    medium: number;
    low: number;
  };
  blockedReasons: Record<string, number>;
  tierBreakdown: Record<string, { total: number; allowed: number; blocked: number }>;
}

// ============================================================================
// PRESET CONFIGURATIONS
// ============================================================================

const PRESETS: Record<string, GateConfig> = {
  current: {
    name: 'Current (Default)',
    enabled: true,
    blockRedTier: true,
    minMfe30mPct: 0.30,
    yellowMinMfe30mPct: 0.50,
    redMinMfe30mPct: 0.50,
    minMqs: 0.20,
    useCombinedScore: true,
    minCombinedScore: 2,
    require15mConfirmation: false,
    minMfe15mPct: 0.20,
    allowEarlyReady: false,
  },
  strictScore3: {
    name: 'Strict - Score >= 3',
    enabled: true,
    blockRedTier: true,
    minMfe30mPct: 0.30,
    yellowMinMfe30mPct: 0.50,
    redMinMfe30mPct: 0.50,
    minMqs: 0.20,
    useCombinedScore: true,
    minCombinedScore: 3,
    require15mConfirmation: false,
    minMfe15mPct: 0.20,
    allowEarlyReady: false,
  },
  highMfe: {
    name: 'High MFE (0.5%)',
    enabled: true,
    blockRedTier: true,
    minMfe30mPct: 0.50,
    yellowMinMfe30mPct: 0.70,
    redMinMfe30mPct: 0.90,
    minMqs: 0.30,
    useCombinedScore: true,
    minCombinedScore: 2,
    require15mConfirmation: false,
    minMfe15mPct: 0.20,
    allowEarlyReady: false,
  },
  blockRedOnly: {
    name: 'Block RED Only',
    enabled: true,
    blockRedTier: true,
    minMfe30mPct: 0.20,
    yellowMinMfe30mPct: 0.30,
    redMinMfe30mPct: 0.40,
    minMqs: 0.10,
    useCombinedScore: false,
    minCombinedScore: 1,
    require15mConfirmation: false,
    minMfe15mPct: 0.20,
    allowEarlyReady: true,
  },
  aggressive: {
    name: 'Very Aggressive',
    enabled: true,
    blockRedTier: true,
    minMfe30mPct: 0.60,
    yellowMinMfe30mPct: 0.80,
    redMinMfe30mPct: 1.00,
    minMqs: 0.40,
    useCombinedScore: true,
    minCombinedScore: 3,
    require15mConfirmation: true,
    minMfe15mPct: 0.30,
    allowEarlyReady: false,
  },
};

// ============================================================================
// MAIN COMPONENT - Backtest Comparison
// ============================================================================

export function GateBacktestComparison() {
  const [configs, setConfigs] = useState<GateConfig[]>([
    { ...PRESETS.current },
    { ...PRESETS.strictScore3 },
    { ...PRESETS.highMfe },
  ]);
  const [results, setResults] = useState<BacktestResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [limit, setLimit] = useState(200);
  const [customConfig, setCustomConfig] = useState<GateConfig & { name: string }>({
    name: 'Custom',
    enabled: true,
    blockRedTier: true,
    minMfe30mPct: 0.30,
    yellowMinMfe30mPct: 0.50,
    redMinMfe30mPct: 0.50,
    minMqs: 0.20,
    useCombinedScore: true,
    minCombinedScore: 2,
    require15mConfirmation: false,
    minMfe15mPct: 0.20,
    allowEarlyReady: false,
  });

  const addPreset = (key: keyof typeof PRESETS) => {
    const preset = PRESETS[key];
    if (!configs.find(c => c.name === preset.name)) {
      setConfigs([...configs, { ...preset }]);
    }
  };

  const removeConfig = (index: number) => {
    setConfigs(configs.filter((_, i) => i !== index));
    if (activeTab >= index && activeTab > 0) {
      setActiveTab(activeTab - 1);
    }
  };

  const runBacktest = async () => {
    setLoading(true);
    try {
      const res = await fetch(API('/api/gate/backtest/compare'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configs, limit }),
      });
      const data = await res.json();
      if (data.ok) {
        setResults(data.results);
        setActiveTab(0);
      }
    } finally {
      setLoading(false);
    }
  };

  const addCustomConfig = () => {
    if (!configs.find(c => c.name === customConfig.name)) {
      setConfigs([...configs, { ...customConfig }]);
    }
  };

  return (
    <div className="rounded-lg border border-cyan-500/20 bg-slate-900/50 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-cyan-300">Gate Backtest Comparison</h3>
        <div className="flex items-center gap-2">
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700"
          >
            <option value={50}>Last 50 signals</option>
            <option value={100}>Last 100 signals</option>
            <option value={200}>Last 200 signals</option>
            <option value={500}>Last 500 signals</option>
          </select>
          <button
            onClick={runBacktest}
            disabled={loading || configs.length === 0}
            className="px-3 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 rounded"
          >
            {loading ? 'Running...' : 'Run Backtest'}
          </button>
        </div>
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-2 mb-3">
        <span className="text-xs text-white/50">Add preset:</span>
        {Object.entries(PRESETS).map(([key, preset]) => (
          <button
            key={key}
            onClick={() => addPreset(key as keyof typeof PRESETS)}
            className="text-xs px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700"
          >
            +{preset.name}
          </button>
        ))}
        <button
          onClick={addCustomConfig}
          className="text-xs px-2 py-0.5 rounded bg-emerald-900/50 hover:bg-emerald-900 border border-emerald-800"
        >
          +Custom
        </button>
      </div>

      {/* Config Tabs */}
      {configs.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {configs.map((config, i) => (
            <button
              key={i}
              onClick={() => setActiveTab(i)}
              className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
                activeTab === i
                  ? 'bg-cyan-600 text-white'
                  : 'bg-slate-800 text-white/70 hover:bg-slate-700'
              }`}
            >
              {config.name}
              <span
                onClick={(e) => { e.stopPropagation(); removeConfig(i); }}
                className="text-white/50 hover:text-white cursor-pointer"
              >
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Custom Config Editor */}
      <div className="mb-4 p-3 rounded bg-slate-800/50 border border-slate-700">
        <div className="text-xs font-medium text-cyan-300 mb-2">Custom Configuration</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
          <input
            type="text"
            placeholder="Config name"
            value={customConfig.name}
            onChange={(e) => setCustomConfig({ ...customConfig, name: e.target.value })}
            className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={customConfig.blockRedTier}
              onChange={(e) => setCustomConfig({ ...customConfig, blockRedTier: e.target.checked })}
            />
            Block RED
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={customConfig.useCombinedScore}
              onChange={(e) => setCustomConfig({ ...customConfig, useCombinedScore: e.target.checked })}
            />
            Use Score
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={customConfig.allowEarlyReady}
              onChange={(e) => setCustomConfig({ ...customConfig, allowEarlyReady: e.target.checked })}
            />
            Allow Early Ready
          </label>
          <select
            value={customConfig.minCombinedScore}
            onChange={(e) => setCustomConfig({ ...customConfig, minCombinedScore: Number(e.target.value) })}
            className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          >
            <option value={1}>Score ≥ 1</option>
            <option value={2}>Score ≥ 2</option>
            <option value={3}>Score ≥ 3</option>
            <option value={4}>Score ≥ 4</option>
            <option value={5}>Score ≥ 5</option>
          </select>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>
            <label className="text-[10px] text-white/50">Min MFE30m %</label>
            <input
              type="number"
              step="0.05"
              value={customConfig.minMfe30mPct}
              onChange={(e) => setCustomConfig({ ...customConfig, minMfe30mPct: Number(e.target.value) })}
              className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            />
          </div>
          <div>
            <label className="text-[10px] text-white/50">Min MQS</label>
            <input
              type="number"
              step="0.05"
              value={customConfig.minMqs}
              onChange={(e) => setCustomConfig({ ...customConfig, minMqs: Number(e.target.value) })}
              className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            />
          </div>
          <div>
            <label className="text-[10px] text-white/50">RED Min MFE %</label>
            <input
              type="number"
              step="0.05"
              value={customConfig.redMinMfe30mPct}
              onChange={(e) => setCustomConfig({ ...customConfig, redMinMfe30mPct: Number(e.target.value) })}
              className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            />
          </div>
          <div>
            <label className="text-[10px] text-white/50">YELLOW Min MFE %</label>
            <input
              type="number"
              step="0.05"
              value={customConfig.yellowMinMfe30mPct}
              onChange={(e) => setCustomConfig({ ...customConfig, yellowMinMfe30mPct: Number(e.target.value) })}
              className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            />
          </div>
        </div>
      </div>

      {/* Results Table */}
      {results && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white/50 border-b border-white/10">
                <th className="text-left py-2">Config</th>
                <th className="text-right py-2">Kept</th>
                <th className="text-right py-2">Blocked</th>
                <th className="text-right py-2">Win Rate</th>
                <th className="text-right py-2">Total R</th>
                <th className="text-right py-2">Avg R</th>
                <th className="text-right py-2">Median R</th>
                <th className="text-center py-2">Quality</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr
                  key={i}
                  onClick={() => setActiveTab(i)}
                  className={`border-b border-white/5 cursor-pointer hover:bg-white/5 ${
                    activeTab === i ? 'bg-cyan-500/10' : ''
                  }`}
                >
                  <td className="py-2 font-medium">{r.config.name}</td>
                  <td className="text-right py-2">
                    {r.summary.allowed}
                    <span className="text-white/50">({(100 - r.summary.reductionPct).toFixed(0)}%)</span>
                  </td>
                  <td className="text-right py-2 text-rose-300">
                    {r.summary.blocked}
                    <span className="text-white/50">({r.summary.reductionPct.toFixed(0)}%)</span>
                  </td>
                  <td className="text-right py-2">
                    <span className={r.performance.winRate >= 0.5 ? 'text-emerald-300' : 'text-amber-300'}>
                      {(r.performance.winRate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="text-right py-2 font-medium">
                    <span className={r.performance.totalR >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                      {r.performance.totalR >= 0 ? '+' : ''}{r.performance.totalR.toFixed(2)}R
                    </span>
                  </td>
                  <td className="text-right py-2 text-white/70">
                    {r.performance.avgR >= 0 ? '+' : ''}{r.performance.avgR.toFixed(2)}R
                  </td>
                  <td className="text-right py-2 text-white/70">
                    {r.performance.medianR >= 0 ? '+' : ''}{r.performance.medianR.toFixed(2)}R
                  </td>
                  <td className="text-center py-2">
                    <div className="flex justify-center gap-1">
                      {r.quality.high > 0 && (
                        <span className="px-1 rounded bg-emerald-500/20 text-emerald-300">{r.quality.high}</span>
                      )}
                      {r.quality.medium > 0 && (
                        <span className="px-1 rounded bg-blue-500/20 text-blue-300">{r.quality.medium}</span>
                      )}
                      {r.quality.low > 0 && (
                        <span className="px-1 rounded bg-amber-500/20 text-amber-300">{r.quality.low}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Active Config Details */}
          {results[activeTab] && (
            <div className="p-3 rounded-lg border border-white/10 bg-white/5">
              <div className="text-xs font-medium text-cyan-300 mb-2">
                Details: {results[activeTab].config.name}
              </div>
              
              {/* Config Summary */}
              <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3 text-xs">
                <div className="rounded bg-white/5 p-2">
                  <div className="text-white/50">Block RED</div>
                  <div className={results[activeTab].config.blockRedTier ? 'text-emerald-300' : 'text-amber-300'}>
                    {results[activeTab].config.blockRedTier ? 'YES' : 'NO'}
                  </div>
                </div>
                <div className="rounded bg-white/5 p-2">
                  <div className="text-white/50">Min MFE30m</div>
                  <div className="text-white/80">{(results[activeTab].config.minMfe30mPct * 100).toFixed(0)}%</div>
                </div>
                <div className="rounded bg-white/5 p-2">
                  <div className="text-white/50">Min MQS</div>
                  <div className="text-white/80">{results[activeTab].config.minMqs}</div>
                </div>
                <div className="rounded bg-white/5 p-2">
                  <div className="text-white/50">Min Score</div>
                  <div className="text-white/80">{results[activeTab].config.minCombinedScore}</div>
                </div>
                <div className="rounded bg-white/5 p-2">
                  <div className="text-white/50">Early Ready</div>
                  <div className={results[activeTab].config.allowEarlyReady ? 'text-amber-300' : 'text-emerald-300'}>
                    {results[activeTab].config.allowEarlyReady ? 'ALLOWED' : 'BLOCKED'}
                  </div>
                </div>
              </div>

              {/* Blocked Reasons */}
              <div className="text-xs">
                <div className="text-white/50 mb-1">Blocked Reasons:</div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(results[activeTab].blockedReasons).map(([reason, count]) => (
                    <span key={reason} className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300">
                      {reason}: {count}
                    </span>
                  ))}
                </div>
              </div>

              {/* Tier Breakdown */}
              {Object.keys(results[activeTab].tierBreakdown).length > 0 && (
                <div className="mt-3 text-xs">
                  <div className="text-white/50 mb-1">By Tier:</div>
                  <div className="grid grid-cols-3 gap-2">
                    {Object.entries(results[activeTab].tierBreakdown).map(([tier, stats]) => (
                      <div key={tier} className="rounded bg-white/5 p-2">
                        <div className={`font-medium ${
                          tier === 'GREEN' ? 'text-emerald-300' :
                          tier === 'YELLOW' ? 'text-amber-300' :
                          'text-rose-300'
                        }`}>
                          {tier}
                        </div>
                        <div className="text-white/70">
                          {stats.allowed}/{stats.total} passed ({((stats.allowed/stats.total)*100).toFixed(0)}%)
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// QUICK TEST COMPONENT
// ============================================================================

export function GateQuickSettings() {
  const [settings, setSettings] = useState({
    mfe30m: 0.30,
    mqs: 0.20,
    minScore: 2,
    blockRed: true,
  });
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);

  const runTest = async () => {
    setLoading(true);
    const config: GateConfig = {
      enabled: true,
      blockRedTier: settings.blockRed,
      minMfe30mPct: settings.mfe30m,
      yellowMinMfe30mPct: 0.50,
      redMinMfe30mPct: 0.50,
      minMqs: settings.mqs,
      useCombinedScore: true,
      minCombinedScore: settings.minScore,
      require15mConfirmation: false,
      minMfe15mPct: 0.20,
      allowEarlyReady: false,
    };

    try {
      const res = await fetch(API('/api/gate/backtest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, limit: 200 }),
      });
      const data = await res.json();
      if (data.ok) setResult(data.result);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
      <div className="text-xs font-medium text-cyan-300 mb-2">Quick Test Settings</div>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <div>
          <label className="text-[10px] text-white/50">MFE30m %</label>
          <input
            type="number"
            step="0.05"
            value={settings.mfe30m}
            onChange={(e) => setSettings({ ...settings, mfe30m: Number(e.target.value) })}
            className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/50">MQS</label>
          <input
            type="number"
            step="0.05"
            value={settings.mqs}
            onChange={(e) => setSettings({ ...settings, mqs: Number(e.target.value) })}
            className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          />
        </div>
        <div>
          <label className="text-[10px] text-white/50">Min Score</label>
          <select
            value={settings.minScore}
            onChange={(e) => setSettings({ ...settings, minScore: Number(e.target.value) })}
            className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={settings.blockRed}
              onChange={(e) => setSettings({ ...settings, blockRed: e.target.checked })}
              className="rounded"
            />
            Block RED
          </label>
        </div>
      </div>

      <button
        onClick={runTest}
        disabled={loading}
        className="w-full py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 rounded"
      >
        {loading ? 'Testing...' : 'Test Settings'}
      </button>

      {result && (
        <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
          <div className="rounded bg-white/5 p-2 text-center">
            <div className="text-white/50">Kept</div>
            <div className="text-white font-medium">{result.summary.allowed}</div>
          </div>
          <div className="rounded bg-rose-500/10 p-2 text-center">
            <div className="text-rose-300">Blocked</div>
            <div className="text-rose-200 font-medium">{result.summary.reductionPct.toFixed(0)}%</div>
          </div>
          <div className="rounded bg-emerald-500/10 p-2 text-center">
            <div className="text-emerald-300">Win Rate</div>
            <div className="text-emerald-200 font-medium">{(result.performance.winRate * 100).toFixed(1)}%</div>
          </div>
          <div className="rounded bg-blue-500/10 p-2 text-center">
            <div className="text-blue-300">Total R</div>
            <div className={`font-medium ${result.performance.totalR >= 0 ? 'text-emerald-200' : 'text-rose-200'}`}>
              {result.performance.totalR >= 0 ? '+' : ''}{result.performance.totalR.toFixed(2)}R
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// DELETE EARLY_READY_SHORT COMPONENT
// ============================================================================

export function DeleteEarlyReadyShort() {
  const [result, setResult] = useState<{
    dryRun?: boolean;
    wouldDelete?: number;
    deleted?: { signals: number; outcomes: number; extendedOutcomes: number };
    message: string;
    sample?: Array<{ id: number; symbol: string; category: string; created_at: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const checkWhatWouldDelete = async () => {
    setLoading(true);
    try {
      const res = await fetch(API('/api/admin/delete-early-ready-short?dryRun=true'), {
        method: 'POST',
      });
      const data = await res.json();
      setResult(data);
      setShowConfirm(true);
    } finally {
      setLoading(false);
    }
  };

  const doDelete = async () => {
    setLoading(true);
    try {
      const res = await fetch(API('/api/admin/delete-early-ready-short?dryRun=false'), {
        method: 'POST',
      });
      const data = await res.json();
      setResult(data);
      setShowConfirm(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-rose-300">Delete EARLY_READY_SHORT Signals</h3>
      </div>

      <p className="text-xs text-white/60 mb-3">
        Permanently remove all EARLY_READY_SHORT signals and their outcomes from the database.
        This cannot be undone.
      </p>

      {!result && (
        <button
          onClick={checkWhatWouldDelete}
          disabled={loading}
          className="px-3 py-1.5 text-xs bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 rounded"
        >
          {loading ? 'Checking...' : 'Check What Will Be Deleted'}
        </button>
      )}

      {result && result.dryRun && (
        <div className="mb-3 p-3 rounded bg-slate-800/50 border border-amber-500/30">
          <div className="text-xs font-medium text-amber-300 mb-2">
            Dry Run Results - Would Delete:
          </div>
          <div className="text-sm font-bold text-white mb-2">
            {result.wouldDelete} EARLY_READY_SHORT signals
          </div>
          {result.sample && result.sample.length > 0 && (
            <div className="text-xs text-white/50 mb-3">
              Sample: {result.sample.map(s => s.symbol).join(', ')}
            </div>
          )}
          
          {showConfirm && (
            <div className="flex gap-2">
              <button
                onClick={doDelete}
                disabled={loading}
                className="px-3 py-1.5 text-xs bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 rounded"
              >
                {loading ? 'Deleting...' : 'YES, DELETE THEM'}
              </button>
              <button
                onClick={() => { setResult(null); setShowConfirm(false); }}
                className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {result && !result.dryRun && (
        <div className="p-3 rounded bg-emerald-900/30 border border-emerald-500/30">
          <div className="text-xs font-medium text-emerald-300 mb-2">
            ✅ Deleted Successfully
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded bg-white/5 p-2 text-center">
              <div className="text-white/50">Signals</div>
              <div className="text-white font-medium">{result.deleted?.signals}</div>
            </div>
            <div className="rounded bg-white/5 p-2 text-center">
              <div className="text-white/50">Outcomes</div>
              <div className="text-white font-medium">{result.deleted?.outcomes}</div>
            </div>
            <div className="rounded bg-white/5 p-2 text-center">
              <div className="text-white/50">Extended</div>
              <div className="text-white font-medium">{result.deleted?.extendedOutcomes}</div>
            </div>
          </div>
          <button
            onClick={() => setResult(null)}
            className="mt-3 px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
