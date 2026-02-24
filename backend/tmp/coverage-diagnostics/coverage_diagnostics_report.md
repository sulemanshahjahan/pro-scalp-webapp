# Coverage Diagnostics Report

## Summary

Total low-coverage trades analyzed: 20
Average coverage: 23.95%
Min coverage: 1.00%
Max coverage (in this group): 77.00%

## Root Cause Distribution

- WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet: 14 trades
- MODERATE_LOW_COVERAGE - Some candles missing, check API limits/symbol availability: 5 trades
- PARTIAL_CANDLE_DATA - API returned incomplete data, possible pagination bug: 1 trades

## Detailed Trade Analysis (Worst Coverage First)

### Signal 1932 (BIOUSDT)
- Signal Time: 2026-02-20T14:00:00.000Z
- Entry Time: 2026-02-20T14:00:00.000Z
- Expires At: 2026-02-21T14:00:00.000Z
- Status: LOSS_STOP
- Coverage: 1.00% (5/288 candles)
- Window Hours Elapsed: 11.0h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T14:24:53.749Z) < expires_at (2026-02-21T14:00:00.000Z)

### Signal 1929 (SOLUSDT)
- Signal Time: 2026-02-20T11:25:00.000Z
- Entry Time: 2026-02-20T11:25:00.000Z
- Expires At: 2026-02-21T11:25:00.000Z
- Status: LOSS_STOP
- Coverage: 1.00% (5/288 candles)
- Window Hours Elapsed: 13.6h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T11:48:53.974Z) < expires_at (2026-02-21T11:25:00.000Z)

### Signal 1952 (SUIUSDT)
- Signal Time: 2026-02-20T17:35:00.000Z
- Entry Time: 2026-02-20T17:35:00.000Z
- Expires At: 2026-02-21T17:35:00.000Z
- Status: LOSS_STOP
- Coverage: 2.00% (7/288 candles)
- Window Hours Elapsed: 7.4h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T18:08:45.012Z) < expires_at (2026-02-21T17:35:00.000Z)

### Signal 1950 (BTCUSDT)
- Signal Time: 2026-02-20T17:35:00.000Z
- Entry Time: 2026-02-20T17:35:00.000Z
- Expires At: 2026-02-21T17:35:00.000Z
- Status: LOSS_STOP
- Coverage: 2.00% (7/288 candles)
- Window Hours Elapsed: 7.4h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T18:08:46.330Z) < expires_at (2026-02-21T17:35:00.000Z)

### Signal 1941 (BIOUSDT)
- Signal Time: 2026-02-20T14:55:00.000Z
- Entry Time: 2026-02-20T14:55:00.000Z
- Expires At: 2026-02-21T14:55:00.000Z
- Status: WIN_TP2
- Coverage: 2.00% (6/288 candles)
- Window Hours Elapsed: 10.1h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T15:21:22.259Z) < expires_at (2026-02-21T14:55:00.000Z)

### Signal 1947 (DOGEUSDT)
- Signal Time: 2026-02-20T17:20:00.000Z
- Entry Time: 2026-02-20T17:20:00.000Z
- Expires At: 2026-02-21T17:20:00.000Z
- Status: WIN_TP2
- Coverage: 3.00% (10/288 candles)
- Window Hours Elapsed: 7.6h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T18:08:46.773Z) < expires_at (2026-02-21T17:20:00.000Z)

### Signal 1935 (BIOUSDT)
- Signal Time: 2026-02-20T14:25:00.000Z
- Entry Time: 2026-02-20T14:25:00.000Z
- Expires At: 2026-02-21T14:25:00.000Z
- Status: WIN_TP2
- Coverage: 3.00% (11/288 candles)
- Window Hours Elapsed: 10.6h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T15:18:09.956Z) < expires_at (2026-02-21T14:25:00.000Z)

