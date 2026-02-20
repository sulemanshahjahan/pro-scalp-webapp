import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = "postgresql://postgres:KGboQAfuQthAtTRENDCVPcaLVzQzahiJ@switchyard.proxy.rlwy.net:21356/railway";

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    await client.connect();
    
    // Check outcomes for these specific signals
    const res = await client.query(`
      SELECT 
        so.signal_id,
        so.horizon_min,
        so.outcome_state,
        so.trade_state,
        so.result,
        so.exit_reason,
        so.attempted_at,
        so.computed_at,
        so.resolved_at,
        s.symbol,
        s.created_at
      FROM signal_outcomes so
      JOIN signals s ON s.id = so.signal_id
      WHERE s.symbol IN ('JTOUSDT', 'DOGEUSDT')
        AND s.created_at > 1771300000000
      ORDER BY s.symbol, so.horizon_min
    `);
    
    console.log('Outcomes for recent JTOUSDT/DOGEUSDT:');
    console.log('symbol   | signal_id | horizon | state   | trade_state | attempted_at | resolved_at');
    console.log('---------+-----------+---------+---------+-------------+--------------+------------');
    for (const row of res.rows) {
      const attempted = row.attempted_at ? new Date(row.attempted_at).toISOString().slice(11, 16) : 'never';
      const resolved = row.resolved_at ? new Date(row.resolved_at).toISOString().slice(11, 16) : 'pending';
      console.log(`${row.symbol.padEnd(8)} | ${String(row.signal_id).padEnd(9)} | ${String(row.horizon_min).padEnd(7)} | ${row.outcome_state.padEnd(7)} | ${row.trade_state.padEnd(11)} | ${attempted.padEnd(12)} | ${resolved}`);
    }
    
    if (res.rows.length === 0) {
      console.log('(No outcome rows found - checking if signals exist)');
      const sigRes = await client.query(`
        SELECT id, symbol, created_at, category 
        FROM signals 
        WHERE symbol IN ('JTOUSDT', 'DOGEUSDT')
          AND created_at > 1771300000000
        ORDER BY created_at DESC
      `);
      console.log('\nSignals found:', sigRes.rows);
    }
    
    // Summary
    console.log('\n=== OUTCOME RESOLVER STATUS ===');
    const pendingRes = await client.query(`
      SELECT 
        outcome_state,
        COUNT(*) as n,
        MIN(attempted_at) as oldest_attempt,
        MAX(attempted_at) as newest_attempt
      FROM signal_outcomes
      GROUP BY outcome_state
      ORDER BY 1
    `);
    
    console.log('state   | count | oldest_attempt | newest_attempt');
    console.log('--------+-------+----------------+----------------');
    for (const row of pendingRes.rows) {
      const oldest = row.oldest_attempt ? new Date(row.oldest_attempt).toISOString().slice(0, 16) : 'N/A';
      const newest = row.newest_attempt ? new Date(row.newest_attempt).toISOString().slice(0, 16) : 'N/A';
      console.log(`${row.outcome_state.padEnd(7)} | ${String(row.n).padEnd(5)} | ${oldest.padEnd(14)} | ${newest}`);
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
