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
    
    console.log('=== OUTCOME RESOLUTION PROGRESS ===\n');
    
    // Check outcome states
    const stateRes = await client.query(`
      SELECT 
        horizon_min,
        outcome_state,
        COUNT(*) as n
      FROM signal_outcomes
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
    
    console.log('Outcomes by State:');
    console.log('horizon_min | outcome_state | count');
    console.log('------------+---------------+-------');
    for (const row of stateRes.rows) {
      console.log(`${String(row.horizon_min).padEnd(11)} | ${String(row.outcome_state).padEnd(13)} | ${row.n}`);
    }
    
    // Check if EXPIRED_AFTER_15M is gone from long horizons
    const expiredRes = await client.query(`
      SELECT 
        horizon_min,
        COUNT(*) as expired_count
      FROM signal_outcomes
      WHERE exit_reason = 'EXPIRED_AFTER_15M'
      GROUP BY 1
      ORDER BY 1
    `);
    
    console.log('\n=== EXPIRED_AFTER_15M CHECK ===');
    if (expiredRes.rows.length === 0) {
      console.log('✅ No EXPIRED_AFTER_15M rows found!');
    } else {
      console.log('horizon_min | expired_count');
      console.log('------------+---------------');
      for (const row of expiredRes.rows) {
        const marker = row.horizon_min > 15 ? '❌' : '✓';
        console.log(`${marker} ${String(row.horizon_min).padEnd(10)} | ${row.expired_count}`);
      }
    }
    
    // Check recent complete outcomes
    const completeRes = await client.query(`
      SELECT 
        horizon_min,
        exit_reason,
        COUNT(*) as n,
        ROUND(AVG(r_realized)::numeric, 3) as avg_r
      FROM signal_outcomes
      WHERE outcome_state = 'COMPLETE'
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
    
    console.log('\n=== COMPLETE OUTCOMES BY EXIT REASON ===');
    console.log('horizon_min | exit_reason       | n  | avg_r');
    console.log('------------+-------------------+----+-------');
    for (const row of completeRes.rows) {
      console.log(`${String(row.horizon_min).padEnd(11)} | ${String(row.exit_reason).padEnd(17)} | ${String(row.n).padEnd(2)} | ${row.avg_r}`);
    }
    
    // Summary stats
    const summaryRes = await client.query(`
      SELECT
        horizon_min,
        COUNT(*) FILTER (WHERE outcome_state = 'COMPLETE') as complete,
        COUNT(*) FILTER (WHERE outcome_state = 'PENDING') as pending,
        ROUND(AVG(r_realized) FILTER (WHERE outcome_state = 'COMPLETE')::numeric, 3) as avg_r,
        ROUND((SUM(CASE WHEN r_realized > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*) FILTER (WHERE outcome_state = 'COMPLETE'), 0))::numeric, 3) as win_rate
      FROM signal_outcomes
      GROUP BY 1
      ORDER BY 1
    `);
    
    console.log('\n=== SUMMARY BY HORIZON ===');
    console.log('horizon_min | complete | pending | avg_r  | win_rate');
    console.log('------------+----------+---------+--------+----------');
    for (const row of summaryRes.rows) {
      const wr = row.win_rate !== null ? row.win_rate : 'N/A';
      console.log(`${String(row.horizon_min).padEnd(11)} | ${String(row.complete).padEnd(8)} | ${String(row.pending).padEnd(7)} | ${String(row.avg_r).padEnd(6)} | ${wr}`);
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
