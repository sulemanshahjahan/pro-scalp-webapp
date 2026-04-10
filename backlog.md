# Pro-Scalp Webapp - Prioritized Backlog

> Based on full codebase assessment + Railway production env analysis (April 2026)

## P0 (DO NOW) — Critical Security & Active Money-Losing Issues

### 1. Hardcoded Railway PostgreSQL Credentials Committed to Git
**Priority:** P0
**Category:** Security
**File(s):** `backend/scripts/queryDb.js` (line 3)
**Problem:** Database URL with full password is hardcoded in plain text and committed to git history. Anyone with repo access can connect to the production database.
**Fix:** Rotate Railway DB credentials immediately. Delete `backend/scripts/queryDb.js`. Scrub from git history with `git filter-repo`. Credentials must only live in Railway env vars.
**Effort:** S

### 2. SMTP/API Credentials Exposed
**Priority:** P0
**Category:** Security
**File(s):** `backend/.env` (line 7), Railway env vars (SMTP_PASS, RESEND_API_KEY)
**Problem:** Gmail app password in `.env` file. SendGrid API key and Resend API key were shared in plain text. All are compromised.
**Fix:** Rotate Gmail app password, SendGrid API key, and Resend API key. Confirm `backend/.env` is in `.gitignore` and never committed. Secrets only in Railway env vars.
**Effort:** S

### 3. requireAdmin() Returns True When ADMIN_TOKEN Not Set
**Priority:** P0
**Category:** Security
**File(s):** `backend/src/server.ts` (lines 190-199)
**Problem:** Function returns `true` (allows all) when `ADMIN_TOKEN` env var is undefined, making all admin endpoints publicly accessible by default.
**Fix:** Change logic to return `false` when `ADMIN_TOKEN` is not set. Require explicit token configuration for admin access.
**Effort:** S

### 4. Debug Endpoints Have No Authentication
**Priority:** P0
**Category:** Security
**File(s):** `backend/src/server.ts` (lines 2216, 2429, 2447, 2489, 2548, 2593, 2684, 5406, 5485, 5890, 5927, 5996, 6053, 6101, 6196, 6579, 6699)
**Problem:** 17+ `/api/debug/*` endpoints lack `requireAdmin()` checks, exposing sensitive operations (DB table listing, push notifications, email testing, signal recording, outcome manipulation) to anyone.
**Fix:** Add `if (!requireAdmin(req, res)) return;` guard to all debug endpoints. Disable debug endpoints entirely when `DEBUG_ENDPOINTS=false`.
**Effort:** S

### 5. Candle Quality Filters Are Dangerously Loose in Production
**Priority:** P0
**Category:** Signal Quality
**File(s):** `backend/src/logic.ts` (lines 24, 27-30, 166-210)
**Railway production config:** `READY_UPPER_WICK_MAX=0.80`, `READY_BODY_ATR_MULT=0.15`, `READY_BODY_MIN_PCT=0.002`, `READY_CLOSE_POS_MIN=0.35`
**Problem:** Production allows candles with 80% upper wick (strong rejection), 0.2% body (doji), and close in the lower 65% of the range. These are indecision/rejection candles being treated as buy signals. This is the #1 cause of stopped-out trades identified in CONFIG_ANALYSIS.md.
**Fix:** Update Railway env vars: `READY_UPPER_WICK_MAX=0.35`, `READY_BODY_ATR_MULT=0.40`, `READY_BODY_MIN_PCT=0.008`, `READY_CLOSE_POS_MIN=0.60`. Verify with 2 weeks of paper data.
**Effort:** S

