import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const client = await pool.connect();
  const result = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'signals' 
    ORDER BY ordinal_position
  `);
  console.log('=== SIGNALS TABLE COLUMNS ===');
  result.rows.forEach(r => console.log(r.column_name + ' (' + r.data_type + ')'));
  client.release();
  await pool.end();
}
main().catch(console.error);