### Signal 1978 (ALLOUSDT)
- Signal Time: 2026-02-20T22:50:00.000Z
- Entry Time: 2026-02-20T22:50:00.000Z
- Expires At: 2026-02-21T22:50:00.000Z
- Status: LOSS_STOP
- Coverage: 4.00% (13/288 candles)
- Window Hours Elapsed: 2.1h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T23:53:23.121Z) < expires_at (2026-02-21T22:50:00.000Z)

### Signal 1958 (ENSOUSDT)
- Signal Time: 2026-02-20T17:55:00.000Z
- Entry Time: 2026-02-20T17:55:00.000Z
- Expires At: 2026-02-21T17:55:00.000Z
- Status: LOSS_STOP
- Coverage: 5.00% (17/288 candles)
- Window Hours Elapsed: 7.1h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T19:18:47.147Z) < expires_at (2026-02-21T17:55:00.000Z)

### Signal 1944 (ARBUSDT)
- Signal Time: 2026-02-20T16:45:00.000Z
- Entry Time: 2026-02-20T16:45:00.000Z
- Expires At: 2026-02-21T16:45:00.000Z
- Status: LOSS_STOP
- Coverage: 5.00% (17/288 candles)
- Window Hours Elapsed: 8.2h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T18:08:47.686Z) < expires_at (2026-02-21T16:45:00.000Z)

### Signal 1971 (ENSOUSDT)
- Signal Time: 2026-02-20T20:50:00.000Z
- Entry Time: 2026-02-20T20:50:00.000Z
- Expires At: 2026-02-21T20:50:00.000Z
- Status: LOSS_STOP
- Coverage: 6.00% (20/288 candles)
- Window Hours Elapsed: 4.1h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T22:29:51.706Z) < expires_at (2026-02-21T20:50:00.000Z)

### Signal 1964 (ARBUSDT)
- Signal Time: 2026-02-20T20:35:00.000Z
- Entry Time: 2026-02-20T20:35:00.000Z
- Expires At: 2026-02-21T20:35:00.000Z
- Status: LOSS_STOP
- Coverage: 7.00% (23/288 candles)
- Window Hours Elapsed: 4.4h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T22:29:50.369Z) < expires_at (2026-02-21T20:35:00.000Z)

### Signal 1966 (SUIUSDT)
- Signal Time: 2026-02-20T20:35:00.000Z
- Entry Time: 2026-02-20T20:35:00.000Z
- Expires At: 2026-02-21T20:35:00.000Z
- Status: LOSS_STOP
- Coverage: 18.00% (52/288 candles)
- Window Hours Elapsed: 4.4h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-21T00:52:24.161Z) < expires_at (2026-02-21T20:35:00.000Z)

### Signal 1938 (ENSOUSDT)
- Signal Time: 2026-02-20T14:50:00.000Z
- Entry Time: 2026-02-20T14:50:00.000Z
- Expires At: 2026-02-21T14:50:00.000Z
- Status: LOSS_STOP
- Coverage: 31.00% (92/288 candles)
- Window Hours Elapsed: 10.1h
- Is Expired: false
- Root Cause: WINDOW_NOT_EXPIRED - Trade is still within 24h window, should not be finalized yet
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T22:29:53.048Z) < expires_at (2026-02-21T14:50:00.000Z)

### Signal 1920 (ZECUSDT)
- Signal Time: 2026-02-20T00:10:00.000Z
- Entry Time: 2026-02-20T00:10:00.000Z
- Expires At: 2026-02-21T00:10:00.000Z
- Status: WIN_TP2
- Coverage: 48.00% (140/288 candles)
- Window Hours Elapsed: 24.8h
- Is Expired: true
- Root Cause: PARTIAL_CANDLE_DATA - API returned incomplete data, possible pagination bug
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T11:48:45.894Z) < expires_at (2026-02-21T00:10:00.000Z), MISSING_CANDLES: Got 140, expected ~288

