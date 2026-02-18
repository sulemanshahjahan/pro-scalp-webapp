# Pro-Scalp Webapp - Agent Documentation

## Project Overview

**Pro-Scalp Webapp** is a cryptocurrency scalp signal scanner that monitors Binance markets in real-time to detect potential trading opportunities. The system analyzes 5-minute and 15-minute candlestick data using technical indicators (VWAP, EMA, RSI, ATR) to generate signals categorized as:

- `WATCH` - Early monitoring stage
- `EARLY_READY` / `EARLY_READY_SHORT` - Preliminary long/short signals
- `READY_TO_BUY` / `READY_TO_SELL` - Qualified entry signals
- `BEST_ENTRY` / `BEST_SHORT_ENTRY` - Highest conviction signals

The application consists of:
- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + Zustand (state management)
- **Backend**: Express 4 + TypeScript with dual database support (SQLite for local, PostgreSQL for production)
- **Testing**: Vitest for unit tests
- **Notifications**: Web Push API + Email (SMTP via nodemailer)

## Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Vite 5, TypeScript 5, Tailwind CSS 3, Zustand 4 |
| Backend | Express 4, TypeScript 5, tsx (dev), tsc (build) |
| Database | better-sqlite3 (local), pg (PostgreSQL production) |
| Testing | Vitest 2 |
| APIs | Binance REST API |
| Notifications | web-push, nodemailer |
| Deployment | Docker, Railway (backend), Vercel (frontend) |

## Project Structure

```
pro-scalp-webapp/
├── frontend/                    # React frontend (Vite)
│   ├── src/
│   │   ├── pages/              # App.tsx, StatsPage.tsx, TunePage.tsx, TuningBundlesPage.tsx
│   │   ├── components/         # SignalCard.tsx, RiskCalc.tsx, MarketConditionsDashboard.tsx
│   │   ├── services/           # api.ts, push.ts, sound.ts
│   │   ├── state/              # store.ts (Zustand state management)
│   │   ├── config/             # apiBase.ts
│   │   ├── main.tsx            # Entry point
│   │   └── styles.css
│   ├── public/                 # PWA assets (sw.js, sounds, icons)
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts          # Dev server + proxy to backend
│   └── tailwind.config.js
│
├── backend/                     # Express backend
│   ├── src/
│   │   ├── server.ts           # Express entry, API routes
│   │   ├── scanner.ts          # Main scanning loop + signal detection
│   │   ├── logic.ts            # Signal classification logic (READY, BEST_ENTRY, etc.)
│   │   ├── indicators.ts       # Technical indicators (EMA, VWAP, ATR, RSI)
│   │   ├── binance.ts          # Binance API client
│   │   ├── notifier.ts         # Web push notifications
│   │   ├── emailNotifier.ts    # Email notifications
│   │   ├── emailTemplates.ts   # Email HTML templates
│   │   ├── signalStore.ts      # Database operations for signals/outcomes
│   │   ├── scanStore.ts        # Scan run tracking
│   │   ├── candidateFeaturesStore.ts  # Feature snapshots for tuning
│   │   ├── tuningBundleStore.ts       # Tuning bundle storage
│   │   ├── tuneSim.ts          # Outcome simulation and tuning
│   │   ├── marketConditions.ts # BTC market context
│   │   ├── configSnapshot.ts   # Configuration hashing
│   │   ├── types.ts            # Shared TypeScript types
│   │   ├── dbPath.ts           # Database path resolution
│   │   └── db/                 # Database layer
│   │       ├── db.ts           # Dual SQLite/Postgres support
│   │       ├── postgresSchema.ts
│   │       └── emailGuards.ts
│   │   └── tuning/             # Tuning bundle generation
│   │       ├── cli.ts
│   │       └── generateTuningBundle.ts
│   ├── scripts/                # Build and utility scripts
│   ├── data/                   # SQLite database file (app.db)
│   ├── .env                    # Local environment variables
│   ├── .env.example            # Environment template
│   ├── package.json
│   ├── tsconfig.json
│   ├── railway.json            # Railway deployment config
│   └── Dockerfile
│
├── tests/                       # Vitest tests
│   ├── logic.test.ts
│   ├── indicators.test.ts
│   └── outcomes.test.ts
│
├── db/                          # Database schema
│   └── schema.sql
│
├── package.json                 # Root workspace configuration
├── Dockerfile                   # Multi-stage production build
├── vercel.json                  # Vercel frontend routing
└── README.md
```

## Build and Development Commands

### Root Level Commands

```bash
# Install dependencies for all workspaces
npm run install:all

# Run both frontend and backend in development mode
npm run dev

# Build both frontend and backend
npm run build

# Start production server (backend only, serves frontend static files)
npm start

# Run all tests
npm run test
# or
npm run t
```

### Frontend Commands (from `frontend/`)

```bash
npm run dev       # Start Vite dev server (port 5173)
npm run build     # Build for production (outputs to dist/)
npm run preview   # Preview production build
```

