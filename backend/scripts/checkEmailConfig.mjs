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
    
    console.log('=== EMAIL CONFIG CHECK ===\n');
    
    // Check if email_guard table exists
    const tableRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'email_guard'
      ) as exists
    `);
    console.log('email_guard table exists:', tableRes.rows[0].exists);
    
    if (tableRes.rows[0].exists) {
      const guardRes = await client.query('SELECT * FROM email_guard LIMIT 5');
      console.log('Email guard entries:', guardRes.rows);
    }
    
    // Check meta for email
    const metaRes = await client.query(`
      SELECT * FROM meta 
      WHERE key LIKE '%email%' OR key LIKE '%smtp%' OR key LIKE '%mail%'
    `);
    console.log('\nMeta entries:', metaRes.rows);
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
