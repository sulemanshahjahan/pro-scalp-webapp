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
    
    // Check all outcomes in detail
    const res = await client.query(`
      SELECT 
        so.signal_id,
        s.symbol,
        so.horizon_min,
        so.outcome_state,
        so.trade_state,
        so.exit_reason,
        so.result,
        so.r_realized,
        so.hit_sl,
        so.hit_tp1,
        so.hit_tp2,
        so.expired_after_15m
      FROM signal_outcomes so
      JOIN signals s ON s.id = so.signal_id
      ORDER BY s.symbol, so.horizon_min
    `);
    
    console.log('=== ALL OUTCOMES ===');
    console.log('Signal | Symbol   | Hor | State   | Trade     | Exit Reason       | Result | R Realized');
    console.log('-------+----------+-----+---------+-----------+-------------------+--------+------------');
    for (const row of res.rows) {
      console.log(`${String(row.signal_id).padEnd(6)} | ${row.symbol.padEnd(8)} | ${String(row.horizon_min).padEnd(3)} | ${row.outcome_state.padEnd(7)} | ${row.trade_state.padEnd(9)} | ${String(row.exit_reason || 'NULL').padEnd(17)} | ${row.result.padEnd(6)} | ${row.r_realized}`);
    }
    
    // Check if data types are correct
    console.log('\n=== DATA TYPE CHECK ===');
    const typeRes = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'signals' 
        AND column_name IN ('deltavwappct', 'volspike', 'atrpct', 'rsi9')
      ORDER BY column_name
    `);
    console.log('Column | Type');
    console.log('-------+------');
    for (const row of typeRes.rows) {
      console.log(`${row.column_name} | ${row.data_type}`);
    }
    
    // Check actual signal values
    console.log('\n=== SIGNAL VALUES ===');
    const sigRes = await client.query(`
      SELECT 
        id, symbol, price, deltaVwapPct, rsi9, volSpike, atrPct,
        stop, tp1, tp2, rr
      FROM signals
      ORDER BY id
    `);
    console.log('ID | Symbol   | Price   | dVWAP%  | RSI  | Vol    | ATR%   | Stop    | TP1     | RR');
    console.log('---+----------+---------+---------+------+--------+--------+---------+---------+----');
    for (const row of sigRes.rows) {
      console.log(`${row.id} | ${row.symbol.padEnd(8)} | ${row.price} | ${row.deltavwappct} | ${row.rsi9} | ${row.volspike} | ${row.atrpct} | ${row.stop} | ${row.tp1} | ${row.rr}`);
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
