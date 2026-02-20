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
    
    console.log('=== CHECKING SIGNAL EVENTS PATTERN ===\n');
    
    // Get latest signal_events
    const latestEventsRes = await client.query(`
      SELECT id, signal_id, symbol, category, created_at, run_id
      FROM signal_events
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    console.log('Latest 10 signal_events:');
    console.log('Event ID | Signal ID | Symbol   | Category       | Created             | Run ID');
    console.log('---------+-----------+----------+----------------+---------------------+------------------');
    for (const row of latestEventsRes.rows) {
      const created = new Date(Number(row.created_at)).toISOString();
      console.log(`${String(row.id).padEnd(8)} | ${String(row.signal_id).padEnd(9)} | ${row.symbol.padEnd(8)} | ${row.category.padEnd(14)} | ${created} | ${row.run_id?.slice(0, 16)}`);
    }
    
    // Get signals without events
    const noEventRes = await client.query(`
      SELECT s.id, s.symbol, s.category, s.created_at, s.run_id
      FROM signals s
      LEFT JOIN signal_events se ON se.signal_id = s.id
      WHERE se.signal_id IS NULL
        AND s.created_at > 1770000000000
      ORDER BY s.created_at DESC
      LIMIT 10
    `);
    
    console.log('\n=== SIGNALS WITHOUT EVENTS (Recent) ===');
    console.log('Signal ID | Symbol   | Category       | Created             | Run ID');
    console.log('----------+----------+----------------+---------------------+------------------');
    for (const row of noEventRes.rows) {
      const created = new Date(Number(row.created_at)).toISOString();
      console.log(`${String(row.id).padEnd(9)} | ${row.symbol.padEnd(8)} | ${row.category.padEnd(14)} | ${created} | ${row.run_id?.slice(0, 16)}`);
    }
    
    // Count by run
    const runRes = await client.query(`
      SELECT 
        s.run_id,
        COUNT(*) as signals,
        COUNT(se.signal_id) as with_events,
        COUNT(*) - COUNT(se.signal_id) as without_events
      FROM signals s
      LEFT JOIN signal_events se ON se.signal_id = s.id
      WHERE s.created_at > 1771400000000
      GROUP BY s.run_id
      ORDER BY MAX(s.created_at) DESC
      LIMIT 5
    `);
    
    console.log('\n=== SIGNALS VS EVENTS BY RUN ===');
    console.log('Run ID              | Signals | With Events | Without');
    console.log('--------------------+---------+-------------+--------');
    for (const row of runRes.rows) {
      console.log(`${row.run_id?.slice(0, 20).padEnd(20)} | ${String(row.signals).padEnd(7)} | ${String(row.with_events).padEnd(11)} | ${row.without_events}`);
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
