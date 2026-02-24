-- First, check what columns exist in signals table
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'signals' 
ORDER BY ordinal_position;

-- Common column names (try these):
-- rsi9, atrpct, volspike, deltavwappct, confirm15m, trendok, sessionok, sweepok

-- Safe query - only use columns that definitely exist
SELECT 
    s.symbol,
    s.category,
    s.price,
    s.stop,
    s.tp1,
    s.tp2,
    s.rr,
    to_timestamp(s.created_at/1000) as signal_time
FROM signals s
WHERE s.category IN ('READY_TO_SELL', 'BEST_SHORT_ENTRY')
    AND s.created_at > (EXTRACT(EPOCH FROM NOW() - INTERVAL '48 hours') * 1000)::bigint
ORDER BY s.created_at DESC
LIMIT 20;
