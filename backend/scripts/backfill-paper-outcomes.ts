#!/usr/bin/env tsx
/**
 * Backfill PAPER mode outcomes for signals that only have EXECUTED outcomes.
 * 
 * This script:
 * 1. Finds signals with EXECUTED outcomes but no PAPER outcomes
 * 2. Evaluates PAPER mode (using original signal prices)
 * 3. Persists PAPER outcome to database
 * 
 * Usage:
 *   npm run backfill:paper-outcomes          # Default: dry-run mode
 *   npm run backfill:paper-outcomes --write  # Actually write to DB
 *   npm run backfill:paper-outcomes --reset  # Reset checkpoint and start over
 */

import { getDb } from '../src/db/db.js';
import {
  evaluateExtended24hOutcome,
  updateExtendedOutcome,
  getOrCreateExtendedOutcome,
} from '../src/extendedOutcomeStore.js';
import type { ExtendedOutcomeInput, OutcomeMode } from '../src/extendedOutcomeStore.js';
import type { Signal } from '../src/types.js';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const BATCH_SIZE = 50;
const CONCURRENCY = 3;
const CHECKPOINT_FILE = path.join(process.cwd(), '.backfill-paper-checkpoint.json');
const DELAY_BETWEEN_BATCHES_MS = 2000;

interface Checkpoint {
  lastSignalId: number;
  processedCount: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  startedAt: string;
}

interface Args {
  dryRun: boolean;
  reset: boolean;
  limit: number | null;
  fromSignalId: number | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  return {
    dryRun: !args.includes('--write'),
    reset: args.includes('--reset'),
    limit: args.includes('--limit') 
      ? Number(args[args.indexOf('--limit') + 1]) 
      : null,
    fromSignalId: args.includes('--from')
      ? Number(args[args.indexOf('--from') + 1])
      : null,
  };
}

function loadCheckpoint(): Checkpoint | null {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn('[backfill] Could not load checkpoint:', e);
  }
  return null;
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

function deleteCheckpoint(): void {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    console.log('[backfill] Checkpoint deleted');
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function withConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const executing: Promise<void>[] = [];
  
  for (const item of items) {
    const p = fn(item);
    executing.push(p);
    
    if (executing.length >= limit) {
      await Promise.race(executing);
      executing.splice(executing.findIndex(x => x === p), 1);
    }
  }
  
  await Promise.all(executing);
}

async function findSignalsNeedingPaperBackfill(
  fromSignalId: number | null,
  limit: number
): Promise<Signal[]> {
  const d = getDb();
  
  // Find signals that have:
  // 1. EXECUTED outcomes (existing)
  // 2. NO PAPER outcomes (missing)
  // 3. signal_id >= fromSignalId (for resuming)
  const rows = await d.prepare(`
    SELECT 
      s.id,
      s.symbol,
      s.category,
      s.time,
      s.price,
      s.stop,
      s.tp1,
      s.tp2,
      s.vwap,
      s.ema200,
      s.rsi9,
      s.volSpike,
      s.atrPct,
      s.deltaVwapPct,
      s.confirm15mStrict,
      s.confirm15mSoft,
      s.sessionOk,
      s.sweepOk,
      s.trendOk,
      s.blockedByBtc,
      s.wouldBeCategory
    FROM signals s
    INNER JOIN extended_outcomes eo_exec 
      ON eo_exec.signal_id = s.id AND eo_exec.mode = 'EXECUTED'
    LEFT JOIN extended_outcomes eo_paper 
      ON eo_paper.signal_id = s.id AND eo_paper.mode = 'PAPER'
    WHERE 
      eo_paper.signal_id IS NULL
      AND (${fromSignalId ?? 0} = 0 OR s.id >= ${fromSignalId ?? 0})
    ORDER BY s.id ASC
    LIMIT ?
  `).all(limit) as any[];
  
  return rows.map(row => {
    const signalId = Number(row.id);
    return {
      id: signalId,
      symbol: String(row.symbol),
      category: String(row.category),
      time: Number(row.time),
      price: Number(row.price),
      stop: row.stop != null ? Number(row.stop) : undefined,
      tp1: row.tp1 != null ? Number(row.tp1) : undefined,
      tp2: row.tp2 != null ? Number(row.tp2) : undefined,
      target: row.tp2 != null ? Number(row.tp2) : undefined,
      rr: 0,
      riskPct: 0,
      vwap: row.vwap != null ? Number(row.vwap) : undefined,
      ema200: row.ema200 != null ? Number(row.ema200) : undefined,
      rsi9: row.rsi9 != null ? Number(row.rsi9) : undefined,
      volSpike: row.volSpike != null ? Number(row.volSpike) : undefined,
      atrPct: row.atrPct != null ? Number(row.atrPct) : undefined,
      deltaVwapPct: row.deltaVwapPct != null ? Number(row.deltaVwapPct) : undefined,
      confirm15m: row.confirm15mStrict === 1 || row.confirm15mSoft === 1,
      confirm15mStrict: row.confirm15mStrict === 1,
      confirm15mSoft: row.confirm15mSoft === 1,
      sessionOk: row.sessionOk === 1,
      sweepOk: row.sweepOk === 1,
      trendOk: row.trendOk === 1,
      blockedByBtc: row.blockedByBtc === 1,
      wouldBeCategory: row.wouldBeCategory ?? undefined,
      reasons: [],
    } as unknown as Signal;
  });
}