### Backend Commands (from `backend/`)

```bash
npm run dev                          # Start with tsx watch (auto-reload)
npm run build                        # Compile TypeScript to dist/
npm run start                        # Start production server
npm run db:migrate                   # Run database migrations
npm run db:validate:outcomes         # Validate outcome data integrity
npm run fake:email                   # Send test email
npm run test:dedupe                  # Test deduplication logic
npm run tuning:bundle -- --hours=6   # Generate tuning bundle
```

### Test Commands (from `tests/`)

```bash
npm run test        # Run all Vitest tests
npx vitest run logic.test.ts    # Run specific test file
```

## Environment Configuration

### Backend Environment Variables (`backend/.env`)

#### Database
```bash
DB_DRIVER=sqlite                    # sqlite or postgres
# DATABASE_URL=postgres://user:pass@host:5432/dbname
PG_AUTO_SCHEMA=false
PG_POOL_MAX=10
PG_IDLE_TIMEOUT_MS=30000
PG_CONNECT_TIMEOUT_MS=5000
```

#### Scanning Configuration
```bash
SCAN_INTERVAL_MS=90000              # Milliseconds between scans (default: 90s)
TOP_N=300                           # Number of top symbols to scan
SYMBOL_DELAY_MS=120                 # Delay between symbol API calls
MAX_SCAN_MS=240000                  # Maximum scan duration
CLOCK_SKEW_MS=1500                  # Wait time after candle close (anti-lookahead)
```

#### Signal Thresholds (READY Signals)
```bash
READY_VWAP_MAX_PCT=0.45             # Max distance from VWAP (%)
READY_VWAP_EPS_PCT=0.25             # VWAP epsilon tolerance (%)
READY_BODY_PCT=0.06                 # Minimum body size (%)
READY_CLOSE_POS_MIN=0.60            # Close position in candle (0-1)
READY_UPPER_WICK_MAX=0.40           # Max upper wick (%)
READY_MIN_RR=1.35                   # Minimum risk/reward ratio
READY_MIN_RISK_PCT=0.15             # Minimum risk percentage
```

#### RSI Configuration
```bash
RSI_READY_MIN=40                    # READY signal RSI minimum
RSI_READY_MAX=82                    # READY signal RSI maximum
RSI_DELTA_STRICT=0.20               # RSI confirmation strictness
RSI_BEST_MIN=55                     # BEST entry RSI minimum
RSI_BEST_MAX=72                     # BEST entry RSI maximum
```

#### Feature Flags
```bash
READY_TREND_REQUIRED=true           # Require trend confirmation
READY_RECLAIM_REQUIRED=true         # Require VWAP reclaim
READY_CONFIRM15_REQUIRED=true       # Require 15m confirmation
READY_VOL_SPIKE_REQUIRED=false      # Require volume spike
READY_SWEEP_REQUIRED=false          # Require liquidity sweep
READY_BTC_REQUIRED=false            # Require BTC market context
```

#### Notifications
```bash
ADMIN_TOKEN=your_secret_token       # Admin API access token
SMTP_HOST=smtp.gmail.com
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
VAPID_PUBLIC_KEY=your_vapid_public
VAPID_PRIVATE_KEY=your_vapid_private
```

### Frontend Environment Variables (`frontend/.env.development`)

```bash
VITE_API_BASE=http://localhost:8080  # Backend API base URL
```

## API Endpoints

### Core Endpoints
- `GET /api/scan` - Trigger market scan
- `GET /api/market/btc` - Get BTC market context
- `GET /api/stats` - Get signal statistics
- `GET /api/system/health` - System health check

### Signal Management
- `GET /api/signals` - List recent signals
- `GET /api/signals/:id` - Get signal by ID
- `GET /api/outcomes` - List signal outcomes

### Tuning & Analysis
- `GET /api/tune` - Run tuning simulation
- `GET /api/tuning/bundles` - List tuning bundles
- `GET /api/tuning/bundles/:id` - Get specific bundle

### Admin Endpoints (require `x-admin-token` header)
- `POST /api/debug/push` - Send test push notification
- `GET /api/debug/readyGate` - Debug READY gate decisions
- `POST /api/admin/clear-signals` - Clear all signal data

### Push Notifications
- `POST /api/subscribe` - Subscribe to push notifications
- `POST /api/unsubscribe` - Unsubscribe from push notifications
- `GET /api/vapidPublicKey` - Get VAPID public key

## Code Style Guidelines

### TypeScript
- **Strict mode enabled** - All code must pass TypeScript strict checks
- **2-space indentation**
- **Semicolons required**
- Use explicit types for function parameters and return values
- Prefer `interface` over `type` for object shapes

### Naming Conventions
- PascalCase for components, interfaces, and types
- camelCase for variables, functions, and methods
- UPPER_SNAKE_CASE for environment variables and constants

### File Organization
- Each module should have a single responsibility
- Co-locate related types in `types.ts`
- Database operations go in `*Store.ts` files