### 6. All Quality Gates Disabled in Production
**Priority:** P0
**Category:** Signal Quality
**File(s):** `backend/src/logic.ts` (lines 35-41, 989-1022)
**Railway production config:** `READY_TREND_REQUIRED=false`, `READY_BTC_REQUIRED=false`, `READY_CONFIRM15_REQUIRED=false`, `READY_VOL_SPIKE_REQUIRED=false`, `READY_SWEEP_REQUIRED=false`, `SHORT_TREND_REQUIRED=false`, `SHORT_BTC_REQUIRED=false`, `SHORT_SWEEP_REQUIRED=false`
**Problem:** Every quality gate is OFF. The system accepts signals with no trend alignment, no BTC regime support, no 15m confirmation, no volume spike, and no liquidity sweep. Combined with loose candle quality (#5), signals are essentially random entries near VWAP.
**Fix:** Update Railway env vars: `READY_CONFIRM15_REQUIRED=true`, `READY_TREND_REQUIRED=true`, `READY_BTC_REQUIRED=true`, `READY_VOL_SPIKE_REQUIRED=true`. Leave `READY_SWEEP_REQUIRED=false` initially (sweep is the most restrictive gate). Monitor for 2 weeks.
**Effort:** S

### 7. Time Gate Blocks 19/24 Hours Compensating for Bad Signal Quality
**Priority:** P0
**Category:** Signal Quality
**File(s):** `backend/src/signalGate.ts` (lines 75, 111-114)
**Railway production config:** `SIGNAL_GATE_BLOCKED_HOURS=0,1,3,4,6,9,10,12,13,14,15,16,17,18,19,20,21,22,23`, `SIGNAL_GATE_BLOCKED_DAYS=Monday,Saturday`
**Problem:** Only 5 hours (2, 5, 7, 8, 11 UTC) on 5 days are allowed. That's ~15% of the week. Result: only 2 signals in 7 days, both low quality. The time gate is doing the job that quality gates should do.
**Fix:** After enabling quality gates (#6), open time window: `SIGNAL_GATE_BLOCKED_HOURS=0,1,2,3,4,22,23` (block only dead hours), `SIGNAL_GATE_BLOCKED_DAYS=Saturday`. Let quality gates filter instead of the clock.
**Effort:** S

### 8. Blocked Signals Leak Into Extended Outcomes
**Priority:** P0
**Category:** Bug
**File(s):** `backend/src/server.ts` (lines 2337-2378), `backend/src/delayedEntry.ts` (line 536)
**Problem:** At server.ts line 2337: `const allSignals = out;` — ALL signals are recorded to DB including gate-blocked ones. The `blockedMap` is keyed by symbol (not signal), so if the same symbol produces both LONG and SHORT signals, blocking is unreliable. Delayed entry at line 2363 checks `!isBlocked` but the extended outcome created at delayedEntry.ts line 536 still appears on the /extended page. This is why 2 `EARLY_READY_SHORT` signals appeared on the extended page despite `SIGNAL_GATE_ALLOWED_CATEGORIES=READY_TO_BUY,BEST_ENTRY`.
**Fix:** Skip `recordSignal()` entirely for blocked signals. OR: only call `initDelayedEntry()` for signals whose category is in `SIGNAL_GATE_ALLOWED_CATEGORIES`. Add a `gate_blocked` column to signals table and filter it out in extended outcomes queries.
**Effort:** M

### 9. Short Signals Enabled But 100% Rejected — Wasted Compute
**Priority:** P0
**Category:** Bug
**File(s):** `backend/src/logic.ts` (lines 1146-1248), `backend/src/scanner.ts`, Railway env vars
**Railway production config:** `ENABLE_SHORT_SIGNALS=true` but `SIGNAL_GATE_ALLOWED_CATEGORIES=READY_TO_BUY,BEST_ENTRY`
**Problem:** Every scan cycle, the scanner runs full short signal analysis for all 300+ symbols (15m confirmation, sweep detection, RSI calculation, body quality check, trade plan computation) then the gate rejects 100% of short signals because no short category is in the allowed list. This wastes significant CPU and API calls on every 90-second scan.
**Fix:** Set `ENABLE_SHORT_SIGNALS=false` in Railway env vars until you decide to trade shorts. When ready, add `READY_TO_SELL,BEST_SHORT_ENTRY` to `SIGNAL_GATE_ALLOWED_CATEGORIES`.
**Effort:** S

---

## P1 (THIS WEEK) — Signal Quality Improvements & Important Fixes

### 10. Body Quality Score (0-100) Computed Then Thrown Away
**Priority:** P1
**Category:** Signal Quality
**File(s):** `backend/src/logic.ts` (lines 189-210, 792-793)
**Problem:** `bodyQualityReady.score` is a sophisticated 0-100 quality metric considering body size, close position, and wick ratios. It's calculated, stored in debug JSON, but only the boolean `pass` is used for gating. A score of 51 (barely passing) is treated identically to 99 (perfect candle).
**Fix:** Add `READY_BODY_QUALITY_MIN_SCORE` env var (default 65). Replace boolean gate with `bodyQualityReady.score >= minScore`. Include score in signal data and email for analysis.
**Effort:** S

### 11. Market Regime (DORMANT/WARMING/ACTIVE) Calculated But Never Used for Gating
**Priority:** P1
**Category:** Signal Quality
**File(s):** `backend/src/marketConditions.ts` (lines 106-116), `backend/src/scanner.ts`
**Problem:** The system calculates market readiness score and regime (DORMANT/WARMING/ACTIVE) from aggregated gate stats. This is displayed in the UI but the scanner completely ignores it. Signals are generated in DORMANT markets that statistically lose.
**Fix:** Import `getMarketConditions()` in scanner. If regime is DORMANT (score < 40), skip signal generation entirely. If WARMING (40-70), only allow BEST_ENTRY. If ACTIVE (> 70), normal operation. Add `MARKET_REGIME_GATING=true` env var.
**Effort:** M

### 12. MFE Death Zone Filter Is Dead Code in Production
**Priority:** P1
**Category:** Signal Quality
**File(s):** `backend/src/signalGate.ts` (lines 78-80, 303, 432-446)
**Railway production config:** `SIGNAL_GATE_USE_MFE_ZONE=false`
**Problem:** The MFE death zone filter checks MFE30m data, but new signals don't have MFE data (it's an outcome metric calculated after 30 minutes). The `hasMfeData` check at line 303 means it would skip on all fresh signals anyway. Plus it's disabled via env var. Entire block is dead code.
**Fix:** Remove the MFE death zone filter from `checkSignalGate()`. If the concept is useful, redesign as a post-30m re-evaluation that can retroactively flag or invalidate signals.
**Effort:** S

### 13. Symbol Whitelist Statistics Based on N=3-6 Samples
**Priority:** P1
**Category:** Signal Quality
**File(s):** `backend/src/signalGate.ts` (lines 60-97)
**Problem:** Default whitelist has 5 symbols with win rates like "66.7%" (likely 2/3 or 4/6 trades). BCHUSDT shows "100%" which almost certainly means 2-4 trades. These statistics are not statistically significant and will not generalize.
**Fix:** Add minimum sample size validation (N >= 20) before any symbol tier or whitelist decision is trusted. Display sample size alongside win rate in the UI and in `computeSymbolTier`. Flag low-confidence statistics with a warning.
**Effort:** M

### 14. Signal Detection Uses 14 AND'd Boolean Conditions Instead of Weighted Scoring
**Priority:** P1
**Category:** Signal Quality
**File(s):** `backend/src/logic.ts` (lines 996-1010)
**Problem:** `readyCore` requires 14 boolean conditions all AND'd together. A signal that barely passes all 14 looks identical to one that crushes all 14. No confluence scoring at the signal level. This produces many borderline entries.
**Fix:** Implement weighted signal strength score (0-100) combining VWAP proximity, RSI momentum, body quality score, volume spike magnitude, trend strength, 15m confirmation type (strict vs soft), BTC alignment, and sweep quality. Store score with signal. Add `MIN_SIGNAL_STRENGTH` env var threshold.
**Effort:** L

### 15. Stop Loss Uses Fixed ATR Multiplier Regardless of Market Regime
**Priority:** P1
**Category:** Signal Quality
**File(s):** `backend/src/logic.ts` (lines 864-897)
**Railway production config:** `STOP_ATR_MULT=3.15`
**Problem:** Stop multiplier is static regardless of whether market is in high or low volatility. During high-vol periods, 3.15x ATR may be appropriate. During low-vol, it creates unnecessarily wide stops that reduce R:R.
**Fix:** Adjust ATR multiplier based on recent ATR percentile or market regime from `marketConditions.ts`. E.g., DORMANT: 2.0x, WARMING: 2.5x, ACTIVE: 3.15x. Add `STOP_ATR_ADAPTIVE=true` env var.
**Effort:** M

### 16. 15m Confirmation Too Rigid for Pullback Entries
**Priority:** P1
**Category:** Signal Quality
**File(s):** `backend/src/logic.ts` (lines 329-354)
**Problem:** Strict 15m confirm requires price above 15m VWAP AND above 15m EMA200 AND RSI 55-80 rising. This rejects valid pullback entries in uptrends — the entire point of VWAP scalping is catching pullbacks. By the time all conditions align, the move has already started.
**Fix:** Add a "pullback mode" that checks: is the 15m trend bullish (EMA50 > EMA200)? Is the 5m price pulling back toward VWAP (not away)? Is RSI showing divergence (price lower, RSI higher)? Add `CONFIRM15_ALLOW_PULLBACK=true` env var.
**Effort:** M

### 17. Error Responses Leak Stack Traces and DB Schema
**Priority:** P1
**Category:** Security
**File(s):** `backend/src/server.ts` (lines 1213, 1225, 1381, 1596, 1955, 2016, 2101, 2484, etc.)
**Problem:** Error responses use `error: String(e)` and sometimes include full stack traces (line 2484: `stack: (err as any)?.stack`). Database errors reveal table and column names.
**Fix:** Create error handler middleware that logs full errors server-side but returns generic `{ ok: false, error: 'Internal server error' }` to clients when `NODE_ENV=production`.
**Effort:** S

---

## P2 (DO SOON) — Architecture, Code Quality & Infrastructure

### 18. Three Overlapping Filter Layers with Duplicated Concepts
**Priority:** P2
**Category:** Architecture
**File(s):** `backend/src/logic.ts`, `backend/src/signalGate.ts`, `backend/src/entryFilter.ts`
**Problem:** `logic.ts` (core gates), `signalGate.ts` (hard execution filter), and `entryFilter.ts` (decision engine) all check overlapping criteria (tier, MFE, MQS, categories). MQS is calculated in both `signalGate.ts:188` and `entryFilter.ts:113`. Symbol blocking exists in both. Categories are checked in both.
**Fix:** Consolidate into single filter pipeline. Remove `entryFilter.ts` if unused in production or merge its concepts into `signalGate.ts`. One score, one threshold, one place to configure.
**Effort:** L

### 19. server.ts is 6,798 Lines with All Routes in One File
**Priority:** P2
**Category:** Architecture
**File(s):** `backend/src/server.ts` (6798 lines)
**Problem:** Monolithic file with all API routes, middleware, scan logic, and debug endpoints. Makes code review difficult, increases merge conflicts, and slows IDE performance.
**Fix:** Extract route handlers into `backend/src/routes/` directory: `signals.ts`, `outcomes.ts`, `tuning.ts`, `debug.ts`, `market.ts`, `admin.ts`. Keep server.ts as the app entry point that mounts routers.
**Effort:** L

### 20. 131+ Empty Catch Blocks Silently Swallowing Errors
**Priority:** P2
**Category:** Code Quality
**File(s):** Throughout backend (`binance.ts`, `signalStore.ts`, `scanStore.ts`, `server.ts`, `extendedOutcomeStore.ts`, etc.)
**Problem:** `catch {}` or `catch (e) {}` patterns hide database errors, schema migration failures, and API errors. Makes debugging production issues nearly impossible.
**Fix:** Audit all catch blocks. Add `console.error('[module] operation failed:', e)` at minimum. For schema migrations, log but continue. For critical operations, re-throw.
**Effort:** M

### 21. Frontend Pages Are Enormous
**Priority:** P2
**Category:** Code Quality
**File(s):** `frontend/src/pages/TunePage.tsx` (84K lines), `frontend/src/pages/StatsPage.tsx` (67K lines), `frontend/src/pages/ExtendedOutcomePage.tsx` (56K lines)
**Problem:** Massive single-file components are unmaintainable, slow IDE performance, and likely cause runtime performance issues.
**Fix:** Extract sub-components, custom hooks, and utility functions. No single file over 1,000 lines.
**Effort:** XL

### 22. 90+ Uses of `any` Type in Backend TypeScript
**Priority:** P2
**Category:** Code Quality
**File(s):** Throughout `backend/src/`
**Problem:** `any` usage undermines TypeScript's type safety, allowing runtime errors that the compiler should catch.
**Fix:** Replace `any` with proper types or `unknown` with type guards. Priority targets: function parameters, DB query results, API response handlers.
**Effort:** M

### 23. Only 3 Test Files for 250K+ Lines of Code
**Priority:** P2
**Category:** Code Quality
**File(s):** `tests/indicators.test.ts`, `tests/logic.test.ts`, `tests/outcomes.test.ts`
**Problem:** No test coverage for signal gate logic, extended outcome evaluation, delayed entry flow, server routes, or email notifications. Regressions go undetected.
**Fix:** Add unit tests for: gate logic with different configs, extended outcome evaluation, delayed entry state machine. Add integration test for scanner → gate → record → extended outcome pipeline. Target: core signal flow has >80% coverage.
**Effort:** L

### 24. No Structured Logging
**Priority:** P2
**Category:** Infrastructure
**File(s):** Throughout backend (113+ `console.log`/`console.error` calls)
**Problem:** No log levels, no JSON format, no correlation IDs, no request logging middleware. Production troubleshooting requires reading raw stdout.
**Fix:** Replace `console.log` with structured logger (`pino` recommended for Node.js). JSON format in production, pretty-print in dev. Add request ID to every log line.
**Effort:** M

### 25. No Startup Validation of Required Env Vars
**Priority:** P2
**Category:** Infrastructure
**File(s):** `backend/src/server.ts` (entry point), `backend/src/mailer.ts` (lines 9-17)
**Problem:** Server starts even if critical env vars are missing. `mailer.ts` uses non-null assertions (`process.env.SMTP_HOST!`) that crash at runtime when email is enabled but vars are missing. No DB connectivity check before accepting requests.
**Fix:** Add `validateEnv()` function at startup that checks all required vars (`DATABASE_URL` when `DB_DRIVER=postgres`, `SMTP_HOST/USER/PASS` when `EMAIL_ENABLED=true`, etc.). Exit with clear error message if missing.
**Effort:** S

### 26. CORS Defaults to Wildcard '*'
**Priority:** P2
**Category:** Security
**File(s):** `backend/src/server.ts` (line 143)
**Problem:** `CORS_ORIGINS` defaults to `'*'` if not set. Also allows any `*.vercel.app` origin and any `localhost`. Debug endpoints have hardcoded `Access-Control-Allow-Origin: *`.
**Fix:** Remove default wildcard. Require explicit `CORS_ORIGINS` configuration. Remove wildcard overrides on debug endpoints.
**Effort:** S

### 27. No Rate Limiting on Any Endpoint
**Priority:** P2
**Category:** Security
**File(s):** `backend/src/server.ts`
**Problem:** Zero rate limiting. Failed auth attempts, scan triggers, debug endpoints — all unlimited. Vulnerable to brute force and DoS.
**Fix:** Add `express-rate-limit` middleware. Admin endpoints: 10 req/min. Scan trigger: 1 req/min. General API: 100 req/min.
**Effort:** S

### 28. SSL Certificate Verification Disabled on PostgreSQL
**Priority:** P2
**Category:** Security
**File(s):** `backend/src/db/db.ts` (line 270), `backend/src/signalStore.ts` (line 1454)
**Problem:** `rejectUnauthorized: false` on PostgreSQL connections disables SSL certificate verification, vulnerable to MITM attacks.
**Fix:** Set `rejectUnauthorized: true` in production. Configure CA certificate via `PG_SSL_CA` env var if Railway requires custom CA.
**Effort:** S

### 29. No Request Payload Size Limits
**Priority:** P2
**Category:** Security
**File(s):** `backend/src/server.ts` (line 182)
**Problem:** `app.use(express.json())` without limit. Large POST payloads to `/api/tune/simBatch` could consume memory.
**Fix:** Change to `app.use(express.json({ limit: '1mb' }))`.
**Effort:** S

### 30. No CSRF Protection
**Priority:** P2
**Category:** Security
**File(s):** `backend/src/server.ts`
**Problem:** No CSRF token validation despite `credentials: true` on CORS. POST/PUT/DELETE endpoints vulnerable to cross-site request forgery.
**Fix:** Implement double-submit cookie pattern or SameSite cookie attribute for state-changing endpoints.
**Effort:** M

### 31. No Graceful Shutdown Handler
**Priority:** P2
**Category:** Infrastructure
**File(s):** `backend/src/server.ts` (lines 5282-5283)
**Problem:** No SIGTERM handler. No drain of in-flight requests. No cleanup of database pool. Scanner may be mid-scan when Railway restarts the container.
**Fix:** Add SIGTERM/SIGINT handler that stops accepting new requests, waits for active scan to complete, closes DB pool, then exits cleanly.
**Effort:** M

### 32. SQLite .db Files Tracked in Git
**Priority:** P2
**Category:** Code Quality
**File(s):** `db/app.db`, `db/app.db-shm`, `db/app.db-wal`, `data/app.db`
**Problem:** Binary database files in git bloat repository and risk committing local data.
**Fix:** Add `*.db`, `*.db-shm`, `*.db-wal` to `.gitignore`. Run `git rm --cached` on tracked files.
**Effort:** S

---

## P3 (NICE TO HAVE) — Cleanup & Optimization

### 33. /stats Page and Short-Horizon Outcomes Are Unused But Still Running
**Priority:** P3
**Category:** Architecture
**File(s):** `backend/src/signalStore.ts` (outcome updater), `frontend/src/pages/StatsPage.tsx`
**Problem:** The 15m/30m/60m/120m/240m outcome tracking runs continuously on a timer, fetching candle data from Binance API for every signal at every horizon. The /stats page and these outcomes are not used by the trader — only the 24h extended outcomes matter.
**Fix:** Disable short-horizon outcome updater to reduce DB load and API calls. Or repurpose /stats to show extended outcome statistics. Document which systems are active vs deprecated.
**Effort:** S

### 34. Docker Image Includes devDependencies
**Priority:** P3
**Category:** Infrastructure
**File(s):** `Dockerfile`
**Problem:** Final Docker stage copies all `node_modules` including TypeScript compiler, vitest, tsx, and other dev tools. Image is unnecessarily large.
**Fix:** Add `npm ci --omit=dev` or `npm prune --production` in the final Docker stage before copying node_modules.
**Effort:** S

### 35. delayedEntry.ts is 35K+ Lines
**Priority:** P3
**Category:** Code Quality
**File(s):** `backend/src/delayedEntry.ts` (35K+ lines)
**Problem:** Monolithic file with DB operations, validation, watcher loop, simulation, state machine, and recalculation logic all in one place.
**Fix:** Split into `backend/src/delayedEntry/` directory: `store.ts`, `watcher.ts`, `validation.ts`, `simulation.ts`, `types.ts`.
**Effort:** M

### 36. signalStore.ts is 174KB
**Priority:** P3
**Category:** Code Quality
**File(s):** `backend/src/signalStore.ts` (4,635+ lines)
**Problem:** Contains signal storage, outcome tracking, stats calculation, bulk operations, and advisory locking all in one file.
**Fix:** Split into `signalStore.ts` (CRUD), `outcomeTracker.ts` (horizon evaluation), `signalStats.ts` (aggregation queries).
**Effort:** L

### 37. scanner.ts Has Mixed Responsibilities
**Priority:** P3
**Category:** Code Quality
**File(s):** `backend/src/scanner.ts` (1,147 lines)
**Problem:** Contains API client logic, signal evaluation, gate stats accumulation, push notifications, and email sending all interleaved.
**Fix:** Extract notification logic to dedicated module. Extract gate stats accumulation to analytics module. Keep scanner focused on the scan loop.
**Effort:** M

### 38. Non-null Assertions on Env Vars in mailer.ts
**Priority:** P3
**Category:** Code Quality
**File(s):** `backend/src/mailer.ts` (lines 9-17)
**Problem:** `process.env.SMTP_HOST!`, `SMTP_USER!`, `SMTP_PASS!` non-null assertions will crash at runtime if email is enabled but vars are missing.
**Fix:** Add validation at initialization: if `EMAIL_ENABLED=true` and any SMTP var is missing, log error and set `enabled=false` instead of crashing.
**Effort:** S

---

## Summary

**Total: 38 backlog items**

### Completion Status (Updated April 10, 2026)

| Item | Status | Notes |
|------|--------|-------|
| 1 | DONE (code) | queryDb.js removed from git. **YOU MUST rotate Railway DB password.** |
| 2 | DONE (code) | .gitignore updated. **YOU MUST rotate SendGrid, Resend, Gmail credentials.** |
| 3 | DONE | requireAdmin() denies when ADMIN_TOKEN unset |
| 4 | DONE | All 14 debug endpoints now require admin auth |
| 5 | MANUAL | **Update Railway env vars** (candle quality) |
| 6 | MANUAL | **Update Railway env vars** (enable quality gates) |
| 7 | MANUAL | **Update Railway env vars** (open time window) |
| 8 | DONE | Only gate-passed signals recorded. Blocked signals no longer leak. |
| 9 | MANUAL | **Set ENABLE_SHORT_SIGNALS=false in Railway** |
| 10 | DONE | Body quality score env vars: READY_BODY_QUALITY_MIN_SCORE, BEST_BODY_QUALITY_MIN_SCORE |
| 11 | DONE | Market regime gating: MARKET_REGIME_GATING, MARKET_REGIME_MIN_SCORE |
| 12 | DONE | MFE death zone dead code removed from signalGate.ts |
| 13 | DONE | MIN_SIGNALS_FOR_TIER raised to 20, lowConfidence flag added |
| 14 | DONE | Weighted confluenceScore (0-100) added, MIN_CONFLUENCE_SCORE env var |
| 15 | DONE | Adaptive stops: STOP_ATR_ADAPTIVE with DORMANT/WARMING/ACTIVE multipliers |
| 16 | DONE | Pullback 15m confirm: CONFIRM15_ALLOW_PULLBACK env var |
| 17 | DONE | Global error handler prevents stack trace leaks in production |
| 18 | DONE | entryFilter.ts marked @deprecated, documented as not in live pipeline |
| 19 | DEFERRED | Split server.ts — XL effort, high risk |
| 20 | DONE | 8 critical empty catches fixed with logging |
| 21 | DEFERRED | Split frontend pages — XL effort |
| 22 | DEFERRED | Replace any types — M effort, incremental |
| 23 | DEFERRED | Add tests — L effort, incremental |
| 24 | DONE (partial) | Logger module created (backend/src/logger.ts). Gradual adoption. |
| 25 | DONE | validateEnv() at startup, fails fast on missing critical vars |
| 26 | DONE | CORS wildcard removed, explicit origins required, wildcard removed from debug endpoints |
| 27 | DONE | Rate limiting: API 120/min, debug 10/min, scan 2/min |
| 28 | DONE | SSL verification configurable via PG_SSL_REJECT_UNAUTHORIZED |
| 29 | DONE | express.json({ limit: '1mb' }) |
| 30 | DEFERRED | CSRF protection — CORS now locked down |
| 31 | DONE | Graceful shutdown: SIGTERM/SIGINT handlers, connection drain, 10s timeout |
| 32 | DONE | .db files removed from git, patterns in .gitignore |
| 33 | DONE | SHORT_HORIZON_OUTCOMES=false disables unused 15m/30m/60m updater |
| 34 | DONE | Dockerfile: npm ci --omit=dev in final stage |
| 35 | DEFERRED | Split delayedEntry.ts — only 1006 lines, not urgent |
| 36 | DEFERRED | Split signalStore.ts — L effort, high risk |
| 37 | DEFERRED | Split scanner.ts — M effort |
| 38 | DONE | Non-null assertions replaced with safe checks + error logging |

### Stats: 27 done, 5 manual (Railway env), 6 deferred

### Railway Env Vars To Update
```bash
# P0 SIGNAL QUALITY (Items 5-7, 9)
READY_UPPER_WICK_MAX=0.35
READY_BODY_ATR_MULT=0.40
READY_BODY_MIN_PCT=0.008
READY_CLOSE_POS_MIN=0.60
READY_CONFIRM15_REQUIRED=true
READY_TREND_REQUIRED=true
READY_BTC_REQUIRED=true
READY_VOL_SPIKE_REQUIRED=true
SIGNAL_GATE_BLOCKED_HOURS=0,1,2,3,4,22,23
SIGNAL_GATE_BLOCKED_DAYS=Saturday
ENABLE_SHORT_SIGNALS=false

# P1 NEW FEATURES (Items 10-16)
READY_BODY_QUALITY_MIN_SCORE=65
BEST_BODY_QUALITY_MIN_SCORE=70
MARKET_REGIME_GATING=true
MARKET_REGIME_MIN_SCORE=30
MIN_CONFLUENCE_SCORE=50
STOP_ATR_ADAPTIVE=true
STOP_ATR_DORMANT=2.0
STOP_ATR_WARMING=2.5
STOP_ATR_ACTIVE=3.15
CONFIRM15_ALLOW_PULLBACK=true
MIN_SIGNALS_FOR_TIER=20

# P2 INFRASTRUCTURE (Items 28, 33)
SHORT_HORIZON_OUTCOMES=false
PG_SSL_REJECT_UNAUTHORIZED=false
ADMIN_TOKEN=<generate-a-strong-token>
```
