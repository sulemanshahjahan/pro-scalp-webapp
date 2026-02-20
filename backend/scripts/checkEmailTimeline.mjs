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
    
    console.log('=== EMAIL vs OUTCOME TIMELINE ===\n');
    
    // Signal 1882 details
    console.log('Signal 1882 (TAOUSDT READY_TO_BUY):');
    console.log('  Triggered at: 2026-02-18T11:18:31.818Z');
    console.log('  Email should be sent: IMMEDIATELY (within seconds)');
    console.log('  Outcomes resolve: After 15m/30m/60m/120m/240m\n');
    
    // Check if email was attempted (via email_guard)
    const guardRes = await client.query(`
      SELECT * FROM email_guard
      WHERE key LIKE '%TAOUSDT%'
         OR last_sent_ms BETWEEN 1771413511818 AND 1771413511818 + 60000
      ORDER BY last_sent_ms DESC
      LIMIT 5
    `);
    
    console.log('Email guard entries around signal time:', guardRes.rows.length);
    for (const row of guardRes.rows) {
      console.log(`  ${row.key}: ${new Date(Number(row.last_sent_ms)).toISOString()}`);
    }
    
    if (guardRes.rows.length === 0) {
      console.log('  ❌ NO EMAIL GUARD ENTRY = Email was never attempted');
    }
    
    // Check the outcomes for this signal
    const outcomeRes = await client.query(`
      SELECT horizon_min, outcome_state, attempted_at, resolved_at
      FROM signal_outcomes
      WHERE signal_id = 1882
      ORDER BY horizon_min
    `);
    
    console.log('\nOutcomes for signal 1882:');
    console.log('Horizon | State   | Created | Attempted | Resolved');
    console.log('--------+---------+---------+-----------+----------');
    for (const row of outcomeRes.rows) {
      const created = row.created_at ? new Date(Number(row.created_at)).toISOString().slice(11, 16) : 'N/A';
      const attempted = row.attempted_at ? new Date(Number(row.attempted_at)).toISOString().slice(11, 16) : 'pending';
      const resolved = row.resolved_at ? new Date(Number(row.resolved_at)).toISOString().slice(11, 16) : 'pending';
      console.log(`${String(row.horizon_min).padEnd(7)} | ${row.outcome_state.padEnd(7)} | ${created} | ${attempted} | ${resolved}`);
    }
    
    console.log('\n=== TIMELINE EXPLANATION ===');
    console.log('T+0s (11:18:31):    Signal triggered → Email SHOULD be sent');
    console.log('T+15m (11:33:31):   15m outcome resolves');
    console.log('T+30m (11:48:31):   30m outcome resolves');
    console.log('T+60m (12:18:31):   60m outcome resolves');
    console.log('etc...\n');
    
    if (guardRes.rows.length === 0) {
      console.log('🚨 CONCLUSION: Email was NEVER attempted at T+0');
      console.log('   This is a bug in the scanner notification logic.');
    }
    
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
