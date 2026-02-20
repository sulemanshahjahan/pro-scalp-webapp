// Simulate what recordSignal does step by step
import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = "postgresql://postgres:JzvZpcCoXcdMgQNrgWRqupfAERvmJQHx@crossover.proxy.rlwy.net:15308/railway";

// Simulate the exact signal data
const testSignal = {
  symbol: 'TESTUSDT',
  category: 'READY_TO_BUY',
  time: 1771413511818,
  price: 191.5,
  vwap: 191.2,
  ema200: 190.8,
  rsi9: 72.5,
  volSpike: 2.24,
  atrPct: 1.08,
  confirm15m: false,
  deltaVwapPct: 0.16,
  stop: 183.5,
  tp1: 199.5,
  tp2: 207.5,
  target: 207.5,
  rr: 2.0,
  riskPct: 4.2,
  sessionOk: true,
  sweepOk: false,
  trendOk: false,
  blockedByBtc: false,
  runId: 'test_run_debug',
  instanceId: 'test_instance',
  reasons: ['Test signal'],
  thresholdVwapDistancePct: 0.3,
  thresholdVolSpikeX: 1.5,
  thresholdAtrGuardPct: 2.5,
  configHash: 'test_hash_debug',
  preset: 'BALANCED'
};

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    await client.connect();
    console.log('=== SIMULATING RECORD SIGNAL FLOW ===\n');
    
    // Step 1: Insert signal (simplified)
    console.log('1. Inserting signal...');
    const insertRes = await client.query(`
      INSERT INTO signals (
        symbol, category, time, preset, strategy_version,
        price, vwap, ema200, rsi9, volSpike, atrPct, confirm15m, deltaVwapPct,
        stop, tp1, tp2, target, rr, riskPct,
        session_ok, sweep_ok, trend_ok, blocked_by_btc,
        run_id, instance_id, config_hash,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'v1.0.0',
        $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22,
        $23, $24, $25,
        $26, $26
      )
      ON CONFLICT (symbol, category, time, config_hash) DO UPDATE SET
        price = EXCLUDED.price,
        updated_at = EXCLUDED.updated_at
      RETURNING id
    `, [
      testSignal.symbol, testSignal.category, testSignal.time, testSignal.preset,
      testSignal.price, testSignal.vwap, testSignal.ema200, testSignal.rsi9,
      testSignal.volSpike, testSignal.atrPct, testSignal.confirm15m ? 1 : 0, testSignal.deltaVwapPct,
      testSignal.stop, testSignal.tp1, testSignal.tp2, testSignal.target, testSignal.rr, testSignal.riskPct,
      testSignal.sessionOk ? 1 : 0, testSignal.sweepOk ? 1 : 0, testSignal.trendOk ? 1 : 0, testSignal.blockedByBtc ? 1 : 0,
      testSignal.runId, testSignal.instanceId, testSignal.configHash,
      Date.now()
    ]);
    
    const signalId = insertRes.rows[0].id;
    console.log('   ✓ Signal inserted with ID:', signalId);
    
    // Step 2: Try to SELECT the signal back (like recordSignal does)
    console.log('\n2. Selecting signal back...');
    const selectRes = await client.query(`
      SELECT id FROM signals 
      WHERE symbol = $1 AND category = $2 AND time = $3 AND config_hash = $4
    `, [testSignal.symbol, testSignal.category, testSignal.time, testSignal.configHash]);
    
    if (selectRes.rows.length > 0) {
      console.log('   ✓ Found signal:', selectRes.rows[0].id);
    } else {
      console.log('   ✗ Signal NOT found!');
    }
    
    // Step 3: Insert signal_events
    console.log('\n3. Inserting signal_event...');
    try {
      await client.query(`
        INSERT INTO signal_events (
          signal_id, run_id, instance_id, symbol, category, time, preset, config_hash,
          signal_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        signalId, testSignal.runId, testSignal.instanceId, 
        testSignal.symbol, testSignal.category, testSignal.time, testSignal.preset, testSignal.configHash,
        JSON.stringify(testSignal), Date.now()
      ]);
      console.log('   ✓ Event inserted');
    } catch (e) {
      console.log('   ✗ Event insert failed:', e.message);
    }
    
    // Step 4: Seed outcomes
    console.log('\n4. Seeding outcomes...');
    const horizons = [15, 30, 60, 120, 240];
    for (const h of horizons) {
      try {
        await client.query(`
          INSERT INTO signal_outcomes (
            signal_id, horizon_min, entry_time, entry_candle_open_time, entry_rule,
            start_time, end_time, interval_min, n_candles_expected,
            entry_price, outcome_state, window_status, trade_state, result
          ) VALUES ($1, $2, $3, $3, 'signal_close', $3, $4, 5, $5, $6, 'PENDING', 'PARTIAL', 'PENDING', 'NONE')
          ON CONFLICT DO NOTHING
        `, [signalId, h, testSignal.time, testSignal.time + (h * 60000), Math.ceil(h/5), testSignal.price]);
        console.log(`   ✓ Horizon ${h}m seeded`);
      } catch (e) {
        console.log(`   ✗ Horizon ${h}m failed:`, e.message);
      }
    }
    
    console.log('\n=== CLEANUP ===');
    await client.query(`DELETE FROM signal_outcomes WHERE signal_id = $1`, [signalId]);
    await client.query(`DELETE FROM signal_events WHERE signal_id = $1`, [signalId]);
    await client.query(`DELETE FROM signals WHERE id = $1`, [signalId]);
    console.log('Test data cleaned up');
    
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
