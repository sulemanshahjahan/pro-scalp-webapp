-- Step 6: Fix LONG Dataset Quality
-- 
-- This script helps diagnose and fix issues with LONG signal outcomes
-- Run this to ensure long outcomes are being generated correctly

-- ============================================================================
-- 1. Check LONG vs SHORT signal counts
-- ============================================================================

SELECT 
    CASE 
        WHEN category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY') THEN 'LONG'
        WHEN category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT'
        ELSE 'OTHER'
    END as direction,
    category,
    COUNT(*) as signal_count,
    COUNT(CASE WHEN eo.id IS NOT NULL THEN 1 END) as has_extended_outcome,
    COUNT(CASE WHEN eo.completed_at IS NOT NULL THEN 1 END) as completed_outcomes
FROM signals s
LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint
GROUP BY 
    CASE 
        WHEN category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY') THEN 'LONG'
        WHEN category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT'
        ELSE 'OTHER'
    END,
    category
ORDER BY direction, category;

-- ============================================================================
-- 2. Check for LONG signals missing extended outcomes
-- ============================================================================

SELECT 
    s.id,
    s.symbol,
    s.category,
    s.price,
    s.stop,
    s.tp1,
    s.tp2,
    to_timestamp(s.created_at/1000) as signal_time
FROM signals s
LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY')
    AND s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint
    AND eo.id IS NULL
ORDER BY s.created_at DESC
LIMIT 50;

-- ============================================================================
-- 3. Check LONG outcome completion status
-- ============================================================================

SELECT 
    eo.status,
    eo.ext24_managed_status,
    COUNT(*) as count
FROM extended_outcomes eo
JOIN signals s ON s.id = eo.signal_id
WHERE s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY')
    AND eo.signal_time > (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint
GROUP BY eo.status, eo.ext24_managed_status
ORDER BY count DESC;

-- ============================================================================
-- 4. Check for PENDING LONG signals that should be completed
-- (signal_time + 24h < now, but still pending)
-- ============================================================================

SELECT 
    eo.signal_id,
    s.symbol,
    s.category,
    eo.status,
    to_timestamp(eo.signal_time/1000) as signal_time,
    to_timestamp(eo.expires_at/1000) as expires_at,
    to_timestamp(eo.completed_at/1000) as completed_at,
    EXTRACT(EPOCH FROM (NOW() - to_timestamp(eo.signal_time/1000))) / 3600 as hours_since_signal
FROM extended_outcomes eo
JOIN signals s ON s.id = eo.signal_id
WHERE s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY')
    AND eo.status = 'PENDING'
    AND eo.expires_at < EXTRACT(EPOCH FROM NOW()) * 1000
ORDER BY eo.signal_time DESC
LIMIT 50;

-- ============================================================================
-- 5. Force reset stuck LONG outcomes (use with caution)
-- This resets outcomes that are past 24h but still marked as PENDING
-- ============================================================================

/*
UPDATE extended_outcomes
SET 
    status = CASE 
        WHEN first_tp1_at IS NOT NULL THEN 'WIN_TP1'
        ELSE 'FLAT_TIMEOUT_24H'
    END,
    completed_at = CASE 
        WHEN completed_at IS NULL THEN EXTRACT(EPOCH FROM NOW()) * 1000
        ELSE completed_at
    END,
    outcome_state = 'COMPLETE'
WHERE signal_id IN (
    SELECT eo.signal_id
    FROM extended_outcomes eo
    JOIN signals s ON s.id = eo.signal_id
    WHERE s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY')
        AND eo.status = 'PENDING'
        AND eo.expires_at < EXTRACT(EPOCH FROM NOW()) * 1000 - (24 * 60 * 60 * 1000)
);
*/

-- ============================================================================
-- 6. Add explicit timeout status (optional - for data consistency)
-- This updates FLAT_TIMEOUT_24H status for better tracking
-- ============================================================================

/*
UPDATE extended_outcomes
SET 
    ext24_managed_status = 'CLOSED_TIMEOUT',
    ext24_managed_r = 0,
    ext24_realized_r = 0
WHERE status = 'FLAT_TIMEOUT_24H'
    AND (ext24_managed_status IS NULL OR ext24_managed_status = '');
*/

-- ============================================================================
-- 7. Check LONG outcome generation rate over time
-- ============================================================================

SELECT 
    DATE(to_timestamp(s.created_at/1000)) as date,
    COUNT(*) as total_signals,
    COUNT(CASE WHEN s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY') THEN 1 END) as long_signals,
    COUNT(CASE WHEN s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 1 END) as short_signals,
    COUNT(CASE WHEN eo.id IS NOT NULL AND s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY') THEN 1 END) as long_with_outcomes,
    COUNT(CASE WHEN eo.id IS NOT NULL AND s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 1 END) as short_with_outcomes
FROM signals s
LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '14 days') * 1000)::bigint
GROUP BY DATE(to_timestamp(s.created_at/1000))
ORDER BY date DESC;

-- ============================================================================
-- NOTES FOR MANUAL FIXES
-- ============================================================================

/*
If LONG outcomes are not being generated:

1. Check the 24h runner is enabled:
   - Verify EXTENDED_OUTCOME_ENABLED env var is set
   - Check backend logs for "[extended-outcomes]" messages

2. Ensure the extended_outcomes table exists:
   - Run: npm --prefix backend run db:migrate
   - Or use the backfill endpoint: POST /api/extended-outcomes/backfill

3. If specific signals are stuck in PENDING:
   - Use force-reevaluate: POST /api/extended-outcomes/force-reevaluate
   - Or manually reset with the SQL above (uncomment section 5)

4. For missing LONG signals entirely:
   - Check scanner configuration for LONG signal categories
   - Verify SIGNAL_LOG_CATS includes 'READY_TO_BUY' and 'BEST_ENTRY'
   - Check if LONG signals are being blocked by BTC gate

5. To add CLOSED_TIMEOUT explicitly:
   - Uncomment section 6 above and run
   - This ensures all timeouts have a managed status set
*/
