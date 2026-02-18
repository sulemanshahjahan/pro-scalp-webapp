import pg from 'pg';
const { Client } = pg;

const DATABASE_URL = "postgresql://postgres:KGboQAfuQthAtTRENDCVPcaLVzQzahiJ@switchyard.proxy.rlwy.net:21356/railway";

async function runFix(name, sql) {
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
    console.log(`Affected rows: ${res.rowCount} (${elapsed}ms)`);
    return res.rowCount;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return 0;
  } finally {
    await client.end();
  }
}

async function main() {
  console.log('Fixing outcome labels in Railway PostgreSQL...');
  
  // 1. Fix result column based on r_realized
  const fix1 = await runFix('FIX 1: Setting result from r_realized', `
    UPDATE signal_outcomes
    SET result = CASE
      WHEN r_realized > 0 THEN 'WIN'
      WHEN r_realized < 0 THEN 'LOSS'
      WHEN r_realized = 0 THEN 'FLAT'
      ELSE 'NONE'
    END
    WHERE outcome_state = 'COMPLETE'
      AND (result IS NULL OR result = 'NONE')
      AND exit_reason IS NOT NULL
  `);
  
  // 2. Fix outcome_driver for STOP hits
  const fix2 = await runFix('FIX 2: Setting outcome_driver for STOP hits', `
    UPDATE signal_outcomes so
    SET outcome_driver = CASE
      WHEN s.rr < 1.35 THEN 'RR_BELOW_MIN'
      WHEN ABS(s.deltaVwapPct) > 1.0 THEN 'VWAP_TOO_FAR'
      WHEN s.sweep_ok = 0 THEN 'NO_SWEEP'
      WHEN s.volSpike < 1.3 THEN 'VOL_SPIKE_NOT_MET'
      WHEN s.rsi9 < 40 OR s.rsi9 > 76 THEN 'RSI_NOT_IN_WINDOW'
      WHEN (s.btc_bear = 1 AND s.category IN ('READY_TO_BUY', 'BEST_ENTRY')) 
        OR (s.btc_bull = 1 AND s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY')) THEN 'BTC_CONTRA_TREND'
      WHEN s.session_ok = 0 THEN 'SESSION_OFF'
      ELSE 'STOP_HIT'
    END
    FROM signals s
    WHERE so.signal_id = s.id
      AND so.outcome_state = 'COMPLETE'
      AND so.trade_state = 'FAILED_SL'
      AND (so.outcome_driver IS NULL OR so.outcome_driver = '')
  `);
  
  // 3. Fix outcome_driver for WINS
  const fix3 = await runFix('FIX 3: Setting outcome_driver for WINS', `
    UPDATE signal_outcomes so
    SET outcome_driver = CASE
      WHEN (s.btc_bear = 1 AND s.category IN ('READY_TO_BUY', 'BEST_ENTRY')) 
        OR (s.btc_bull = 1 AND s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY')) THEN 'BTC_CONTRA_BUT_WIN'
      WHEN s.btc_bull = 1 AND s.category IN ('READY_TO_BUY', 'BEST_ENTRY') THEN 'BTC_BULL_TAILWIND'
      WHEN s.btc_bear = 1 AND s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY') THEN 'BTC_BEAR_TAILWIND'
      ELSE 'SETUP_WORKED'
    END
    FROM signals s
    WHERE so.signal_id = s.id
      AND so.outcome_state = 'COMPLETE'
      AND so.trade_state IN ('COMPLETED_TP1', 'COMPLETED_TP2')
      AND (so.outcome_driver IS NULL OR so.outcome_driver = '')
  `);
  
  // 4. Fix outcome_driver for TIMEOUTS/EXPIRES
  const fix4 = await runFix('FIX 4: Setting outcome_driver for TIMEOUTS', `
    UPDATE signal_outcomes
    SET outcome_driver = CASE
      WHEN exit_reason = 'EXPIRED_AFTER_15M' THEN 'EXPIRED_AFTER_15M'
      ELSE 'TIMEOUT_NO_HIT'
    END
    WHERE outcome_state = 'COMPLETE'
      AND trade_state = 'EXPIRED'
      AND (outcome_driver IS NULL OR outcome_driver = '')
  `);
  
  // 5. Optional: Reset poisoned long horizons (uncomment if you want to re-resolve)
  // const fix5 = await runFix('FIX 5: Resetting poisoned long horizons for re-resolution', `
  //   UPDATE signal_outcomes
  //   SET 
  //     outcome_state = 'PENDING',
  //     window_status = 'PARTIAL',
  //     trade_state = 'PENDING',
  //     result = 'NONE',
  //     outcome_driver = NULL,
  //     exit_reason = NULL,
  //     expired_after_15m = 0,
  //     expired_reason = NULL,
  //     attempted_at = 0,
  //     computed_at = 0,
  //     resolved_at = 0,
  //     resolve_version = NULL
  //   WHERE exit_reason = 'EXPIRED_AFTER_15M'
  //     AND horizon_min > 15
  // `);
  
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY:');
  console.log(`  - Fixed result labels: ${fix1} rows`);
  console.log(`  - Fixed STOP drivers: ${fix2} rows`);
  console.log(`  - Fixed WIN drivers: ${fix3} rows`);
  console.log(`  - Fixed TIMEOUT drivers: ${fix4} rows`);
  console.log('='.repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });
