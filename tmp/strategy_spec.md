# Strategy Specification v1.2.0 (Production - PERMISSIVE)
**One-page audit reference — what counts as a valid signal**

> ⚠️ **NOTE**: This spec reflects the PERMISSIVE configuration (sweep/BTC/reclaim gates DISABLED)

---

## 1. Timeframes & System

| Purpose | Candle | Lookback |
|---------|--------|----------|
| Entry analysis | 5m | 210+ bars (~17h) |
| Confirmation filter | 15m | 210+ bars (~52h) |
| Anchored VWAP | Daily reset | 288 bars (5m) / 96 bars (15m) |

**Scan Interval**: 90,000ms (90s)  
**Clock Skew**: 800ms (no-lookahead protection)  
**Strict No-Lookahead**: Enabled (throws on future data)  

---

## 2. Signal Categories (Hierarchy)

```
WATCH → EARLY_READY → READY_TO_BUY → BEST_ENTRY
 └─setup phase    └─pre-entry    └─tradeable    └─optimal
```

Only **READY_TO_BUY** and **BEST_ENTRY** generate trade plans with SL/TP.

---

## 3. Entry Gates (All MUST pass for READY)

### 3.1 Precheck Gate (Early Filter)
- Price within `5.0%` of VWAP (prevents extended entries)
- Price within `0.5%` below EMA (soft tolerance)
- RSI 20-85 (broad pre-filter)
- ATR% ≥ 0.20% (sufficient volatility)
- Env: `PRECHECK_VWAP_MAX_PCT=5.0`, `PRECHECK_EMA_SOFT_PCT=0.5`, `RSI_PRECHECK_MIN=20`, `RSI_PRECHECK_MAX=85`

### 3.2 Session Gate
- **DISABLED in production** — signals allowed 24/7
- Env: `SESSION_FILTER_ENABLED=false`

### 3.3 Trend Gate
- EMA50 > EMA200 on 5m
- EMA200 rising (≥ previous 3 bars)
- Env: `READY_TREND_REQUIRED=true`

### 3.4 VWAP Gate (RELAXED)
- Price within `1.5%` of anchored VWAP (widened from 1.0%)
- Must have touched VWAP in last 10 candles (extended from 5)
- Touch tolerance: `0.50%` (widened from 0.20%)
- Price > VWAP OR reclaim/tap pattern active
- Relaxation buffer: `0.12%` below VWAP allowed
- Env: `READY_VWAP_MAX_PCT=1.50`, `READY_VWAP_TOUCH_PCT=0.50`, `READY_VWAP_TOUCH_BARS=10`, `READY_VWAP_EPS_PCT=0.12`

### 3.5 EMA Gate
- Price ≥ EMA200 (hard requirement)
- Env: Default (no epsilon configured)

### 3.6 RSI Gate (READY)
- RSI-9 in band: `40–76`
- Delta ≥ `0.20` (rising momentum)
- Env: `RSI_READY_MIN=40`, `RSI_READY_MAX=76`, `RSI_DELTA_STRICT=0.20`

### 3.7 RSI Gate (EARLY/WATCH)
- RSI-9 in band: `30–90`
- Env: `RSI_EARLY_MIN=30`, `RSI_EARLY_MAX=90`

### 3.8 Volume Gate
- Spike ≥ `1.3x` 20-bar average (required)
- Cap ≤ `4.0x` (anti-whale)
- Env: `THRESHOLD_VOL_SPIKE_X=1.3`, `READY_VOL_SPIKE_MAX=4.0`, `READY_VOL_SPIKE_REQUIRED=true`

### 3.9 Confirm15 Gate (15m Alignment)
- **Strict**: Price > VWAP + EMA200, RSI-9 55-80 and rising
- **Soft fallback**: Within `0.15%` of rolling VWAP (96-bar), RSI ≥ 50, not falling
- Env: `CONFIRM15_VWAP_EPS_PCT=0.15`, `CONFIRM15_VWAP_ROLL_BARS=96`

### 3.10 Daily VWAP Gate
- Price > daily-anchored VWAP OR strict 15m confirm
- Blocks entries in daily downtrend
- Env: `READY_REQUIRE_DAILY_VWAP=true`

