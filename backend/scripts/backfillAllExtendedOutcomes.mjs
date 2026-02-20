/**
 * Backfill ALL historical signals to extended_outcomes
 * Run: node scripts/backfillAllExtendedOutcomes.mjs
 */
import { getDb } from '../src/db/db.js';
import { 
  getOrCreateExtendedOutcome,
  getSignalDirection 
} from '../src/extendedOutcomeStore.js';

const db = getDb();

async function backfillAll() {
  console.log('[backfill] Starting full historical backfill...');
  
  // Count total to backfill
  const countRow = await db.prepare(`
    SELECT COUNT(*) as n
    FROM signals s
    LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
    WHERE eo.id IS NULL
  `).get();
  
  const totalToProcess = countRow?.n || 0;
  console.log(`[backfill] Found ${totalToProcess} signals to backfill`);
  
  if (totalToProcess === 0) {
    console.log('[backfill] Nothing to do - all signals already have extended outcomes');
    process.exit(0);
  }
  
  const batchSize = 100;
  let processed = 0;
  let errors = 0;
  let hasMore = true;
  
  while (hasMore) {
    const signals = await db.prepare(`
      SELECT s.id, s.symbol, s.category, s.time, s.price, s.stop, s.tp1, s.tp2
      FROM signals s
      LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
      WHERE eo.id IS NULL
      ORDER BY s.time DESC
      LIMIT ?
    `).all(batchSize);
    
    if (!signals || signals.length === 0) {
      hasMore = false;
      break;
    }
    
    for (const signal of signals) {
      try {
        await getOrCreateExtendedOutcome({
          signalId: signal.id,
          symbol: signal.symbol,
          category: signal.category,
          direction: getSignalDirection(signal.category),
          signalTime: signal.time,
          entryPrice: signal.price,
          stopPrice: signal.stop,
          tp1Price: signal.tp1,
          tp2Price: signal.tp2,
        });
        processed++;
        
        if (processed % 100 === 0) {
          const pct = ((processed / totalToProcess) * 100).toFixed(1);
          console.log(`[backfill] Processed ${processed}/${totalToProcess} (${pct}%)...`);
        }
      } catch (e) {
        console.error(`[backfill] Error for signal ${signal.id}:`, e.message);
        errors++;
      }
    }
    
    // Small delay to prevent overload
    await new Promise(r => setTimeout(r, 50));
  }
  
  console.log(`[backfill] Complete! Processed: ${processed}, Errors: ${errors}`);
  process.exit(0);
}

backfillAll().catch(e => {
  console.error('[backfill] Fatal error:', e);
  process.exit(1);
});
