# Configuration Verification Guide

## Step 1: Verify Gate Config is Loaded

### Check API Endpoint
```
GET https://pro-scalp-backend-production.up.railway.app/api/gate/config
```

**Expected Response:**
```json
{
  "ok": true,
  "config": {
    "enabled": true,
    "useSymbolWhitelist": false,
    "useTimeFilters": true,
    "blockedHours": [0,1,3,4,6,9,10,12,13,14,15,16,17,18,19,20,21,22,23],
    "blockedDays": ["Monday", "Saturday"],
    "allowedCategories": ["READY_TO_BUY", "BEST_ENTRY"]
  }
}
```

**⚠️ Verify:**
- `useSymbolWhitelist: false` (using blacklist mode)
- `useTimeFilters: true` (time restrictions active)
- `blockedHours` has 19 entries (only 2,5,7,8,11 UTC allowed)

---

## Step 2: Verify System Health

### Check Health Endpoint
```
GET https://pro-scalp-backend-production.up.railway.app/api/system/health
```

**What to Check:**
- `scan.state`: Should be "IDLE" or "RUNNING" (not stuck)
- `scan.nextScanAt`: Should be recent timestamp
- `outcomes.pendingOutcomesCount`: Should be low (<10)
- `outcomes.resolverLagMs`: Should be < 1 hour

**⚠️ Red Flags:**
- `resolverLagMs > 1 day` = outcomes not processing
- `scan.state: ERROR` = scanner broken
- `pendingOutcomesCount > 50` = backlog building

---

## Step 3: Check Recent Signals

### Method A: API Endpoint
```
GET https://pro-scalp-backend-production.up.railway.app/api/signals?limit=20
```

**What to Verify:**
- Only symbols NOT in blocklist appear
- Categories are READY_TO_BUY or BEST_ENTRY
- Times are in allowed hours (2,5,7,8,11 UTC)

### Method B: Extended Outcomes Table
```
GET https://pro-scalp-backend-production.up.railway.app/api/extended-outcomes?limit=20
```

**Verify Blocked Symbols Are NOT Present:**
- ❌ ZECUSDT should NOT appear
- ❌ ENSOUSDT should NOT appear
- ❌ ESPUSDT should NOT appear
- ❌ PUMPUSDT should NOT appear
- ❌ TAOUSDT should NOT appear
- ❌ KITEUSDT should NOT appear
- ❌ BARDUSDT should NOT appear
- ❌ ALLOUSDT should NOT appear
- ❌ ARBUSDT should NOT appear
- ❌ XPLUSDT should NOT appear

**Allowed Symbols SHOULD Appear:**
- ✅ SOLUSDT, ADAUSDT, SUIUSDT, AVAXUSDT, LINKUSDT
- ✅ BTCUSDT, ETHUSDT, DOTUSDT, NEARUSDT

---

## Step 4: Monitor First 24 Hours

### What to Track

| Time | Action | Expected Result |
|------|--------|-----------------|
| 0-6h | Check `/api/system/health` | Scan running normally |
| 6-12h | Check signals endpoint | 0-2 signals (time-filtered) |
| 12-24h | Check outcomes | Signals complete with status |

### Hourly Checks

**Run this query every few hours:**
```sql
-- Check recent signals
SELECT 
  symbol, 
  category, 
  TO_TIMESTAMP(time/1000) as time,
  blocked_reasons_json
FROM signals 
WHERE time > EXTRACT(EPOCH FROM NOW() - INTERVAL '6 hours') * 1000
ORDER BY time DESC;
```

**Expected:**
- No blocked_reasons_json (signals passed gate)
- Symbols NOT in blocked list
- Times in allowed hours only

---

## Step 5: Verify Outcomes Are Processing

### Check Outcome Stats
```
GET https://pro-scalp-backend-production.up.railway.app/api/extended-outcomes/stats
```

**What to Verify:**
- `totals.totalSignals` increasing
- `totals.completedSignals` increasing
- `signalRates.winRate.pct` around 50-60%

### Manual Check (pgAdmin)
```sql
-- Count signals in last 24h
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) as completed,
  SUM(CASE WHEN status = 'WIN_TP2' THEN 1 ELSE 0 END) as wins_tp2,
  SUM(CASE WHEN status = 'LOSS_STOP' THEN 1 ELSE 0 END) as losses
FROM extended_outcomes
WHERE signal_time > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000;
```

**Expected:**
- 1-3 signals per day
- 60-70% complete within 24h
- Win rate around 50-60%

---

## Step 6: Verify Blocked Symbols Are Actually Blocked

### Test API Endpoint
```
GET https://pro-scalp-backend-production.up.railway.app/api/gate/check
```

With body:
```json
{
  "symbol": "ZECUSDT",
  "category": "READY_TO_BUY",
  "direction": "LONG",
  "price": 100,
  "time": 1234567890
}
```

**Expected Response:**
```json
{
  "ok": true,
  "result": {
    "allowed": false,
    "reasons": ["SYMBOL_BLOCKED"]
  }
}
```

---

## Step 7: Verify Time Filters

### Check Current Trading Window
```
GET https://pro-scalp-backend-production.up.railway.app/api/gate/config
```

Compare `blockedHours` with current UTC time.

**Example:**
- Current UTC: 14:00
- Blocked hours: [0,1,3,4,6,9,10,12,13,14,15,16...]
- Result: 14 IS blocked → No signals expected

**Example:**
- Current UTC: 7:00  
- Blocked hours: [0,1,3,4,6...] (7 NOT in list)
- Result: 7 IS allowed → Signals expected

---

## 🚨 RED FLAGS TO WATCH FOR

### Critical Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| No signals for 24h | Gate too restrictive | Check `USE_WHITELIST` vs `BLOCK_SYMBOLS` |
| Blocked symbols appearing | Blacklist not working | Verify `USE_WHITELIST=false` |
| Outcomes stuck PENDING | Resolver not running | Check `resolverLagMs` in health |
| All signals blocked | Time filter wrong | Verify UTC hours vs local time |
| ZEC/TAO still trading | Config not deployed | Redeploy Railway service |

### Diagnostic Commands

**Check gate is working:**
```bash
curl https://pro-scalp-backend-production.up.railway.app/api/gate/config | jq
```

**Check recent blocked signals:**
```sql
SELECT symbol, blocked_reasons_json, time 
FROM signals 
WHERE time > EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour') * 1000
  AND blocked_reasons_json IS NOT NULL;
```

**Check outcomes processing:**
```sql
SELECT 
  status, 
  COUNT(*),
  AVG(ext24_managed_r) as avg_r
FROM extended_outcomes
WHERE signal_time > EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') * 1000
GROUP BY status;
```

---

## ✅ SUCCESS CRITERIA (First Week)

| Metric | Target | Check After |
|--------|--------|-------------|
| Signals/Day | 1-2 | 7 days |
| Blocked symbols | 0 | Immediate |
| Outcomes completing | 100% within 24h | 7 days |
| Win rate | 50-60% | 20+ signals |
| Avg R per trade | > 0 | 20+ signals |

---

## 📊 DASHBOARD MONITORING

Create a daily check routine:

1. Morning: Check `/api/system/health`
2. After signals: Verify `/api/extended-outcomes` 
3. Evening: Run analysis query in pgAdmin

**Want me to create an automated monitoring script?**
