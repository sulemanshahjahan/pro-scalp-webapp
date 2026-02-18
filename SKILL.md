---
name: pro-scalp-webapp
description: >
  Use this skill when working on the pro-scalp-webapp project — a crypto scalp signal scanner
  with a React frontend and Express/TypeScript backend. Covers signal logic changes, DB migrations,
  indicator tuning, notification changes, outcome tracking, and deployment to Railway/Vercel.
---

# Pro-Scalp Webapp - Skill Guide

## What to Ask Me For First

Before starting any task, I need:

- [ ] **Task context**: What feature/bug? Expected behavior vs actual
- [ ] **Error logs** (if bug): backend logs, browser console, or test output
- [ ] **Specific files modified** (if partial work done)
- [ ] **Environment**: `backend/.env` (sensitive values redacted) or confirm using `.env.example`

Optional but helpful:
- [ ] Frontend screenshot (for UI issues)
- [ ] `backend/data/app.db` (if data-specific issue)

---

## Golden Rules for Editing

| Rule | Instruction |
|------|-------------|
| **Replacements** | Prefer full-file `WriteFile` over patches. Only use `StrReplaceFile` for small, isolated changes. |
| **Formatting** | Follow existing code style. 2-space indent. Semicolons required. |
| **Types** | TypeScript strict mode. Always add types for new functions/params. |
| **Tests** | Run `npm run test` (from root) before committing. Add tests for logic changes. |
| **Lint** | No explicit linter; follow existing patterns. |
| **Commits** | No git mutations unless explicitly asked. |
| **Env vars** | Add new env vars to `backend/.env.example` with comments. |
| **DB changes** | Use migrations in `backend/src/db/`. Support both SQLite (local) and PostgreSQL (prod). |

---

## Fast Repo Orientation

### Folder Tree Summary
```
pro-scalp-webapp/
├── frontend/                 # React + Vite + Tailwind + Zustand
│   ├── src/
│   │   ├── pages/           # App.tsx, StatsPage.tsx, TunePage.tsx, TuningBundlesPage.tsx
│   │   ├── components/      # SignalCard.tsx, RiskCalc.tsx
│   │   ├── services/        # api.ts, push.ts, sound.ts
│   │   └── state/           # store.ts (Zustand)
│   ├── public/              # PWA assets (sw.js, sounds, icons)
│   └── dist/                # Build output (served by backend in prod)
├── backend/                  # Express + TypeScript
│   ├── src/
│   │   ├── server.ts        # Express entry, API routes
│   │   ├── scanner.ts       # Main scanning loop + signal detection
│   │   ├── logic.ts         # Signal classification logic (READY, BEST_ENTRY, etc.)
│   │   ├── indicators.ts    # Technical indicators (EMA, VWAP, ATR, RSI)
│   │   ├── binance.ts       # Binance API client
│   │   ├── db/              # DB layer (SQLite + Postgres dual support)
│   │   ├── tuning/          # Tuning bundle generation
│   │   └── types.ts         # Shared TypeScript types
│   ├── data/                # SQLite file (app.db)
│   └── .env.example         # Env template
├── tests/                    # Vitest tests
│   ├── logic.test.ts
│   ├── indicators.test.ts
│   └── outcomes.test.ts
└── db/                       # Schema/migration files
```

### Key Logic Locations

| Feature | Files |
|---------|-------|
| Signal detection | `backend/src/logic.ts`, `backend/src/scanner.ts` |
| Indicators (EMA/VWAP/RSI/ATR) | `backend/src/indicators.ts` |
| API endpoints | `backend/src/server.ts` (routes defined inline) |
| Database access | `backend/src/db/db.ts`, `backend/src/signalStore.ts` |
| Frontend state | `frontend/src/state/store.ts` |
| Notifications | `backend/src/notifier.ts`, `backend/src/emailNotifier.ts` |
| Outcome tracking | `backend/src/tuneSim.ts`, `backend/src/signalStore.ts` |

### Data Flow

```
Binance API → scanner.ts → logic.ts → signalStore.ts → DB
                                    ↓
                              notifier.ts (push/email)
                                    ↓
                              frontend (API polling)
```

---

## Common Tasks Playbook

### 1. Backend Bugfix
1. Check logs: Look at the specific error message and stack trace
2. Reproduce: Use `npm run dev:backend` locally
3. Locate: Find relevant file in `backend/src/`
4. Fix: Apply minimal change, maintain types
5. Test: `npm run test` or create minimal reproduction
6. Verify: Check with `npm run dev` (full stack)

### 2. Add API Endpoint
1. Open `backend/src/server.ts`
2. Add route after existing routes (search for `app.get`/`app.post`)
3. Use existing patterns: `requireAdmin()` for admin endpoints
4. Add to frontend `frontend/src/services/api.ts` if needed
5. Test: `curl` or browser devtools

### 3. Change Signal Logic
1. Read `backend/src/logic.ts` — main classification logic
2. Read `backend/src/types.ts` — ScanCategory types
3. Update guards/filters in `evaluateSignal()` or related
4. Update tests in `tests/logic.test.ts`
5. Run: `npm run test`
6. Manual verify: `npm run dev:backend` and trigger scan

