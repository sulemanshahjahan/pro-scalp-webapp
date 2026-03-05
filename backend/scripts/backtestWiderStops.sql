-- Backtest: Wider Stops Analysis
-- Compares current stops vs 1.5x wider stops on historical data

WITH trade_outcomes AS (
  SELECT 
    eo.signal_id,
    eo.symbol,
    eo.category,
    eo.direction,
    eo.entry_price,
    eo.stop_price,
    eo.tp1_price,
    eo.tp2_price,
    eo.status,
    eo.time_to_stop_seconds,
    eo.time_to_tp1_seconds,
    eo.max_favorable_excursion_pct,
    eo.max_adverse_excursion_pct,
    -- Calculate current stop distance
    CASE 
      WHEN eo.direction = 'LONG' AND eo.entry_price > 0 
      THEN ((eo.entry_price - eo.stop_price) / eo.entry_price * 100)
      WHEN eo.direction = 'SHORT' AND eo.entry_price > 0
      THEN ((eo.stop_price - eo.entry_price) / eo.entry_price * 100)
      ELSE NULL
    END as current_stop_pct,
    -- Calculate realized R
    eo.ext24_realized_r
  FROM extended_outcomes eo
  WHERE eo.mode = 'EXECUTED'
    AND eo.completed_at IS NOT NULL
    AND eo.status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP')
    AND eo.stop_price IS NOT NULL
    AND eo.stop_price > 0
),

wider_stop_scenarios AS (
  SELECT 
    *,
    -- Scenario 1: 1.5x wider stop
    current_stop_pct * 1.5 as wider_stop_1_5x,
    -- Check if 1.5x wider stop would have avoided the loss
    CASE 
      WHEN status = 'LOSS_STOP' AND max_adverse_excursion_pct IS NOT NULL
      THEN CASE 
        WHEN (current_stop_pct * 1.5) > ABS(max_adverse_excursion_pct * 100)
        THEN 'WOULD_SURVIVE'
        ELSE 'STILL_STOPPED'
      END
      ELSE 'NOT_APPLICABLE'
    END as outcome_1_5x,
    -- Check if price eventually hit TP1 after stop
    CASE 
      WHEN status = 'LOSS_STOP' AND time_to_tp1_seconds IS NOT NULL
      THEN 'YES_TP1_LATER'
      WHEN status = 'LOSS_STOP' AND time_to_tp1_seconds IS NULL
      THEN 'NO_TP1'
      ELSE 'NOT_STOPPED'
    END as tp1_after_stop
  FROM trade_outcomes
),

summary AS (
  SELECT 
    COUNT(*) as total_trades,
    SUM(CASE WHEN status IN ('WIN_TP1', 'WIN_TP2') THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN status = 'LOSS_STOP' THEN 1 ELSE 0 END) as losses,
    ROUND(100.0 * SUM(CASE WHEN status IN ('WIN_TP1', 'WIN_TP2') THEN 1 ELSE 0 END) / 
      NULLIF(SUM(CASE WHEN status IN ('WIN_TP1', 'WIN_TP2', 'LOSS_STOP') THEN 1 ELSE 0 END), 0), 1) as win_rate,
    
    -- Current performance
    ROUND(SUM(ext24_realized_r), 2) as current_total_r,
    ROUND(AVG(ext24_realized_r), 2) as current_avg_r,
    
    -- Wider stop analysis
    SUM(CASE WHEN status = 'LOSS_STOP' AND outcome_1_5x = 'WOULD_SURVIVE' THEN 1 ELSE 0 END) as saved_by_wider_stop,
    SUM(CASE WHEN status = 'LOSS_STOP' AND outcome_1_5x = 'WOULD_SURVIVE' AND tp1_after_stop = 'YES_TP1_LATER' THEN 1 ELSE 0 END) as saved_and_hit_tp1,
    
    -- Estimated new performance (assume saved stops become BE at 0R)
    ROUND(SUM(CASE 
      WHEN status IN ('WIN_TP1', 'WIN_TP2') THEN ext24_realized_r
      WHEN status = 'LOSS_STOP' AND outcome_1_5x = 'WOULD_SURVIVE' THEN 0  -- Breakeven
      ELSE ext24_realized_r  -- Still lost
    END), 2) as estimated_total_r,
    
    -- Average stop distances
    ROUND(AVG(current_stop_pct), 2) as avg_current_stop_pct,
    ROUND(AVG(CASE WHEN status = 'WIN_TP1' THEN current_stop_pct END), 2) as avg_stop_on_wins,
    ROUND(AVG(CASE WHEN status = 'LOSS_STOP' THEN current_stop_pct END), 2) as avg_stop_on_losses
    
  FROM wider_stop_scenarios
)

SELECT 
  'CURRENT PERFORMANCE' as metric,
  total_trades::text || ' trades' as value,
  win_rate || '% win rate' as detail,
  current_total_r || 'R total' as performance
FROM summary

UNION ALL

SELECT 
  'LOSSES THAT COULD BE SAVED',
  saved_by_wider_stop::text || ' trades',
  ROUND(100.0 * saved_by_wider_stop / NULLIF(losses, 0), 1) || '% of losses',
  'Avoided -1R each'
FROM summary

UNION ALL

SELECT 
  'SAVED + HIT TP1 LATER',
  saved_and_hit_tp1::text || ' trades',
  'Best case scenario',
  '+' || saved_and_hit_tp1 || 'R potential'
FROM summary

UNION ALL

SELECT 
  'ESTIMATED WITH WIDER STOPS',
  estimated_total_r || 'R total',
  CASE 
    WHEN estimated_total_r > current_total_r THEN 'IMPROVEMENT: +' || ROUND(estimated_total_r - current_total_r, 1) || 'R'
    ELSE 'WORSE: ' || ROUND(estimated_total_r - current_total_r, 1) || 'R'
  END as detail,
  current_total_r || 'R → ' || estimated_total_r || 'R'
FROM summary

UNION ALL

SELECT 
  'AVG STOP DISTANCE',
  avg_current_stop_pct || '%',
  'Wins: ' || COALESCE(avg_stop_on_wins, 0) || '% | Losses: ' || COALESCE(avg_stop_on_losses, 0) || '%',
  'Target: 1.5-2%'
FROM summary;
