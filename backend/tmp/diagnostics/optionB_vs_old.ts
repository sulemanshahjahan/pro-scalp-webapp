/**
 * Option B vs Old Config Comparative Analysis
 * Quant Strategy Analysis for Railway Production DB
 * 
 * Usage: npx tsx backend/tmp/diagnostics/optionB_vs_old.ts
 */

import * as pg from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const { Pool } = pg;

// Config detection parameters
const OPTION_B_RSI_MIN = 55;
const OLD_RSI_MIN = 35;
const MIN_SAMPLE_SIZE = 10;

interface SignalOutcome {
  symbol: string;
  category: string;
  direction: 'LONG' | 'SHORT';
  price: number;
  stop: number;
  tp1: number;
  tp2: number;
  time: number;
  config_hash: string;
  config_snapshot_json: string | null;
  // Outcome fields
  horizon_min: number;
  tp1_hit: boolean;
  tp2_hit: boolean;
  sl_hit: boolean;
  no_hit: boolean;
  resolved_at: number | null;
  mfe_price: number | null;
  mae_price: number | null;
  final_price: number | null;
  coverage_pct: number | null;
  // Managed outcome fields
  managed_status: string | null;
  managed_r: number | null;
  exit_reason: string | null;
  // Metadata
  rsi_at_entry: number | null;
  vwap_dist_pct: number | null;
  vol_spike: number | null;
  session: string | null;
}

interface ConfigMetrics {
  configLabel: string;
  dateRange: { start: string; end: string };
  totalSignals: number;
  completedCount: number;
  pendingCount: number;
  officialWinRate: number; // TP1+TP2 completed
  stopRate: number;
  tp1TouchRate: number;
  tp2ConversionRate: number;
  managedWinRate: number;
  managedAvgR: number;
  managedNetR: number;
  stopBeforeTp1Count: number;
  stopBeforeTp1Pct: number;
  avgTimeToTp1Min: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
  coverage: {
    avg: number;
    median: number;
    over100pct: number;
    under80pct: number;
  };
  // Breakdowns
  bySymbol: Record<string, { count: number; avgR: number; netR: number }>;
  bySession: Record<string, { count: number; avgR: number; winRate: number }>;
  byRsiBucket: Record<string, { count: number; avgR: number; winRate: number }>;
  byVolSpike: Record<string, { count: number; avgR: number; winRate: number }>;
}

interface ComparisonReport {
  oldConfig: ConfigMetrics;
  optionB: ConfigMetrics;
  comparisonTable: Array<{
    metric: string;
    oldValue: string | number;
    optionBValue: string | number;
    delta: string;
    verdict: 'BETTER' | 'WORSE' | 'NEUTRAL' | 'INSUFFICIENT';
  }>;
  insights: string[];
  recommendation: string;
}

