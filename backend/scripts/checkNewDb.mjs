import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = "postgresql://postgres:JzvZpcCoXcdMgQNrgWRqupfAERvmJQHx@crossover.proxy.rlwy.net:15308/railway";

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    query_timeout: 30000
  });
  
  try {
    await client.connect();
    console.log('✅ Connected to new database\n');
    
    // Check signals count
    const sigCount = await client.query(`
      SELECT COUNT(*) as n, 
        MIN(created_at) as first,
        MAX(created_at) as last
      FROM signals
    `);
    console.log('=== SIGNALS ===');
    console.log(`Total: ${sigCount.rows[0].n}`);
    if (sigCount.rows[0].n > 0) {
      console.log(`First: ${new Date(Number(sigCount.rows[0].first)).toISOString()}`);
      console.log(`Last: ${new Date(Number(sigCount.rows[0].last)).toISOString()}`);
    }
    
    // Check by category
    const catRes = await client.query(`
      SELECT category, COUNT(*) as n
      FROM signals
      GROUP BY 1
      ORDER BY 2 DESC
    `);
    console.log('\nBy Category:');
    for (const row of catRes.rows) {
      console.log(`  ${row.category}: ${row.n}`);
    }
    
    // Check outcomes
    const outCount = await client.query(`
      SELECT COUNT(*) as n,
        COUNT(*) FILTER (WHERE outcome_state = 'COMPLETE') as complete,
        COUNT(*) FILTER (WHERE outcome_state = 'PENDING') as pending,
        COUNT(*) FILTER (WHERE outcome_state = 'INVALID') as invalid
      FROM signal_outcomes
    `);
    console.log('\n=== OUTCOMES ===');
    console.log(`Total: ${outCount.rows[0].n}`);
    console.log(`  COMPLETE: ${outCount.rows[0].complete}`);
    console.log(`  PENDING: ${outCount.rows[0].pending}`);
    console.log(`  INVALID: ${outCount.rows[0].invalid}`);
    
    // Recent signals detail
    if (sigCount.rows[0].n > 0) {
      const recentRes = await client.query(`
        SELECT 
          s.id,
          s.symbol,
          s.category,
          s.price,
          s.deltaVwapPct,
          s.rsi9,
          s.volSpike,
          s.created_at,
          COUNT(so.id) as outcome_count
        FROM signals s
        LEFT JOIN signal_outcomes so ON so.signal_id = s.id
        GROUP BY s.id, s.symbol, s.category, s.price, s.deltaVwapPct, s.rsi9, s.volSpike, s.created_at
        ORDER BY s.created_at DESC
        LIMIT 10
      `);
      
      console.log('\n=== LAST 10 SIGNALS ===');
      console.log('ID    | Symbol   | Category       | Price    | dVWAP% | RSI  | Vol  | Outcomes | Time');
      console.log('------+----------+----------------+----------+--------+------+------+----------+-------------------');
      for (const row of recentRes.rows) {
        const time = new Date(Number(row.created_at)).toISOString().slice(0, 16);
        console.log(`${String(row.id).padEnd(5)} | ${row.symbol.padEnd(8)} | ${row.category.padEnd(14)} | ${String(row.price).padEnd(8)} | ${Number(row.deltaVwapPct).toFixed(2).padEnd(6)} | ${Number(row.rsi9).toFixed(0).padEnd(4)} | ${Number(row.volSpike).toFixed(1).padEnd(4)} | ${String(row.outcome_count).padEnd(8)} | ${time}`);
      }
    }
    
    // Complete outcomes summary
    if (outCount.rows[0].complete > 0) {
      const summaryRes = await client.query(`
        SELECT 
          so.horizon_min,
          COUNT(*) as n,
          COUNT(*) FILTER (WHERE so.trade_state = 'FAILED_SL') as stops,
          COUNT(*) FILTER (WHERE so.trade_state IN ('COMPLETED_TP1', 'COMPLETED_TP2')) as wins,
          ROUND(AVG(so.r_realized)::numeric, 3) as avg_r,
          ROUND((SUM(CASE WHEN so.r_realized > 0 THEN 1 ELSE 0 END)::float / COUNT(*))::numeric, 3) as win_rate
        FROM signal_outcomes so
        WHERE so.outcome_state = 'COMPLETE'
        GROUP BY 1
        ORDER BY 1
      `);
      
      console.log('\n=== COMPLETE OUTCOMES BY HORIZON ===');
      console.log('Horizon | Count | Stops | Wins | Avg R | Win Rate');
      console.log('--------+-------+-------+------+-------+----------');
      for (const row of summaryRes.rows) {
        console.log(`${String(row.horizon_min).padEnd(7)} | ${String(row.n).padEnd(5)} | ${String(row.stops).padEnd(5)} | ${String(row.wins).padEnd(4)} | ${String(row.avg_r).padEnd(5)} | ${row.win_rate}`);
      }
    }
    
  } catch (e) {
    console.error(`❌ ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