### 3.11 Reclaim/Tap Gate (DISABLED)
- ~~**Reclaim**: Prev close > VWAP, prev-2 close ≤ VWAP~~
- ~~**Tap**: Prev low touched VWAP, prev close held above~~
- **CURRENT**: Reclaim/tap check still computed but NOT required
- Env: `READY_RECLAIM_REQUIRED=false`

### 3.12 Sweep Gate (DISABLED for READY)
- ~~Wick sweep below prior 20-bar swing low~~
- ~~Depth: `0.35×ATR` (min 0.10%, max `0.25%`)~~
- **CURRENT**: Sweep detection disabled for READY signals
- Sweep still required for BEST_ENTRY
- Env: `READY_SWEEP_REQUIRED=false`, `SWEEP_MIN_DEPTH_ATR_MULT=0.25`, `SWEEP_MAX_DEPTH_CAP=0.25`, `LIQ_LOOKBACK=20`

### 3.13 BTC Gate (DISABLED for READY)
- ~~BTC 15m bullish OR~~
- ~~BTC neutral + strict 15m confirm OR~~
- ~~BTC bear + strict + trend + vol override~~
- **CURRENT**: BTC gate DISABLED for READY (still required for BEST)
- Env: `READY_BTC_REQUIRED=false`, `BEST_BTC_REQUIRED=true`

### 3.14 Body Quality Gate (ATR-Relative - NEW)
- Bullish candle (close > open)
- Body ≥ `(ATR% × 0.40)` OR ≥ `0.8%` of price (whichever is larger)
- Close in upper `60%` of range (relaxed from 62%)
- Upper wick ≤ `40%` of range (relaxed from 35%)
- Env: `READY_BODY_ATR_MULT=0.40`, `READY_BODY_MIN_PCT=0.008`, `READY_CLOSE_POS_MIN=0.60`, `READY_UPPER_WICK_MAX=0.40`

### 3.15 R:R Gate
- Minimum R:R ≥ `1.35`
- Env: `READY_MIN_RR=1.35`

### 3.16 Risk% Gate
- Risk distance ≥ `0.25%` (entry to stop)
- Env: `READY_MIN_RISK_PCT=0.25`

---

## 4. BEST_ENTRY (Additional Requirements)

| Gate | BEST Requirement | Env |
|------|-----------------|-----|
| RSI | `55–72` (tighter band) | `RSI_BEST_MIN=55`, `RSI_BEST_MAX=72` |
| Body | ≥ `(ATR% × 0.80)` OR ≥ `1.5%` | `BEST_BODY_ATR_MULT=0.80`, `BEST_BODY_MIN_PCT=0.015` |
| Wick | Upper ≤ `40%` | Default |
| ATR | ≤ `2.5%` | `THRESHOLD_ATR_GUARD_PCT` (default 2.5) |
| Vol | ≥ `1.4x` | Max of `1.3` or `1.4` |
| Sweep | **Required** (0.25×ATR depth) | `SWEEP_MIN_DEPTH_ATR_MULT=0.25` |
| BTC | **Must be bullish** | `BEST_BTC_REQUIRED=true` |

---

## 5. Stop Loss Logic

```
Priority 1: Sweep wick low (if liq sweep detected)
Priority 2: Recent swing low (20-bar lookback, excl. current)
Priority 3: ATR-based stop (1.5×ATR below entry)

Floor: Stop ≥ 1.2×ATR below entry (prevents micro-stops)
```

**Env**: `STOP_ATR_MULT=1.5`, `STOP_ATR_FLOOR_MULT=1.2`

---

## 6. Take Profit Logic

```
TP1 = Entry + 1R
TP2 = Entry + 2R
Target = Nearest upside liquidity (swing high) if closer than 2R
```

R:R calculated as: `(Target - Entry) / (Entry - Stop)`

---

## 7. Outcome Resolution

| Window | Time | Status |
|--------|------|--------|
| 15m | 15 min | PARTIAL |
| 30m | 30 min | PARTIAL |
| 60m | 1 hour | PARTIAL |
| 120m | 2 hours | PARTIAL |
| 240m | 4 hours | FINAL |

**Results**: `STOP` (SL hit) / `TP1` (1R reached) / `TP2` (2R reached) / `TIMEOUT` (no trigger) / `AMBIGUOUS` (data gap)

**Auto-expire**: Signals > 12 candles old without resolution → `TIMEOUT`  
**Env**: `OUTCOME_EXPIRE_AFTER_15M=12`

---

## 8. What Counts as VALID SIGNAL (Plain Terms)