### 4. Add/Modify Indicator
1. Open `backend/src/indicators.ts`
2. Add function with proper TypeScript types
3. Export and import in `scanner.ts` or `logic.ts`
4. Add test in `tests/indicators.test.ts`
5. Run: `npm run test`

### 5. Database Migration
1. Check `backend/src/db/db.ts` — dual SQLite/Postgres support
2. Add migration SQL to `postgresSchema.ts` (if Postgres)
3. For SQLite: schema auto-created, add fallback logic
4. Update store functions in `backend/src/signalStore.ts`
5. Test locally with SQLite, verify SQL works on Postgres

### 6. Frontend UI Change
1. Component: `frontend/src/components/` or `frontend/src/pages/`
2. State: `frontend/src/state/store.ts` (Zustand)
3. API: `frontend/src/services/api.ts`
4. Style: Tailwind classes (see `frontend/tailwind.config.js`)
5. Dev: `npm run dev` (concurrently runs both)

### 7. Environment/Config Change
1. Add to `backend/.env.example` with comment
2. Read in code via `process.env.VAR_NAME`
3. For tuning params: may also add to `backend/src/tuneSim.ts`
4. Document in README if user-facing

### 8. Notification Change
1. Push: `backend/src/notifier.ts` (web-push)
2. Email: `backend/src/emailNotifier.ts`, `backend/src/emailTemplates.ts`
3. Sounds: `frontend/public/sounds/`
4. Test: `npm run fake:email` (backend) for email testing

### 9. Tuning/Outcome Analysis
1. Generate bundle: `npm --prefix backend run tuning:bundle -- --hours=6`
2. Logic: `backend/src/tuning/generateTuningBundle.ts`
3. View: Frontend TuningBundlesPage
4. Config: `backend/src/tuneSim.ts`

### 10. Deployment (Railway/Vercel)
1. **Railway (backend)**: Git push → auto-deploy, uses `Dockerfile`
2. **Vercel (frontend)**: Git push → auto-deploy, uses `frontend/vercel.json`
3. Env vars: Set in Railway dashboard (not in repo)
4. Build: `npm run build` (root) → builds both
5. Start: `npm start` (root) → starts backend only (serves frontend static)

### 11. Run Tests
```bash
# All tests
npm run test

# Specific file (from tests/ directory)
cd tests && npx vitest run logic.test.ts
```

### 12. Clean/Rebuild
```bash
# Clean build artifacts
rm -rf backend/dist backend/dist-test

# Full reinstall
rm -rf node_modules backend/node_modules frontend/node_modules tests/node_modules
npm run install:all

# Build
npm run build
```

---

## Debug Playbook

### Where to Look First

| Symptom | First Look |
|---------|------------|
| No signals | `backend/src/logic.ts` guards, `backend/src/scanner.ts` logs |
| Wrong signal category | `evaluateSignal()` in `logic.ts`, check `wouldBeCategory` |
| Indicator values off | `backend/src/indicators.ts`, verify candle data |
| DB errors | `backend/src/db/db.ts`, check `DB_DRIVER` env var |
| Email not sending | `backend/src/emailNotifier.ts`, SMTP env vars |
| Push not working | `backend/src/notifier.ts`, VAPID keys |
| Frontend not loading | Check backend serving `frontend/dist`, CORS |
| Outcomes wrong | `backend/src/tuneSim.ts`, `updateOutcomesOnce()` |

### What Logs to Request
1. Backend stderr/stdout (error with stack trace)
2. Browser console (frontend errors)
3. Network tab (API responses)
4. Database query logs (if performance issue)

### How to Reproduce
1. Note the symbol/timeframe where issue occurred
2. Run `npm run dev:backend`
3. Trigger manual scan or wait for interval
4. Check `backend/data/app.db` with SQLite browser if needed

### How to Verify Fix
1. Unit test passes: `npm run test`
2. Manual test: `npm run dev` and observe behavior
3. For signal logic: Check `/api/stats` endpoint output
4. For DB: Verify data integrity with query

---

## Context Loading Strategy

### Load First (Always)
- [ ] `backend/src/types.ts` — type definitions
- [ ] `backend/src/logic.ts` — if modifying signals
- [ ] `backend/src/server.ts` — if adding endpoints
- [ ] `frontend/src/services/api.ts` — if frontend API changes

### Load When Needed
- [ ] `backend/src/scanner.ts` — scan loop details
- [ ] `backend/src/indicators.ts` — indicator calculations
- [ ] `backend/src/signalStore.ts` — DB operations
- [ ] `backend/src/tuneSim.ts` — outcome/tuning logic
- [ ] `backend/src/db/db.ts` — DB connection layer
- [ ] `tests/*.test.ts` — relevant tests

### Search Keywords

