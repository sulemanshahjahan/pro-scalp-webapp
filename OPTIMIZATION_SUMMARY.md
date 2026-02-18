# 120m/240m Horizon Optimization - Implementation Summary

## Changes Made

### 1. Backend: Email Notifications (`backend/src/emailTemplates.ts`)
- Added `SIGNAL_HOLD_MINUTES` environment variable support
- Added hold time recommendation to HTML emails (green banner)
- Added hold time recommendation to text emails
- Shows: "Hold 2-4h for optimal R (data: 37-44% win rate at 2-4h vs 7% at 15m)"

### 2. Backend: Push Notifications (`backend/src/scanner.ts`)
- Added hold recommendation to push notification body
- Added `holdMinutes` and `holdRecommendation` to push payload data

### 3. Frontend: Signal Card (`frontend/src/components/SignalCard.tsx`)
- Added green banner with hold time recommendation for:
  - BEST_ENTRY
  - READY_TO_BUY
  - BEST_SHORT_ENTRY
  - READY_TO_SELL
- Shows: "⏱️ Hold Time: 2-4 hours for optimal R. (Data: 37-44% win rate at 2-4h vs 7% at 15m)"

### 4. Environment Config (`backend/.env.example`)
- Added `SIGNAL_HOLD_MINUTES=120` with documentation

## Environment Variables to Set in Railway

```bash
# Already done:
OUTCOME_EXPIRE_AFTER_15M=false
READY_VWAP_MAX_PCT=0.50
READY_VWAP_EPS_PCT=0.10

# New (optional - defaults to 120):
SIGNAL_HOLD_MINUTES=120
```

## What Users Will See

### Email Alerts
```
[Pro Scalp Scanner]

[BEST] Long: BTCUSDT @ 43250.00

⏱️ Hold 2-4h for optimal R (data: 37-44% win rate at 2-4h vs 7% at 15m)

Symbol: BTCUSDT
Price: 43250.00
...
```

### Push Notifications
```
[BEST] Best Entry
BTCUSDT @ 43250.0000 | ΔVWAP 0.20% | RSI 56.5 | Vol× 1.80 | Hold 2-4h for optimal R
```

### Web App Signal Card
```
┌─────────────────────────────────────┐
│ BTCUSDT                    [BEST]   │
│ ...                                 │
│ ⏱️ Hold Time: 2-4 hours for optimal │
│   R. (Data: 37-44% win rate...)     │
└─────────────────────────────────────┘
```

## Data Behind the Recommendation

| Horizon | Win Rate | Avg R | Sample |
|---------|----------|-------|--------|
| 15m     | 6.7%     | -0.07 | 30     |
| 30m     | 20%      | +0.03 | 30     |
| 60m     | 23.3%    | 0.00  | 30     |
| 120m    | 37%      | +0.19 | 27     |
| 240m    | 44%      | +0.08 | 25     |

**Conclusion:** Signals need 2-4 hours to develop. Shorter holds = chop, longer holds = trend capture.

## Deploy

1. Push to git (Railway auto-deploys backend)
2. Vercel auto-deploys frontend
3. Done!
