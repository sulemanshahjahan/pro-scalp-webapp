-- =====================================================
-- OUTCOME LABELING FIX - Run this on your Railway PostgreSQL
-- =====================================================
-- This script:
-- 1. Fixes missing result/outcome_driver for COMPLETE outcomes
-- 2. Fixes EXPIRED_AFTER_15M poisoning on longer horizons
-- 3. Provides segmentation analysis queries
--
-- Run with: psql $DATABASE_URL -f fix_outcomes.sql
-- =====================================================

-- =====================================================
-- PART 1: Diagnose current state
-- =====================================================
SELECT '=== CURRENT STATE DIAGNOSIS ===' as section;

SELECT
  COUNT(*) FILTER (WHERE outcome_state='COMPLETE') as complete_total,
  COUNT(*) FILTER (WHERE outcome_state='COMPLETE' AND (result IS NULL OR result='NONE')) as bad_result,
  COUNT(*) FILTER (WHERE outcome_state='COMPLETE' AND (outcome_driver IS NULL OR outcome_driver='')) as bad_driver,
  COUNT(*) FILTER (WHERE outcome_state='COMPLETE' AND exit_reason='EXPIRED_AFTER_15M') as expired_15m_count
FROM signal_outcomes;

SELECT
  horizon_min,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE exit_reason='EXPIRED_AFTER_15M') as expired_15m,
  COUNT(*) FILTER (WHERE result IS NULL OR result='NONE') as missing_result,
  COUNT(*) FILTER (WHERE outcome_driver IS NULL OR outcome_driver='') as missing_driver
FROM signal_outcomes
WHERE outcome_state='COMPLETE'
GROUP BY horizon_min
ORDER BY horizon_min;

-- =====================================================
-- PART 2: Fix result column based on r_realized
-- =====================================================
SELECT '=== FIXING RESULT COLUMN ===' as section;

UPDATE signal_outcomes
SET result = CASE
  WHEN r_realized > 0 THEN 'WIN'
  WHEN r_realized < 0 THEN 'LOSS'
  WHEN r_realized = 0 THEN 'FLAT'
  ELSE 'NONE'
END
WHERE outcome_state = 'COMPLETE'
  AND (result IS NULL OR result = 'NONE')
  AND exit_reason IS NOT NULL;

-- =====================================================
-- PART 3: Fix outcome_driver for STOP hits
-- =====================================================
SELECT '=== FIXING OUTCOME_DRIVER FOR STOPS ===' as section;

-- For outcomes that hit stop, derive the driver from signal quality metrics
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
  AND (so.outcome_driver IS NULL OR so.outcome_driver = '');

-- =====================================================
-- PART 4: Set outcome_driver for WINS
-- =====================================================
SELECT '=== FIXING OUTCOME_DRIVER FOR WINS ===' as section;

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
  AND (so.outcome_driver IS NULL OR so.outcome_driver = '');

-- =====================================================
-- PART 5: Set outcome_driver for TIMEOUTS/EXPIRES
-- =====================================================
SELECT '=== FIXING OUTCOME_DRIVER FOR TIMEOUTS ===' as section;

UPDATE signal_outcomes
SET outcome_driver = CASE
  WHEN exit_reason = 'EXPIRED_AFTER_15M' THEN 'EXPIRED_AFTER_15M'
  ELSE 'TIMEOUT_NO_HIT'
END
WHERE outcome_state = 'COMPLETE'
  AND trade_state = 'EXPIRED'
  AND (outcome_driver IS NULL OR outcome_driver = '');

-- =====================================================
-- PART 6: Fix EXPIRED_AFTER_15M poisoning (if OUTCOME_EXPIRE_AFTER_15M changed)
-- =====================================================
-- NOTE: Only run this if you've disabled OUTCOME_EXPIRE_AFTER_15M 
-- or changed it to '15' to only expire the 15m horizon
-- This will reset longer horizons that were incorrectly marked as expired

-- SELECT '=== RESETTING POISONED LONG HORIZONS (optional) ===' as section;
-- 
-- UPDATE signal_outcomes
-- SET 
--   outcome_state = 'PENDING',
--   window_status = 'PARTIAL',
--   trade_state = 'PENDING',
--   result = 'NONE',
--   outcome_driver = NULL,
--   exit_reason = NULL,
--   expired_after_15m = 0,
--   expired_reason = NULL,
--   attempted_at = 0,
--   computed_at = 0,
--   resolved_at = 0,
--   resolve_version = NULL
-- WHERE exit_reason = 'EXPIRED_AFTER_15M'
--   AND horizon_min > 15;

-- =====================================================
-- PART 7: Verify fixes
-- =====================================================
SELECT '=== VERIFICATION ===' as section;

SELECT
  COUNT(*) FILTER (WHERE outcome_state='COMPLETE') as complete_total,
  COUNT(*) FILTER (WHERE outcome_state='COMPLETE' AND (result IS NULL OR result='NONE')) as bad_result,
  COUNT(*) FILTER (WHERE outcome_state='COMPLETE' AND (outcome_driver IS NULL OR outcome_driver='')) as bad_driver
FROM signal_outcomes;

-- =====================================================
-- PART 8: SEGMENTATION ANALYSIS (The queries you requested)
-- =====================================================
SELECT '=== SEGMENTATION: BY BTC REGIME ===' as section;

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
  AND so.exit_reason != 'EXPIRED_AFTER_15M'  -- Exclude expired for cleaner stats
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT '=== SEGMENTATION: BY CONFIRM15M ===' as section;

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
  AND so.exit_reason != 'EXPIRED_AFTER_15M'
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT '=== SEGMENTATION: BY VWAP DISTANCE (deltaVwapPct) ===' as section;

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
  AND so.exit_reason != 'EXPIRED_AFTER_15M'
GROUP BY 1, 2
ORDER BY 1, 2;

SELECT '=== SEGMENTATION: BY EXIT REASON ===' as section;

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
ORDER BY 1, 2;

SELECT '=== COMPLETE SUMMARY BY HORIZON ===' as section;

SELECT
  so.horizon_min,
  COUNT(*) AS total_signals,
  COUNT(*) FILTER (WHERE so.result = 'WIN') AS wins,
  COUNT(*) FILTER (WHERE so.result = 'LOSS') AS losses,
  COUNT(*) FILTER (WHERE so.result = 'FLAT') AS flats,
  ROUND(AVG(so.r_realized)::numeric, 3) AS avg_r,
  ROUND(AVG(so.r_mae)::numeric, 3) AS avg_mae_r,
  ROUND(AVG(so.r_mfe)::numeric, 3) AS avg_mfe_r,
  ROUND((SUM(CASE WHEN so.r_realized > 0 THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0))::numeric, 3) AS win_rate
FROM signal_outcomes so
WHERE so.outcome_state='COMPLETE'
GROUP BY 1
ORDER BY 1;
