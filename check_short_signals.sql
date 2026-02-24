-- Check for short signals in the database
-- FIXED for bigint timestamps (Unix epoch milliseconds)

-- 1. Count all short signals by category (last 7 days)
SELECT 
    category,
    COUNT(*) as count,
    MAX(created_at) as latest_signal_ms,
    to_timestamp(MAX(created_at)/1000) as latest_signal_time
FROM signals
WHERE category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT')
    AND created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint
GROUP BY category
ORDER BY count DESC;

-- 2. List recent short signals with details
SELECT 
    symbol,
    category,
    price,
    stop,
    tp1,
    tp2,
    rr,
    rsi_9 as rsi,
    created_at,
    to_timestamp(created_at/1000) as created_time,
    trend_ok,
    confirm_15m
FROM signals
WHERE category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT')
    AND created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000)::bigint
ORDER BY created_at DESC
LIMIT 20;

-- 3. Compare long vs short signal counts (last 24 hours)
SELECT 
    CASE 
        WHEN category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY') THEN 'LONG'
        WHEN category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT'
        ELSE 'OTHER'
    END as direction,
    COUNT(*) as count
FROM signals
WHERE created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000)::bigint
GROUP BY 
    CASE 
        WHEN category IN ('READY_TO_BUY', 'BEST_ENTRY', 'EARLY_READY') THEN 'LONG'
        WHEN category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT') THEN 'SHORT'
        ELSE 'OTHER'
    END;

-- 4. Check ALL recent signals (regardless of category) to see what's being generated
SELECT 
    category,
    COUNT(*) as count,
    MIN(to_timestamp(created_at/1000)) as earliest,
    MAX(to_timestamp(created_at/1000)) as latest
FROM signals
WHERE created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000)::bigint
GROUP BY category
ORDER BY count DESC;

-- 5. Check scan_runs for signals_by_category_json (contains signal counts)
SELECT 
    id,
    run_id,
    to_timestamp(started_at/1000) as started_time,
    signals_by_category_json
FROM scan_runs
WHERE started_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000)::bigint
ORDER BY started_at DESC
LIMIT 10;

-- 6. Parse signals_by_category_json to extract short signal counts
WITH recent_runs AS (
    SELECT 
        id,
        run_id,
        to_timestamp(started_at/1000) as started_time,
        signals_by_category_json::jsonb as cats
    FROM scan_runs
    WHERE started_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000)::bigint
)
SELECT 
    id,
    run_id,
    started_time,
    COALESCE((cats->>'READY_TO_SELL')::int, 0) as ready_to_sell,
    COALESCE((cats->>'BEST_SHORT_ENTRY')::int, 0) as best_short_entry,
    COALESCE((cats->>'EARLY_READY_SHORT')::int, 0) as early_ready_short,
    COALESCE((cats->>'READY_TO_BUY')::int, 0) as ready_to_buy,
    COALESCE((cats->>'BEST_ENTRY')::int, 0) as best_entry,
    COALESCE((cats->>'EARLY_READY')::int, 0) as early_ready
FROM recent_runs
ORDER BY started_time DESC
LIMIT 20;

-- 7. Check recent signals with full details (last 12 hours, any category)
SELECT 
    s.symbol,
    s.category,
    s.price,
    s.stop,
    s.tp1,
    s.rr,
    s.rsi_9,
    to_timestamp(s.created_at/1000) as created_time,
    s.trend_ok,
    s.confirm_15m,
    s.would_be_category
FROM signals s
WHERE s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '12 hours') * 1000)::bigint
ORDER BY s.created_at DESC
LIMIT 50;

-- 8. Check for would_be_category short signals (shorts that were detected but possibly filtered)
SELECT 
    would_be_category,
    category as actual_category,
    COUNT(*) as count
FROM signals
WHERE would_be_category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY', 'EARLY_READY_SHORT')
    AND created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000)::bigint
GROUP BY would_be_category, category
ORDER BY count DESC;

-- 9. Check gate_stats_json for short gate statistics (if available)
WITH gate_stats AS (
    SELECT 
        id,
        run_id,
        to_timestamp(started_at/1000) as started_time,
        gate_stats_json::jsonb as gs
    FROM scan_runs
    WHERE started_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000)::bigint
      AND gate_stats_json IS NOT NULL
    ORDER BY started_at DESC
    LIMIT 5
)
SELECT 
    id,
    run_id,
    started_time,
    gs->'gateTrue'->'readyShort' as ready_short_gates,
    gs->'gateTrue'->'bestShort' as best_short_gates,
    gs->'firstFailed'->'readyShort' as ready_short_first_failed
FROM gate_stats;
