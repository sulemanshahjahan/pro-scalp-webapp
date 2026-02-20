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
    
    console.log('=== DEBUGGING EMAIL FLOW FOR SIGNAL 1882 ===\n');
    
    // Get signal details
    const signalRes = await client.query(`
      SELECT * FROM signals WHERE id = 1882
    `);
    
    if (signalRes.rows.length === 0) {
      console.log('Signal 1882 not found');
      return;
    }
    
    const sig = signalRes.rows[0];
    console.log('Signal details:');
    console.log('  ID:', sig.id);
    console.log('  Symbol:', sig.symbol);
    console.log('  Category:', sig.category);
    console.log('  Created:', new Date(Number(sig.created_at)).toISOString());
    console.log('  Run ID:', sig.run_id);
    
    // Check signal_events (which triggers email)
    const eventRes = await client.query(`
      SELECT * FROM signal_events 
      WHERE signal_id = 1882
      ORDER BY created_at DESC
    `);
    
    console.log('\n=== SIGNAL EVENTS ===');
    console.log('Event count:', eventRes.rows.length);
    for (const row of eventRes.rows) {
      console.log(`  Event ${row.id}:`, row.category, '|', new Date(Number(row.created_at)).toISOString());
    }
    
    // Check if there's a cooldown entry in memory (we can't check this directly, but check meta)
    const metaRes = await client.query(`
      SELECT * FROM meta WHERE key LIKE '%email%' OR key LIKE '%cooldown%'
    `);
    
    console.log('\n=== META ENTRIES ===');
    console.log('Meta rows:', metaRes.rows.length);
    for (const row of metaRes.rows) {
      console.log(`  ${row.key}:`, row.value);
    }
    
    // Check backend logs via scan_runs
    const runRes = await client.query(`
      SELECT * FROM scan_runs 
      WHERE run_id = $1
    `, [sig.run_id]);
    
    console.log('\n=== SCAN RUN ===');
    if (runRes.rows.length > 0) {
      const run = runRes.rows[0];
      console.log('Run ID:', run.run_id);
      console.log('Status:', run.status);
      console.log('Signals by category:', run.signals_by_category_json);
      console.log('Error:', run.error_message);
    } else {
      console.log('No scan run found');
    }
    
    // Check if outcomes were seeded
    const outcomeRes = await client.query(`
      SELECT COUNT(*) as n FROM signal_outcomes WHERE signal_id = 1882
    `);
    
    console.log('\n=== OUTCOME SEEDING ===');
    console.log('Outcome rows for signal 1882:', outcomeRes.rows[0].n);
    if (outcomeRes.rows[0].n === 0) {
      console.log('❌ Outcomes were NOT seeded for this signal');
      console.log('   This means seedPendingOutcomeRowsForSignal failed or was not called');
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
