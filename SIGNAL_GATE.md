# Signal Gate - Hard Execution Filter

## 🚨 What This Does

The Signal Gate is a **HARD FILTER** that blocks bad signals **BEFORE** they are recorded or sent to you.

**Before**: All signals generated → recorded → notified → you lose money on bad ones
**After**: Signals generated → filtered → only good ones recorded → higher win rate

---

## How It Works

### Default Hard Rules (Active when `SIGNAL_GATE_ENABLED=true`)

1. **RED tier symbols = BLOCKED**
   - If a symbol has <15% win rate, it's blocked entirely
   - Exception: Can set `SIGNAL_GATE_BLOCK_RED=false` to allow with 0.5% MFE requirement

2. **MFE30m < 0.3% = BLOCKED**
   - No early momentum proof = no entry
   - YELLOW symbols need 0.5%
   - RED symbols need 0.5% (if allowed)

3. **MQS < 0.2 = BLOCKED**
   - Momentum Quality Score = MFE30m / MAE30m
   - Low ratio = weak momentum = blocked

4. **Combined Score < 2 = BLOCKED**
   - Need confluence of multiple conditions
   - Score points:
     - MFE30m pass: +1
     - MQS pass: +1
     - GREEN tier: +1
     - TP1 within 45m: +1 (if applicable)
     - MFE15m pass: +1 (if enabled)

---

## Environment Variables

```bash
# Master switch (default: true)
SIGNAL_GATE_ENABLED=true

# Block RED tier entirely (default: true)
SIGNAL_GATE_BLOCK_RED=true

# Momentum thresholds
SIGNAL_GATE_MIN_MFE30M=0.30
SIGNAL_GATE_YELLOW_MIN_MFE30M=0.50
SIGNAL_GATE_RED_MIN_MFE30M=0.50

# Quality threshold
SIGNAL_GATE_MIN_MQS=0.20

# Combined score (confluence)
SIGNAL_GATE_USE_SCORE=true
SIGNAL_GATE_MIN_SCORE=2

# 15m confirmation (optional)
SIGNAL_GATE_15M=false
SIGNAL_GATE_MIN_MFE15M=0.20

# Target reduction % (for logging)
SIGNAL_GATE_TARGET_REDUCTION=50
```

---

## Signal Quality Levels

| Quality | Score | Description |
|---------|-------|-------------|
| **HIGH** | 3-5 | Strong confluence - likely winner |
| **MEDIUM** | 2 | Moderate quality - acceptable |
| **LOW** | 1 | Weak - would be blocked if score enabled |
| **REJECTED** | 0 | Failed hard rules - blocked |

---

## API Endpoints

### Check a Signal (Dry Run)
```bash
POST /api/gate/check
{
  "signal": {
    "symbol": "BTCUSDT",
    "category": "READY_TO_SELL",
    "mfe30mPct": 0.45,
    "mae30mPct": 0.15,
    "mfe15mPct": 0.25
  }
}

Response:
{
  "ok": true,
  "result": {
    "allowed": true,
    "quality": "HIGH",
    "score": { "total": 4, "mfe30m": 1, "mqs": 1, "tier": 1, "speed": 0, "mfe15m": 1 },
    "totalScore": 4,
    "reasons": ["PASSED_ALL_CHECKS"],
    "tier": "GREEN",
    "mqs": 3.0
  }
}
```

### Get Real-time Stats
```bash
GET /api/gate/stats

Response:
{
  "ok": true,
  "stats": {
    "totalChecked": 100,
    "totalBlocked": 65,
    "blockedByRed": 20,
    "blockedByScore": 40,
    "blockedBy15m": 5,
    "passedHigh": 25,
    "passedMedium": 8,
    "passedLow": 2
  }
}
```

### Get Config
```bash
GET /api/gate/config
```

### Batch Check (for testing)
```bash
POST /api/gate/batch
{
  "signals": [...],
  "config": { "enabled": true, "minMfe30mPct": 0.4 }
}
```

---

## Frontend Components

### SignalGateStats
Live metrics showing:
- Total signals checked
- Blocked % (target: 40-60%)
- Passed count
- Quality distribution (HIGH/MEDIUM/LOW)
- RED tier blocks

### SignalQualityBadge
Visual indicator in table:
- `HIGH` - green badge
- `MEDIUM` - blue badge
- `LOW` - amber badge
- `REJECTED` - red badge

---

## Expected Results

### Before Gate
- Win rate: ~22%
- Trades/day: High
- Many STOP_BEFORE_TP1 losses

### After Gate (Target)
- Win rate: 35-50%
- Trades/day: Reduced 40-60%
- Fewer but higher quality trades
- Lower loss streaks

---

## Testing Workflow

### 1. Test Current Signals
```bash
curl -X POST "https://your-api.com/api/gate/batch" \
  -H "Content-Type: application/json" \
  -d '{
    "signals": [...your signals...]
  }'
```

### 2. Review Blocked %
- Check `/api/gate/stats`
- Aim for 40-60% blocked
- Adjust thresholds if needed

### 3. Enable Live
```bash
# Set env var
SIGNAL_GATE_ENABLED=true
```

### 4. Monitor
- Watch gate stats in UI
- Check quality distribution
- Verify win rate improvement

---

## Troubleshooting

### Gate blocking 100% of signals
- Check symbol tiers exist
- Lower `SIGNAL_GATE_MIN_MFE30M`
- Disable `SIGNAL_GATE_USE_SCORE`

### Gate blocking 0% of signals
- Verify `SIGNAL_GATE_ENABLED=true`
- Check stats endpoint is returning data
- Verify symbol tiers computed

### Missing quality data
- Signal quality based on realized R
- Requires completed outcomes
- Will show '--' for pending signals

---

## Comparison: Before vs After

| Metric | Before | After Gate |
|--------|--------|------------|
| Win Rate | ~22% | 35-50% |
| Signals/Day | 20+ | 8-12 |
| Avg R/Trade | Low | Higher |
| Loss Streaks | Long | Shorter |
| Quality | Mixed | HIGH/MEDIUM only |

---

## Migration Guide

### From Analysis Mode
1. Compute symbol tiers: `POST /api/symbol-tiers/compute`
2. Set manual blocks for known bad symbols
3. Enable gate: `SIGNAL_GATE_ENABLED=true`
4. Monitor for 1 week
5. Adjust thresholds based on results

### Gradual Rollout
1. Start with `SIGNAL_GATE_BLOCK_RED=false` (allow RED with strict MFE)
2. Lower `SIGNAL_GATE_MIN_SCORE=1`
3. Monitor blocked %
4. Increase strictness gradually

---

## Key Principle

> **Enter ONLY if there's proof of movement**

No early momentum = No entry
Weak momentum = No entry
RED symbol = No entry (or very strict)

This cuts the 182 losses you saw in your data.
