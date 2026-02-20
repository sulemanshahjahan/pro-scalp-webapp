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
    
    // Find all TAOUSDT signals
    const res = await client.query(`
      SELECT id, symbol, category, price, stop, tp1, tp2, time, created_at
      FROM signals 
      WHERE symbol = 'TAOUSDT'
      ORDER BY time DESC
      LIMIT 5
    `);
    
    console.log('TAOUSDT Signals:');
    console.log('ID | Time | Price | TP1 | TP2');
    for (const row of res.rows) {
      const time = new Date(Number(row.time)).toISOString();
      console.log(`${row.id} | ${time} | ${row.price} | ${row.tp1} | ${row.tp2}`);
    }
    
    // If found, check outcomes
    if (res.rows.length > 0) {
      const sig = res.rows[0];
      const outRes = await client.query(`
        SELECT horizon_min, outcome_state, exit_reason, r_realized, 
               hit_tp1, hit_tp2, hit_sl, max_high, exit_price
        FROM signal_outcomes 
        WHERE signal_id = $1
        ORDER BY horizon_min
      `, [sig.id]);
      
      console.log('\nOutcomes for ID', sig.id);
      for (const row of outRes.rows) {
        console.log(`  ${row.horizon_min}m: ${row.outcome_state} | ${row.exit_reason} | max_high: ${row.max_high} | exit: ${row.exit_price}`);
      }
    }
    
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
