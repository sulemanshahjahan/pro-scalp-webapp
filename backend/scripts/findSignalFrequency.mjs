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
    
    console.log('=== SIGNAL FREQUENCY ANALYSIS ===\n');
    
    // Check columns in signals table
    const colRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'signals'
      ORDER BY ordinal_position
    `);
    
    console.log('Available columns:', colRes.rows.map(r => r.column_name).join(', '));
    
    // Check last 7 days signal count
    const countRes = await client.query(`
      SELECT 
        DATE_TRUNC('day', to_timestamp(created_at/1000)) as day,
        category,
        COUNT(*) as n,
        ROUND(AVG(rr)::numeric, 2) as avg_rr,
        ROUND(AVG(ABS(deltaVwapPct))::numeric, 3) as avg_dvwap,
        ROUND(AVG(volSpike)::numeric, 2) as avg_vol
      FROM signals
      WHERE created_at > extract(epoch from now() - interval '7 days') * 1000
      GROUP BY 1, 2
      ORDER BY 1 DESC, 2
    `);
    
    console.log('\n=== Last 7 Days Signals ===');
    console.log('day        | category       | n  | avg_rr | avg_dvwap | avg_vol');
    console.log('-----------+----------------+----+--------+-----------+--------');
    for (const row of countRes.rows.slice(0, 20)) {
      const day = new Date(row.day).toISOString().split('T')[0];
      console.log(`${day} | ${String(row.category).padEnd(14)} | ${String(row.n).padEnd(2)} | ${String(row.avg_rr).padEnd(6)} | ${String(row.avg_dvwap).padEnd(9)} | ${row.avg_vol}`);
    }
    
    // Total signals by hour of day
    const hourlyRes = await client.query(`
      SELECT 
        EXTRACT(hour from to_timestamp(created_at/1000)) as hour,
        COUNT(*) as n
      FROM signals
      WHERE created_at > extract(epoch from now() - interval '7 days') * 1000
        AND category IN ('READY_TO_BUY', 'BEST_ENTRY')
      GROUP BY 1
      ORDER BY 1
    `);
    
    console.log('\n=== Signals by Hour (Last 7 Days) ===');
    for (const row of hourlyRes.rows) {
      const bar = '█'.repeat(Math.min(20, Math.floor(row.n / 2)));
      console.log(`Hour ${String(row.hour).padStart(2, '0')}: ${String(row.n).padStart(3)} ${bar}`);
    }
    
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
