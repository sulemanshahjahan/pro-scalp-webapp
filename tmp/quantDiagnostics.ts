#!/usr/bin/env npx tsx
/**
 * Quant Strategy Diagnostics Tool
 * 
 * Analyzes live signal + outcome data from Railway production database
 * to identify weak performance patterns and propose filter improvements.
 * 
 * Usage:
 *   DATABASE_URL="postgres://..." npx tsx tmp/quantDiagnostics.ts
 * 
 * Or with Railway CLI:
 *   railway run -- npx tsx tmp/quantDiagnostics.ts
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

// ============================================
// CONFIGURATION
// ============================================
const OUTPUT_DIR = process.env.OUTPUT_DIR || './tmp/diagnostics';
const MIN_TRADES_FOR_FILTER = 5; // Minimum trades to consider a filter valid
const COVERAGE_THRESHOLD_LOW = 80; // Low coverage threshold

// ============================================
// TYPES
// ============================================

interface SignalWithOutcome {
  // Signal fields
  id: number;
  symbol: string;
  category: string;
  direction: string;
  time: number;
  price: number;
  stop: number;
  tp1: number;
  tp2: number;
  rr: number;
  riskPct: number;
  
  // Signal metrics
  vwap: number;
  ema200: number;
  rsi9: number;
  volSpike: number;
  atrPct: number;
  deltaVwapPct: number;
  
  // Gate conditions
  confirm15m: number;
  confirm15Strict: number;
  confirm15Soft: number;
  sessionOk: number;
  sweepOk: number;
  trendOk: number;
  blockedByBtc: number;
  btcGate: string;
  gateScore: number;
  
  // BTC context
  btcClose: number;
  btcVwap: number;
  btcEma200: number;
  btcRsi: number;
  btcDeltaVwap: number;
  btcBull: number;
  btcBear: number;
  
  // Extended outcome fields (24h)
  extStatus: string;
  extCompleted: boolean;
  extFirstTp1At: number | null;
  extTp2At: number | null;
  extStopAt: number | null;
  extCoveragePct: number;
  extMfePct: number;
  extMaePct: number;
  extTimeToTp1Seconds: number | null;
  extTimeToTp2Seconds: number | null;
  extTimeToStopSeconds: number | null;
  
  // Managed PnL fields
  extManagedR: number | null;
  extRunnerExitReason: string | null;
}

interface FilterRecommendation {
  rank: number;
  name: string;
  rule: string;
  why: string;
  tradesRemoved: number;
  newAvgR: number;
  newNetR: number;
  newWinRate: number;
  confidence: 'low' | 'med' | 'high';
  envMapping?: string;
}

interface LossPattern {
  dimension: string;
  value: string;
  count: number;
  totalTrades: number;
  netRDamage: number;
  avgR: number;
  stopRate: number;
}

interface WinnerCluster {
  dimension: string;
  value: string;
  count: number;
  tp2Rate: number;
  avgR: number;
  netR: number;
  stopRate: number;
}

// ============================================
// DATABASE CONNECTION
// ============================================

function createPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  
  const ssl = url.includes('sslmode=require') || url.includes('railway.app') 
    ? { rejectUnauthorized: false } 
    : undefined;
    
  return new Pool({
    connectionString: url,
    ssl,
    max: 5,
    connectionTimeoutMillis: 30000,
  });
}

// ============================================
// DATA FETCHING
// ============================================

async function fetchLiveData(pool: pg.Pool): Promise<{
  signals: SignalWithOutcome[];
  dbInfo: { host: string; database: string; latestTimestamp: number; rowCount: number };
}> {
  console.log('\n[DIAGNOSTICS] Connecting to production database...');
  
  const client = await pool.connect();
  try {
    // Get database info
    const dbInfoResult = await client.query(`
      SELECT 
        inet_server_addr() as host,
        current_database() as database,
        MAX(s.time) as latest_signal_time,
        COUNT(*) as signal_count
      FROM signals s
      WHERE s.category IN ('READY_TO_BUY', 'READY_TO_SELL', 'BEST_ENTRY', 'BEST_SHORT_ENTRY')
    `);
    
    const dbInfo = {
      host: dbInfoResult.rows[0]?.host ? '[RAILWAY-PROD]' : 'unknown',
      database: dbInfoResult.rows[0]?.database || 'unknown',
      latestTimestamp: Number(dbInfoResult.rows[0]?.latest_signal_time) || 0,
      rowCount: Number(dbInfoResult.rows[0]?.signal_count) || 0,
    };
    
    console.log(`[DIAGNOSTICS] Database: ${dbInfo.database}`);
    console.log(`[DIAGNOSTICS] Latest signal: ${new Date(dbInfo.latestTimestamp).toISOString()}`);
    console.log(`[DIAGNOSTICS] Total signals: ${dbInfo.rowCount}`);
    
    // Fetch signals with extended outcomes
    console.log('[DIAGNOSTICS] Fetching signals with extended outcomes...');
    
    const result = await client.query(`
      SELECT 
        s.id,
        s.symbol,
        s.category,
        CASE 
          WHEN s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY') THEN 'SHORT'
          ELSE 'LONG'
        END as direction,
        s.time,
        s.price,
        s.stop,
        s.tp1,
        s.tp2,
        s.rr,
        s.risk_pct as riskPct,
        s.vwap,
        s.ema200,
        s.rsi9,
        s.vol_spike as volSpike,
        s.atr_pct as atrPct,
        s.delta_v_wap_pct as deltaVwapPct,
        s.confirm15m,
        s.confirm15_strict as confirm15Strict,
        s.confirm15_soft as confirm15Soft,
        s.session_ok as sessionOk,
        s.sweep_ok as sweepOk,
        s.trend_ok as trendOk,
        s.blocked_by_btc as blockedByBtc,
        s.btc_gate as btcGate,
        s.gate_score as gateScore,
        s.btc_close as btcClose,
        s.btc_vwap as btcVwap,
        s.btc_ema200 as btcEma200,
        s.btc_rsi as btcRsi,
        s.btc_delta_vwap as btcDeltaVwap,
        s.btc_bull as btcBull,
        s.btc_bear as btcBear,
        eo.status as extStatus,
        eo.completed_at IS NOT NULL as extCompleted,
        eo.first_tp1_at as extFirstTp1At,
        eo.tp2_at as extTp2At,
        eo.stop_at as extStopAt,
        eo.coverage_pct as extCoveragePct,
        eo.max_favorable_excursion_pct as extMfePct,
        eo.max_adverse_excursion_pct as extMaePct,
        eo.time_to_tp1_seconds as extTimeToTp1Seconds,
        eo.time_to_tp2_seconds as extTimeToTp2Seconds,
        eo.time_to_stop_seconds as extTimeToStopSeconds,
        eo.ext24_managed_r as extManagedR,
        eo.ext24_runner_exit_reason as extRunnerExitReason
      FROM signals s
      LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
      WHERE s.category IN ('READY_TO_BUY', 'READY_TO_SELL', 'BEST_ENTRY', 'BEST_SHORT_ENTRY')
        AND eo.id IS NOT NULL
      ORDER BY s.time DESC
    `);
    
    console.log(`[DIAGNOSTICS] Fetched ${result.rows.length} signals with outcomes`);
    
    const signals = result.rows.map(row => ({
      ...row,
      extManagedR: row.extmanagedr !== null ? Number(row.extmanagedr) : null,
      extRunnerExitReason: row.extrunnerexitreason,
      extStatus: row.extstatus || 'PENDING',
      extCompleted: row.extcompleted === true || row.extcompleted === 't',
      extCoveragePct: Number(row.extcoveragepct) || 0,
      extMfePct: Number(row.extmfepct) || 0,
      extMaePct: Number(row.extmaepct) || 0,
      extFirstTp1At: row.extfirsttp1at ? Number(row.extfirsttp1at) : null,
      extTp2At: row.exttp2at ? Number(row.exttp2at) : null,
      extStopAt: row.extstopat ? Number(row.extstopat) : null,
      rsi9: Number(row.rsi9) || 0,
      volSpike: Number(row.volspike) || 0,
      atrPct: Number(row.atrpct) || 0,
      deltaVwapPct: Number(row.deltavwappct) || 0,
      rr: Number(row.rr) || 0,
      riskPct: Number(row.riskpct) || 0,
      confirm15m: row.confirm15m === 1 || row.confirm15m === 't' ? 1 : 0,
      confirm15Strict: row.confirm15strict === 1 || row.confirm15strict === 't' ? 1 : 0,
      confirm15Soft: row.confirm15soft === 1 || row.confirm15soft === 't' ? 1 : 0,
      sessionOk: row.sessionok === 1 || row.sessionok === 't' ? 1 : 0,
      sweepOk: row.sweepok === 1 || row.sweepok === 't' ? 1 : 0,
      trendOk: row.trendok === 1 || row.trendok === 't' ? 1 : 0,
      blockedByBtc: row.blockedbybtc === 1 || row.blockedbybtc === 't' ? 1 : 0,
      gateScore: Number(row.gatescore) || 0,
      btcRsi: Number(row.btcrsi) || 0,
    })) as SignalWithOutcome[];
    
    return { signals, dbInfo };
  } finally {
    client.release();
  }
}

// ============================================
// ANALYSIS FUNCTIONS
// ============================================

function getSessionBucket(hour: number): string {
  if (hour >= 1 && hour < 9) return 'Asia';
  if (hour >= 9 && hour < 16) return 'London';
  if (hour >= 16 && hour < 22) return 'NY';
  return 'LowLiquidity';
}

function analyzeOfficialOutcomes(signals: SignalWithOutcome[]) {
  const completed = signals.filter(s => s.extCompleted);
  
  const tp2 = completed.filter(s => s.extStatus === 'WIN_TP2');
  const lossStop = completed.filter(s => s.extStatus === 'LOSS_STOP');
  const timeout = completed.filter(s => s.extStatus === 'FLAT_TIMEOUT_24H');
  const tp1Only = completed.filter(s => s.extStatus === 'WIN_TP1');
  const pending = signals.filter(s => !s.extCompleted);
  
  return {
    total: signals.length,
    completed: completed.length,
    pending: pending.length,
    winTp2: tp2.length,
    lossStop: lossStop.length,
    flatTimeout: timeout.length,
    winTp1: tp1Only.length,
    winRate: completed.length > 0 ? (tp2.length + tp1Only.length) / completed.length : 0,
    stopRate: completed.length > 0 ? lossStop.length / completed.length : 0,
    timeoutRate: completed.length > 0 ? timeout.length / completed.length : 0,
  };
}

function analyzeManagedOutcomes(signals: SignalWithOutcome[]) {
  const closed = signals.filter(s => s.extCompleted && s.extManagedR !== null);
  
  if (closed.length === 0) {
    return {
      totalClosed: 0,
      avgManagedR: 0,
      netManagedR: 0,
      winRate: 0,
      stopBeforeTp1: 0,
      tp1ThenTp2: 0,
      tp1ThenBe: 0,
      tp1ThenTimeout: 0,
    };
  }
  
  const totalR = closed.reduce((sum, s) => sum + (s.extManagedR || 0), 0);
  const winners = closed.filter(s => (s.extManagedR || 0) > 0);
  const stopBeforeTp1 = closed.filter(s => s.extRunnerExitReason === 'STOP_BEFORE_TP1');
  const tp1ThenTp2 = closed.filter(s => s.extRunnerExitReason === 'TP2');
  const tp1ThenBe = closed.filter(s => s.extRunnerExitReason === 'BREAK_EVEN');
  const tp1ThenTimeout = closed.filter(s => s.extRunnerExitReason === 'TIMEOUT_MARKET' && s.extFirstTp1At);
  
  return {
    totalClosed: closed.length,
    avgManagedR: totalR / closed.length,
    netManagedR: totalR,
    winRate: winners.length / closed.length,
    stopBeforeTp1: stopBeforeTp1.length,
    tp1ThenTp2: tp1ThenTp2.length,
    tp1ThenBe: tp1ThenBe.length,
    tp1ThenTimeout: tp1ThenTimeout.length,
  };
}

function analyzeLossPatterns(signals: SignalWithOutcome[]): LossPattern[] {
  const losses = signals.filter(s => 
    s.extCompleted && (s.extManagedR === -1.0 || s.extStatus === 'LOSS_STOP')
  );
  
  if (losses.length === 0) return [];
  
  const patterns: LossPattern[] = [];
  
  // By symbol
  const bySymbol = groupBy(losses, 'symbol');
  for (const [symbol, trades] of Object.entries(bySymbol)) {
    const allTradesForSymbol = signals.filter(s => s.symbol === symbol);
    const totalR = trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0);
    patterns.push({
      dimension: 'Symbol',
      value: symbol,
      count: trades.length,
      totalTrades: allTradesForSymbol.length,
      netRDamage: totalR,
      avgR: totalR / trades.length,
      stopRate: trades.length / allTradesForSymbol.length,
    });
  }
  
  // By session
  const bySession = groupBy(losses, s => {
    const hour = new Date(s.time).getUTCHours();
    return getSessionBucket(hour);
  });
  for (const [session, trades] of Object.entries(bySession)) {
    const allTradesForSession = signals.filter(s => {
      const hour = new Date(s.time).getUTCHours();
      return getSessionBucket(hour) === session;
    });
    const totalR = trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0);
    patterns.push({
      dimension: 'Session',
      value: session,
      count: trades.length,
      totalTrades: allTradesForSession.length,
      netRDamage: totalR,
      avgR: totalR / trades.length,
      stopRate: trades.length / allTradesForSession.length,
    });
  }
  
  // By coverage bucket
  const byCoverage = groupBy(losses, s => {
    if (s.extCoveragePct < 70) return 'Low (<70%)';
    if (s.extCoveragePct < 90) return 'Med (70-90%)';
    return 'High (90%+';
  });
  for (const [coverage, trades] of Object.entries(byCoverage)) {
    const allTradesForCoverage = signals.filter(s => {
      if (coverage === 'Low (<70%)') return s.extCoveragePct < 70;
      if (coverage === 'Med (70-90%)') return s.extCoveragePct >= 70 && s.extCoveragePct < 90;
      return s.extCoveragePct >= 90;
    });
    const totalR = trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0);
    patterns.push({
      dimension: 'Coverage',
      value: coverage,
      count: trades.length,
      totalTrades: allTradesForCoverage.length,
      netRDamage: totalR,
      avgR: totalR / trades.length,
      stopRate: trades.length / allTradesForCoverage.length,
    });
  }
  
  // By RSI range
  const byRsi = groupBy(losses, s => {
    if (s.rsi9 < 40) return 'RSI<40';
    if (s.rsi9 < 55) return 'RSI 40-55';
    if (s.rsi9 < 70) return 'RSI 55-70';
    return 'RSI 70+';
  });
  for (const [rsiRange, trades] of Object.entries(byRsi)) {
    const allTradesForRsi = signals.filter(s => {
      if (rsiRange === 'RSI<40') return s.rsi9 < 40;
      if (rsiRange === 'RSI 40-55') return s.rsi9 >= 40 && s.rsi9 < 55;
      if (rsiRange === 'RSI 55-70') return s.rsi9 >= 55 && s.rsi9 < 70;
      return s.rsi9 >= 70;
    });
    const totalR = trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0);
    patterns.push({
      dimension: 'RSI',
      value: rsiRange,
      count: trades.length,
      totalTrades: allTradesForRsi.length,
      netRDamage: totalR,
      avgR: totalR / trades.length,
      stopRate: trades.length / allTradesForRsi.length,
    });
  }
  
  // By category
  const byCategory = groupBy(losses, 'category');
  for (const [category, trades] of Object.entries(byCategory)) {
    const allTradesForCategory = signals.filter(s => s.category === category);
    const totalR = trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0);
    patterns.push({
      dimension: 'Category',
      value: category,
      count: trades.length,
      totalTrades: allTradesForCategory.length,
      netRDamage: totalR,
      avgR: totalR / trades.length,
      stopRate: trades.length / allTradesForCategory.length,
    });
  }
  
  // Sort by net R damage (most negative first)
  return patterns.sort((a, b) => a.netRDamage - b.netRDamage);
}

function analyzeTp1ButNoTp2(signals: SignalWithOutcome[]) {
  const tp1Only = signals.filter(s => 
    s.extCompleted && 
    s.extFirstTp1At && 
    !s.extTp2At &&
    (s.extManagedR === 0.5 || (s.extManagedR && s.extManagedR > 0 && s.extManagedR < 1.0))
  );
  
  const tp2Winners = signals.filter(s => 
    s.extCompleted && s.extTp2At
  );
  
  return {
    tp1OnlyCount: tp1Only.length,
    tp2Count: tp2Winners.length,
    avgMfeTp1Only: tp1Only.length > 0 ? tp1Only.reduce((sum, s) => sum + s.extMfePct, 0) / tp1Only.length : 0,
    avgMfeTp2: tp2Winners.length > 0 ? tp2Winners.reduce((sum, s) => sum + s.extMfePct, 0) / tp2Winners.length : 0,
    avgMaeTp1Only: tp1Only.length > 0 ? tp1Only.reduce((sum, s) => sum + s.extMaePct, 0) / tp1Only.length : 0,
    avgMaeTp2: tp2Winners.length > 0 ? tp2Winners.reduce((sum, s) => sum + s.extMaePct, 0) / tp2Winners.length : 0,
    avgTimeToTp1: tp1Only.length > 0 && tp1Only.filter(s => s.extTimeToTp1Seconds).length > 0
      ? tp1Only.filter(s => s.extTimeToTp1Seconds).reduce((sum, s) => sum + (s.extTimeToTp1Seconds || 0), 0) / tp1Only.filter(s => s.extTimeToTp1Seconds).length / 60
      : 0,
    avgCoverageTp1Only: tp1Only.length > 0 ? tp1Only.reduce((sum, s) => sum + s.extCoveragePct, 0) / tp1Only.length : 0,
    avgCoverageTp2: tp2Winners.length > 0 ? tp2Winners.reduce((sum, s) => sum + s.extCoveragePct, 0) / tp2Winners.length : 0,
  };
}

function findWinnerClusters(signals: SignalWithOutcome[]): WinnerCluster[] {
  const completed = signals.filter(s => s.extCompleted);
  const clusters: WinnerCluster[] = [];
  
  // By symbol
  const bySymbol = groupBy(completed, 'symbol');
  for (const [symbol, trades] of Object.entries(bySymbol)) {
    if (trades.length < 3) continue;
    const tp2Hits = trades.filter(s => s.extTp2At);
    const avgR = trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0) / trades.length;
    const stops = trades.filter(s => s.extStatus === 'LOSS_STOP');
    clusters.push({
      dimension: 'Symbol',
      value: symbol,
      count: trades.length,
      tp2Rate: tp2Hits.length / trades.length,
      avgR,
      netR: trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0),
      stopRate: stops.length / trades.length,
    });
  }
  
  // By session
  const bySession = groupBy(completed, s => {
    const hour = new Date(s.time).getUTCHours();
    return getSessionBucket(hour);
  });
  for (const [session, trades] of Object.entries(bySession)) {
    if (trades.length < 5) continue;
    const tp2Hits = trades.filter(s => s.extTp2At);
    const avgR = trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0) / trades.length;
    const stops = trades.filter(s => s.extStatus === 'LOSS_STOP');
    clusters.push({
      dimension: 'Session',
      value: session,
      count: trades.length,
      tp2Rate: tp2Hits.length / trades.length,
      avgR,
      netR: trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0),
      stopRate: stops.length / trades.length,
    });
  }
  
  // By RSI range
  const byRsi = groupBy(completed, s => {
    if (s.rsi9 < 50) return 'RSI<50';
    if (s.rsi9 < 60) return 'RSI 50-60';
    if (s.rsi9 < 70) return 'RSI 60-70';
    return 'RSI 70+';
  });
  for (const [rsiRange, trades] of Object.entries(byRsi)) {
    if (trades.length < 5) continue;
    const tp2Hits = trades.filter(s => s.extTp2At);
    const avgR = trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0) / trades.length;
    const stops = trades.filter(s => s.extStatus === 'LOSS_STOP');
    clusters.push({
      dimension: 'RSI',
      value: rsiRange,
      count: trades.length,
      tp2Rate: tp2Hits.length / trades.length,
      avgR,
      netR: trades.reduce((sum, s) => sum + (s.extManagedR || 0), 0),
      stopRate: stops.length / trades.length,
    });
  }
  
  // By gate combinations
  const strongGates = completed.filter(s => 
    s.sweepOk && s.trendOk && s.confirm15m && s.sessionOk
  );
  if (strongGates.length >= 5) {
    const tp2Hits = strongGates.filter(s => s.extTp2At);
    const avgR = strongGates.reduce((sum, s) => sum + (s.extManagedR || 0), 0) / strongGates.length;
    const stops = strongGates.filter(s => s.extStatus === 'LOSS_STOP');
    clusters.push({
      dimension: 'Gates',
      value: 'All Strong (sweep+trend+confirm15+session)',
      count: strongGates.length,
      tp2Rate: tp2Hits.length / strongGates.length,
      avgR,
      netR: strongGates.reduce((sum, s) => sum + (s.extManagedR || 0), 0),
      stopRate: stops.length / strongGates.length,
    });
  }
  
  return clusters.sort((a, b) => b.avgR - a.avgR);
}

function generateFilterRecommendations(signals: SignalWithOutcome[]): FilterRecommendation[] {
  const recommendations: FilterRecommendation[] = [];
  const baseline = analyzeManagedOutcomes(signals);
  
  // Test: Exclude low coverage
  const withoutLowCoverage = signals.filter(s => s.extCoveragePct >= 85);
  const withoutLowCoverageStats = analyzeManagedOutcomes(withoutLowCoverage);
  const removedLowCoverage = signals.length - withoutLowCoverage.length;
  if (removedLowCoverage > 0 && withoutLowCoverageStats.avgManagedR > baseline.avgManagedR) {
    recommendations.push({
      rank: 0,
      name: 'High Coverage Filter',
      rule: 'ext_coverage_pct >= 85',
      why: 'Low coverage outcomes have unreliable hit detection due to missing data',
      tradesRemoved: removedLowCoverage,
      newAvgR: withoutLowCoverageStats.avgManagedR,
      newNetR: withoutLowCoverageStats.netManagedR,
      newWinRate: withoutLowCoverageStats.winRate,
      confidence: removedLowCoverage >= 10 ? 'high' : 'med',
      envMapping: 'OUTCOME_MIN_COVERAGE_PCT=85',
    });
  }
  
  // Test: Tighten RSI range (exclude extremes)
  const rsiSweetSpot = signals.filter(s => s.rsi9 >= 45 && s.rsi9 <= 70);
  const rsiSweetSpotStats = analyzeManagedOutcomes(rsiSweetSpot);
  const removedRsi = signals.length - rsiSweetSpot.length;
  if (removedRsi > 0 && rsiSweetSpotStats.avgManagedR > baseline.avgManagedR) {
    recommendations.push({
      rank: 0,
      name: 'RSI Sweet Spot Filter',
      rule: 'rsi9 >= 45 AND rsi9 <= 70',
      why: 'Excludes weak momentum (RSI<45) and overbought (RSI>70) conditions',
      tradesRemoved: removedRsi,
      newAvgR: rsiSweetSpotStats.avgManagedR,
      newNetR: rsiSweetSpotStats.netManagedR,
      newWinRate: rsiSweetSpotStats.winRate,
      confidence: removedRsi >= 10 ? 'high' : 'med',
      envMapping: 'RSI_READY_MIN=45, RSI_READY_MAX=70',
    });
  }
  
  // Test: Require volume spike
  const withVolSpike = signals.filter(s => s.volSpike >= 1.5);
  const withVolSpikeStats = analyzeManagedOutcomes(withVolSpike);
  const removedVol = signals.length - withVolSpike.length;
  if (removedVol > 0 && withVolSpikeStats.avgManagedR > baseline.avgManagedR) {
    recommendations.push({
      rank: 0,
      name: 'Volume Spike Filter',
      rule: 'vol_spike >= 1.5',
      why: 'Requires significant volume confirmation for entries',
      tradesRemoved: removedVol,
      newAvgR: withVolSpikeStats.avgManagedR,
      newNetR: withVolSpikeStats.netManagedR,
      newWinRate: withVolSpikeStats.winRate,
      confidence: removedVol >= 10 ? 'high' : 'med',
      envMapping: 'THRESHOLD_VOL_SPIKE_X=1.5, READY_VOL_SPIKE_REQUIRED=true',
    });
  }
  
  // Test: Exclude Asia/LowLiquidity session
  const noAsia = signals.filter(s => {
    const hour = new Date(s.time).getUTCHours();
    return getSessionBucket(hour) !== 'Asia' && getSessionBucket(hour) !== 'LowLiquidity';
  });
  const noAsiaStats = analyzeManagedOutcomes(noAsia);
  const removedAsia = signals.length - noAsia.length;
  if (removedAsia > 0 && noAsiaStats.avgManagedR > baseline.avgManagedR) {
    recommendations.push({
      rank: 0,
      name: 'Session Filter (Exclude Asia)',
      rule: "EXCLUDE session = 'Asia' OR 'LowLiquidity'",
      why: 'Low liquidity periods have higher slippage and false signals',
      tradesRemoved: removedAsia,
      newAvgR: noAsiaStats.avgManagedR,
      newNetR: noAsiaStats.netManagedR,
      newWinRate: noAsiaStats.winRate,
      confidence: removedAsia >= 10 ? 'high' : 'med',
      envMapping: 'SESSION_FILTER_ENABLED=true',
    });
  }
  
  // Test: Strong gate confluence
  const strongConfluence = signals.filter(s => 
    s.trendOk && s.sweepOk && s.confirm15m
  );
  const strongConfluenceStats = analyzeManagedOutcomes(strongConfluence);
  const removedWeakConfluence = signals.length - strongConfluence.length;
  if (removedWeakConfluence > 0 && strongConfluenceStats.avgManagedR > baseline.avgManagedR) {
    recommendations.push({
      rank: 0,
      name: 'Strong Confluence Filter',
      rule: 'trend_ok AND sweep_ok AND confirm15m',
      why: 'Requires all major confirmation gates to pass',
      tradesRemoved: removedWeakConfluence,
      newAvgR: strongConfluenceStats.avgManagedR,
      newNetR: strongConfluenceStats.netManagedR,
      newWinRate: strongConfluenceStats.winRate,
      confidence: removedWeakConfluence >= 10 ? 'high' : 'med',
      envMapping: 'READY_TREND_REQUIRED=true, READY_SWEEP_REQUIRED=true, READY_CONFIRM15_REQUIRED=true',
    });
  }
  
  // Test: Exclude high ATR% (volatile)
  const normalAtr = signals.filter(s => s.atrPct < 2.0);
  const normalAtrStats = analyzeManagedOutcomes(normalAtr);
  const removedHighAtr = signals.length - normalAtr.length;
  if (removedHighAtr > 0 && normalAtrStats.avgManagedR > baseline.avgManagedR) {
    recommendations.push({
      rank: 0,
      name: 'ATR Filter (Low Volatility)',
      rule: 'atr_pct < 2.0',
      why: 'High volatility increases stop-out probability',
      tradesRemoved: removedHighAtr,
      newAvgR: normalAtrStats.avgManagedR,
      newNetR: normalAtrStats.netManagedR,
      newWinRate: normalAtrStats.winRate,
      confidence: removedHighAtr >= 10 ? 'high' : 'med',
      envMapping: 'MIN_ATR_PCT=0.2, MAX_ATR_PCT=2.0',
    });
  }
  
  // Test: Exclude blocked_by_btc
  const notBlockedByBtc = signals.filter(s => !s.blockedByBtc);
  const notBlockedByBtcStats = analyzeManagedOutcomes(notBlockedByBtc);
  const removedBlockedBtc = signals.length - notBlockedByBtc.length;
  if (removedBlockedBtc > 0 && notBlockedByBtcStats.avgManagedR > baseline.avgManagedR) {
    recommendations.push({
      rank: 0,
      name: 'BTC Gate Filter',
      rule: 'NOT blocked_by_btc',
      why: 'Trades taken during adverse BTC conditions underperform',
      tradesRemoved: removedBlockedBtc,
      newAvgR: notBlockedByBtcStats.avgManagedR,
      newNetR: notBlockedByBtcStats.netManagedR,
      newWinRate: notBlockedByBtcStats.winRate,
      confidence: removedBlockedBtc >= 10 ? 'high' : 'med',
      envMapping: 'READY_BTC_REQUIRED=true',
    });
  }
  
  // Sort by improvement in Avg R, then assign ranks
  const sorted = recommendations
    .filter(r => r.tradesRemoved > 0)
    .sort((a, b) => b.newAvgR - a.newAvgR);
  
  sorted.forEach((r, i) => { r.rank = i + 1; });
  
  return sorted;
}

// ============================================
// UTILITIES
// ============================================

function groupBy<T>(array: T[], key: keyof T | ((item: T) => string)): Record<string, T[]> {
  return array.reduce((result, item) => {
    const groupKey = typeof key === 'function' ? key(item) : String(item[key]);
    if (!result[groupKey]) result[groupKey] = [];
    result[groupKey].push(item);
    return result;
  }, {} as Record<string, T[]>);
}

function formatR(r: number): string {
  const sign = r >= 0 ? '+' : '';
  return `${sign}${r.toFixed(2)}R`;
}

function formatPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

// ============================================
// REPORT GENERATION
// ============================================

function generateReport(
  dbInfo: any,
  official: any,
  managed: any,
  lossPatterns: LossPattern[],
  tp1Analysis: any,
  winnerClusters: WinnerCluster[],
  recommendations: FilterRecommendation[]
): string {
  const report = [];
  
  report.push('# Quant Strategy Diagnostic Report');
  report.push('');
  report.push('## 1. Live Data Verification');
  report.push('');
  report.push(`- **Database Host:** ${dbInfo.host}`);
  report.push(`- **Database Name:** ${dbInfo.database}`);
  report.push(`- **Latest Signal Timestamp:** ${new Date(dbInfo.latestTimestamp).toISOString()}`);
  report.push(`- **Total Signals Queried:** ${dbInfo.rowCount}`);
  report.push(`- **Tables Queried:** signals, extended_outcomes`);
  report.push('');
  
  report.push('## 2. Strategy Diagnostic Summary');
  report.push('');
  report.push('### Official Outcomes (24h)');
  report.push(`- Total Signals: ${official.total}`);
  report.push(`- Completed: ${official.completed}`);
  report.push(`- Pending: ${official.pending}`);
  report.push(`- WIN TP2: ${official.winTp2}`);
  report.push(`- WIN TP1: ${official.winTp1}`);
  report.push(`- LOSS STOP: ${official.lossStop}`);
  report.push(`- FLAT TIMEOUT: ${official.flatTimeout}`);
  report.push(`- Official Win Rate: ${formatPct(official.winRate)}`);
  report.push(`- Official Stop Rate: ${formatPct(official.stopRate)}`);
  report.push('');
  report.push('### Managed Outcomes (Option B)');
  report.push(`- Total Closed: ${managed.totalClosed}`);
  report.push(`- Managed Avg R/trade: ${formatR(managed.avgManagedR)}`);
  report.push(`- Managed Net R: ${formatR(managed.netManagedR)}`);
  report.push(`- Managed Win Rate: ${formatPct(managed.winRate)}`);
  report.push(`- Stop Before TP1: ${managed.stopBeforeTp1}`);
  report.push(`- TP1 → TP2: ${managed.tp1ThenTp2}`);
  report.push(`- TP1 → BE: ${managed.tp1ThenBe}`);
  report.push(`- TP1 → Timeout: ${managed.tp1ThenTimeout}`);
  report.push('');
  
  report.push('### Main Leaks');
  const topLosses = lossPatterns.slice(0, 5);
  topLosses.forEach(p => {
    report.push(`- **${p.dimension} = ${p.value}**: ${p.count} stops (${formatPct(p.stopRate)} stop rate), Avg R: ${formatR(p.avgR)}`);
  });
  report.push('');
  
  report.push('### Main Strengths');
  const topClusters = winnerClusters.slice(0, 5);
  topClusters.forEach(c => {
    report.push(`- **${c.dimension} = ${c.value}**: Avg R ${formatR(c.avgR)}, TP2 Rate: ${formatPct(c.tp2Rate)}`);
  });
  report.push('');
  
  report.push('## 3. Loss Analysis Table');
  report.push('');
  report.push('| Dimension | Value | Count | Total Trades | Stop Rate | Net R Damage | Avg R |');
  report.push('|-----------|-------|-------|--------------|-----------|--------------|-------|');
  lossPatterns.slice(0, 20).forEach(p => {
    report.push(`| ${p.dimension} | ${p.value} | ${p.count} | ${p.totalTrades} | ${formatPct(p.stopRate)} | ${formatR(p.netRDamage)} | ${formatR(p.avgR)} |`);
  });
  report.push('');
  
  report.push('## 4. Winner Blueprint Table');
  report.push('');
  report.push('| Dimension | Value | Count | TP2 Rate | Stop Rate | Avg R | Net R |');
  report.push('|-----------|-------|-------|----------|-----------|-------|-------|');
  winnerClusters.slice(0, 20).forEach(c => {
    report.push(`| ${c.dimension} | ${c.value} | ${c.count} | ${formatPct(c.tp2Rate)} | ${formatPct(c.stopRate)} | ${formatR(c.avgR)} | ${formatR(c.netR)} |`);
  });
  report.push('');
  
  report.push('## 5. TP1 vs TP2 Analysis (Almost Good Trades)');
  report.push('');
  report.push('| Metric | TP1 Only | TP2 Winners | Delta |');
  report.push('|--------|----------|-------------|-------|');
  report.push(`| Count | ${tp1Analysis.tp1OnlyCount} | ${tp1Analysis.tp2Count} | - |`);
  report.push(`| Avg MFE% | ${tp1Analysis.avgMfeTp1Only.toFixed(2)}% | ${tp1Analysis.avgMfeTp2.toFixed(2)}% | ${(tp1Analysis.avgMfeTp2 - tp1Analysis.avgMfeTp1Only).toFixed(2)}% |`);
  report.push(`| Avg MAE% | ${tp1Analysis.avgMaeTp1Only.toFixed(2)}% | ${tp1Analysis.avgMaeTp2.toFixed(2)}% | ${(tp1Analysis.avgMaeTp2 - tp1Analysis.avgMaeTp1Only).toFixed(2)}% |`);
  report.push(`| Avg Coverage% | ${tp1Analysis.avgCoverageTp1Only.toFixed(1)}% | ${tp1Analysis.avgCoverageTp2.toFixed(1)}% | ${(tp1Analysis.avgCoverageTp2 - tp1Analysis.avgCoverageTp1Only).toFixed(1)}% |`);
  report.push(`| Avg Time to TP1 | ${tp1Analysis.avgTimeToTp1.toFixed(0)}m | - | - |`);
  report.push('');
  
  report.push('## 6. Ranked Filter Recommendations');
  report.push('');
  recommendations.forEach(r => {
    report.push(`### Rank ${r.rank}: ${r.name}`);
    report.push(`- **Filter Rule:** ${r.rule}`);
    report.push(`- **Why:** ${r.why}`);
    report.push(`- **Trades Removed:** ${r.tradesRemoved}`);
    report.push(`- **New Managed Avg R:** ${formatR(r.newAvgR)}`);
    report.push(`- **New Managed Net R:** ${formatR(r.newNetR)}`);
    report.push(`- **New Managed Win Rate:** ${formatPct(r.newWinRate)}`);
    report.push(`- **Confidence:** ${r.confidence.toUpperCase()}`);
    if (r.envMapping) report.push(`- **ENV Mapping:** ${r.envMapping}`);
    report.push('');
  });
  
  report.push('## 7. Safe First Changes (Conservative)');
  report.push('');
  report.push('These filters are recommended for immediate testing (high confidence, minimal overfitting risk):');
  report.push('');
  const safeChanges = recommendations.filter(r => r.confidence === 'high').slice(0, 5);
  safeChanges.forEach((r, i) => {
    report.push(`${i + 1}. **${r.name}** (${r.rule}) - Improves Avg R from ${formatR(managed.avgManagedR)} to ${formatR(r.newAvgR)}`);
  });
  if (safeChanges.length === 0) {
    report.push('No high-confidence filters identified. Consider waiting for more data.');
  }
  report.push('');
  
  report.push('---');
  report.push(`Report generated: ${new Date().toISOString()}`);
  
  return report.join('\n');
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       QUANT STRATEGY DIAGNOSTICS - RAILWAY PRODUCTION        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  if (!process.env.DATABASE_URL) {
    console.error('\n❌ ERROR: DATABASE_URL environment variable is required');
    console.error('\nTo get your Railway DATABASE_URL:');
    console.error('  1. railway variables --project=your-project');
    console.error('  2. Or: railway open -> Variables tab');
    console.error('\nThen run:');
    console.error('  DATABASE_URL="postgresql://..." npx tsx tmp/quantDiagnostics.ts');
    process.exit(1);
  }
  
  const pool = createPool();
  
  try {
    const { signals, dbInfo } = await fetchLiveData(pool);
    
    if (signals.length === 0) {
      console.error('\n❌ No signals with extended outcomes found');
      process.exit(1);
    }
    
    console.log('\n[ANALYSIS] Running diagnostics...');
    
    const official = analyzeOfficialOutcomes(signals);
    const managed = analyzeManagedOutcomes(signals);
    const lossPatterns = analyzeLossPatterns(signals);
    const tp1Analysis = analyzeTp1ButNoTp2(signals);
    const winnerClusters = findWinnerClusters(signals);
    const recommendations = generateFilterRecommendations(signals);
    
    console.log('[ANALYSIS] Generating report...');
    
    const report = generateReport(
      dbInfo,
      official,
      managed,
      lossPatterns,
      tp1Analysis,
      winnerClusters,
      recommendations
    );
    
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Write report
    const reportPath = path.join(OUTPUT_DIR, 'quant_diagnostics_report.md');
    fs.writeFileSync(reportPath, report);
    console.log(`\n✅ Report written to: ${reportPath}`);
    
    // Write JSON data for further analysis
    const jsonPath = path.join(OUTPUT_DIR, 'quant_diagnostics_data.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      dbInfo,
      official,
      managed,
      lossPatterns: lossPatterns.slice(0, 30),
      tp1Analysis,
      winnerClusters: winnerClusters.slice(0, 30),
      recommendations,
    }, null, 2));
    console.log(`✅ Data written to: ${jsonPath}`);
    
    // Print summary
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                      EXECUTIVE SUMMARY                       ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Total Signals:     ${String(signals.length).padEnd(42)} ║`);
    console.log(`║  Managed Avg R:     ${formatR(managed.avgManagedR).padEnd(42)} ║`);
    console.log(`║  Managed Net R:     ${formatR(managed.netManagedR).padEnd(42)} ║`);
    console.log(`║  Managed Win Rate:  ${formatPct(managed.winRate).padEnd(42)} ║`);
    console.log(`║  Top Filter:        ${(recommendations[0]?.name || 'N/A').padEnd(42)} ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
