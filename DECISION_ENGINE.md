# Decision Engine Documentation

## Overview

The Decision Engine transforms your analysis dashboard into a **live entry filter** that prevents weak trades from being entered.

## Quick Start

### 1. Enable the Entry Filter

Add to your `.env` file:

```bash
# Master switch - set to true to enable live filtering
ENTRY_FILTER_ENABLED=true

# Block RED tier symbols entirely
ENTRY_FILTER_BLOCK_RED=true

# YELLOW symbols require stricter thresholds
ENTRY_FILTER_YELLOW_STRICT=true

# Minimum early momentum (0.30 = 0.3% MFE in first 30m)
ENTRY_FILTER_MIN_MFE30M=0.30

# Stricter thresholds for lower-tier symbols
ENTRY_FILTER_YELLOW_MIN_MFE30M=0.50
ENTRY_FILTER_RED_MIN_MFE30M=0.80

# Minimum Momentum Quality Score (MFE/MAE ratio)
ENTRY_FILTER_MIN_RATIO=0.20

# Optional: require TP1 within 45 minutes
ENTRY_FILTER_REQUIRE_SPEED=false

# Which categories to allow
ENTRY_FILTER_CATEGORIES=READY_TO_BUY,BEST_ENTRY,READY_TO_SELL,BEST_SHORT_ENTRY
```

### 2. Compute Symbol Tiers

After deployment, compute tiers from your historical data:

```bash
curl -X POST "https://your-api.com/api/symbol-tiers/compute" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

Or use the UI: Extended Outcomes page → "Compute from History" button

### 3. Set Manual Overrides (Optional)

For symbols you know are bad:

```bash
curl -X POST "https://your-api.com/api/symbol-tiers/BTCUSDT" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"direction":"SHORT","tier":"RED","reason":"Too choppy"}'
```

## Core Concepts

### Momentum Quality Score (MQS)

Formula: `MQS = MFE30m / MAE30m`

| MQS Range | Label | Action |
|-----------|-------|--------|
| < 0.1 | BAD | Reject - no momentum |
| 0.1 - 0.3 | WEAK | Reject - weak momentum |
| > 0.3 | GOOD | Accept - strong momentum |

### Symbol Tiers

| Tier | Win Rate | Default Action |
|------|----------|----------------|
| GREEN | ≥ 30% | Normal filter (0.3% MFE) |
| YELLOW | 15-30% | Strict filter (0.5% MFE) |
| RED | < 15% | Blocked or very strict (0.8% MFE) |

### Filter Logic Flow

```
Signal Generated
    ↓
Category Allowed? → NO → Reject
    ↓ YES
Symbol Tier Lookup
    ↓
RED + blockRedSymbols? → YES → Reject
    ↓ NO
MFE30m >= Required? → NO → Reject
    ↓ YES
MQS >= 0.2? → NO → Reject
    ↓ YES
ALLOW SIGNAL
```

## API Endpoints

### Filter Testing

```bash
# Test a signal (dry run)
POST /api/filter/test
{
  "signal": {
    "symbol": "BTCUSDT",
    "category": "READY_TO_SELL",
    "mfe30mPct": 0.25,
    "mae30mPct": 0.15
  }
}

# Response
{
  "ok": true,
  "result": {
    "allowed": false,
    "reason": "MFE30M_TOO_LOW",
    "message": "Early momentum too weak: 0.25% < 30% required",
    "details": {
      "symbol": "BTCUSDT",
      "tier": "RED",
      "mqs": 1.67,
      "mqsLabel": "GOOD",
      "actualMfe": 0.25,
      "requiredMfe": 0.80
    }
  }
}
```

### Calculate MQS

```bash
POST /api/filter/mqs
{
  "mfe30mPct": 0.45,
  "mae30mPct": 0.15
}

# Response
{
  "ok": true,
  "mqs": 3.0,
  "interpretation": {
    "label": "GOOD",
    "class": "good"
  }
}
```

### Symbol Tiers

```bash
# List all tiers
GET /api/symbol-tiers

# Filter by tier
GET /api/symbol-tiers?tier=RED

# Get specific symbol
GET /api/symbol-tiers/BTCUSDT?direction=SHORT

# Set manual tier (admin only)
POST /api/symbol-tiers/BTCUSDT
{
  "direction": "SHORT",
  "tier": "RED",
  "reason": "Too choppy for shorts"
}

# Compute from history (admin only)
POST /api/symbol-tiers/compute

