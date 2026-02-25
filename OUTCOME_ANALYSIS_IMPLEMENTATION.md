# Outcome Analysis Implementation

This document describes the implementation of the 6-step action plan for improving signal analysis and filtering.

## Overview

The implementation adds comprehensive outcome analysis capabilities to track signal performance, identify the best/worst performing symbols, and test filter strategies before deploying them live.

## Files Added/Modified

### Backend

1. **`backend/src/outcomeAnalysis.ts`** (NEW)
   - Canonical bucket classification (Step 0)
   - Early-window metrics calculation (Step 1)
   - Bucket analysis with proper stats (Step 2)
   - Symbol tier/gate system (Step 3)
   - Filter backtesting (Step 4)

2. **`backend/src/extendedOutcomeStore.ts`** (MODIFIED)
   - Added early-window columns (mfe_30m_pct, mae_30m_pct, etc.)
   - Added `backfillEarlyWindowMetrics()` function
   - Added `calculateEarlyWindowMetrics()` function

3. **`backend/src/server.ts`** (MODIFIED)
   - Added new API endpoints for outcome analysis

### Frontend

1. **`frontend/src/components/OutcomeAnalysis.tsx`** (NEW)
   - `BucketAnalysisSection` - Stats by direction+bucket
   - `SymbolTierSection` - Symbol tier table (GREEN/YELLOW/RED)
   - `FilterSimulatorSection` - A/B/C filter backtest UI

2. **`frontend/src/pages/ExtendedOutcomePage.tsx`** (MODIFIED)
   - Integrated new analysis sections

### Database

1. **`db/fix_long_dataset.sql`** (NEW)
   - SQL scripts for diagnosing LONG outcome issues
   - Fixes for stuck PENDING outcomes
   - Data quality checks

## API Endpoints

### Diagnostics (Step 0)

```
GET /api/stats/ext24/diagnostics?start={ms}&end={ms}
```

Returns:
- Total outcomes count
- Counts by `status` and `ext24ManagedStatus`
- Canonical bucket counts (WIN, LOSS, BE, EXCLUDE, PENDING)
- Classification reasons for sanity checking

### Bucket Analysis (Step 2)

```
GET /api/stats/ext24/by-bucket?start={ms}&end={ms}
```

Returns stats for:
- Winning LONGs, Losing LONGs, BE LONGs
- Winning SHORTs, Losing SHORTs, BE SHORTs

Each bucket includes:
- Count
- Median + Q1/Q3 for timeToTp1, timeToStop
- MFE/MAE (full and early-window)
- Rates (stop-before-TP1%, TP1 achieved%, etc.)

### Symbol Tiers (Step 3)

```
GET /api/stats/ext24/by-symbol?start={ms}&end={ms}&minSignals={n}
```

Returns symbol performance with tiers:
- **GREEN**: win rate ≥ 30%
- **YELLOW**: win rate 15-30%
- **RED**: win rate < 15%

### Filter Backtest (Step 4)

```
GET /api/stats/ext24/backtest?start={ms}&end={ms}&filter={A|B|C}
```

Returns backtest results:
- Trades kept %
- Win rate before/after
- Avg/Median realized R before/after
- Max loss streak before/after

### Filter Definitions

```
GET /api/stats/ext24/filter-definitions
```

Returns the definition of filter sets A, B, and C.

### Early Window Backfill

```
POST /api/extended-outcomes/backfill-early-window?limit={n}
```

Computes and stores early-window MFE/MAE metrics for completed outcomes.

## Filter Sets

### Filter A: Momentum Confirmation
- MFE30m ≥ 0.30%
- MFE/MAE ratio ≥ 0.20

### Filter B: Speed Requirement
- TP1 hit within 35 minutes

### Filter C: Symbol-Adaptive
- Green tier: MFE30m ≥ 0.25%
- Yellow tier: MFE30m ≥ 0.30%
- Red tier: MFE30m ≥ 0.50%

## Canonical Bucket Rules (Step 0)

