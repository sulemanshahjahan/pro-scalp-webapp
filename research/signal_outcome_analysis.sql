-- ============================================================================
-- SIGNAL & OUTCOME RESEARCH ANALYSIS
-- Run these queries in pgAdmin to understand trading performance
-- ============================================================================

-- ============================================================================
-- SECTION 1: OVERVIEW STATISTICS
-- ============================================================================

-- 1.1 Overall Signal Count by Status
SELECT 
    status,
    COUNT(*) as count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) as pct
FROM extended_outcomes
GROUP BY status
ORDER BY count DESC;

-- 1.2 Overall Performance (Managed R)
SELECT 
    COUNT(*) as total_signals,
    SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as winners,
    SUM(CASE WHEN ext24_managed_r < 0 THEN 1 ELSE 0 END) as losers,
    SUM(CASE WHEN ext24_managed_r = 0 THEN 1 ELSE 0 END) as breakeven,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(SUM(ext24_managed_r), 3) as total_r,
    ROUND(SUM(CASE WHEN ext24_managed_r > 0 THEN ext24_managed_r ELSE 0 END), 3) as total_win_r,
    ROUND(SUM(CASE WHEN ext24_managed_r < 0 THEN ext24_managed_r ELSE 0 END), 3) as total_loss_r
FROM extended_outcomes
WHERE completed_at IS NOT NULL
    AND status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP', 'FLAT_TIMEOUT_24H');

-- 1.3 Completed vs Pending
SELECT 
    CASE WHEN completed_at IS NOT NULL THEN 'Completed' ELSE 'Pending' END as status,
    COUNT(*) as count
FROM extended_outcomes
GROUP BY completed_at IS NOT NULL;

-- ============================================================================
-- SECTION 2: SYMBOL PERFORMANCE ANALYSIS
-- ============================================================================

