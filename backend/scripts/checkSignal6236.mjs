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
    
    console.log('=== CHECKING SIGNAL FROM RUN 1771413383789 ===\n');
    
    // Check if signal was recorded
    const signalRes = await client.query(`
      SELECT id, symbol, category, price, created_at, run_id
      FROM signals
      WHERE run_id = 'run_1771413383789_1be457'
    `);
    
    console.log('Signals from this run:', signalRes.rows.length);
    for (const row of signalRes.rows) {
      console.log(`  - ${row.symbol} | ${row.category} | ${row.price} | ID: ${row.id}`);
    }
    
    // Check email guard (cooldown tracking)
    const guardRes = await client.query(`
      SELECT * FROM email_guard
      ORDER BY last_sent_ms DESC
      LIMIT 5
    `);
    
    console.log('\n=== RECENT EMAIL GUARD ENTRIES ===');
    console.log('Key | Last Sent');
    console.log('----|------------');
    for (const row of guardRes.rows) {
      const date = new Date(Number(row.last_sent_ms)).toISOString();
      console.log(`${row.key} | ${date}`);
    }
    
    // Check outcomes for these signals
    if (signalRes.rows.length > 0) {
      const signalIds = signalRes.rows.map(r => r.id);
      const outcomeRes = await client.query(`
        SELECT signal_id, horizon_min, outcome_state
        FROM signal_outcomes
        WHERE signal_id = ANY($1)
        ORDER BY signal_id, horizon_min
      `, [signalIds]);
      
      console.log('\n=== OUTCOMES FOR THESE SIGNALS ===');
      console.log('Signal ID | Horizon | State');
      console.log('----------+---------+-------');
      for (const row of outcomeRes.rows) {
        console.log(`${row.signal_id} | ${row.horizon_min} | ${row.outcome_state}`);
      }
    }
    
    // Check recent signals overall
    const recentRes = await client.query(`
      SELECT id, symbol, category, created_at, run_id
      FROM signals
      WHERE created_at > 1771410000000
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    console.log('\n=== RECENT SIGNALS (last few hours) ===');
    console.log('ID | Symbol | Category | Created | Run ID');
    console.log('---+--------+----------+---------+---------');
    for (const row of recentRes.rows) {
      const date = new Date(Number(row.created_at)).toISOString().slice(11, 16);
      console.log(`${row.id} | ${row.symbol} | ${row.category} | ${date} | ${row.run_id?.slice(0, 20)}...`);
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