The bucket classification uses strict precedence:

1. **EXCLUDE**: status == "PENDING" AND (ext24ManagedStatus is null OR "PENDING")
2. **LOSS**: ext24ManagedStatus == "CLOSED_STOP" OR status == "LOSS_STOP"
3. **WIN**: 
   - status in ("WIN_TP2", "ACHIEVED_TP1") → WIN
   - OR ext24ManagedStatus == "CLOSED_TP2" → WIN
   - OR ext24ManagedStatus == "PARTIAL_TP1_OPEN" AND ext24RealizedR > 0 → WIN
4. **BE**: ext24ManagedStatus == "CLOSED_BE_AFTER_TP1" → BE

## Usage Guide

### 1. View Diagnostics

Visit the Extended Outcome (24h) page. The diagnostics section shows:
- How many signals are in each status
- How the canonical bucket mapping classifies them
- Any data quality issues

### 2. Review Bucket Analysis

Check the "Bucket Analysis (Step 2)" section:
- Compare LONG vs SHORT performance
- See median time to TP1/Stop for each bucket
- Review MFE/MAE distributions

### 3. Check Symbol Tiers

In the "Symbol Gates (Step 3)" section:
- Sort by win rate to find best/worst symbols
- Use the tier filter to focus on problematic symbols
- Consider blocking RED tier symbols or requiring stricter criteria

### 4. Test Filters

Use the "Filter Simulator (Step 4)" section:
- Review backtest results for Filter A, B, and C
- Compare win rate and realized R improvements
- Choose the filter that improves realized R (not just win rate)

### 5. Deploy Filter

Once you've chosen a filter:
1. Update the scanner configuration to apply the filter criteria
2. Monitor new signals for a few days
3. Re-run backtests to verify improvement

## Fixing LONG Dataset Quality (Step 6)

If LONG outcomes are missing or incomplete:

1. Run the diagnostic SQL in `db/fix_long_dataset.sql`

2. Check for signals missing extended outcomes:
```bash
curl "http://localhost:8080/api/stats/ext24/diagnostics"
```

3. Backfill missing outcomes:
```bash
curl -X POST "http://localhost:8080/api/extended-outcomes/backfill?days=7" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

4. Re-evaluate stuck pending signals:
```bash
curl -X POST "http://localhost:8080/api/extended-outcomes/reevaluate?limit=50" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

5. Backfill early window metrics:
```bash
curl -X POST "http://localhost:8080/api/extended-outcomes/backfill-early-window?limit=100" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

## Recommended Workflow

### Daily
1. Check Extended Outcome page for new completed signals
2. Review symbol tier changes
3. Note any RED tier symbols that hit

### Weekly
1. Run backtests on the past week's data
2. Compare filter performance
3. Adjust filter criteria if needed

### Monthly
1. Review symbol tier assignments
2. Update blocked symbols list
3. Analyze filter effectiveness over longer period

## Future Improvements

1. **Automated Symbol Blocking**: Automatically block RED tier symbols after N consecutive losses
2. **Dynamic Filter Adjustment**: Adjust filter thresholds based on recent market conditions
3. **ML-Based Scoring**: Train a model using early-window features to predict outcomes
4. **Real-Time Alerts**: Alert when a RED tier symbol generates a signal

## Troubleshooting

### No data in bucket analysis
- Ensure extended outcomes exist: Run backfill
- Check date range includes completed signals
- Verify signals have `completed_at` set

### Symbol tiers not showing
- Lower `minSignals` threshold (default is 10)
- Check that symbols have completed outcomes
- Verify date range has enough data

### Filter backtest shows no improvement
- Ensure early window metrics are computed: Run backfill-early-window
- Check that filters aren't too strict (keep rate too low)
- Verify the historical period has diverse market conditions

### LONG outcomes missing
- Run the SQL in `db/fix_long_dataset.sql`
- Check scanner logs for LONG signal generation
- Verify SIGNAL_LOG_CATS includes LONG categories
