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
    
    // Find TAOUSDT signal around 2:10 PM (14:10)
    const signalRes = await client.query(`
      SELECT * FROM signals 
      WHERE symbol = 'TAOUSDT' 
        AND category = 'READY_TO_BUY'
        AND created_at > 1771450000000
      ORDER BY created_at DESC
      LIMIT 1
    `);
    
    if (signalRes.rows.length === 0) {
      console.log('No TAOUSDT signal found');
      return;
    }
    
    const sig = signalRes.rows[0];
    console.log('=== TAOUSDT SIGNAL ===');
    console.log('ID:', sig.id);
    console.log('Time:', new Date(Number(sig.time)).toISOString());
    console.log('Entry:', sig.price);
    console.log('Stop:', sig.stop);
    console.log('TP1:', sig.tp1);
    console.log('TP2:', sig.tp2);
    console.log('RR:', sig.rr);
    
    // Check outcomes
    const outcomeRes = await client.query(`
      SELECT * FROM signal_outcomes 
      WHERE signal_id = $1
      ORDER BY horizon_min
    `, [sig.id]);
    
    console.log('\n=== OUTCOMES ===');
    console.log('Horizon | State   | Exit Reason | R Realized | Exit Price | Exit Time');
    console.log('--------+---------+-------------+------------+------------+----------');
    for (const row of outcomeRes.rows) {
      const exitTime = row.exit_time ? new Date(Number(row.exit_time)).toISOString() : 'N/A';
      console.log(`${String(row.horizon_min).padEnd(7)} | ${row.outcome_state.padEnd(7)} | ${String(row.exit_reason).padEnd(11)} | ${String(row.r_realized).padEnd(10)} | ${String(row.exit_price).padEnd(10)} | ${exitTime.slice(11, 19)}`);
    }
    
    // Check which TP was hit
    const hitRes = await client.query(`
      SELECT 
        hit_tp1, hit_tp2, hit_sl,
        tp1_hit_time, tp2_hit_time, sl_hit_time,
        max_high, min_low
      FROM signal_outcomes 
      WHERE signal_id = $1 AND horizon_min = 60
    `, [sig.id]);
    
    if (hitRes.rows.length > 0) {
      const row = hitRes.rows[0];
      console.log('\n=== 60M DETAILS ===');
      console.log('Hit TP1:', row.hit_tp1 ? 'YES' : 'NO');
      console.log('Hit TP2:', row.hit_tp2 ? 'YES' : 'NO');
      console.log('Hit SL:', row.hit_sl ? 'YES' : 'NO');
      console.log('Max High:', row.max_high);
      console.log('Min Low:', row.min_low);
      console.log('TP1:', sig.tp1);
      console.log('TP2:', sig.tp2);
      
      if (row.max_high && Number(row.max_high) >= Number(sig.tp2)) {
        console.log('\n🚨 ISSUE: Max high (' + row.max_high + ') >= TP2 (' + sig.tp2 + ') but TP2 not marked as hit!');
      }
    }
    
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
