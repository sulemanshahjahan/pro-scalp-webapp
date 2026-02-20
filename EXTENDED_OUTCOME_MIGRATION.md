# Extended Outcome (24h) Migration Guide

## Overview

This document describes the migration process for the new Extended Outcome (24h) feature that evaluates signal performance over a 24-hour window, tracking TP1, TP2, and Stop Loss hits separately from the existing fixed-horizon outcomes.

## Database Schema

The feature creates a new table `extended_outcomes` automatically on first use:

```sql
CREATE TABLE extended_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'LONG',
  
  signal_time INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  
  entry_price REAL NOT NULL,
  stop_price REAL,
  tp1_price REAL,
  tp2_price REAL,
  
  status TEXT NOT NULL DEFAULT 'PENDING',
  
  first_tp1_at INTEGER,
  tp2_at INTEGER,
  stop_at INTEGER,
  
  time_to_first_hit_seconds INTEGER,
  time_to_tp1_seconds INTEGER,
  time_to_tp2_seconds INTEGER,
  time_to_stop_seconds INTEGER,
  
  max_favorable_excursion_pct REAL,
  max_adverse_excursion_pct REAL,
  coverage_pct REAL NOT NULL DEFAULT 0,
  
  n_candles_evaluated INTEGER NOT NULL DEFAULT 0,
  n_candles_expected INTEGER NOT NULL DEFAULT 0,
  last_evaluated_at INTEGER NOT NULL DEFAULT 0,
  resolve_version TEXT,
  
  debug_json TEXT,
  
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  
  FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
);
```

## Migration Steps

### 1. Deploy Code Changes

Deploy the updated backend and frontend code:

```bash
# Backend is auto-deployed on push (Railway)
# Frontend is auto-deployed on push (Vercel)
git push
```

### 2. Backfill Existing Signals

After deployment, backfill extended outcome records for existing signals:

```bash
# Backfill signals from the last 7 days (default)
curl -X POST "https://your-api.com/api/extended-outcomes/backfill" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"

# Backfill with custom parameters
curl -X POST "https://your-api.com/api/extended-outcomes/backfill?days=30&batchSize=100" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

Or use the "Backfill Signals" button on the Extended Outcome (24h) page.

### 3. Evaluate Pending Signals

Trigger evaluation for pending signals:

```bash
# Evaluate up to 25 pending signals
curl -X POST "https://your-api.com/api/extended-outcomes/reevaluate?limit=25" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

Or use the "Re-evaluate Pending" button on the page.

### 4. Force Re-evaluation (if needed)

If you need to re-evaluate a specific date range:

```bash
curl -X POST "https://your-api.com/api/extended-outcomes/force-reevaluate?start=1704067200000&end=1706745600000" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN"
```

## API Endpoints

### Public Endpoints

- `GET /api/extended-outcomes` - List extended outcomes with filtering
- `GET /api/extended-outcomes/stats` - Get summary statistics

### Admin Endpoints (require `x-admin-token` header)

- `POST /api/extended-outcomes/backfill` - Backfill signals from date range
- `POST /api/extended-outcomes/reevaluate` - Re-evaluate pending signals
- `POST /api/extended-outcomes/force-reevaluate` - Force re-evaluation of range
- `POST /api/extended-outcomes/evaluate/:signalId` - Evaluate single signal

## Query Parameters

### GET /api/extended-outcomes

- `start` - Start timestamp (ms)
- `end` - End timestamp (ms)
- `symbol` - Filter by symbol (e.g., BTCUSDT)
- `category` - Filter by category (BEST_ENTRY, READY_TO_BUY, etc.)
- `status` - Filter by status (PENDING, ACHIEVED_TP1, LOSS_STOP, WIN_TP1, WIN_TP2, FLAT_TIMEOUT_24H)
- `direction` - Filter by direction (LONG, SHORT)
- `completed` - Filter by completion status (true/false)
- `limit` - Page size (default: 100)
- `offset` - Pagination offset
- `sort` - Sort order (time_desc, time_asc, completed_desc)

### GET /api/extended-outcomes/stats

- `start` - Start timestamp (ms)
- `end` - End timestamp (ms)
- `symbol` - Filter by symbol
- `category` - Filter by category
- `direction` - Filter by direction

## Status Definitions

| Status | Description |
|--------|-------------|
| `PENDING` | Signal is within 24h window, no hits yet |
| `ACHIEVED_TP1` | TP1 was hit, still tracking for TP2 before 24h expiry |
| `WIN_TP1 (24h)` | TP1 hit but TP2 was not hit within 24h |
| `WIN_TP2 (24h)` | TP2 was hit within 24h |
| `LOSS_STOP (24h)` | Stop Loss was hit |
| `FLAT_TIMEOUT_24H` | No hits within 24h window |

## Same-Candle Ambiguity Rule

When both Stop and TP levels are touched in the same candle (possible with OHLC data), the conservative rule applies:

> **STOP wins if both are touched in the same candle.**

This is documented in code comments and the debug JSON tracks any conflicts that occur.

## Performance Considerations

- Extended outcomes use 5-minute candles for evaluation
- Each signal evaluates up to 288 candles (24h / 5m)
- Evaluation is idempotent - safe to re-run multiple times
- Completed signals are skipped on re-evaluation
- Use pagination for large result sets

## Monitoring

Check the Extended Outcome page for:
- Total signals evaluated
- Win rate (TP1 + TP2 / completed)
- Average time to hits
- Coverage percentage
- Pending signals count

## Troubleshooting

### No data showing

1. Check if signals exist in the database
2. Run backfill to create extended outcome records
3. Check browser console for API errors

### Signals stuck in PENDING

1. Signal may still be within 24h window (expected)
2. Re-evaluate pending signals manually
3. Check if candles are being fetched correctly

### Incorrect outcomes

1. Force re-evaluation for the date range
2. Check debug JSON for same-candle conflicts
3. Verify signal levels (entry, stop, tp1, tp2) are correct

## Integration with Existing Stats

The Extended Outcome feature is completely separate from existing horizon-based outcomes:

- Horizon outcomes (15m/30m/60m/120m/240m) remain unchanged
- Extended outcomes track 24h window independently
- Both can be viewed side-by-side for comparison
- No data migration needed for existing outcomes
