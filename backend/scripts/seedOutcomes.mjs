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
    console.log('Seeding outcomes for signal 1882...\n');
    
    const horizons = [15, 30, 60, 120, 240];
    
    for (const h of horizons) {
      try {
        const intervalMs = 5 * 60 * 1000;
        const needed = Math.ceil((h + 5 - 1) / 5);
        const endTime = 1771413000000 + ((needed - 1) * intervalMs);
        
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
            1882, $1::int, 1771413000000::bigint, 1771412700000::bigint, 'signal_close',
            1771413000000::bigint, $2::bigint, 5, 0, $3::int, 0,
            191.5::float, 191.5::float, 191.5::float, 191.5::float, 191.5::float,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0,
            'NONE', NULL, NULL, 'PENDING', 191.5::float, 1771413000000::bigint,
            'PARTIAL', 'PENDING', 0, 0,
            0, 0, 0
          )
          ON CONFLICT (signal_id, horizon_min) DO NOTHING
        `, [h, endTime, needed]);
        console.log(`✓ Horizon ${h}m seeded`);
      } catch (e) {
        console.log(`✗ Horizon ${h}m: ${e.message}`);
      }
    }
    
    // Verify
    const countRes = await client.query('SELECT COUNT(*) as n FROM signal_outcomes WHERE signal_id = 1882');
    console.log(`\nTotal outcomes for signal 1882: ${countRes.rows[0].n}`);
    
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