### Error Handling
- Use explicit error types where possible
- Log errors with context before throwing
- Database operations should handle both SQLite and PostgreSQL errors

## Testing Strategy

### Test Structure
Tests are located in the `tests/` directory as a separate workspace:

- `logic.test.ts` - Signal classification logic tests
- `indicators.test.ts` - Technical indicator calculation tests
- `outcomes.test.ts` - Outcome resolution tests

### Running Tests
```bash
# From root
npm run test

# From tests directory with specific file
cd tests && npx vitest run logic.test.ts
```

### Test Patterns
- Use Vitest's `describe` and `it` blocks
- Create mock data generators for time series (see `makeSeries` in logic.test.ts)
- Test both positive and negative cases
- Verify calculations match expected mathematical results

## Data Flow Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Binance API │────▶│  scanner.ts │────▶│  logic.ts   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                                │
                       ┌────────────────────────┼────────────────────────┐
                       ▼                        ▼                        ▼
                ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
                │ signalStore │          │  notifier   │          │   email     │
                │    (DB)     │          │  (push)     │          │  (SMTP)     │
                └──────┬──────┘          └──────┬──────┘          └─────────────┘
                       │                        │
                       ▼                        ▼
                ┌─────────────┐          ┌─────────────┐
                │   tuneSim   │          │  Frontend   │
                │  (outcomes) │          │   (polls)   │
                └─────────────┘          └─────────────┘
```

1. **scanner.ts** polls Binance API for candle data
2. **logic.ts** evaluates signals against thresholds
3. Valid signals are stored via **signalStore.ts**
4. Notifications sent via **notifier.ts** (push) and **emailNotifier.ts** (email)
5. Frontend polls `/api/scan` for updates
6. **tuneSim.ts** resolves outcomes (WIN/LOSS/TIMEOUT) over time

## Database Schema

### Core Tables

#### signals
Stores detected trading signals with full metadata.

#### signal_outcomes
Tracks the result of signals over time (TP1 hit, SL hit, etc.).

#### candidate_features
Stores raw feature snapshots for backtesting and tuning.

#### subscriptions
Web push notification subscriptions.

#### scan_runs
Tracks each scan execution with timing and statistics.

#### tuning_bundles
Periodic analysis reports with outcome statistics.

## Deployment Process

### Railway (Backend)
1. Git push triggers auto-deploy
2. Uses `Dockerfile` for build
3. Environment variables set in Railway dashboard
4. Exposes port 8080

### Vercel (Frontend)
1. Git push triggers auto-deploy
2. Uses `vercel.json` for routing configuration
3. All routes rewrite to `index.html` (SPA behavior)
4. API calls target Railway backend via `VITE_API_BASE`

### Docker Build
Multi-stage Dockerfile:
1. Stage 1: Build frontend with Node 20
2. Stage 2: Build backend with Node 20
3. Stage 3: Combine into production image

## Security Considerations

### Environment Variables
- Never commit `.env` files
- Use `ADMIN_TOKEN` for admin endpoints
- Rotate VAPID keys periodically

### API Security
- CORS configured via `CORS_ORIGINS` env var
- Admin endpoints require `x-admin-token` header
- Rate limiting handled by Binance API client delays

### Data Integrity
- No-lookahead guards prevent using partial candle data
- `STRICT_NO_LOOKAHEAD` throws on suspicious data
- `CLOCK_SKEW_MS` adds buffer after candle close

## Common Development Tasks

### Adding a New Signal Filter
1. Add threshold constant to `backend/src/logic.ts`
2. Add environment variable to `.env.example`
3. Implement filter logic in `evaluateSignal()`
4. Add test in `tests/logic.test.ts`

### Adding an API Endpoint
1. Add route in `backend/src/server.ts`
2. Use `requireAdmin()` for admin-only endpoints
3. Add frontend service call in `frontend/src/services/api.ts`
4. Update state management if needed

### Database Migration
1. For SQLite: Update `db/schema.sql`
2. For PostgreSQL: Add migration to `backend/src/db/postgresSchema.ts`
3. Run `npm run db:migrate`
4. Test locally with SQLite, verify on Postgres

### Tuning Parameter Changes
1. Update `backend/src/logic.ts` constants
2. Document in `README.md` tuning section
3. Generate bundle: `npm --prefix backend run tuning:bundle -- --hours=6`
4. Review in TuningBundlesPage

## Troubleshooting

### No Signals Generated
- Check `backend/src/logic.ts` guard conditions
- Verify `gateStats` in health endpoint
- Review scanner logs for failed prechecks

### Database Errors
- Verify `DB_DRIVER` env var
- Check `backend/data/app.db` exists (SQLite)
- Run `npm run db:migrate` for Postgres

### Frontend Not Loading
- Check backend serving `frontend/dist` folder
- Verify `VITE_API_BASE` configuration
- Check browser console for CORS errors

### Push Notifications Not Working
- Verify VAPID keys are set
- Check `subscriptions` table has entries
- Test with `npm run fake:email`