### Signal 1923 (SUIUSDT)
- Signal Time: 2026-02-20T00:20:00.000Z
- Entry Time: 2026-02-20T00:20:00.000Z
- Expires At: 2026-02-21T00:20:00.000Z
- Status: LOSS_STOP
- Coverage: 57.00% (166/288 candles)
- Window Hours Elapsed: 24.6h
- Is Expired: true
- Root Cause: MODERATE_LOW_COVERAGE - Some candles missing, check API limits/symbol availability
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T14:06:53.347Z) < expires_at (2026-02-21T00:20:00.000Z), MISSING_CANDLES: Got 166, expected ~288

### Signal 1926 (INJUSDT)
- Signal Time: 2026-02-20T00:40:00.000Z
- Entry Time: 2026-02-20T00:40:00.000Z
- Expires At: 2026-02-21T00:40:00.000Z
- Status: WIN_TP2
- Coverage: 61.00% (176/288 candles)
- Window Hours Elapsed: 24.3h
- Is Expired: true
- Root Cause: MODERATE_LOW_COVERAGE - Some candles missing, check API limits/symbol availability
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T15:18:11.342Z) < expires_at (2026-02-21T00:40:00.000Z), MISSING_CANDLES: Got 176, expected ~288

### Signal 1917 (INJUSDT)
- Signal Time: 2026-02-19T19:05:00.000Z
- Entry Time: 2026-02-19T19:05:00.000Z
- Expires At: 2026-02-20T19:05:00.000Z
- Status: LOSS_STOP
- Coverage: 69.00% (201/288 candles)
- Window Hours Elapsed: 29.9h
- Is Expired: true
- Root Cause: MODERATE_LOW_COVERAGE - Some candles missing, check API limits/symbol availability
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T11:48:46.344Z) < expires_at (2026-02-20T19:05:00.000Z), MISSING_CANDLES: Got 201, expected ~288

### Signal 1887 (BTCUSDT)
- Signal Time: 2026-02-19T17:10:00.000Z
- Entry Time: 2026-02-19T17:10:00.000Z
- Expires At: 2026-02-20T17:10:00.000Z
- Status: WIN_TP2
- Coverage: 77.00% (224/288 candles)
- Window Hours Elapsed: 31.8h
- Is Expired: true
- Root Cause: MODERATE_LOW_COVERAGE - Some candles missing, check API limits/symbol availability
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T11:48:52.598Z) < expires_at (2026-02-20T17:10:00.000Z), MISSING_CANDLES: Got 224, expected ~288

### Signal 1888 (SOLUSDT)
- Signal Time: 2026-02-19T17:10:00.000Z
- Entry Time: 2026-02-19T17:10:00.000Z
- Expires At: 2026-02-20T17:10:00.000Z
- Status: WIN_TP2
- Coverage: 77.00% (224/288 candles)
- Window Hours Elapsed: 31.8h
- Is Expired: true
- Root Cause: MODERATE_LOW_COVERAGE - Some candles missing, check API limits/symbol availability
    Issues: FINALIZED_TOO_EARLY: completed_at (2026-02-20T11:48:52.145Z) < expires_at (2026-02-20T17:10:00.000Z), MISSING_CANDLES: Got 224, expected ~288

## Recommendations

### Immediate Actions

1. **Fix Evaluator Timing**
   - Ensure trades are NOT marked complete before expires_at timestamp
   - Add explicit check: if (now < expiresAt) status = PENDING

2. **Investigate API Pagination**
   - Check klinesRange() pagination logic for 24h windows
   - Verify rate limiting is not truncating results
   - Add debug logging for: requested vs returned candle counts

3. **Add Coverage Validation**
   - Before finalizing a trade, require coverage >= 80%
   - If coverage < 80%, leave as PENDING and retry later

### Code Changes Required

File: `backend/src/extendedOutcomeStore.ts`

```typescript
// In evaluateExtended24hOutcome(), add BEFORE the timeout check:
const MIN_COVERAGE_FOR_COMPLETION = 80;
if (coveragePct < MIN_COVERAGE_FOR_COMPLETION && !windowExpired) {
  status = "PENDING";
  completed = false;
}
```