class QuantAnalyzer {
  private pool: pg.Pool;
  private outputDir: string;

  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL not set - cannot connect to Railway DB');
    }
    
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });

    this.outputDir = path.join(process.cwd(), 'backend', 'tmp', 'diagnostics');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async analyze(): Promise<void> {
    console.log('🔌 Connecting to Railway Production DB...');
    const client = await this.pool.connect();
    
    try {
      console.log('✅ Connected to Railway DB');
      
      // Step A: Detect config switch
      console.log('\n📊 STEP A: Detecting config switch timestamp...');
      const configWindows = await this.detectConfigWindows(client);
      
      if (!configWindows.old || !configWindows.optionB) {
        console.log('⚠️ Could not detect both config windows automatically');
        console.log('Falling back to manual time window...');
      }
      
      // Step B: Build comparison windows
      console.log('\n📊 STEP B: Building fair comparison windows...');
      const signals = await this.pullSignals(client, configWindows);
      
      if (signals.length < MIN_SAMPLE_SIZE) {
        console.log(`⚠️ Insufficient sample size: ${signals.length} signals (need ${MIN_SAMPLE_SIZE}+)`);
      }
      
      // Step C: Compute metrics
      console.log('\n📊 STEP C: Computing metrics...');
      const oldMetrics = await this.computeMetrics(signals, 'old');
      const optionBMetrics = await this.computeMetrics(signals, 'optionB');
      
      // Step D: Compare
      console.log('\n📊 STEP D: Comparing configs...');
      const comparison = this.compareConfigs(oldMetrics, optionBMetrics);
      
      // Step E: Generate insights
      console.log('\n📊 STEP E: Generating insights...');
      const insights = this.generateInsights(oldMetrics, optionBMetrics, signals);
      
      // Step F: Recommendation
      console.log('\n📊 STEP F: Generating recommendation...');
      const recommendation = this.generateRecommendation(oldMetrics, optionBMetrics);
      
      // Save outputs
      const report: ComparisonReport = {
        oldConfig: oldMetrics,
        optionB: optionBMetrics,
        comparisonTable: comparison,
        insights,
        recommendation,
      };
      
      await this.saveOutputs(report, signals);
      
      console.log('\n✅ Analysis complete!');
      this.printExecutiveSummary(report);
      
    } finally {
      client.release();
      await this.pool.end();
    }
  }

  private async detectConfigWindows(client: pg.PoolClient): Promise<{
    old?: { start: Date; end: Date };
    optionB?: { start: Date; end: Date };
  }> {
    // Query to find config_hash transitions
    const query = `
      SELECT 
        config_hash,
        config_snapshot_json,
        MIN(time) as first_signal,
        MAX(time) as last_signal,
        COUNT(*) as signal_count
      FROM signals
      WHERE category = 'READY_TO_BUY'
        AND config_hash IS NOT NULL
        AND config_hash != 'legacy'
      GROUP BY config_hash, config_snapshot_json
      ORDER BY MIN(time) DESC
      LIMIT 10
    `;
    
    const result = await client.query(query);
    console.log('Config hashes found:');
    
    const configs: Array<{
      hash: string;
      snapshot: any;
      firstSignal: Date;
      lastSignal: Date;
      count: number;
    }> = [];
    
    for (const row of result.rows) {
      let snapshot: any = null;
      try {
        snapshot = row.config_snapshot_json ? JSON.parse(row.config_snapshot_json) : null;
      } catch {}
      
      const rsiMin = snapshot?.RSI_READY_MIN;
      const vwapMax = snapshot?.READY_VWAP_MAX_PCT;
      
      const label = rsiMin === OPTION_B_RSI_MIN ? 'OPTION_B' : 
                    rsiMin === OLD_RSI_MIN ? 'OLD_CONFIG' : 'UNKNOWN';
      
      console.log(`  ${row.config_hash?.substring(0, 8)}: ${label} | RSI ${rsiMin} | VWAP ${vwapMax} | ${row.signal_count} signals`);
      
      configs.push({
        hash: row.config_hash,
        snapshot,
        firstSignal: row.first_signal,
        lastSignal: row.last_signal,
        count: parseInt(row.signal_count),
      });
    }
    
    // Identify Option B and Old configs
    const optionBConfig = configs.find(c => c.snapshot?.RSI_READY_MIN === OPTION_B_RSI_MIN);
    const oldConfig = configs.find(c => c.snapshot?.RSI_READY_MIN === OLD_RSI_MIN);
    
    const windows: any = {};
    
    if (oldConfig) {
      windows.old = {
        start: oldConfig.firstSignal,
        end: oldConfig.lastSignal,
      };
      console.log(`\n✓ Old config window: ${oldConfig.firstSignal.toISOString()} to ${oldConfig.lastSignal.toISOString()}`);
    }
    
    if (optionBConfig) {
      windows.optionB = {
        start: optionBConfig.firstSignal,
        end: optionBConfig.lastSignal,
      };
      console.log(`✓ Option B window: ${optionBConfig.firstSignal.toISOString()} to ${optionBConfig.lastSignal.toISOString()}`);
    }
    
    if (!optionBConfig && configs.length > 0) {
      // Fallback: use most recent config as Option B
      const latest = configs[0];
      console.log(`\n⚠️ Using most recent config (${latest.hash?.substring(0, 8)}) as Option B`);
      windows.optionB = {
        start: latest.firstSignal,
        end: latest.lastSignal,
      };
    }
    
    return windows;
  }

  private async pullSignals(
    client: pg.PoolClient,
    windows: { old?: { start: Date; end: Date }; optionB?: { start: Date; end: Date } }
  ): Promise<SignalOutcome[]> {
    // Build time range covering both windows
    const startTimes: Date[] = [];
    const endTimes: Date[] = [];
    
    if (windows.old) {
      startTimes.push(windows.old.start);
      endTimes.push(windows.old.end);
    }
    if (windows.optionB) {
      startTimes.push(windows.optionB.start);
      endTimes.push(windows.optionB.end);
    }
    
    if (startTimes.length === 0) {
      // Fallback: last 14 days
      const fourteenDaysAgo = new Date();
      fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
      startTimes.push(fourteenDaysAgo);
      endTimes.push(new Date());
    }
    
    const minTime = Math.min(...startTimes.map(d => d.getTime()));
    const maxTime = Math.max(...endTimes.map(d => d.getTime()));
    
    console.log(`Querying signals from ${new Date(minTime).toISOString()} to ${new Date(maxTime).toISOString()}`);
    
    const query = `
      SELECT 
        s.symbol,
        s.category,
        CASE WHEN s.category LIKE '%SELL%' OR s.category LIKE '%SHORT%' THEN 'SHORT' ELSE 'LONG' END as direction,
        s.price,
        s.stop,
        s.tp1,
        s.tp2,
        s.time,
        s.config_hash,
        s.config_snapshot_json,
        so.horizon_min,
        so.tp1_hit,
        so.tp2_hit,
        so.sl_hit,
        so.no_hit,
        so.resolved_at,
        so.mfe_price,
        so.mae_price,
        so.final_price,
        so.coverage_pct,
        so.managed_status,
        so.managed_r,
        so.exit_reason,
        se.gate_snapshot_json,
        se.ready_debug_json
      FROM signals s
      LEFT JOIN signal_outcomes so ON s.id = so.signal_id AND so.horizon_min = 2880
      LEFT JOIN signal_events se ON s.id = se.signal_id AND se.event_type = 'created'
      WHERE s.category = 'READY_TO_BUY'
        AND s.time >= $1
        AND s.time <= $2
        AND s.price IS NOT NULL
        AND s.stop IS NOT NULL
      ORDER BY s.time DESC
    `;
    
    const result = await client.query(query, [minTime, maxTime]);
    console.log(`Found ${result.rows.length} READY_TO_BUY signals`);
    
    return result.rows.map(row => ({
      symbol: row.symbol,
      category: row.category,
      direction: row.direction,
      price: parseFloat(row.price),
      stop: parseFloat(row.stop),
      tp1: parseFloat(row.tp1),
      tp2: parseFloat(row.tp2),
      time: parseInt(row.time),
      config_hash: row.config_hash || 'unknown',
      config_snapshot_json: row.config_snapshot_json,
      horizon_min: row.horizon_min,
      tp1_hit: row.tp1_hit,
      tp2_hit: row.tp2_hit,
      sl_hit: row.sl_hit,
      no_hit: row.no_hit,
      resolved_at: row.resolved_at,
      mfe_price: row.mfe_price ? parseFloat(row.mfe_price) : null,
      mae_price: row.mae_price ? parseFloat(row.mae_price) : null,
      final_price: row.final_price ? parseFloat(row.final_price) : null,
      coverage_pct: row.coverage_pct ? parseFloat(row.coverage_pct) : null,
      managed_status: row.managed_status,
      managed_r: row.managed_r ? parseFloat(row.managed_r) : null,
      exit_reason: row.exit_reason,
      rsi_at_entry: this.extractRsiFromDebug(row.ready_debug_json),
      vwap_dist_pct: this.extractVwapDistFromDebug(row.gate_snapshot_json),
      vol_spike: this.extractVolSpikeFromDebug(row.ready_debug_json),
      session: this.getSessionFromTimestamp(parseInt(row.time)),
    }));
  }

  private extractRsiFromDebug(debugJson: string | null): number | null {
    if (!debugJson) return null;
    try {
      const debug = JSON.parse(debugJson);
      return debug?.indicators?.rsi ?? debug?.rsi ?? null;
    } catch { return null; }
  }

  private extractVwapDistFromDebug(gateJson: string | null): number | null {
    if (!gateJson) return null;
    try {
      const gate = JSON.parse(gateJson);
      return gate?.vwapDistPct ?? gate?.indicators?.vwapDistPct ?? null;
    } catch { return null; }
  }

  private extractVolSpikeFromDebug(debugJson: string | null): number | null {
    if (!debugJson) return null;
    try {
      const debug = JSON.parse(debugJson);
      return debug?.volSpike ?? debug?.indicators?.volSpike ?? null;
    } catch { return null; }
  }

  private getSessionFromTimestamp(timeMs: number): string {
    const hour = new Date(timeMs).getUTCHours();
    if (hour >= 0 && hour < 8) return 'ASIA';
    if (hour >= 8 && hour < 16) return 'LONDON';
    return 'NY';
  }

  private async computeMetrics(
    signals: SignalOutcome[],
    configType: 'old' | 'optionB'
  ): Promise<ConfigMetrics> {
    // Filter signals by config type
    const filtered = signals.filter(s => {
      const snapshot = s.config_snapshot_json ? JSON.parse(s.config_snapshot_json) : null;
      const rsiMin = snapshot?.RSI_READY_MIN;
      
      if (configType === 'optionB') {
        return rsiMin === OPTION_B_RSI_MIN || s.config_hash?.includes('option') || rsiMin === 55;
      } else {
        return rsiMin === OLD_RSI_MIN || rsiMin === 35;
      }
    });

    if (filtered.length === 0) {
      return this.createEmptyMetrics(configType);
    }

    // Basic counts
    const totalSignals = filtered.length;
    const completed = filtered.filter(s => s.managed_status && s.managed_status !== 'PENDING');
    const pending = filtered.filter(s => !s.managed_status || s.managed_status === 'PENDING');
    
    // Official stats (TP1/TP2 hit)
    const tp1Hits = completed.filter(s => s.tp1_hit).length;
    const tp2Hits = completed.filter(s => s.tp2_hit).length;
    const slHits = completed.filter(s => s.sl_hit).length;
    const noHits = completed.filter(s => s.no_hit).length;
    
    const officialWinRate = completed.length > 0 ? ((tp1Hits + tp2Hits) / completed.length) * 100 : 0;
    const stopRate = completed.length > 0 ? (slHits / completed.length) * 100 : 0;
    const tp1TouchRate = completed.length > 0 ? (tp1Hits / completed.length) * 100 : 0;
    const tp2ConversionRate = tp1Hits > 0 ? (tp2Hits / tp1Hits) * 100 : 0;
    
    // Managed stats
    const managedResults = completed.filter(s => s.managed_r !== null);
    const managedWinners = managedResults.filter(s => (s.managed_r || 0) > 0);
    const managedWinRate = managedResults.length > 0 ? (managedWinners.length / managedResults.length) * 100 : 0;
    const managedAvgR = managedResults.length > 0 ? managedResults.reduce((a, s) => a + (s.managed_r || 0), 0) / managedResults.length : 0;
    const managedNetR = managedResults.reduce((a, s) => a + (s.managed_r || 0), 0);
    
    // Stop before TP1
    const stopBeforeTp1 = completed.filter(s => s.sl_hit && !s.tp1_hit).length;
    const stopBeforeTp1Pct = completed.length > 0 ? (stopBeforeTp1 / completed.length) * 100 : 0;
    
    // Time to TP1
    const tp1Signals = completed.filter(s => s.tp1_hit && s.resolved_at);
    const avgTimeToTp1 = tp1Signals.length > 0 
      ? tp1Signals.reduce((a, s) => a + ((s.resolved_at || s.time) - s.time), 0) / tp1Signals.length / 60000 // minutes
      : null;
    
    // MFE/MAE
    const withMfe = completed.filter(s => s.mfe_price && s.price && s.stop);
    const avgMfeR = withMfe.length > 0
      ? withMfe.reduce((a, s) => a + (Math.abs((s.mfe_price! - s.price) / (s.price - s.stop))), 0) / withMfe.length
      : null;
    const withMae = completed.filter(s => s.mae_price && s.price && s.stop);
    const avgMaeR = withMae.length > 0
      ? withMae.reduce((a, s) => a + (Math.abs((s.mae_price! - s.price) / (s.price - s.stop))), 0) / withMae.length
      : null;
    
    // Coverage
    const coverages = completed.map(s => s.coverage_pct).filter((c): c is number => c !== null);
    const avgCoverage = coverages.length > 0 ? coverages.reduce((a, b) => a + b, 0) / coverages.length : 0;
    const sortedCoverages = [...coverages].sort((a, b) => a - b);
    const medianCoverage = sortedCoverages[Math.floor(sortedCoverages.length / 2)] || 0;
    const over100 = coverages.filter(c => c > 100).length;
    const under80 = coverages.filter(c => c < 80).length;
    
    // Breakdowns
    const bySymbol = this.breakdownBySymbol(filtered);
    const bySession = this.breakdownBySession(filtered);
    const byRsiBucket = this.breakdownByRsiBucket(filtered);
    const byVolSpike = this.breakdownByVolSpike(filtered);

    return {
      configLabel: configType === 'optionB' ? 'Option B (RSI 55-80)' : 'Old Config (RSI 35-82)',
      dateRange: {
        start: new Date(Math.min(...filtered.map(s => s.time))).toISOString(),
        end: new Date(Math.max(...filtered.map(s => s.time))).toISOString(),
      },
      totalSignals,
      completedCount: completed.length,
      pendingCount: pending.length,
      officialWinRate,
      stopRate,
      tp1TouchRate,
      tp2ConversionRate,
      managedWinRate,
      managedAvgR,
      managedNetR,
      stopBeforeTp1Count: stopBeforeTp1,
      stopBeforeTp1Pct,
      avgTimeToTp1Min: avgTimeToTp1,
      avgMfeR,
      avgMaeR,
      coverage: {
        avg: avgCoverage,
        median: medianCoverage,
        over100pct: over100,
        under80pct: under80,
      },
      bySymbol,
      bySession,
      byRsiBucket,
      byVolSpike,
    };
  }

  private createEmptyMetrics(configType: string): ConfigMetrics {
    return {
      configLabel: configType,
      dateRange: { start: '', end: '' },
      totalSignals: 0,
      completedCount: 0,
      pendingCount: 0,
      officialWinRate: 0,
      stopRate: 0,
      tp1TouchRate: 0,
      tp2ConversionRate: 0,
      managedWinRate: 0,
      managedAvgR: 0,
      managedNetR: 0,
      stopBeforeTp1Count: 0,
      stopBeforeTp1Pct: 0,
      avgTimeToTp1Min: null,
      avgMfeR: null,
      avgMaeR: null,
      coverage: { avg: 0, median: 0, over100pct: 0, under80pct: 0 },
      bySymbol: {},
      bySession: {},
      byRsiBucket: {},
      byVolSpike: {},
    };
  }

  private breakdownBySymbol(signals: SignalOutcome[]): Record<string, { count: number; avgR: number; netR: number }> {
    const bySymbol: Record<string, { rs: number[]; netR: number }> = {};
    
    for (const s of signals) {
      if (!bySymbol[s.symbol]) bySymbol[s.symbol] = { rs: [], netR: 0 };
      if (s.managed_r !== null) {
        bySymbol[s.symbol].rs.push(s.managed_r);
        bySymbol[s.symbol].netR += s.managed_r;
      }
    }
    
    const result: Record<string, { count: number; avgR: number; netR: number }> = {};
    for (const [sym, data] of Object.entries(bySymbol)) {
      if (data.rs.length >= 3) { // Minimum sample size
        result[sym] = {
          count: data.rs.length,
          avgR: data.rs.reduce((a, b) => a + b, 0) / data.rs.length,
          netR: data.netR,
        };
      }
    }
    
    // Sort by avgR
    return Object.fromEntries(
      Object.entries(result).sort((a, b) => b[1].avgR - a[1].avgR)
    );
  }

  private breakdownBySession(signals: SignalOutcome[]): Record<string, { count: number; avgR: number; winRate: number }> {
    const bySession: Record<string, { rs: number[]; wins: number }> = {};
    
    for (const s of signals) {
      const session = s.session || 'UNKNOWN';
      if (!bySession[session]) bySession[session] = { rs: [], wins: 0 };
      if (s.managed_r !== null) {
        bySession[session].rs.push(s.managed_r);
        if (s.managed_r > 0) bySession[session].wins++;
      }
    }
    
    const result: Record<string, { count: number; avgR: number; winRate: number }> = {};
    for (const [sess, data] of Object.entries(bySession)) {
      if (data.rs.length > 0) {
        result[sess] = {
          count: data.rs.length,
          avgR: data.rs.reduce((a, b) => a + b, 0) / data.rs.length,
          winRate: (data.wins / data.rs.length) * 100,
        };
      }
    }
    
    return result;
  }

  private breakdownByRsiBucket(signals: SignalOutcome[]): Record<string, { count: number; avgR: number; winRate: number }> {
    const buckets: Record<string, { rs: number[]; wins: number }> = {
      '40-55': { rs: [], wins: 0 },
      '55-65': { rs: [], wins: 0 },
      '65-80': { rs: [], wins: 0 },
    };
    
    for (const s of signals) {
      const rsi = s.rsi_at_entry;
      if (rsi === null) continue;
      
      let bucket = 'OTHER';
      if (rsi >= 40 && rsi < 55) bucket = '40-55';
      else if (rsi >= 55 && rsi < 65) bucket = '55-65';
      else if (rsi >= 65 && rsi <= 80) bucket = '65-80';
      else continue;
      
      if (s.managed_r !== null) {
        buckets[bucket].rs.push(s.managed_r);
        if (s.managed_r > 0) buckets[bucket].wins++;
      }
    }
    
    const result: Record<string, { count: number; avgR: number; winRate: number }> = {};
    for (const [bucket, data] of Object.entries(buckets)) {
      if (data.rs.length > 0) {
        result[bucket] = {
          count: data.rs.length,
          avgR: data.rs.reduce((a, b) => a + b, 0) / data.rs.length,
          winRate: (data.wins / data.rs.length) * 100,
        };
      }
    }
    
    return result;
  }

  private breakdownByVolSpike(signals: SignalOutcome[]): Record<string, { count: number; avgR: number; winRate: number }> {
    const buckets: Record<string, { rs: number[]; wins: number }> = {
      '1.0-1.5': { rs: [], wins: 0 },
      '1.5-2.5': { rs: [], wins: 0 },
      '2.5+': { rs: [], wins: 0 },
    };
    
    for (const s of signals) {
      const vol = s.vol_spike;
      if (vol === null) continue;
      
      let bucket = 'OTHER';
      if (vol >= 1.0 && vol < 1.5) bucket = '1.0-1.5';
      else if (vol >= 1.5 && vol < 2.5) bucket = '1.5-2.5';
      else if (vol >= 2.5) bucket = '2.5+';
      else continue;
      
      if (s.managed_r !== null) {
        buckets[bucket].rs.push(s.managed_r);
        if (s.managed_r > 0) buckets[bucket].wins++;
      }
    }
    
    const result: Record<string, { count: number; avgR: number; winRate: number }> = {};
    for (const [bucket, data] of Object.entries(buckets)) {
      if (data.rs.length > 0) {
        result[bucket] = {
          count: data.rs.length,
          avgR: data.rs.reduce((a, b) => a + b, 0) / data.rs.length,
          winRate: (data.wins / data.rs.length) * 100,
        };
      }
    }
    
    return result;
  }

  private compareConfigs(old: ConfigMetrics, optionB: ConfigMetrics): ComparisonReport['comparisonTable'] {
    const rows: ComparisonReport['comparisonTable'] = [];
    
    const addRow = (metric: string, oldVal: number, newVal: number, format: 'pct' | 'decimal' | 'count' = 'decimal') => {
      const delta = newVal - oldVal;
      const deltaStr = delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2);
      
      let verdict: 'BETTER' | 'WORSE' | 'NEUTRAL' | 'INSUFFICIENT' = 'NEUTRAL';
      if (old.totalSignals < 5 || optionB.totalSignals < 5) verdict = 'INSUFFICIENT';
      else if (metric.includes('Win Rate') || metric.includes('R ') || metric === 'Signal Count') {
        verdict = delta > 0 ? 'BETTER' : delta < 0 ? 'WORSE' : 'NEUTRAL';
      } else if (metric.includes('Stop') && !metric.includes('before')) {
        verdict = delta < 0 ? 'BETTER' : delta > 0 ? 'WORSE' : 'NEUTRAL';
      }
      
      let oldStr = oldVal.toFixed(2);
      let newStr = newVal.toFixed(2);
      
      if (format === 'pct') {
        oldStr = `${oldVal.toFixed(1)}%`;
        newStr = `${newVal.toFixed(1)}%`;
      } else if (format === 'count') {
        oldStr = Math.round(oldVal).toString();
        newStr = Math.round(newVal).toString();
      }
      
      rows.push({ metric, oldValue: oldStr, optionBValue: newStr, delta: deltaStr, verdict });
    };
    
    addRow('Signal Count', old.totalSignals, optionB.totalSignals, 'count');
    addRow('Completed Count', old.completedCount, optionB.completedCount, 'count');
    addRow('Official Win Rate', old.officialWinRate, optionB.officialWinRate, 'pct');
    addRow('STOP Rate', old.stopRate, optionB.stopRate, 'pct');
    addRow('TP1 Touch Rate', old.tp1TouchRate, optionB.tp1TouchRate, 'pct');
    addRow('TP2 Conversion Rate', old.tp2ConversionRate, optionB.tp2ConversionRate, 'pct');
    addRow('Managed Win Rate', old.managedWinRate, optionB.managedWinRate, 'pct');
    addRow('Managed Avg R', old.managedAvgR, optionB.managedAvgR);
    addRow('Managed Net R', old.managedNetR, optionB.managedNetR);
    addRow('Stop-Before-TP1 %', old.stopBeforeTp1Pct, optionB.stopBeforeTp1Pct, 'pct');
    
    return rows;
  }

  private generateInsights(old: ConfigMetrics, optionB: ConfigMetrics, signals: SignalOutcome[]): string[] {
    const insights: string[] = [];
    
    // Signal flow
    if (optionB.totalSignals < old.totalSignals * 0.5) {
      insights.push(`⚠️ Signal flow reduced by ${((1 - optionB.totalSignals / old.totalSignals) * 100).toFixed(0)}% - may be too restrictive`);
    } else if (optionB.totalSignals > old.totalSignals * 1.2) {
      insights.push(`✓ Signal flow increased by ${((optionB.totalSignals / old.totalSignals - 1) * 100).toFixed(0)}%`);
    }
    
    // Quality metrics
    if (optionB.managedAvgR > old.managedAvgR * 1.2) {
      insights.push(`✓ Signal quality improved: Avg R ${optionB.managedAvgR.toFixed(2)} vs ${old.managedAvgR.toFixed(2)} (+${((optionB.managedAvgR/old.managedAvgR - 1) * 100).toFixed(0)}%)`);
    } else if (optionB.managedAvgR < old.managedAvgR * 0.8) {
      insights.push(`⚠️ Signal quality degraded: Avg R ${optionB.managedAvgR.toFixed(2)} vs ${old.managedAvgR.toFixed(2)}`);
    }
    
    // Stop before TP1
    if (optionB.stopBeforeTp1Pct < old.stopBeforeTp1Pct * 0.8) {
      insights.push(`✓ Early stops reduced: ${optionB.stopBeforeTp1Pct.toFixed(1)}% vs ${old.stopBeforeTp1Pct.toFixed(1)}% (RSI filter working)`);
    }
    
    // Session analysis
    const oldNy = old.bySession['NY'];
    const optionBNy = optionB.bySession['NY'];
    if (oldNy && optionBNy && optionBNy.avgR > oldNy.avgR) {
      insights.push(`✓ NY session improved: ${optionBNy.avgR.toFixed(2)}R vs ${oldNy.avgR.toFixed(2)}R`);
    }
    
    // RSI bucket analysis
    const midRsiOld = old.byRsiBucket['55-65'];
    const midRsiNew = optionB.byRsiBucket['55-65'];
    if (midRsiOld && midRsiNew) {
      if (midRsiNew.winRate > midRsiOld.winRate) {
        insights.push(`✓ Mid-range RSI (55-65) performing better: ${midRsiNew.winRate.toFixed(1)}% WR vs ${midRsiOld.winRate.toFixed(1)}%`);
      }
    }
    
    // Coverage
    if (optionB.coverage.under80pct > old.coverage.under80pct) {
      insights.push(`⚠️ More signals with poor coverage (<80%): ${optionB.coverage.under80pct} vs ${old.coverage.under80pct}`);
    }
    
    return insights;
  }

  private generateRecommendation(old: ConfigMetrics, optionB: ConfigMetrics): string {
    if (optionB.totalSignals < 5) {
      return 'INSUFFICIENT_DATA: Option B has too few signals to evaluate. Wait for more data.';
    }
    
    const qualityScore = optionB.managedAvgR;
    const flowScore = optionB.totalSignals;
    const oldQuality = old.managedAvgR;
    const oldFlow = old.totalSignals;
    
    // Decision matrix
    if (qualityScore > oldQuality && flowScore >= oldFlow * 0.7) {
      return 'KEEP_OPTION_B: Higher quality with acceptable signal flow. Consider adding volume filter for next optimization.';
    }
    
    if (qualityScore > oldQuality * 1.3 && flowScore < oldFlow * 0.5) {
      return 'RELAX_OPTION_B: Quality is better but flow is too low. Try RSI_READY_MIN=50 or READY_VWAP_MAX_PCT=1.0';
    }
    
    if (qualityScore < oldQuality && flowScore > oldFlow) {
      return 'QUALITY_ISSUE: More signals but worse quality. Revert or tighten filters.';
    }
    
    if (Math.abs(qualityScore - oldQuality) < 0.1 && Math.abs(flowScore - oldFlow) < 5) {
      return 'NEUTRAL: No significant change. Run A/B test with READY_VOL_SPIKE_REQUIRED=true as next experiment.';
    }
    
    return 'MONITOR: Mixed results. Collect more data before deciding.';
  }

  private async saveOutputs(report: ComparisonReport, signals: SignalOutcome[]): Promise<void> {
    // Save JSON
    fs.writeFileSync(
      path.join(this.outputDir, 'optionB_vs_old_data.json'),
      JSON.stringify({ report, rawSignals: signals.slice(0, 100) }, null, 2)
    );
    
    // Generate Markdown report
    const md = this.generateMarkdownReport(report);
    fs.writeFileSync(
      path.join(this.outputDir, 'optionB_vs_old_report.md'),
      md
    );
    
    console.log(`\n📁 Outputs saved to:`);
    console.log(`  - backend/tmp/diagnostics/optionB_vs_old_report.md`);
    console.log(`  - backend/tmp/diagnostics/optionB_vs_old_data.json`);
    console.log(`  - backend/tmp/diagnostics/optionB_vs_old.ts`);
  }

  private generateMarkdownReport(report: ComparisonReport): string {
    const lines: string[] = [];
    
    lines.push('# Option B vs Old Config: Comparative Analysis');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    
    // Executive summary
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(`- **Old Config**: ${report.oldConfig.totalSignals} signals, ${report.oldConfig.managedAvgR.toFixed(2)}R avg`);
    lines.push(`- **Option B**: ${report.optionB.totalSignals} signals, ${report.optionB.managedAvgR.toFixed(2)}R avg`);
    lines.push(`- **Signal Flow Change**: ${((report.optionB.totalSignals / Math.max(report.oldConfig.totalSignals, 1) - 1) * 100).toFixed(0)}%`);
    lines.push(`- **Quality Change**: ${((report.optionB.managedAvgR / Math.max(report.oldConfig.managedAvgR, 0.01) - 1) * 100).toFixed(0)}%`);
    lines.push(`- **Recommendation**: ${report.recommendation}`);
    lines.push('');
    
    // Comparison table
    lines.push('## Core Comparison');
    lines.push('');
    lines.push('| Metric | Old Config | Option B | Delta | Verdict |');
    lines.push('|--------|-----------|----------|-------|---------|');
    for (const row of report.comparisonTable) {
      lines.push(`| ${row.metric} | ${row.oldValue} | ${row.optionBValue} | ${row.delta} | ${row.verdict} |`);
    }
    lines.push('');
    
    // Insights
    lines.push('## Key Insights');
    lines.push('');
    for (const insight of report.insights) {
      lines.push(`- ${insight}`);
    }
    lines.push('');
    
    // Breakdowns
    lines.push('## Breakdowns');
    lines.push('');
    
    lines.push('### By Symbol (Top 10)');
    lines.push('| Symbol | Count | Avg R | Net R |');
    lines.push('|--------|-------|-------|-------|');
    const topSymbols = Object.entries(report.optionB.bySymbol).slice(0, 10);
    for (const [sym, data] of topSymbols) {
      lines.push(`| ${sym} | ${data.count} | ${data.avgR.toFixed(2)} | ${data.netR.toFixed(2)} |`);
    }
    lines.push('');
    
    lines.push('### By Session');
    lines.push('| Session | Count | Avg R | Win Rate |');
    lines.push('|---------|-------|-------|----------|');
    for (const [sess, data] of Object.entries(report.optionB.bySession)) {
      lines.push(`| ${sess} | ${data.count} | ${data.avgR.toFixed(2)} | ${data.winRate.toFixed(1)}% |`);
    }
    lines.push('');
    
    lines.push('### By RSI Bucket');
    lines.push('| RSI Range | Count | Avg R | Win Rate |');
    lines.push('|-----------|-------|-------|----------|');
    for (const [bucket, data] of Object.entries(report.optionB.byRsiBucket)) {
      lines.push(`| ${bucket} | ${data.count} | ${data.avgR.toFixed(2)} | ${data.winRate.toFixed(1)}% |`);
    }
    lines.push('');
    
    // Recommendation
    lines.push('## Recommendation');
    lines.push('');
    lines.push(report.recommendation);
    lines.push('');
    lines.push('### Suggested Next Experiment');
    lines.push('');
    lines.push('If keeping Option B, try adding volume filter:');
    lines.push('```');
    lines.push('READY_VOL_SPIKE_REQUIRED=true');
    lines.push('THRESHOLD_VOL_SPIKE_X=1.5');
    lines.push('```');
    lines.push('');
    lines.push('Monitor for: signal count change, stop-before-TP1 rate, Avg R stability.');
    
    return lines.join('\n');
  }

  private printExecutiveSummary(report: ComparisonReport): void {
    console.log('\n' + '='.repeat(60));
    console.log('EXECUTIVE SUMMARY');
    console.log('='.repeat(60));
    console.log(`Old Config:  ${report.oldConfig.totalSignals} signals | ${report.oldConfig.managedAvgR.toFixed(2)}R avg | ${report.oldConfig.officialWinRate.toFixed(1)}% WR`);
    console.log(`Option B:    ${report.optionB.totalSignals} signals | ${report.optionB.managedAvgR.toFixed(2)}R avg | ${report.optionB.officialWinRate.toFixed(1)}% WR`);
    console.log(`Net R:       Old ${report.oldConfig.managedNetR.toFixed(2)}R vs Option B ${report.optionB.managedNetR.toFixed(2)}R`);
    console.log(`Verdict:     ${report.recommendation}`);
    console.log('='.repeat(60));
  }
}

// Run analysis
const analyzer = new QuantAnalyzer();
analyzer.analyze().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
