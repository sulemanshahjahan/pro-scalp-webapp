import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = "postgresql://postgres:KGboQAfuQthAtTRENDCVPcaLVzQzahiJ@switchyard.proxy.rlwy.net:21356/railway";

const OUTCOME_HORIZONS_MIN = [15, 30, 60, 120, 240];
const OUTCOME_INTERVAL_MIN = 5;

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    await client.connect();
    
    // Find signals without outcomes
    const missingRes = await client.query(`
      SELECT s.id, s.symbol, s.category, s.created_at, s.price, s.entry_time, s.entry_candle_open_time, s.entry_rule
      FROM signals s
      LEFT JOIN signal_outcomes so ON so.signal_id = s.id
      WHERE so.signal_id IS NULL
        AND s.created_at > 1770000000000
      ORDER BY s.created_at DESC
    `);
    
    console.log(`Found ${missingRes.rows.length} signals without outcomes`);
    
    let seeded = 0;
    for (const sig of missingRes.rows) {
      const signalId = Number(sig.id);
      const entryTime = Number(sig.entry_time || sig.created_at);
      const entryCandleOpenTime = Number(sig.entry_candle_open_time || entryTime);
      const entryRule = String(sig.entry_rule || 'signal_close');
      const entryPrice = Number(sig.price);
      const intervalMin = OUTCOME_INTERVAL_MIN;
      const intervalMs = intervalMin * 60_000;
      
      // Create horizon values
      const horizonValues = OUTCOME_HORIZONS_MIN.map(h => `(${h})`).join(', ');
      
      try {
        await client.query(`
          WITH horizons(horizon_min) AS (
            VALUES ${horizonValues}
          )
          INSERT INTO signal_outcomes (
            signal_id, horizon_min,
            entry_time, entry_candle_open_time, entry_rule, start_time, end_time,
            interval_min, n_candles, n_candles_expected, coverage_pct,
            entry_price, open_price, close_price, max_high, min_low,
            ret_pct, r_mult, r_close, r_mfe, r_mae, r_realized,
            hit_sl, hit_tp1, hit_tp2,
            tp1_hit_time, sl_hit_time, tp2_hit_time, time_to_first_hit_ms,
            bars_to_exit, mfe_pct, mae_pct,
            result, exit_reason, outcome_driver, trade_state, exit_price, exit_time,
            window_status, outcome_state, invalid_levels, expired_after_15m,
            attempted_at, computed_at, resolved_at
          )
          SELECT
            $1::bigint, h.horizon_min,
            $2::bigint, $3::bigint, $4, $2::bigint,
            $2::bigint + ((CEIL((h.horizon_min::float + $5::float - 1) / $5::float) - 1) * $6::bigint)::bigint,
            $5::int, 0, CEIL((h.horizon_min::float + $5::float - 1) / $5::float)::int, 0,
            $7::float, $7::float, $7::float, $7::float, $7::float,
            0, 0, 0, 0, 0, 0,
            0, 0, 0,
            0, 0, 0, 0, 0,
            0, 0,
            'NONE', NULL, NULL, 'PENDING', $7::float, $2::bigint,
            'PARTIAL', 'PENDING', 0, 0,
            0, 0, 0
          FROM horizons h
          ON CONFLICT(signal_id, horizon_min) DO NOTHING
        `, [
          signalId, entryTime, entryCandleOpenTime, entryRule, 
          intervalMin, intervalMs, entryPrice
        ]);
        
        seeded++;
        console.log(`✓ Seeded outcomes for ${sig.symbol} (ID: ${signalId})`);
      } catch (e) {
        console.error(`✗ Failed to seed ${sig.symbol}: ${e.message}`);
      }
    }
    
    console.log(`\nTotal seeded: ${seeded} signals × 5 horizons = ${seeded * 5} outcome rows`);
    
    // Verify
    const verifyRes = await client.query('SELECT COUNT(*) as n FROM signal_outcomes');
    console.log(`Total outcome rows now: ${verifyRes.rows[0].n}`);
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