-- 2.1 Symbol Performance Summary (min 3 trades)
SELECT 
    symbol,
    COUNT(*) as total_trades,
    SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN ext24_managed_r < 0 THEN 1 ELSE 0 END) as losses,
    ROUND(100.0 * SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(SUM(ext24_managed_r), 3) as total_r,
    ROUND(AVG(max_favorable_excursion_pct), 3) as avg_mfe_pct,
    ROUND(AVG(max_adverse_excursion_pct), 3) as avg_mae_pct
FROM extended_outcomes
WHERE completed_at IS NOT NULL
    AND status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP', 'FLAT_TIMEOUT_24H')
GROUP BY symbol
HAVING COUNT(*) >= 3
ORDER BY total_r DESC;

-- 2.2 Symbol Performance by Direction
SELECT 
    symbol,
    direction,
    COUNT(*) as trades,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(SUM(ext24_managed_r), 3) as total_r
FROM extended_outcomes
WHERE completed_at IS NOT NULL
GROUP BY symbol, direction
HAVING COUNT(*) >= 2
ORDER BY symbol, direction;

-- ============================================================================
-- SECTION 3: CATEGORY/SIGNAL TYPE ANALYSIS
-- ============================================================================

-- 3.1 Performance by Category
SELECT 
    category,
    COUNT(*) as total,
    SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN ext24_managed_r <= 0 THEN 1 ELSE 0 END) as losses,
    ROUND(100.0 * SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(SUM(ext24_managed_r), 3) as total_r
FROM extended_outcomes
WHERE completed_at IS NOT NULL
    AND status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP', 'FLAT_TIMEOUT_24H')
GROUP BY category
ORDER BY total_r DESC;

-- 3.2 Category by Direction
SELECT 
    category,
    direction,
    COUNT(*) as trades,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(AVG(max_favorable_excursion_pct), 3) as avg_mfe,
    ROUND(AVG(max_adverse_excursion_pct), 3) as avg_mae
FROM extended_outcomes
WHERE completed_at IS NOT NULL
GROUP BY category, direction
ORDER BY category, direction;

-- ============================================================================
-- SECTION 4: TIMING ANALYSIS
-- ============================================================================

-- 4.1 Performance by Hour of Day (UTC)
SELECT 
    EXTRACT(HOUR FROM TO_TIMESTAMP(signal_time / 1000)) as hour_utc,
    COUNT(*) as trades,
    SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(100.0 * SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(SUM(ext24_managed_r), 3) as total_r
FROM extended_outcomes
WHERE completed_at IS NOT NULL
    AND status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP', 'FLAT_TIMEOUT_24H')
GROUP BY EXTRACT(HOUR FROM TO_TIMESTAMP(signal_time / 1000))
ORDER BY hour_utc;

-- 4.2 Performance by Day of Week
SELECT 
    EXTRACT(DOW FROM TO_TIMESTAMP(signal_time / 1000)) as day_of_week,
    TO_CHAR(TO_TIMESTAMP(signal_time / 1000), 'Day') as day_name,
    COUNT(*) as trades,
    SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(100.0 * SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(SUM(ext24_managed_r), 3) as total_r
FROM extended_outcomes
WHERE completed_at IS NOT NULL
    AND status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP', 'FLAT_TIMEOUT_24H')
GROUP BY EXTRACT(DOW FROM TO_TIMESTAMP(signal_time / 1000)), 
         TO_CHAR(TO_TIMESTAMP(signal_time / 1000), 'Day')
ORDER BY day_of_week;

-- 4.3 Time to Hit Analysis (how fast do signals resolve)
SELECT 
    status,
    COUNT(*) as count,
    ROUND(AVG(time_to_first_hit_seconds) / 60, 1) as avg_minutes_to_first_hit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_to_first_hit_seconds) / 60, 1) as median_minutes
FROM extended_outcomes
WHERE completed_at IS NOT NULL
    AND time_to_first_hit_seconds > 0
GROUP BY status;

-- ============================================================================
-- SECTION 5: MFE/MAE ANALYSIS (Understanding Winners vs Losers)
-- ============================================================================

-- 5.1 MFE/MAE Distribution by Outcome
SELECT 
    CASE 
        WHEN status IN ('WIN_TP1', 'WIN_TP2') THEN 'WIN'
        WHEN status = 'LOSS_STOP' THEN 'LOSS'
        WHEN status = 'FLAT_TIMEOUT_24H' THEN 'TIMEOUT'
        ELSE 'OTHER'
    END as outcome_group,
    COUNT(*) as count,
    ROUND(AVG(max_favorable_excursion_pct), 3) as avg_mfe_pct,
    ROUND(AVG(max_adverse_excursion_pct), 3) as avg_mae_pct,
    ROUND(AVG(max_favorable_excursion_pct - max_adverse_excursion_pct), 3) as avg_mfe_mae_diff,
    ROUND(STDDEV(max_favorable_excursion_pct), 3) as mfe_stddev,
    ROUND(STDDEV(max_adverse_excursion_pct), 3) as mae_stddev
FROM extended_outcomes
WHERE completed_at IS NOT NULL
GROUP BY CASE 
        WHEN status IN ('WIN_TP1', 'WIN_TP2') THEN 'WIN'
        WHEN status = 'LOSS_STOP' THEN 'LOSS'
        WHEN status = 'FLAT_TIMEOUT_24H' THEN 'TIMEOUT'
        ELSE 'OTHER'
    END
ORDER BY avg_r DESC;

-- 5.2 Stop Loss Analysis - How many would be saved by wider stops?
SELECT 
    symbol,
    entry_price,
    stop_price,
    max_adverse_excursion_pct,
    ABS((entry_price - stop_price) / entry_price * 100) as original_stop_pct,
    ABS((entry_price - stop_price) / entry_price * 100) * 1.4 as wider_stop_pct_1_4x,
    CASE 
        WHEN max_adverse_excursion_pct < ABS((entry_price - stop_price) / entry_price * 100) * 1.4 
        THEN 'WOULD_SURVIVE_1_4X'
        ELSE 'STILL_STOPPED'
    END as wider_stop_outcome,
    ext24_managed_r
FROM extended_outcomes
WHERE status = 'LOSS_STOP'
    AND completed_at IS NOT NULL
ORDER BY signal_time DESC
LIMIT 20;

-- ============================================================================
-- SECTION 6: GATE FAILURE ANALYSIS
-- ============================================================================

-- 6.1 Join with signals to see gate failures
SELECT 
    s.category,
    s.first_failed_gate,
    COUNT(*) as blocked_count,
    ROUND(AVG(s.gate_score), 2) as avg_gate_score
FROM signals s
LEFT JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE s.blocked_reasons_json IS NOT NULL
    OR eo.id IS NULL
GROUP BY s.category, s.first_failed_gate
ORDER BY blocked_count DESC;

-- 6.2 Signals that passed gate but still lost
SELECT 
    s.symbol,
    s.category,
    s.time,
    s.gate_score,
    eo.status,
    eo.ext24_managed_r,
    eo.max_favorable_excursion_pct,
    eo.max_adverse_excursion_pct,
    s.blocked_reasons_json
FROM signals s
JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE eo.status = 'LOSS_STOP'
    AND (s.blocked_reasons_json IS NULL OR s.blocked_reasons_json = '[]')
ORDER BY s.time DESC
LIMIT 20;

-- ============================================================================
-- SECTION 7: RISK/REWARD ANALYSIS
-- ============================================================================

-- 7.1 Performance by R:R at entry
SELECT 
    CASE 
        WHEN s.rr < 1.2 THEN '< 1.2'
        WHEN s.rr BETWEEN 1.2 AND 1.5 THEN '1.2 - 1.5'
        WHEN s.rr BETWEEN 1.5 AND 2.0 THEN '1.5 - 2.0'
        WHEN s.rr > 2.0 THEN '> 2.0'
        ELSE 'Unknown'
    END as rr_bucket,
    COUNT(*) as trades,
    SUM(CASE WHEN eo.ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(100.0 * SUM(CASE WHEN eo.ext24_managed_r > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate,
    ROUND(AVG(eo.ext24_managed_r), 3) as avg_r,
    ROUND(SUM(eo.ext24_managed_r), 3) as total_r
FROM signals s
JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE eo.completed_at IS NOT NULL
GROUP BY CASE 
        WHEN s.rr < 1.2 THEN '< 1.2'
        WHEN s.rr BETWEEN 1.2 AND 1.5 THEN '1.2 - 1.5'
        WHEN s.rr BETWEEN 1.5 AND 2.0 THEN '1.5 - 2.0'
        WHEN s.rr > 2.0 THEN '> 2.0'
        ELSE 'Unknown'
    END
ORDER BY rr_bucket;

-- ============================================================================
-- SECTION 9: CORRELATION ANALYSIS
-- ============================================================================

-- 9.1 BTC Market Condition vs Performance
SELECT 
    CASE 
        WHEN s.btc_bull = 1 THEN 'BULL'
        WHEN s.btc_bear = 1 THEN 'BEAR'
        ELSE 'NEUTRAL'
    END as btc_condition,
    COUNT(*) as trades,
    SUM(CASE WHEN eo.ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(100.0 * SUM(CASE WHEN eo.ext24_managed_r > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate,
    ROUND(AVG(eo.ext24_managed_r), 3) as avg_r,
    ROUND(SUM(eo.ext24_managed_r), 3) as total_r
FROM signals s
JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE eo.completed_at IS NOT NULL
GROUP BY CASE 
        WHEN s.btc_bull = 1 THEN 'BULL'
        WHEN s.btc_bear = 1 THEN 'BEAR'
        ELSE 'NEUTRAL'
    END
ORDER BY total_r DESC;

-- 9.2 Volume Spike vs Performance
SELECT 
    CASE 
        WHEN s.volSpike < 1.5 THEN 'Low (< 1.5x)'
        WHEN s.volSpike BETWEEN 1.5 AND 2.5 THEN 'Medium (1.5-2.5x)'
        WHEN s.volSpike > 2.5 THEN 'High (> 2.5x)'
        ELSE 'Unknown'
    END as vol_spike_bucket,
    COUNT(*) as trades,
    ROUND(AVG(eo.ext24_managed_r), 3) as avg_r,
    SUM(CASE WHEN eo.ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins
FROM signals s
JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE eo.completed_at IS NOT NULL
    AND s.volSpike IS NOT NULL
GROUP BY CASE 
        WHEN s.volSpike < 1.5 THEN 'Low (< 1.5x)'
        WHEN s.volSpike BETWEEN 1.5 AND 2.5 THEN 'Medium (1.5-2.5x)'
        WHEN s.volSpike > 2.5 THEN 'High (> 2.5x)'
        ELSE 'Unknown'
    END;

-- 9.3 RSI at Entry vs Performance
SELECT 
    CASE 
        WHEN s.rsi9 < 40 THEN 'Oversold (< 40)'
        WHEN s.rsi9 BETWEEN 40 AND 55 THEN 'Lower Range (40-55)'
        WHEN s.rsi9 BETWEEN 55 AND 70 THEN 'Mid Range (55-70)'
        WHEN s.rsi9 > 70 THEN 'Higher (> 70)'
        ELSE 'Unknown'
    END as rsi_bucket,
    COUNT(*) as trades,
    ROUND(AVG(eo.ext24_managed_r), 3) as avg_r,
    SUM(CASE WHEN eo.ext24_managed_r > 0 THEN 1 ELSE 0 END) as wins
FROM signals s
JOIN extended_outcomes eo ON eo.signal_id = s.id
WHERE eo.completed_at IS NOT NULL
    AND s.rsi9 IS NOT NULL
GROUP BY CASE 
        WHEN s.rsi9 < 40 THEN 'Oversold (< 40)'
        WHEN s.rsi9 BETWEEN 40 AND 55 THEN 'Lower Range (40-55)'
        WHEN s.rsi9 BETWEEN 55 AND 70 THEN 'Mid Range (55-70)'
        WHEN s.rsi9 > 70 THEN 'Higher (> 70)'
        ELSE 'Unknown'
    END;

-- ============================================================================
-- SECTION 10: ACTIONABLE INSIGHTS SUMMARY
-- ============================================================================

-- 10.1 Which symbols should be removed from trading?
SELECT 
    symbol,
    COUNT(*) as trades,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(SUM(ext24_managed_r), 3) as total_r,
    ROUND(100.0 * SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate
FROM extended_outcomes
WHERE completed_at IS NOT NULL
    AND status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP', 'FLAT_TIMEOUT_24H')
GROUP BY symbol
HAVING COUNT(*) >= 2
ORDER BY total_r ASC
LIMIT 10;

-- 10.2 Best performing setups (symbol + category combinations)
SELECT 
    symbol,
    category,
    COUNT(*) as trades,
    ROUND(AVG(ext24_managed_r), 3) as avg_r,
    ROUND(SUM(ext24_managed_r), 3) as total_r,
    ROUND(100.0 * SUM(CASE WHEN ext24_managed_r > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as win_rate
FROM extended_outcomes
WHERE completed_at IS NOT NULL
GROUP BY symbol, category
HAVING COUNT(*) >= 2
ORDER BY total_r DESC
LIMIT 10;