> A **READY_TO_BUY** signal is a long scalp setup that passes ALL of:
> 1. **Precheck**: Price within 5% of VWAP, RSI 20-85, ATR ≥ 0.2%
> 2. **Trend**: EMA50 > EMA200 and both rising
> 3. **Value**: Price within 1.5% of VWAP with recent touch (0.50% tolerance, 10 bars)
> 4. **Momentum**: RSI 40-76 with delta ≥ 0.20
> 5. **Volume**: 1.3x-4.0x spike (required)
> 6. **Daily Trend**: Price above daily VWAP
> 7. **Higher TF**: 15m aligned (strict or soft confirm)
> 8. ~~**Structure**: VWAP reclaim or tap~~ (relaxed - not required)
> 9. ~~**Liquidity**: Stop sweep~~ (DISABLED for READY)
> 10. ~~**Market**: BTC supportive~~ (DISABLED for READY)
> 11. **Candle**: Bullish, body ≥ max(ATR×0.4, 0.8%), close upper 60%, wick ≤ 40%
> 12. **Math**: R:R ≥ 1.35, risk% ≥ 0.25

> A **BEST_ENTRY** is a READY signal with:
> - Tighter RSI (55-72)
> - Larger body (ATR×0.8 or 1.5%)
> - **Liquidity sweep required**
> - **BTC explicitly bullish**
> - R:R ≥ 2.0

---

## 9. Universe Filters

| Filter | Value | Purpose |
|--------|-------|---------|
| Top symbols only | `INCLUDE_NON_TOP=false` | No low-cap bleeders |
| Extra symbols | `EXTRA_USDT_COUNT=0` | Disable extras |
| Min price | `MIN_PRICE_USDT=0.001` | Filter dust |
| Quote volume | `MIN_QUOTE_USDT=5000000` (5M USDT) | Liquidity requirement |

---

## 10. Choke Points (Why Signals Fail)

| Fail Reason | Symptom | Fix |
|-------------|---------|-----|
| `precheck` | Price too far from VWAP or RSI outside 20-85 | Check `PRECHECK_VWAP_MAX_PCT` |
| `fail_vwap` | Price > 1.5% from VWAP | Widen `READY_VWAP_MAX_PCT` further |
| `fail_ema` | Price below EMA200 | Wait for reclaim |
| `fail_rsi` | RSI not in 40-76 or falling | Adjust `RSI_READY_MIN/MAX` |
| `fail_vol` | Volume < 1.3x or > 4x | Adjust `THRESHOLD_VOL_SPIKE_X` |
| `confirm15` | 15m not aligned | Check higher timeframe trend |
| `dailyVwap` | Price below daily VWAP | Wait for daily reclaim |
| `reclaimOrTap` | No reclaim pattern | Not required (gate disabled) |
| `readySweep` | No liquidity sweep | Not required for READY (only BEST) |
| `btcOkReady` | BTC regime blocking | Not required for READY (only BEST) |
| `strongBody` | Candle quality poor | Check ATR or lower `READY_BODY_ATR_MULT` |
| `rrOk` | R:R < 1.35 | Widen `READY_MIN_RR` or wait |
| `riskOk` | Risk% < 0.25 | Lower `READY_MIN_RISK_PCT` |

---

## 11. Current Production Env Config (PERMISSIVE)

