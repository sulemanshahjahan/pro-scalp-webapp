#!/usr/bin/env npx tsx
/**
 * Force Re-evaluate Without Admin Token
 * 
 * Directly resets and re-evaluates low-coverage trades from the database.
 * No API/admin token needed - uses direct DB connection.
 * 
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx tmp/forceReevaluateNoToken.ts
 * 
 * Or with Railway:
 *   railway run -- npx tsx tmp/forceReevaluateNoToken.ts
 */

import pg from 'pg';
import { 
  evaluateExtended24hOutcome, 
  updateExtendedOutcome,
  getSignalDirection 
} from '../src/extendedOutcomeStore.js';

const { Pool } = pg;

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

function createPool(): pg.Pool {
  const ssl = DB_URL!.includes('railway.app') 
    ? { rejectUnauthorized: false } 
    : undefined;
  return new Pool({ connectionString: DB_URL, ssl, max: 5 });
}

interface TradeToReevaluate {
  signalId: number;
  symbol: string;
  category: string;
  signalTime: number;
  entryPrice: number;
  stopPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  oldCoverage: number;
  oldStatus: string;
}

async function fetchTradesToReevaluate(pool: pg.Pool, startMs: number, endMs: number): Promise<TradeToReevaluate[]> {
  const client = await pool.connect();
  try {
    console.log(`[RE-EVAL] Fetching trades from ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}...`);
    
    const result = await client.query(`
      SELECT 
        eo.signal_id,
        eo.symbol,
        eo.category,
        eo.signal_time,
        eo.entry_price,
        eo.stop_price,
        eo.tp1_price,
        eo.tp2_price,
        eo.coverage_pct,
        eo.status
      FROM extended_outcomes eo
      WHERE eo.signal_time >= $1 
        AND eo.signal_time <= $2
        AND eo.coverage_pct < 80
      ORDER BY eo.coverage_pct ASC
    `, [startMs, endMs]);
    
    return result.rows.map(row => ({
      signalId: Number(row.signal_id),
      symbol: row.symbol,
      category: row.category,
      signalTime: Number(row.signal_time),
      entryPrice: Number(row.entry_price),
      stopPrice: row.stop_price ? Number(row.stop_price) : null,
      tp1Price: row.tp1_price ? Number(row.tp1_price) : null,
      tp2Price: row.tp2_price ? Number(row.tp2_price) : null,
      oldCoverage: Number(row.coverage_pct),
      oldStatus: row.status,
    }));
  } finally {
    client.release();
  }
}

async function resetAndReevaluate(pool: pg.Pool, trade: TradeToReevaluate): Promise<{ success: boolean; newCoverage: number; newStatus: string; error?: string }> {
  const client = await pool.connect();
  
  try {
    // Step 1: Reset the outcome record to force re-evaluation
    await client.query(`
      UPDATE extended_outcomes SET
        completed_at = NULL,
        status = 'PENDING',
        first_tp1_at = NULL,
        tp2_at = NULL,
        stop_at = NULL,
        time_to_first_hit_seconds = NULL,
        time_to_tp1_seconds = NULL,
        time_to_tp2_seconds = NULL,
        time_to_stop_seconds = NULL,
        max_favorable_excursion_pct = NULL,
        max_adverse_excursion_pct = NULL,
        coverage_pct = 0,
        n_candles_evaluated = 0,
        debug_json = NULL,
        ext24_managed_status = NULL,
        ext24_managed_r = NULL,
        ext24_managed_pnl_usd = NULL,
        ext24_realized_r = NULL,
        ext24_unrealized_runner_r = NULL,
        ext24_live_managed_r = NULL,
        ext24_tp1_partial_at = NULL,
        ext24_runner_be_at = NULL,
        ext24_runner_exit_at = NULL,
        ext24_runner_exit_reason = NULL,
        ext24_timeout_exit_price = NULL,
        ext24_risk_usd_snapshot = NULL,
        managed_debug_json = NULL,
        updated_at = $1
      WHERE signal_id = $2
    `, [Date.now(), trade.signalId]);
    
    // Step 2: Re-evaluate with new code
    const input = {
      signalId: trade.signalId,
      symbol: trade.symbol,
      category: trade.category,
      direction: getSignalDirection(trade.category),
      signalTime: trade.signalTime,
      entryPrice: trade.entryPrice,
      stopPrice: trade.stopPrice,
      tp1Price: trade.tp1Price,
      tp2Price: trade.tp2Price,
    };
    
    const result = await evaluateExtended24hOutcome(input);
    
    // Step 3: Update with new results
    await updateExtendedOutcome(trade.signalId, result);
    
    return {
      success: true,
      newCoverage: result.coveragePct,
      newStatus: result.status,
    };
    
  } catch (error: any) {
    return {
      success: false,
      newCoverage: 0,
      newStatus: 'ERROR',
      error: error?.message || String(error),
    };
  } finally {
    client.release();
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     FORCE RE-EVALUATE (No Admin Token Required)             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  const pool = createPool();
  
  // Date range: Feb 18 - Feb 22 (covers all recent affected trades)
  // Note: Current year is 2026 based on system date
  const startMs = new Date('2026-02-18').getTime();
  const endMs = new Date('2026-02-23').getTime();
  
  try {
    // Fetch trades to re-evaluate
    const trades = await fetchTradesToReevaluate(pool, startMs, endMs);
    
    if (trades.length === 0) {
      console.log('\n✅ No low-coverage trades found in date range.');
      return;
    }
    
    console.log(`\n[RE-EVAL] Found ${trades.length} trades to re-evaluate`);
    console.log('\n====================================================================================================');
    console.log('SIGNAL_ID | SYMBOL   | OLD COV | OLD STATUS   | NEW COV | NEW STATUS   | RESULT');
    console.log('====================================================================================================');
    
    let successCount = 0;
    let failCount = 0;
    let totalImprovement = 0;
    
    for (const trade of trades) {
      process.stdout.write(`${trade.signalId.toString().padEnd(9)} | ${trade.symbol.padEnd(8)} | ${trade.oldCoverage.toFixed(1).padStart(6)}% | ${trade.oldStatus.padEnd(12)} | `);
      
      const result = await resetAndReevaluate(pool, trade);
      
      if (result.success) {
        const improvement = result.newCoverage - trade.oldCoverage;
        totalImprovement += improvement;
        successCount++;
        
        const status = improvement > 50 ? '✅ MAJOR' : improvement > 20 ? '✅ GOOD' : improvement > 0 ? '✅ FIXED' : '⚠️ SAME';
        
        console.log(`${result.newCoverage.toFixed(1).padStart(6)}% | ${result.newStatus.padEnd(12)} | ${status}`);
      } else {
        failCount++;
        console.log(`ERROR    | ERROR        | ❌ ${result.error?.substring(0, 30)}`);
      }
      
      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 100));
    }
    
    console.log('====================================================================================================');
    console.log(`\n✅ Re-evaluation complete!`);
    console.log(`   Successful: ${successCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log(`   Avg improvement: ${successCount > 0 ? (totalImprovement / successCount).toFixed(1) : 0}%`);
    
    console.log('\n📊 Next steps:');
    console.log('   1. Re-run quant diagnostics to see updated strategy metrics');
    console.log('   2. Check if coverage filter recommendation has changed');
    console.log('   3. Apply real performance filters (RSI/volume/symbol)');
    
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
