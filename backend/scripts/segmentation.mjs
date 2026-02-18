import pg from 'pg';
const { Client } = pg;

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
    console.log('='.repeat(80));
    const start = Date.now();
    const res = await client.query(sql);
    const elapsed = Date.now() - start;
    
    if (res.rows.length === 0) {
      console.log('(no rows)');
    } else {
      // Print as table
      const cols = Object.keys(res.rows[0]);
      const colWidths = cols.map(c => {
        const maxDataLen = Math.max(...res.rows.map(r => String(r[c] ?? 'NULL').length));
        return Math.max(c.length, maxDataLen);
      });
      
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
  console.log('Running segmentation analysis on Railway PostgreSQL...');
  
  // 1. SEGMENTATION: BY BTC REGIME
  await runQuery('SEGMENTATION: BY BTC REGIME', `
    SELECT
      so.horizon_min,
      CASE WHEN s.blocked_by_btc=1 THEN 'BTC_BLOCKED' ELSE 'BTC_OK' END AS btc_bucket,
      COUNT(*) AS n,
      ROUND(AVG(so.r_realized)::numeric, 3) AS avg_r,
      ROUND(AVG(so.r_mae)::numeric, 3) AS avg_mae_r,
      ROUND(AVG(so.r_mfe)::numeric, 3) AS avg_mfe_r,
      ROUND((SUM(CASE WHEN so.r_realized > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0))::numeric, 3) AS win_rate
    FROM signal_outcomes so
    JOIN signals s ON s.id = so.signal_id
    WHERE so.outcome_state='COMPLETE'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  
  // 2. SEGMENTATION: BY CONFIRM15M
  await runQuery('SEGMENTATION: BY CONFIRM15M', `
    SELECT
      so.horizon_min,
      COALESCE(s.confirm15m, 0) as confirm15m,
      COUNT(*) AS n,
      ROUND(AVG(so.r_realized)::numeric, 3) AS avg_r,
      ROUND(AVG(so.r_mae)::numeric, 3) AS avg_mae_r,
      ROUND(AVG(so.r_mfe)::numeric, 3) AS avg_mfe_r,
      ROUND((SUM(CASE WHEN so.r_realized > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0))::numeric, 3) AS win_rate
    FROM signal_outcomes so
    JOIN signals s ON s.id = so.signal_id
    WHERE so.outcome_state='COMPLETE'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  
  // 3. SEGMENTATION: BY VWAP DISTANCE
  await runQuery('SEGMENTATION: BY VWAP DISTANCE (deltaVwapPct)', `
    SELECT
      so.horizon_min,
      CASE 
        WHEN s.deltaVwapPct < -1.0 THEN '< -1.0%'
        WHEN s.deltaVwapPct < -0.5 THEN '-1.0% to -0.5%'
        WHEN s.deltaVwapPct < 0 THEN '-0.5% to 0%'
        WHEN s.deltaVwapPct < 0.5 THEN '0% to 0.5%'
        WHEN s.deltaVwapPct < 1.0 THEN '0.5% to 1.0%'
        ELSE '> 1.0%'
      END AS vwap_bucket,
      ROUND(AVG(s.deltaVwapPct)::numeric, 3) as avg_delta_vwap,
      COUNT(*) AS n,
      ROUND(AVG(so.r_realized)::numeric, 3) AS avg_r,
      ROUND((SUM(CASE WHEN so.r_realized > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0))::numeric, 3) AS win_rate
    FROM signal_outcomes so
    JOIN signals s ON s.id = so.signal_id
    WHERE so.outcome_state='COMPLETE'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  
  // 4. SEGMENTATION: BY EXIT REASON
  await runQuery('SEGMENTATION: BY EXIT REASON', `
    SELECT
      so.horizon_min,
      so.exit_reason,
      COUNT(*) AS n,
      ROUND(AVG(so.r_realized)::numeric, 3) AS avg_r,
      ROUND(AVG(so.r_mae)::numeric, 3) AS avg_mae_r,
      ROUND(AVG(so.r_mfe)::numeric, 3) AS avg_mfe_r
    FROM signal_outcomes so
    WHERE so.outcome_state='COMPLETE'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  
  // 5. SUMMARY BY HORIZON
  await runQuery('SUMMARY BY HORIZON', `
    SELECT
      so.horizon_min,
      COUNT(*) AS total_signals,
      COUNT(*) FILTER (WHERE so.r_realized > 0) AS wins,
      COUNT(*) FILTER (WHERE so.r_realized < 0) AS losses,
      COUNT(*) FILTER (WHERE so.r_realized = 0) AS flats,
      ROUND(AVG(so.r_realized)::numeric, 3) AS avg_r,
      ROUND(AVG(so.r_mae)::numeric, 3) AS avg_mae_r,
      ROUND(AVG(so.r_mfe)::numeric, 3) AS avg_mfe_r,
      ROUND((SUM(CASE WHEN so.r_realized > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0))::numeric, 3) AS win_rate
    FROM signal_outcomes so
    WHERE so.outcome_state='COMPLETE'
    GROUP BY 1
    ORDER BY 1
  `);
}

main().catch(e => { console.error(e); process.exit(1); });
