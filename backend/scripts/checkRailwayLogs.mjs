// Check recent signals and their events/outcomes in detail
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
    
    console.log('=== CHECKING SIGNAL 1882 IN DETAIL ===\n');
    
    // Get full signal record
    const sigRes = await client.query(`SELECT * FROM signals WHERE id = 1882`);
    if (sigRes.rows.length === 0) {
      console.log('Signal not found');
      return;
    }
    
    console.log('Full signal record:');
    const sig = sigRes.rows[0];
    for (const [key, val] of Object.entries(sig)) {
      console.log(`  ${key}: ${val}`);
    }
    
    // Check if config_hash is causing issues
    console.log('\n=== CONFIG HASH ANALYSIS ===');
    console.log('Signal config_hash:', sig.config_hash);
    
    // Check for similar signals with same hash
    const sameHashRes = await client.query(`
      SELECT id, symbol, category, created_at, config_hash
      FROM signals
      WHERE config_hash = $1
      ORDER BY created_at
    `, [sig.config_hash]);
    
    console.log(`\nSignals with same config_hash (${sig.config_hash}):`, sameHashRes.rows.length);
    for (const row of sameHashRes.rows) {
      console.log(`  ${row.id} | ${row.symbol} | ${row.category} | ${new Date(Number(row.created_at)).toISOString()}`);
    }
    
    // Check if there's a conflict issue
    console.log('\n=== CONFLICT CHECK ===');
    const conflictRes = await client.query(`
      SELECT id, symbol, category, time, config_hash, created_at
      FROM signals
      WHERE symbol = $1 AND category = $2 AND time = $3
    `, [sig.symbol, sig.category, sig.time]);
    
    console.log('Signals with same symbol/category/time:', conflictRes.rows.length);
    for (const row of conflictRes.rows) {
      console.log(`  ID: ${row.id}, config_hash: ${row.config_hash}, created: ${new Date(Number(row.created_at)).toISOString()}`);
    }
    
    // Check signal_events for this exact combination
    console.log('\n=== EVENT CHECK ===');
    const eventRes = await client.query(`
      SELECT * FROM signal_events
      WHERE symbol = $1 AND category = $2 AND time = $3
    `, [sig.symbol, sig.category, sig.time]);
    
    console.log('Events found:', eventRes.rows.length);
    for (const row of eventRes.rows) {
      console.log(`  Event ID: ${row.id}, signal_id: ${row.signal_id}, created: ${new Date(Number(row.created_at)).toISOString()}`);
    }
    
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