async function processSignal(
  signal: Signal & { id: number },
  dryRun: boolean
): Promise<{ status: 'created' | 'skipped' | 'error'; error?: string }> {
  try {
    const input: ExtendedOutcomeInput = {
      signalId: signal.id,
      symbol: signal.symbol,
      category: signal.category,
      direction: signal.category.toUpperCase().includes('SELL') ? 'SHORT' : 'LONG',
      signalTime: signal.time,
      entryPrice: signal.price,
      stopPrice: signal.stop ?? null,
      tp1Price: signal.tp1 ?? null,
      tp2Price: signal.tp2 ?? null,
      mode: 'PAPER',
    };
    
    if (dryRun) {
      console.log(`[backfill] Would process signal ${signal.id} ${signal.symbol} ${signal.category}`);
      return { status: 'skipped' };
    }
    
    // Create/get the PAPER outcome record
    const { outcome } = await getOrCreateExtendedOutcome(input);
    if (!outcome) {
      return { status: 'error', error: 'Failed to create outcome record' };
    }
    
    // Evaluate PAPER mode
    const result = await evaluateExtended24hOutcome(input, undefined, undefined, 'PAPER');
    
    // Update the record
    await updateExtendedOutcome(signal.id, result, 'PAPER');
    
    console.log(`[backfill] Created PAPER outcome for signal ${signal.id} ${signal.symbol}: ${result.status}`);
    return { status: 'created' };
  } catch (e: any) {
    console.error(`[backfill] Error processing signal ${(signal as any).id}:`, e?.message || e);
    return { status: 'error', error: String(e?.message || e) };
  }
}

async function main() {
  const args = parseArgs();
  
  console.log('='.repeat(70));
  console.log('PAPER Outcome Backfill Script');
  console.log('='.repeat(70));
  console.log(`Mode: ${args.dryRun ? 'DRY RUN (no writes)' : 'LIVE (writes enabled)'}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  if (args.limit) console.log(`Limit: ${args.limit} signals`);
  console.log('');
  
  if (args.reset) {
    deleteCheckpoint();
  }
  
  const checkpoint = loadCheckpoint();
  const fromSignalId = args.fromSignalId ?? checkpoint?.lastSignalId ?? null;
  
  let processedCount = checkpoint?.processedCount ?? 0;
  let createdCount = checkpoint?.createdCount ?? 0;
  let skippedCount = checkpoint?.skippedCount ?? 0;
  let errorCount = checkpoint?.errorCount ?? 0;
  
  console.log(`Resuming from signal_id: ${fromSignalId ?? 'start'}`);
  console.log(`Already processed: ${processedCount}`);
  console.log('');
  console.log('Starting backfill...');
  console.log('');
  
  while (true) {
    // Check limit
    if (args.limit && processedCount >= args.limit) {
      console.log(`Reached limit of ${args.limit} signals`);
      break;
    }
    
    // Fetch batch
    const remaining = args.limit ? args.limit - processedCount : BATCH_SIZE;
    const batchSize = Math.min(BATCH_SIZE, remaining);
    
    const signals = await findSignalsNeedingPaperBackfill(fromSignalId, batchSize);
    
    if (signals.length === 0) {
      console.log('No more signals to process');
      break;
    }
    
    const firstSignal = signals[0] as Signal & { id: number };
    const lastSignal = signals[signals.length - 1] as Signal & { id: number };
    console.log(`Processing batch of ${signals.length} signals (IDs: ${firstSignal.id} - ${lastSignal.id})`);
    
    // Process batch with concurrency
    await withConcurrency(signals as (Signal & { id: number })[], CONCURRENCY, async (signal) => {
      const result = await processSignal(signal, args.dryRun);
      
      processedCount++;
      if (result.status === 'created') createdCount++;
      else if (result.status === 'skipped') skippedCount++;
      else if (result.status === 'error') errorCount++;
    });
    
    // Save checkpoint
    const newCheckpoint: Checkpoint = {
      lastSignalId: lastSignal.id,
      processedCount,
      createdCount,
      skippedCount,
      errorCount,
      startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
    };
    saveCheckpoint(newCheckpoint);
    
    console.log(`Progress: processed=${processedCount} created=${createdCount} skipped=${skippedCount} errors=${errorCount}`);
    console.log('');
    
    // Delay between batches to avoid hammering the DB/API
    if (!args.dryRun) {
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }
  
  console.log('='.repeat(70));
  console.log('Backfill Complete');
  console.log('='.repeat(70));
  console.log(`Total processed: ${processedCount}`);
  console.log(`Created: ${createdCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log('');
  
  if (args.dryRun) {
    console.log('This was a DRY RUN. No changes were made.');
    console.log('Run with --write to actually create PAPER outcomes.');
  }
  
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
