-- Check 24h Extended Outcomes (the REAL performance data)
-- FIXED for PostgreSQL type casting

-- 1. Quick 24h performance summary
SELECT 
    s.category,
    COUNT(*) as total_signals,
    COUNT(CASE WHEN eo.status = 'WIN_TP1' THEN 1 END) as win_tp1,
    COUNT(CASE WHEN eo.status = 'WIN_TP2' THEN 1 END) as win_tp2,
    COUNT(CASE WHEN eo.status = 'LOSS_STOP' THEN 1 END) as loss_stop,
    COUNT(CASE WHEN eo.status = 'FLAT_TIMEOUT_24H' THEN 1 END) as flat_timeout,
    COUNT(CASE WHEN eo.status = 'PENDING' THEN 1 END) as pending,
    ROUND(
        (COUNT(CASE WHEN eo.status IN ('WIN_TP1', 'WIN_TP2') THEN 1 END)::numeric / 
         NULLIF(COUNT(*), 0)) * 100, 1
    ) as win_rate_pct,
    ROUND(
        (COUNT(CASE WHEN eo.status = 'LOSS_STOP' THEN 1 END)::numeric / 
         NULLIF(COUNT(*), 0)) * 100, 1
    ) as loss_rate_pct,
    ROUND(AVG(eo.ext24_managed_r)::numeric, 3) as avg_managed_r,
    ROUND(SUM(COALESCE(eo.ext24_managed_r, 0))::numeric, 2) as total_r
FROM signals s
JOIN extended_outcomes eo ON s.id = eo.signal_id
WHERE s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint
GROUP BY s.category
ORDER BY total_signals DESC;

-- 2. Recent 24h outcomes with details (last 48 hours)
SELECT 
    s.symbol,
    s.category,
    s.price as entry,
    s.stop,
    s.tp1,
    s.tp2,
    eo.status as outcome_24h,
    ROUND(eo.ext24_managed_r::numeric, 3) as managed_r,
    ROUND(eo.ext24_managed_pnl_usd::numeric, 2) as pnl_usd,
    ROUND(eo.time_to_first_hit_seconds::numeric / 60, 1) as time_to_hit_min,
    ROUND(eo.max_favorable_excursion_pct::numeric, 2) as mfe_pct,
    ROUND(eo.max_adverse_excursion_pct::numeric, 2) as mae_pct,
    ROUND(eo.coverage_pct::numeric, 1) as coverage_pct,
    to_timestamp(s.created_at/1000) as signal_time
FROM signals s
JOIN extended_outcomes eo ON s.id = eo.signal_id
WHERE s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '48 hours') * 1000)::bigint
    AND s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'READY_TO_SELL', 'BEST_SHORT_ENTRY')
ORDER BY s.created_at DESC
LIMIT 50;

-- 3. Simple 24h stats - Your actual bleeding money check
SELECT 
    'ALL SIGNALS' as scope,
    COUNT(*) as total,
    COUNT(CASE WHEN eo.status IN ('WIN_TP1', 'WIN_TP2') THEN 1 END) as wins,
    COUNT(CASE WHEN eo.status = 'LOSS_STOP' THEN 1 END) as losses,
    COUNT(CASE WHEN eo.status = 'FLAT_TIMEOUT_24H' THEN 1 END) as timeouts,
    ROUND(
        (COUNT(CASE WHEN eo.status IN ('WIN_TP1', 'WIN_TP2') THEN 1 END)::numeric / 
         NULLIF(COUNT(*), 0)) * 100, 1
    ) as win_rate_pct,
    ROUND(AVG(eo.ext24_managed_r)::numeric, 3) as avg_r,
    ROUND(SUM(COALESCE(eo.ext24_managed_r, 0))::numeric, 2) as total_r
FROM signals s
JOIN extended_outcomes eo ON s.id = eo.signal_id
WHERE s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint
    AND s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'READY_TO_SELL', 'BEST_SHORT_ENTRY');

-- 4. Your specific 41 READY_TO_BUY signals - 24h outcomes
SELECT 
    s.symbol,
    eo.status as final_24h_outcome,
    ROUND(eo.ext24_managed_r::numeric, 3) as r_return,
    ROUND(eo.ext24_managed_pnl_usd::numeric, 2) as pnl_usd,
    ROUND(eo.time_to_first_hit_seconds::numeric / 3600, 1) as hours_to_hit,
    to_timestamp(s.created_at/1000) as signal_time
FROM signals s
JOIN extended_outcomes eo ON s.id = eo.signal_id
WHERE s.category = 'READY_TO_BUY'
    AND s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint
ORDER BY s.created_at DESC
LIMIT 50;

-- 5. Performance trend by day (last 7 days)
SELECT 
    DATE(to_timestamp(s.created_at/1000)) as date,
    COUNT(*) as signals,
    COUNT(CASE WHEN eo.status IN ('WIN_TP1', 'WIN_TP2') THEN 1 END) as wins,
    COUNT(CASE WHEN eo.status = 'LOSS_STOP' THEN 1 END) as losses,
    ROUND(AVG(eo.ext24_managed_r)::numeric, 3) as avg_r,
    ROUND(SUM(COALESCE(eo.ext24_managed_r, 0))::numeric, 2) as total_r
FROM signals s
JOIN extended_outcomes eo ON s.id = eo.signal_id
WHERE s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint
    AND s.category IN ('READY_TO_BUY', 'BEST_ENTRY', 'READY_TO_SELL', 'BEST_SHORT_ENTRY')
GROUP BY DATE(to_timestamp(s.created_at/1000))
ORDER BY date DESC;
