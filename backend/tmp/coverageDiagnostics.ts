#!/usr/bin/env npx tsx
/**
 * Coverage Diagnostics Tool
 * 
 * Investigates low coverage issues in extended outcome evaluation.
 * Connects to LIVE Railway production DB to trace the exact data flow.
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

// Configuration
const OUTPUT_DIR = process.env.OUTPUT_DIR || './tmp/coverage-diagnostics';
const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

// Constants matching the production code
const EXTENDED_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const EVALUATION_INTERVAL_MIN = 5;
const EVALUATION_INTERVAL_MS = EVALUATION_INTERVAL_MIN * 60 * 1000;

interface LowCoverageTrade {
  signalId: number;
  symbol: string;
  category: string;
  signalTime: number;
  signalTimeUtc: string;
  entryTime: number;
  entryTimeUtc: string;
  expiresAt: number;
  expiresAtUtc: string;
  expectedCandles: number;
  actualCandles: number;
  coveragePct: number;
  status: string;
  completedAt: number | null;
  firstTp1At: number | null;
  tp2At: number | null;
  stopAt: number | null;
  windowHoursElapsed: number;
  isExpired: boolean;
  rootCause?: string;
}

interface CandleFetchAudit {
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
  expectedFromApi: number;
  actualReceived: number;
  firstCandleTime?: number;
  lastCandleTime?: number;
  gaps: Array<{ from: number; to: number }>;
  duplicates: number;
}

// ============================================
// DATABASE CONNECTION
// ============================================

function createPool(): pg.Pool {
  const ssl = DB_URL!.includes('railway.app') 
    ? { rejectUnauthorized: false } 
    : undefined;
    
  return new Pool({
    connectionString: DB_URL,
    ssl,
    max: 5,
    connectionTimeoutMillis: 30000,
  });
}

// ============================================
// DIAGNOSTIC FUNCTIONS
// ============================================

async function fetchLowCoverageTrades(pool: pg.Pool, threshold = 80): Promise<LowCoverageTrade[]> {
  const client = await pool.connect();
  try {
    console.log(`[DIAGNOSTICS] Fetching trades with coverage < ${threshold}%...`);
    
    const result = await client.query(`
      SELECT 
        eo.signal_id,
        eo.symbol,
        eo.category,
        eo.signal_time,
        eo.entry_price,
        eo.expires_at,
        eo.coverage_pct,
        eo.n_candles_evaluated,
        eo.n_candles_expected,
        eo.status,
        eo.completed_at,
        eo.first_tp1_at,
        eo.tp2_at,
        eo.stop_at,
        s.entry_time,
        s.time as raw_signal_time
      FROM extended_outcomes eo
      JOIN signals s ON s.id = eo.signal_id
      WHERE eo.coverage_pct < $1
      ORDER BY eo.coverage_pct ASC, eo.signal_time DESC
      LIMIT 50
    `, [threshold]);
    
    console.log(`[DIAGNOSTICS] Found ${result.rows.length} low-coverage trades`);
    
    const now = Date.now();
    
    return result.rows.map(row => {
      const signalTime = Number(row.signal_time);
      const entryTime = Number(row.entry_time) || signalTime;
      const expiresAt = Number(row.expires_at);
      const completedAt = row.completed_at ? Number(row.completed_at) : null;
      
      // Calculate expected candles correctly (same as production code)
      const expectedCandles = Math.floor(EXTENDED_WINDOW_MS / EVALUATION_INTERVAL_MS);
      const actualCandles = Number(row.n_candles_evaluated) || 0;
      const coveragePct = Number(row.coverage_pct) || 0;
      
      return {
        signalId: Number(row.signal_id),
        symbol: row.symbol,
        category: row.category,
        signalTime,
        signalTimeUtc: new Date(signalTime).toISOString(),
        entryTime,
        entryTimeUtc: new Date(entryTime).toISOString(),
        expiresAt,
        expiresAtUtc: new Date(expiresAt).toISOString(),
        expectedCandles,
        actualCandles,
        coveragePct,
        status: row.status,
        completedAt,
        firstTp1At: row.first_tp1_at ? Number(row.first_tp1_at) : null,
        tp2At: row.tp2_at ? Number(row.tp2_at) : null,
        stopAt: row.stop_at ? Number(row.stop_at) : null,
        windowHoursElapsed: (now - signalTime) / (60 * 60 * 1000),
        isExpired: now >= expiresAt,
      };
    });
  } finally {
    client.release();
  }
}

async function analyzeTrade(pool: pg.Pool, trade: LowCoverageTrade): Promise<LowCoverageTrade> {
  const client = await pool.connect();
  try {
    // Check if candles are stored anywhere
    const candleTables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name LIKE '%candle%'
    `);
    
    // Get debug info if available
    const debugResult = await client.query(`
      SELECT debug_json 
      FROM extended_outcomes 
      WHERE signal_id = $1
    `, [trade.signalId]);
    
    let debugInfo: any = null;
    if (debugResult.rows[0]?.debug_json) {
      try {
        debugInfo = JSON.parse(debugResult.rows[0].debug_json);
      } catch {}
    }
    
    // Calculate what we expected vs what we got
    const analysis = {
      expectedWindowStart: trade.signalTime,
      expectedWindowEnd: Math.min(trade.expiresAt, Date.now()),
      full24hWindow: trade.expiresAt,
      expectedCandlesIfComplete: Math.floor(EXTENDED_WINDOW_MS / EVALUATION_INTERVAL_MS),
      expectedCandlesIfPartial: Math.floor((Math.min(Date.now(), trade.expiresAt) - trade.signalTime) / EVALUATION_INTERVAL_MS),
      debugCandlesProcessed: debugInfo?.candlesProcessed || 'unknown',
      debugFirstCandle: debugInfo?.firstCandleTime || 'unknown',
      debugLastCandle: debugInfo?.lastCandleTime || 'unknown',
    };
    
    // Determine root cause
    let rootCause = 'UNKNOWN';
    
    if (!trade.isExpired) {
      rootCause = 'WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet';
    } else if (trade.actualCandles === 0) {
      rootCause = 'NO_CANDLES_FETCHED - API returned zero candles for the window';
    } else if (trade.coveragePct < 10) {
      rootCause = 'EXTREME_LOW_COVERAGE - Likely API pagination failure or rate limit';
    } else if (trade.coveragePct < 50) {
      rootCause = 'PARTIAL_CANDLE_DATA - API returned incomplete data, possible pagination bug';
    } else if (trade.coveragePct < 80) {
      rootCause = 'MODERATE_LOW_COVERAGE - Some candles missing, check API limits/symbol availability';
    }
    
    // Check for specific issues
    const issues: string[] = [];
    
    // Issue 1: Evaluated before window expired
    if (trade.completedAt && trade.completedAt < trade.expiresAt) {
      issues.push(`FINALIZED_TOO_EARLY: completed_at (${new Date(trade.completedAt).toISOString()}) < expires_at (${new Date(trade.expiresAt).toISOString()})`);
    }
    
    // Issue 2: Expected vs actual mismatch
    if (trade.isExpired && trade.actualCandles < analysis.expectedCandlesIfComplete * 0.8) {
      issues.push(`MISSING_CANDLES: Got ${trade.actualCandles}, expected ~${analysis.expectedCandlesIfComplete}`);
    }
    
    // Issue 3: Check if entry time alignment issue
    const alignedTo5m = trade.signalTime % (5 * 60 * 1000) === 0;
    if (!alignedTo5m) {
      issues.push(`TIME_NOT_5M_ALIGNED: signal_time may not align to candle boundaries`);
    }
    
    return {
      ...trade,
      rootCause: `${rootCause}\n  Issues: ${issues.join(', ') || 'None detected'}`,
    };
  } finally {
    client.release();
  }
}

function validateExpectedCandleMath(): void {
  console.log('\n[VALIDATION] Expected Candle Count Math:');
  console.log('==========================================');
  
  const windowMs = 24 * 60 * 60 * 1000; // 86400000
  const intervalMs = 5 * 60 * 1000; // 300000
  
  console.log(`Window duration: ${windowMs}ms (24h)`);
  console.log(`Interval duration: ${intervalMs}ms (5m)`);
  console.log(`Raw division: ${windowMs / intervalMs}`);
  console.log(`Math.floor(): ${Math.floor(windowMs / intervalMs)}`);
  console.log(`Expected candles: 288 (for full 24h)`);
  
  // Example calculations for real scenarios
  const examples = [
    { hours: 1, desc: '1 hour elapsed' },
    { hours: 6, desc: '6 hours elapsed' },
    { hours: 12, desc: '12 hours elapsed' },
    { hours: 24, desc: '24 hours elapsed (complete)' },
  ];
  
  console.log('\nPartial window examples:');
  for (const ex of examples) {
    const elapsedMs = ex.hours * 60 * 60 * 1000;
    const expected = Math.floor(elapsedMs / intervalMs);
    console.log(`  ${ex.desc}: ~${expected} candles expected`);
  }
}

async function checkSignalTimestampAlignment(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('\n[VALIDATION] Signal Timestamp Alignment:');
    console.log('==========================================');
    
    const result = await client.query(`
      SELECT 
        id,
        symbol,
        time,
        entry_time,
        entry_candle_open_time,
        MOD(time, 300000) as time_mod_5m
      FROM signals
      WHERE id IN (SELECT signal_id FROM extended_outcomes WHERE coverage_pct < 80)
      LIMIT 10
    `);
    
    console.log('\nSample low-coverage signal timestamps:');
    console.log('ID | Symbol | Time (UTC) | Time Mod 5m | Entry Time | Entry Candle Open');
    console.log('---|--------|------------|-------------|------------|------------------');
    
    for (const row of result.rows) {
      const time = new Date(Number(row.time)).toISOString();
      const mod5m = Number(row.time_mod_5m);
      const entryTime = row.entry_time ? new Date(Number(row.entry_time)).toISOString() : 'NULL';
      const entryOpen = row.entry_candle_open_time ? new Date(Number(row.entry_candle_open_time)).toISOString() : 'NULL';
      
      console.log(`${row.id} | ${row.symbol} | ${time} | ${mod5m}ms | ${entryTime} | ${entryOpen}`);
      
      if (mod5m !== 0) {
        console.log(`   ⚠️  WARNING: Time not aligned to 5m boundary! Offset: ${mod5m}ms`);
      }
    }
  } finally {
    client.release();
  }
}

async function checkEvaluatorTiming(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('\n[VALIDATION] Evaluator Timing Analysis:');
    console.log('==========================================');
    
    const result = await client.query(`
      SELECT 
        status,
        completed_at,
        expires_at,
        signal_time,
        coverage_pct,
        CASE 
          WHEN completed_at IS NULL THEN 'PENDING'
          WHEN completed_at < expires_at THEN 'FINALIZED_BEFORE_EXPIRY'
          ELSE 'FINALIZED_AFTER_EXPIRY'
        END as timing_issue
      FROM extended_outcomes
      WHERE coverage_pct < 80
      ORDER BY coverage_pct ASC
      LIMIT 20
    `);
    
    const issues = {
      finalizedBeforeExpiry: 0,
      pendingButLowCoverage: 0,
      expiredButLowCoverage: 0,
    };
    
    console.log('\nTiming analysis for low-coverage trades:');
    console.log('Status | Coverage% | Timing Check');
    console.log('-------|-----------|-------------');
    
    for (const row of result.rows) {
      const status = row.status;
      const coverage = Number(row.coverage_pct).toFixed(1);
      const timingIssue = row.timing_issue;
      
      console.log(`${status} | ${coverage}% | ${timingIssue}`);
      
      if (timingIssue === 'FINALIZED_BEFORE_EXPIRY') issues.finalizedBeforeExpiry++;
      if (timingIssue === 'PENDING' && Number(row.coverage_pct) < 50) issues.pendingButLowCoverage++;
      if (timingIssue === 'FINALIZED_AFTER_EXPIRY' && Number(row.coverage_pct) < 50) issues.expiredButLowCoverage++;
    }
    
    console.log('\nSummary:');
    console.log(`  - Finalized before expiry: ${issues.finalizedBeforeExpiry}`);
    console.log(`  - Pending but very low coverage (<50%): ${issues.pendingButLowCoverage}`);
    console.log(`  - Expired but low coverage: ${issues.expiredButLowCoverage}`);
    
    if (issues.finalizedBeforeExpiry > 0) {
      console.log('\n  ⚠️  CRITICAL: Some trades were finalized before 24h window expired!');
      console.log('     This suggests the evaluator is completing trades too early.');
    }
  } finally {
    client.release();
  }
}

async function generateReport(trades: LowCoverageTrade[]): Promise<string> {
  const lines: string[] = [];
  
  lines.push('# Coverage Diagnostics Report');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`Total low-coverage trades analyzed: ${trades.length}`);
  lines.push(`Average coverage: ${(trades.reduce((a, b) => a + b.coveragePct, 0) / trades.length).toFixed(2)}%`);
  lines.push(`Min coverage: ${Math.min(...trades.map(t => t.coveragePct)).toFixed(2)}%`);
  lines.push(`Max coverage (in this group): ${Math.max(...trades.map(t => t.coveragePct)).toFixed(2)}%`);
  lines.push('');
  
  // Group by root cause
  const byCause: Record<string, number> = {};
  for (const t of trades) {
    const cause = (t.rootCause || 'UNKNOWN').split('\n')[0];
    byCause[cause] = (byCause[cause] || 0) + 1;
  }
  
  lines.push('## Root Cause Distribution');
  lines.push('');
  for (const [cause, count] of Object.entries(byCause).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${cause}: ${count} trades`);
  }
  lines.push('');
  
  // Detailed trade analysis
  lines.push('## Detailed Trade Analysis (Worst Coverage First)');
  lines.push('');
  
  for (const t of trades.slice(0, 20)) {
    lines.push(`### Signal ${t.signalId} (${t.symbol})`);
    lines.push(`- Signal Time: ${t.signalTimeUtc}`);
    lines.push(`- Entry Time: ${t.entryTimeUtc}`);
    lines.push(`- Expires At: ${t.expiresAtUtc}`);
    lines.push(`- Status: ${t.status}`);
    lines.push(`- Coverage: ${t.coveragePct.toFixed(2)}% (${t.actualCandles}/${t.expectedCandles} candles)`);
    lines.push(`- Window Hours Elapsed: ${t.windowHoursElapsed.toFixed(1)}h`);
    lines.push(`- Is Expired: ${t.isExpired}`);
    lines.push(`- Root Cause: ${t.rootCause?.replace(/\n/g, '\n  ')}`);
    lines.push('');
  }
  
  lines.push('## Recommendations');
  lines.push('');
  lines.push('### Immediate Actions');
  lines.push('');
  lines.push('1. **Fix Evaluator Timing**');
  lines.push('   - Ensure trades are NOT marked complete before expires_at timestamp');
  lines.push('   - Add explicit check: if (now < expiresAt) status = PENDING');
  lines.push('');
  lines.push('2. **Investigate API Pagination**');
  lines.push('   - Check klinesRange() pagination logic for 24h windows');
  lines.push('   - Verify rate limiting is not truncating results');
  lines.push('   - Add debug logging for: requested vs returned candle counts');
  lines.push('');
  lines.push('3. **Add Coverage Validation**');
  lines.push('   - Before finalizing a trade, require coverage >= 80%');
  lines.push('   - If coverage < 80%, leave as PENDING and retry later');
  lines.push('');
  lines.push('### Code Changes Required');
  lines.push('');
  lines.push('File: `backend/src/extendedOutcomeStore.ts`');
  lines.push('');
  lines.push('```typescript');
  lines.push('// In evaluateExtended24hOutcome(), add BEFORE the timeout check:');
  lines.push('const MIN_COVERAGE_FOR_COMPLETION = 80;');
  lines.push('if (coveragePct < MIN_COVERAGE_FOR_COMPLETION && !windowExpired) {');
  lines.push('  status = "PENDING";');
  lines.push('  completed = false;');
  lines.push('}');
  lines.push('```');
  lines.push('');
  
  return lines.join('\n');
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         COVERAGE DIAGNOSTICS - RAILWAY PRODUCTION            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  const pool = createPool();
  
  try {
    // Step 1: Validate expected candle math
    validateExpectedCandleMath();
    
    // Step 2: Check signal timestamp alignment
    await checkSignalTimestampAlignment(pool);
    
    // Step 3: Check evaluator timing
    await checkEvaluatorTiming(pool);
    
    // Step 4: Fetch and analyze low-coverage trades
    const trades = await fetchLowCoverageTrades(pool, 80);
    
    if (trades.length === 0) {
      console.log('\n✅ No low-coverage trades found! All trades have >= 80% coverage.');
      return;
    }
    
    // Step 5: Detailed analysis
    console.log('\n[ANALYSIS] Performing detailed root cause analysis...');
    const analyzedTrades: LowCoverageTrade[] = [];
    for (const trade of trades) {
      const analyzed = await analyzeTrade(pool, trade);
      analyzedTrades.push(analyzed);
    }
    
    // Step 6: Generate report
    const report = await generateReport(analyzedTrades);
    
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Write report
    const reportPath = path.join(OUTPUT_DIR, 'coverage_diagnostics_report.md');
    fs.writeFileSync(reportPath, report);
    console.log(`\n✅ Report written to: ${reportPath}`);
    
    // Write JSON data
    const jsonPath = path.join(OUTPUT_DIR, 'coverage_diagnostics_data.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      summary: {
        totalAnalyzed: trades.length,
        avgCoverage: trades.reduce((a, b) => a + b.coveragePct, 0) / trades.length,
        minCoverage: Math.min(...trades.map(t => t.coveragePct)),
        maxCoverage: Math.max(...trades.map(t => t.coveragePct)),
      },
      trades: analyzedTrades,
    }, null, 2));
    console.log(`✅ Data written to: ${jsonPath}`);
    
    // Print summary
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                     EXECUTIVE SUMMARY                        ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Low-Coverage Trades: ${String(trades.length).padEnd(39)} ║`);
    console.log(`║  Avg Coverage: ${String((trades.reduce((a, b) => a + b.coveragePct, 0) / trades.length).toFixed(2) + '%').padEnd(46)} ║`);
    console.log(`║  Min Coverage: ${String(Math.min(...trades.map(t => t.coveragePct)).toFixed(2) + '%').padEnd(46)} ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    
    // Print root cause summary
    const causes: Record<string, number> = {};
    for (const t of analyzedTrades) {
      const cause = (t.rootCause || 'UNKNOWN').split(' - ')[0];
      causes[cause] = (causes[cause] || 0) + 1;
    }
    
    console.log('\nRoot Cause Breakdown:');
    for (const [cause, count] of Object.entries(causes).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cause}: ${count}`);
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
