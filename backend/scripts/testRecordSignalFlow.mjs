// Test the exact recordSignal flow to find where it fails
import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = "postgresql://postgres:JzvZpcCoXcdMgQNrgWRqupfAERvmJQHx@crossover.proxy.rlwy.net:15308/railway";

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    await client.connect();
    console.log('=== TESTING RECORD SIGNAL FLOW ===\n');
    
    // Step 1: Check if we can query signals
    console.log('1. Testing signals table query...');
    const sigRes = await client.query('SELECT COUNT(*) as n FROM signals');
    console.log('   ✓ Signals count:', sigRes.rows[0].n);
    
    // Step 2: Check if we can query signal_events
    console.log('\n2. Testing signal_events table query...');
    try {
      const evtRes = await client.query('SELECT COUNT(*) as n FROM signal_events');
      console.log('   ✓ Events count:', evtRes.rows[0].n);
    } catch (e) {
      console.log('   ✗ Error:', e.message);
    }
    
    // Step 3: Check if we can query signal_outcomes
    console.log('\n3. Testing signal_outcomes table query...');
    try {
      const outRes = await client.query('SELECT COUNT(*) as n FROM signal_outcomes');
      console.log('   ✓ Outcomes count:', outRes.rows[0].n);
    } catch (e) {
      console.log('   ✗ Error:', e.message);
    }
    
    // Step 4: Try to insert a test event for signal 1882
    console.log('\n4. Testing signal_events INSERT for signal 1882...');
    try {
      await client.query(`
        INSERT INTO signal_events (
          signal_id, run_id, instance_id, symbol, category, time, preset, config_hash,
          gate_snapshot_json, ready_debug_json, best_debug_json, entry_debug_json, config_snapshot_json,
          blocked_reasons_json, first_failed_gate, signal_json, created_at
        ) VALUES (
          1882, 'test_run', 'test_instance', 'TAOUSDT', 'READY_TO_BUY', 1771413511818, null, 'test_hash',
          '{}', '{}', '{}', '{}', '{}',
          null, null, '{}', ${Date.now()}
        )
      `);
      console.log('   ✓ Test event inserted');
      
      // Clean up
      await client.query(`DELETE FROM signal_events WHERE run_id = 'test_run'`);
      console.log('   ✓ Test event cleaned up');
    } catch (e) {
      console.log('   ✗ Error:', e.message);
    }
    
    // Step 5: Try to insert test outcome
    console.log('\n5. Testing signal_outcomes INSERT for signal 1882...');
    try {
      await client.query(`
        INSERT INTO signal_outcomes (
          signal_id, horizon_min, entry_time, entry_candle_open_time, entry_rule,
          start_time, end_time, interval_min, n_candles, n_candles_expected, coverage_pct,
          entry_price, open_price, close_price, max_high, min_low,
          ret_pct, r_mult, r_close, r_mfe, r_mae, r_realized,
          hit_sl, hit_tp1, hit_tp2, tp1_hit_time, sl_hit_time, tp2_hit_time,
          time_to_first_hit_ms, bars_to_exit, mfe_pct, mae_pct,
          result, exit_reason, outcome_driver, trade_state, exit_price, exit_time,
          window_status, outcome_state, invalid_levels, expired_after_15m,
          attempted_at, computed_at, resolved_at
        ) VALUES (
          1882, 15, 1771413511818, 1771413511818, 'signal_close',
          1771413511818, 1771414411818, 5, 0, 3, 0,
          191.5, 191.5, 191.5, 191.5, 191.5,
          0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0,
          0, 0, 0, 0,
          'NONE', NULL, NULL, 'PENDING', 191.5, 1771413511818,
          'PARTIAL', 'PENDING', 0, 0,
          0, 0, 0
        )
      `);
      console.log('   ✓ Test outcome inserted');
      
      // Clean up
      await client.query(`DELETE FROM signal_outcomes WHERE signal_id = 1882 AND attempted_at = 0`);
      console.log('   ✓ Test outcome cleaned up');
    } catch (e) {
      console.log('   ✗ Error:', e.message);
    }
    
    // Step 6: Check if signal 1882 has specific issues
    console.log('\n6. Checking signal 1882 details...');
    const detailsRes = await client.query(`
      SELECT id, symbol, category, config_hash, created_at
      FROM signals WHERE id = 1882
    `);
    if (detailsRes.rows.length > 0) {
      const s = detailsRes.rows[0];
      console.log('   Signal exists:', s);
      console.log('   Config hash:', s.config_hash);
    }
    
    console.log('\n=== DIAGNOSIS ===');
    console.log('If steps 4 and 5 work manually but not in the app,');
    console.log('the issue is in the backend code logic, not the DB.');
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
