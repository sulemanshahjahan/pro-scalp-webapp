-- Find all outcomes with bars_to_exit = -1
SELECT 
    id, 
    signal_id,
    horizon_min,
    outcome_state,
    trade_state,
    exit_reason,
    bars_to_exit,
    exit_price,
    exit_index,
    n_candles_expected,
    entry_time,
    exit_time,
    end_time
FROM signal_outcomes
WHERE bars_to_exit = -1
LIMIT 20;

-- Count by state
SELECT 
    outcome_state,
    trade_state,
    exit_reason,
    COUNT(*) as count
FROM signal_outcomes
WHERE bars_to_exit = -1
GROUP BY outcome_state, trade_state, exit_reason;
