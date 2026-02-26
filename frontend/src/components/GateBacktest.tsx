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
// CONFIG BUILDER
// ============================================================================

const PRESET_CONFIGS = {
  default: {
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
// MAIN COMPONENT
// ============================================================================

export function GateBacktestComparison() {
  const [configs, setConfigs] = useState<GateConfig[]>([
    PRESET_CONFIGS.default,
    PRESET_CONFIGS.strictScore3,
    PRESET_CONFIGS.highMfe,
  ]);
  const [results, setResults] = useState<BacktestResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(200);
  const [activeTab, setActiveTab] = useState(0);
  const [showCustom, setShowCustom] = useState(false);
  const [customConfig, setCustomConfig] = useState<GateConfig>(PRESET_CONFIGS.default);

  async function runBacktest() {
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
      }
    } finally {
      setLoading(false);
    }
  }

  function addConfig(presetKey: keyof typeof PRESET_CONFIGS) {
    const preset = PRESET_CONFIGS[presetKey];
    if (!configs.find(c => c.name === preset.name)) {
      setConfigs([...configs, preset]);
    }
  }

  function removeConfig(index: number) {
    setConfigs(configs.filter((_, i) => i !== index));
  }

  function addCustomConfig() {
    if (!configs.find(c => c.name === customConfig.name)) {
      setConfigs([...configs, { ...customConfig, name: customConfig.name || 'Custom' }]);
      setShowCustom(false);
    }
  }

  return (
    <section className="rounded-2xl border border-cyan-500/20 bg-cyan-950/20 p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs text-cyan-400/80 uppercase tracking-widest">Gate Backtest Comparison</div>
        <div className="flex items-center gap-2">
          <select 
            className="text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={100}>Last 100 signals</option>
            <option value={200}>Last 200 signals</option>
            <option value={300}>Last 300 signals</option>
            <option value={500}>Last 500 signals</option>
          </select>
          <button
            onClick={runBacktest}
            disabled={loading || configs.length === 0}
            className="text-xs px-3 py-1.5 rounded bg-cyan-500/20 text-cyan-200 border border-cyan-500/30 disabled:opacity-50"
          >
            {loading ? 'Running...' : 'Run Backtest'}
          </button>
        </div>
      </div>

      {/* Config Presets */}
      <div className="flex flex-wrap gap-2 mb-4">
        <span className="text-xs text-white/50 py-1">Add preset:</span>
        {Object.entries(PRESET_CONFIGS).map(([key, preset]) => (
          <button
            key={key}
            onClick={() => addConfig(key as keyof typeof PRESET_CONFIGS)}
            disabled={configs.some(c => c.name === preset.name)}
            className="text-xs px-2 py-1 rounded bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-30"
          >
            + {preset.name}
          </button>
        ))}
        <button
          onClick={() => setShowCustom(!showCustom)}
          className="text-xs px-2 py-1 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-300"
        >
          {showCustom ? 'Cancel Custom' : '+ Custom'}
        </button>
      </div>

      {/* Custom Config Builder */}
      {showCustom && (
        <div className="mb-4 p-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5">
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
              <label className="text-[10px] text-white/50">Yellow MFE %</label>
              <input
                type="number"
                step="0.05"
                value={customConfig.yellowMinMfe30mPct}
                onChange={(e) => setCustomConfig({ ...customConfig, yellowMinMfe30mPct: Number(e.target.value) })}
                className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
              />
            </div>
            <div>
              <label className="text-[10px] text-white/50">Red MFE %</label>
              <input
                type="number"
                step="0.05"
                value={customConfig.redMinMfe30mPct}
                onChange={(e) => setCustomConfig({ ...customConfig, redMinMfe30mPct: Number(e.target.value) })}
                className="w-full text-xs px-2 py-1 rounded bg-white/10 border border-white/10"
              />
            </div>
          </div>
          <button
            onClick={addCustomConfig}
            className="mt-2 text-xs px-3 py-1.5 rounded bg-cyan-500/20 text-cyan-200 border border-cyan-500/30"
          >
            Add to Comparison
          </button>
        </div>
      )}

      {/* Config List */}
      <div className="flex flex-wrap gap-2 mb-4">
        {configs.map((config, i) => (
          <div key={i} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-white/5 border border-white/10">
            <span className={i === activeTab ? 'text-cyan-300' : ''}>{config.name}</span>
            <button onClick={() => removeConfig(i)} className="text-white/30 hover:text-rose-400">×</button>
          </div>
        ))}
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-4">
          {/* Comparison Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-white/60">
                <tr className="border-b border-white/10">
                  <th className="text-left px-2 py-2">Config</th>
                  <th className="text-right px-2 py-2">Kept</th>
                  <th className="text-right px-2 py-2">Blocked</th>
                  <th className="text-right px-2 py-2">Win Rate</th>
                  <th className="text-right px-2 py-2">Total R</th>
                  <th className="text-right px-2 py-2">Avg R</th>
                  <th className="text-right px-2 py-2">Median R</th>
                  <th className="text-center px-2 py-2">Quality</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr 
                    key={i} 
                    className={`border-b border-white/5 hover:bg-white/5 cursor-pointer ${i === activeTab ? 'bg-cyan-500/10' : ''}`}
                    onClick={() => setActiveTab(i)}
                  >
                    <td className="px-2 py-2 font-medium">{r.config.name}</td>
                    <td className="px-2 py-2 text-right">
                      {r.summary.allowed} 
                      <span className="text-white/40">({(100 - r.summary.reductionPct).toFixed(0)}%)</span>
                    </td>
                    <td className="px-2 py-2 text-right text-rose-300">
                      {r.summary.blocked}
                      <span className="text-white/40">({r.summary.reductionPct.toFixed(0)}%)</span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <span className={r.performance.winRate >= 0.35 ? 'text-emerald-300' : r.performance.winRate >= 0.25 ? 'text-amber-300' : 'text-rose-300'}>
                        {(r.performance.winRate * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <span className={r.performance.totalR >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                        {r.performance.totalR >= 0 ? '+' : ''}{r.performance.totalR.toFixed(2)}R
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right">{r.performance.avgR.toFixed(2)}R</td>
                    <td className="px-2 py-2 text-right">{r.performance.medianR.toFixed(2)}R</td>
                    <td className="px-2 py-2 text-center">
                      <div className="flex gap-1 justify-center">
                        <span className="text-[10px] px-1 rounded bg-emerald-500/20 text-emerald-200">{r.quality.high}</span>
                        <span className="text-[10px] px-1 rounded bg-blue-500/20 text-blue-200">{r.quality.medium}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Detailed View for Active Config */}
          {results[activeTab] && (
            <div className="p-3 rounded-lg border border-white/10 bg-white/5">
              <div className="text-xs font-medium text-cyan-300 mb-2">
                Details: {results[activeTab].config.name}
              </div>
              
              {/* Config Summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 text-xs">
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
                <div className="flex flex-wrap gap-2">
                  {Object.entries(results[activeTab].blockedReasons).map(([reason, count]) => (
                    <span key={reason} className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-200 text-[10px]">
                      {reason.replace(/_/g, ' ')}: {count}
                    </span>
                  ))}
                </div>
              </div>

              {/* Tier Breakdown */}
              <div className="mt-3 text-xs">
                <div className="text-white/50 mb-1">By Tier:</div>
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(results[activeTab].tierBreakdown).map(([tier, data]) => (
                    <div key={tier} className="rounded bg-white/5 p-2">
                      <div className={`font-medium ${tier === 'GREEN' ? 'text-emerald-300' : tier === 'YELLOW' ? 'text-amber-300' : 'text-rose-300'}`}>
                        {tier}
                      </div>
                      <div className="text-white/60 text-[10px]">
                        {data.allowed}/{data.total} passed
                        <span className="text-white/40"> ({data.total > 0 ? ((data.allowed / data.total) * 100).toFixed(0) : 0}%)</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ============================================================================
// QUICK SETTINGS COMPONENT
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

  async function testSettings() {
    setLoading(true);
    const config: GateConfig = {
      ...PRESET_CONFIGS.default,
      minMfe30mPct: settings.mfe30m,
      minMqs: settings.mqs,
      minCombinedScore: settings.minScore,
      blockRedTier: settings.blockRed,
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
            <option value={5}>5</option>
          </select>
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.blockRed}
              onChange={(e) => setSettings({ ...settings, blockRed: e.target.checked })}
            />
            Block RED
          </label>
        </div>
      </div>

      <button
        onClick={testSettings}
        disabled={loading}
        className="text-xs px-3 py-1.5 rounded bg-cyan-500/20 text-cyan-200 border border-cyan-500/30 disabled:opacity-50"
      >
        {loading ? 'Testing...' : 'Test on Last 200 Signals'}
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