```ini
# === Database & Core ===
DB_DRIVER="postgres"
SCAN_INTERVAL_MS="90000"
DEBUG_ENDPOINTS="false"

# === Universe Filters ===
SESSION_FILTER_ENABLED="false"
INCLUDE_NON_TOP="false"
EXTRA_USDT_COUNT="0"
MIN_PRICE_USDT="0.001"

# === Precheck (Early Filter) ===
PRECHECK_EMA_SOFT_PCT="0.5"
PRECHECK_VWAP_MAX_PCT="5.0"
RSI_PRECHECK_MIN="20"
RSI_PRECHECK_MAX="85"

# === RSI Bands ===
RSI_EARLY_MIN="30"
RSI_EARLY_MAX="90"
RSI_READY_MIN="40"
RSI_READY_MAX="76"
RSI_BEST_MIN="55"
RSI_BEST_MAX="72"
RSI_DELTA_STRICT="0.20"

# === VWAP Configuration (RELAXED) ===
READY_VWAP_MAX_PCT="1.50"
READY_VWAP_EPS_PCT="0.12"
READY_VWAP_TOUCH_PCT="0.50"
READY_VWAP_TOUCH_BARS="10"
CONFIRM15_VWAP_EPS_PCT="0.15"
CONFIRM15_VWAP_ROLL_BARS="96"
READY_REQUIRE_DAILY_VWAP="true"

# === Volume ===
THRESHOLD_VOL_SPIKE_X="1.3"
READY_VOL_SPIKE_MAX="4.0"
READY_VOL_SPIKE_REQUIRED="true"

# === Body Quality (ATR-Relative - NEW) ===
READY_BODY_ATR_MULT="0.40"
READY_BODY_MIN_PCT="0.008"
BEST_BODY_ATR_MULT="0.80"
BEST_BODY_MIN_PCT="0.015"
READY_CLOSE_POS_MIN="0.60"
READY_UPPER_WICK_MAX="0.40"

# === Sweep Detection ===
READY_SWEEP_REQUIRED="false"      # DISABLED for READY
SWEEP_MIN_DEPTH_ATR_MULT="0.25"   # Relaxed from 0.35
SWEEP_MAX_DEPTH_CAP="0.25"
LIQ_LOOKBACK="20"

# === Market Quality ===
MIN_ATR_PCT_PRECHECK="0.20"

# === Risk Management ===
READY_MIN_RR="1.35"
READY_MIN_RISK_PCT="0.25"
STOP_ATR_FLOOR_MULT="1.2"

# === Trend & BTC ===
READY_TREND_REQUIRED="true"
READY_BTC_REQUIRED="false"        # DISABLED for READY
BEST_BTC_REQUIRED="true"          # Still required for BEST

# === Reclaim Gate (DISABLED) ===
READY_RECLAIM_REQUIRED="false"

# === Outcome Config ===
OUTCOME_EXPIRE_AFTER_15M="12"

# === No-Lookahead Safety ===
CLOCK_SKEW_MS="800"
STRICT_NO_LOOKAHEAD="true"
NO_LOOKAHEAD_LOG="true"
NO_LOOKAHEAD_LOG_BUDGET="100"

# === Data Retention ===
CANDIDATE_FEATURES_MAX_ROWS="5000"

# === Logging ===
SIGNAL_LOG_CATS="BEST_ENTRY,READY_TO_BUY"
```

---

## 12. Audit Checklist (Quick Reference - PERMISSIVE)

```
□ Precheck: Price within 5% VWAP, RSI 20-85, ATR ≥0.2%
□ Trend: EMA50 > EMA200, both rising
□ VWAP: |Price-VWAP| ≤1.5%, touched in last 10 bars (0.50% tol)
□ RSI: 40-76 with delta ≥0.20
□ Volume: 1.3x-4.0x (required)
□ Daily: Price > daily VWAP
□ Confirm15: Strict OR soft (0.15% eps)
□ Reclaim/Tap: Optional (gate disabled)
□ Sweep: Optional for READY (required for BEST)
□ BTC: Optional for READY (required for BEST)
□ Body: ≥max(ATR×0.4, 0.8%), close upper 60%, wick ≤40%
□ R:R: ≥1.35
□ Risk%: ≥0.25
```

---

## 13. Key Changes from v1.1.0 → v1.2.0

| Gate | v1.1.0 | v1.2.0 (Current) | Impact |
|------|--------|------------------|--------|
| VWAP Window | 1.0% | **1.5%** | +50% more candidates |
| VWAP Touch Bars | 5 | **10** | Double lookback period |
| VWAP Touch Tolerance | 0.20% | **0.50%** | 2.5x more permissive |
| Reclaim Required | true | **false** | Gate removed |
| Sweep Required (READY) | true | **false** | Gate removed |
| BTC Required (READY) | true | **false** | Gate removed |
| Body Sizing | Static 6% | **ATR-relative** | Dynamic with volatility |
| Close Position Min | 62% | **60%** | Slightly relaxed |
| Upper Wick Max | 35% | **40%** | Slightly relaxed |
| Sweep Depth Mult | 0.35 | **0.25** | Shallower sweeps count |

**Expected Signal Volume**: 1-5/day → **10-20/day**

---

*Spec version: 1.2.0-production-permissive*  
*Updated: 2026-02-15*  
*Source: Railway production env, `backend/src/logic.ts`*