| Looking For | Search Terms |
|-------------|--------------|
| Signal categories | `ScanCategory`, `READY_TO_BUY`, `BEST_ENTRY`, `EARLY_READY` |
| Guards/filters | `threshold`, `guard`, `required`, `strict` |
| Env var usage | `process.env.` |
| DB queries | `db.prepare`, `pool.query`, `INSERT`, `SELECT` |
| API routes | `app.get`, `app.post`, `app.put`, `app.delete` |
| Frontend state | `store.ts`, `zustand`, `useStore` |
| Notifications | `pushToAll`, `emailNotify`, `web-push` |
| BTC market context | `btcBull`, `btcBear`, `marketInfo` |
| Outcome resolution | `outcome`, `result`, `STOP`, `TARGET`, `TIMEOUT` |

---

## Reference Files (To Be Created)

Create these in a `references/` folder when needed:

| Filename | Purpose |
|----------|---------|
| `references/signal-guards.md` | Detailed breakdown of all signal guard conditions |
| `references/db-schema.md` | Full DB schema for SQLite and Postgres |
| `references/env-vars.md` | Complete environment variable documentation |
| `references/api-endpoints.md` | Auto-generated API documentation |
| `references/indicator-formulas.md` | Mathematical formulas for indicators |

Create these in a `scripts/` folder when needed:

| Filename | Purpose |
|----------|---------|
| `scripts/seed-test-data.ts` | Seed DB with test signals for local dev |
| `scripts/analyze-outcomes.ts` | CLI tool for outcome analysis |
| `scripts/backtest.ts` | Historical backtesting script |
| `scripts/migrate-db.ts` | Database migration runner |

---

## Key Environment Variables

**Current Railway values** (as of last sync):

```bash
# --- Database & Core ---
DB_DRIVER="postgres"
DATABASE_URL="postgres://..."
SCAN_INTERVAL_MS="90000"
DEBUG_ENDPOINTS="false"

# --- Symbol Filtering ---
SESSION_FILTER_ENABLED="false"
INCLUDE_NON_TOP="false"
EXTRA_USDT_COUNT="0"
MIN_PRICE_USDT="0.001"

# --- Signal Categories to Log ---
SIGNAL_LOG_CATS="BEST_ENTRY,READY_TO_BUY"

# --- Precheck Guards ---
PRECHECK_EMA_SOFT_PCT="0.5"
PRECHECK_VWAP_MAX_PCT="5.0"
RSI_PRECHECK_MIN="20"
RSI_PRECHECK_MAX="85"
RSI_EARLY_MIN="30"
RSI_EARLY_MAX="90"
MIN_ATR_PCT_PRECHECK="0.20"

# --- READY Signal Thresholds ---
READY_VWAP_MAX_PCT="1.00"
READY_VWAP_EPS_PCT="0.12"
READY_BODY_PCT="0.06"
READY_CLOSE_POS_MIN="0.62"
READY_UPPER_WICK_MAX="0.35"
READY_TREND_REQUIRED="true"
READY_BTC_REQUIRED="true"
READY_MIN_RR="1.35"
READY_MIN_RISK_PCT="0.25"

# --- BEST_ENTRY Signal Thresholds ---
BEST_BTC_REQUIRED="true"
RSI_BEST_MIN="55"
RSI_BEST_MAX="72"

# --- Volume & Volatility ---
THRESHOLD_VOL_SPIKE_X="1.3"
READY_VOL_SPIKE_REQUIRED="true"
READY_VOL_SPIKE_MAX="4.0"

# --- Sweep Detection ---
READY_SWEEP_REQUIRED="true"
SWEEP_MIN_DEPTH_ATR_MULT="0.35"
SWEEP_MAX_DEPTH_CAP="0.25"
LIQ_LOOKBACK="20"

# --- 15m Confirmation ---
CONFIRM15_VWAP_EPS_PCT="0.15"
CONFIRM15_VWAP_ROLL_BARS="96"
READY_REQUIRE_DAILY_VWAP="true"

# --- RSI Settings ---
RSI_DELTA_STRICT="0.20"
RSI_READY_MIN="40"
RSI_READY_MAX="76"

# --- Stop Loss ---
STOP_ATR_FLOOR_MULT="1.2"

# --- No-Lookahead Safety ---
CLOCK_SKEW_MS="800"
STRICT_NO_LOOKAHEAD="true"
NO_LOOKAHEAD_LOG="true"
NO_LOOKAHEAD_LOG_BUDGET="100"

# --- Outcome Resolution ---
OUTCOME_EXPIRE_AFTER_15M="12"

# --- Data Retention ---
CANDIDATE_FEATURES_MAX_ROWS="5000"

# --- Notifications (optional) ---
ADMIN_TOKEN="..."
SMTP_HOST=""
SMTP_USER=""
SMTP_PASS=""
VAPID_PUBLIC_KEY=""
VAPID_PRIVATE_KEY=""
```

> **Note:** Keep `backend/.env.example` in sync with Railway. See README.md for tuning parameter explanations.
> 
> **Last updated:** {{auto: never}} — Update manually when Railway vars change

---

## Tech Stack Summary

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, Zustand |
| Backend | Express 4, TypeScript, tsx (dev), esbuild (via tsc) |
| Database | better-sqlite3 (local), pg (PostgreSQL prod) |
| Testing | Vitest |
| Deployment | Docker, Railway (backend), Vercel (frontend) |
| APIs | Binance REST API |
| Notifications | web-push, nodemailer |
