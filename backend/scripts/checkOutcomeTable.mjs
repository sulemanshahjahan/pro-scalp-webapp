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
    
    // Check if table exists
    const tableRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'signal_outcomes'
      ) as exists
    `);
    console.log('signal_outcomes table exists:', tableRes.rows[0].exists);
    
    // Check total count
    const countRes = await client.query('SELECT COUNT(*) as n FROM signal_outcomes');
    console.log('Total outcome rows:', countRes.rows[0].n);
    
    // Check recent signals without outcomes
    const missingRes = await client.query(`
      SELECT s.id, s.symbol, s.category, s.created_at
      FROM signals s
      LEFT JOIN signal_outcomes so ON so.signal_id = s.id
      WHERE s.created_at > 1771300000000
        AND so.signal_id IS NULL
      ORDER BY s.created_at DESC
      LIMIT 10
    `);
    
    console.log('\nSignals WITHOUT outcomes (recent):');
    console.log('id    | symbol   | category       | created_at');
    console.log('------+----------+----------------+------------------');
    for (const row of missingRes.rows) {
      const date = new Date(Number(row.created_at)).toISOString();
      console.log(`${String(row.id).padEnd(5)} | ${row.symbol.padEnd(8)} | ${row.category.padEnd(14)} | ${date}`);
    }
    
    // Check for constraint issues
    console.log('\n=== CHECKING CONSTRAINTS ===');
    const constraintRes = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE conrelid = 'signal_outcomes'::regclass
      AND contype = 'f'
    `);
    console.log('Foreign keys on signal_outcomes:');
    for (const row of constraintRes.rows) {
      console.log(`  ${row.conname}: ${row.def}`);
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
