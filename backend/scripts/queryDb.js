const { Client } = require('pg');

const DATABASE_URL = "postgresql://postgres:KGboQAfuQthAtTRENDCVPcaLVzQzahiJ@switchyard.proxy.rlwy.net:21356/railway";

async function runQuery(name, sql) {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 60000,
    query_timeout: 60000
  });
  
  try {
    await client.connect();
    console.log('\n' + name);
    console.log('='.repeat(70));
    const start = Date.now();
    const res = await client.query(sql);
    const elapsed = Date.now() - start;
    
    if (res.rows.length === 0) {
      console.log('(no rows)');
    } else {
      // Print as table
      const cols = Object.keys(res.rows[0]);
      const colWidths = cols.map(c => Math.max(c.length, ...res.rows.map(r => String(r[c] ?? 'NULL').length)));
      
      // Header
      console.log(cols.map((c, i) => c.padEnd(colWidths[i])).join(' | '));
      console.log(colWidths.map(w => '-'.repeat(w)).join('-+-'));
      
      // Rows
      for (const row of res.rows) {
        console.log(cols.map((c, i) => String(row[c] ?? 'NULL').padEnd(colWidths[i])).join(' | '));
      }
      console.log(`(${res.rows.length} rows, ${elapsed}ms)`);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
  } finally {
    await client.end();
  }
}

async function main() {
  // Quick connectivity test
  console.log('Connecting to Railway PostgreSQL...');
  
  // 1. Current state diagnosis
  await runQuery('CURRENT STATE DIAGNOSIS', `
    SELECT
      COUNT(*) FILTER (WHERE outcome_state='COMPLETE') as complete_total,
      COUNT(*) FILTER (WHERE outcome_state='COMPLETE' AND (result IS NULL OR result='NONE')) as bad_result,
      COUNT(*) FILTER (WHERE outcome_state='COMPLETE' AND (outcome_driver IS NULL OR outcome_driver='')) as bad_driver,
      COUNT(*) FILTER (WHERE outcome_state='COMPLETE' AND exit_reason='EXPIRED_AFTER_15M') as expired_15m_count
    FROM signal_outcomes
  `);
  
  // 2. By horizon
  await runQuery('BY HORIZON', `
    SELECT
      horizon_min,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE exit_reason='EXPIRED_AFTER_15M') as expired_15m,
      COUNT(*) FILTER (WHERE result IS NULL OR result='NONE') as missing_result,
      COUNT(*) FILTER (WHERE outcome_driver IS NULL OR outcome_driver='') as missing_driver
    FROM signal_outcomes
    WHERE outcome_state='COMPLETE'
    GROUP BY horizon_min
    ORDER BY horizon_min
  `);
}

main().catch(e => { console.error(e); process.exit(1); });
