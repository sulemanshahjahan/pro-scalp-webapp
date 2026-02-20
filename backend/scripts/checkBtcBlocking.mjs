import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = "postgresql://postgres:KGboQAfuQthAtTRENDCVPcaLVzQzahiJ@switchyard.proxy.rlwy.net:21356/railway";

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
    query_timeout: 30000
  });
  
  try {
    await client.connect();
    
    console.log('=== BTC BLOCKING ANALYSIS ===\n');
    
    // Check if blocked_by_btc is ever set
    const blockRes = await client.query(`
      SELECT 
        blocked_by_btc,
        btc_bull,
        btc_bear,
        btc_gate,
        would_be_category,
        COUNT(*) as n
      FROM signals
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY 1, 2, 3
    `);
    
    console.log('Signals by BTC Status:');
    console.log('blocked | btc_bull | btc_bear | btc_gate | would_be | count');
    console.log('--------+----------+----------+----------+----------+------');
    for (const row of blockRes.rows) {
      console.log(`${String(row.blocked_by_btc).padEnd(7)} | ${String(row.btc_bull).padEnd(8)} | ${String(row.btc_bear).padEnd(8)} | ${String(row.btc_gate).padEnd(8)} | ${String(row.would_be_category).padEnd(8)} | ${row.n}`);
    }
    
    // Check outcomes by BTC regime
    const outcomeRes = await client.query(`
      SELECT 
        s.btc_bull,
        s.btc_bear,
        s.blocked_by_btc,
        COUNT(*) as n,
        ROUND(AVG(so.r_realized)::numeric, 3) as avg_r,
        ROUND((SUM(CASE WHEN so.r_realized > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0))::numeric, 3) as win_rate
      FROM signal_outcomes so
      JOIN signals s ON s.id = so.signal_id
      WHERE so.outcome_state = 'COMPLETE'
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3
    `);
    
    console.log('\n=== OUTCOMES BY BTC REGIME ===');
    console.log('btc_bull | btc_bear | blocked | n  | avg_r  | win_rate');
    console.log('---------+----------+---------+----+--------+----------');
    for (const row of outcomeRes.rows) {
      console.log(`${String(row.btc_bull).padEnd(8)} | ${String(row.btc_bear).padEnd(8)} | ${String(row.blocked_by_btc).padEnd(7)} | ${String(row.n).padEnd(2)} | ${String(row.avg_r).padEnd(6)} | ${row.win_rate}`);
    }
    
    // Check why stops are being hit
    const driverRes = await client.query(`
      SELECT 
        outcome_driver,
        COUNT(*) as n,
        ROUND(AVG(r_realized)::numeric, 3) as avg_r
      FROM signal_outcomes
      WHERE outcome_state = 'COMPLETE'
        AND trade_state = 'FAILED_SL'
      GROUP BY 1
      ORDER BY 2 DESC
    `);
    
    console.log('\n=== STOP LOSS REASONS (outcome_driver) ===');
    console.log('driver              | n  | avg_r');
    console.log('--------------------+----+-------');
    for (const row of driverRes.rows) {
      console.log(`${String(row.outcome_driver).padEnd(19)} | ${String(row.n).padEnd(2)} | ${row.avg_r}`);
    }
    
    // Recent signal quality
    const recentRes = await client.query(`
      SELECT 
        category,
        COUNT(*) as n,
        ROUND(AVG(rr)::numeric, 2) as avg_rr,
        ROUND(AVG(deltaVwapPct)::numeric, 3) as avg_dvwap,
        ROUND(AVG(ABS(deltaVwapPct))::numeric, 3) as avg_abs_dvwap
      FROM signals
      WHERE created_at > extract(epoch from now() - interval '24 hours') * 1000
      GROUP BY 1
      ORDER BY 1
    `);
    
    console.log('\n=== LAST 24H SIGNALS (with new VWAP filter) ===');
    console.log('category        | n  | avg_rr | avg_dvwap | avg_abs_dvwap');
    console.log('----------------+----+--------+-----------+--------------');
    for (const row of recentRes.rows) {
      console.log(`${String(row.category).padEnd(15)} | ${String(row.n).padEnd(2)} | ${String(row.avg_rr).padEnd(6)} | ${String(row.avg_dvwap).padEnd(9)} | ${row.avg_abs_dvwap}`);
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
