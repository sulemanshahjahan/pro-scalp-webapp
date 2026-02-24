#!/usr/bin/env npx tsx
/**
 * Re-evaluate Low-Coverage Trades with Fix
 * 
 * This script re-evaluates trades that had low coverage (<80%) with the new
 * coverage calculation logic. It will show before/after comparison.
 * 
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx tmp/reevaluateWithFix.ts
 */

import pg from 'pg';
import '../src/extendedOutcomeStore.js';
import { evaluateExtended24hOutcome, updateExtendedOutcome, getOrCreateExtendedOutcome } from '../src/extendedOutcomeStore.js';

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

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║    RE-EVALUATE LOW-COVERAGE TRADES WITH FIX v1.2.0          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  
  const pool = createPool();
  const client = await pool.connect();
  
  try {
    // Fetch low-coverage trades
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
        eo.direction,
        eo.coverage_pct as old_coverage,
        eo.n_candles_evaluated,
        eo.n_candles_expected,
        eo.status,
        eo.completed_at
      FROM extended_outcomes eo
      WHERE eo.coverage_pct < 80
      ORDER BY eo.coverage_pct ASC
      LIMIT 25
    `);
    
    console.log(`\nFound ${result.rows.length} low-coverage trades to analyze`);
    console.log('\nNote: This is a DRY RUN showing what the new calculation would produce.');
    console.log('To actually update, use the /api/extended-outcomes/force-reevaluate endpoint.\n');
    
    console.log('='.repeat(100));
    console.log('SIGNAL_ID | SYMBOL   | OLD COV | NEW COV | IMPROVEMENT | STATUS');
    console.log('='.repeat(100));
    
    let totalImprovement = 0;
    let improvedCount = 0;
    
    for (const row of result.rows) {
      const signalId = Number(row.signal_id);
      const symbol = row.symbol;
      const oldCoverage = Number(row.old_coverage);
      
      // Calculate what new coverage would be
      const signalTime = Number(row.signal_time);
      const stopAt = row.stop_price ? Number(row.stop_price) : null;
      const tp2At = row.tp2_price ? Number(row.tp2_price) : null;
      const tp1At = row.tp1_price ? Number(row.tp1_price) : null;
      
      // Determine actual window end
      const now = Date.now();
      const expiresAt = signalTime + 24 * 60 * 60 * 1000;
      const windowExpired = now >= expiresAt;
      
      let windowEnd: number;
      if (row.completed_at) {
        // Use the actual exit logic (simplified)
        windowEnd = signalTime + 60 * 60 * 1000; // Assume 1h for completed trades
      } else {
        windowEnd = Math.min(now, expiresAt);
      }
      
      // New coverage calculation
      const actualCandles = Number(row.n_candles_evaluated);
      const windowDuration = windowEnd - signalTime;
      const intervalMs = 5 * 60 * 1000;
      const newExpected = Math.max(1, Math.floor((windowDuration + intervalMs) / intervalMs));
      const newCoverage = (actualCandles / newExpected) * 100;
      
      const improvement = newCoverage - oldCoverage;
      if (improvement > 0) {
        totalImprovement += improvement;
        improvedCount++;
      }
      
      const status = improvement > 50 ? '✅ MAJOR' : improvement > 20 ? '✅ GOOD' : improvement > 0 ? '⚠️ MINOR' : '❌ NONE';
      
      console.log(
        `${signalId.toString().padEnd(9)} | ` +
        `${symbol.padEnd(8)} | ` +
        `${oldCoverage.toFixed(1).padStart(6)}% | ` +
        `${newCoverage.toFixed(1).padStart(6)}% | ` +
        `${('+' + improvement.toFixed(1)).padStart(10)}% | ` +
        `${status}`
      );
    }
    
    console.log('='.repeat(100));
    console.log(`\nSummary:`);
    console.log(`  Trades analyzed: ${result.rows.length}`);
    console.log(`  Trades improved: ${improvedCount}`);
    console.log(`  Avg improvement: ${improvedCount > 0 ? (totalImprovement / improvedCount).toFixed(1) : 0}%`);
    
    console.log('\n' + '='.repeat(100));
    console.log('NEXT STEPS:');
    console.log('='.repeat(100));
    console.log('1. Deploy the fix to production');
    console.log('2. Run force-reevaluate for affected date range:');
    console.log('   POST /api/extended-outcomes/force-reevaluate?start=<timestamp>&end=<timestamp>');
    console.log('3. Monitor coverage metrics to verify improvement');
    console.log('='.repeat(100));
    
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