# Clear manual override (admin only)
POST /api/symbol-tiers/BTCUSDT/clear-override
{
  "direction": "SHORT"
}

# Delete tier (admin only)
DELETE /api/symbol-tiers/BTCUSDT?direction=SHORT
```

## Frontend Components

### Filter Config Section

Shows current filter configuration and LIVE/OFF status.

### Symbol Tier Management

- Table of all symbols with their tiers
- Filter by tier (GREEN/YELLOW/RED)
- Add manual overrides
- Compute tiers from history
- Shows manual vs auto-computed status

### Filter Tester

Interactive tool to test signals:
- Enter symbol, category, MFE30m, MAE30m
- See rejection reason with details
- Shows MQS and interpretation

### Signal Rejection Reasoning

Visual component showing:
- ✓ Accepted with passed checks
- ✗ Rejected with specific reason
- MQS display
- Tier badge
- Actual vs required thresholds

### Momentum Quality Score

Badge component:
- `MQS: 0.05 (BAD)` - red
- `MQS: 0.20 (WEAK)` - amber
- `MQS: 0.50 (GOOD)` - green

## Testing Workflow

### Before Going Live

1. **Test your current signals**:
   ```bash
   curl -X POST "https://your-api.com/api/filter/simulate" \
     -H "Content-Type: application/json" \
     -d '{
       "signals": [...],
       "config": { "enabled": true, ... }
     }'
   ```

2. **Review rejection breakdown**:
   - How many would be rejected?
   - What are the main rejection reasons?
   - Are any good signals being blocked?

3. **Adjust thresholds**:
   - Lower `minMfe30mPct` if too strict
   - Raise if still getting losses
   - Consider only blocking RED symbols initially

### Going Live

1. Set `ENTRY_FILTER_ENABLED=true`
2. Monitor for a few days
3. Check that win rate improves
4. Adjust as needed

## Troubleshooting

### Filter not blocking any signals

- Check `ENTRY_FILTER_ENABLED=true` in env
- Verify symbol tiers exist: `GET /api/symbol-tiers`
- Test with Filter Tester UI

### All signals being blocked

- Check thresholds aren't too strict
- Verify tiers are correct
- Look at actual MFE30m values in signals

### MQS calculation wrong

- MFE30m and MAE30m must be in same units (percent)
- Check that values are populated in extended_outcomes
- Run early window backfill if missing

## Recommended Configurations

### Conservative (Start Here)

```bash
ENTRY_FILTER_ENABLED=true
ENTRY_FILTER_BLOCK_RED=true
ENTRY_FILTER_YELLOW_STRICT=true
ENTRY_FILTER_MIN_MFE30M=0.30
ENTRY_FILTER_MIN_RATIO=0.20
ENTRY_FILTER_REQUIRE_SPEED=false
```

### Aggressive (Fewer trades, higher quality)

```bash
ENTRY_FILTER_ENABLED=true
ENTRY_FILTER_BLOCK_RED=true
ENTRY_FILTER_YELLOW_STRICT=true
ENTRY_FILTER_MIN_MFE30M=0.50
ENTRY_FILTER_MIN_RATIO=0.30
ENTRY_FILTER_REQUIRE_SPEED=true
```

### Testing (Analyze without blocking)

```bash
ENTRY_FILTER_ENABLED=false
# Use /api/filter/test to analyze
# Review results before enabling
```

## Future Enhancements

1. **Dynamic Thresholds**: Adjust based on market regime
2. **ML Scoring**: Train model on early-window features
3. **Auto-Tier Updates**: Recompute tiers daily
4. **Position Sizing**: Reduce size for YELLOW tier
5. **Exit Optimization**: Early exit for weak momentum

## Migration from Analysis Only

If you were using the analysis dashboard:

1. Your existing data works - no migration needed
2. Compute tiers: `POST /api/symbol-tiers/compute`
3. Set manual overrides for known bad symbols
4. Enable filter: `ENTRY_FILTER_ENABLED=true`
5. Monitor results

## Key Metrics to Watch

After enabling the filter:

| Metric | Before | After (Target) |
|--------|--------|----------------|
| Win Rate | ~21% | 35-50% |
| Trades/Day | X | X * 0.5-0.7 |
| Avg R/Trade | Y | Y * 1.5-2x |
| Max Loss Streak | N | N * 0.5 |

Remember: **Higher total R is better than higher win rate**
