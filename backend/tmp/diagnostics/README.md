# Option B vs Old Config Analysis

## Quick Start

Run the analysis against LIVE Railway production DB:

```bash
cd backend
DATABASE_URL="${{Postgres.DATABASE_URL}}" npx tsx tmp/diagnostics/optionB_vs_old.ts
```

Or from Railway dashboard:
```bash
# Connect to Railway shell
railway connect

# Run analysis
DATABASE_URL="$DATABASE_URL" npx tsx backend/tmp/diagnostics/optionB_vs_old.ts
```

## What This Does

1. **Detects config switch** - Automatically finds when Option B (RSI 55+) vs Old Config (RSI 35) started
2. **Pulls live outcomes** - Queries 24h managed outcomes from production DB
3. **Computes all metrics** - Signal count, win rates, Avg R, stop rates, MFE/MAE, etc.
4. **Breaks down by** - Symbol, session (Asia/London/NY), RSI buckets, volume spikes
5. **Generates verdict** - Clear recommendation with next experiment suggestion

## Output Files

| File | Description |
|------|-------------|
| `optionB_vs_old_report.md` | Full markdown report with tables |
| `optionB_vs_old_data.json` | Raw data for your own analysis |
| `optionB_vs_old.ts` | Rerunnable script (this file) |

## Key Metrics Calculated

- Signal count & completion rate
- Official win rate (TP1+TP2 hits)
- Managed win rate (Option B logic)
- Managed Avg R per trade
- Stop-before-TP1 rate
- TP1 touch rate & TP2 conversion
- Avg time to TP1
- MFE/MAE analysis
- Coverage quality

## Config Detection

The script auto-detects configs by:
1. Querying `signals.config_snapshot_json` for RSI_READY_MIN values
2. Grouping by `config_hash`
3. Identifying Option B (RSI 55-80) vs Old (RSI 35-82)

If auto-detection fails, it uses time windows and flags confidence level.

## Requirements

- `DATABASE_URL` env var pointing to Railway Postgres
- Node.js + TypeScript (`npx tsx`)
- Read access to `signals`, `signal_outcomes`, `signal_events` tables
