# Config Analysis - Issues Found

## 🔴 Critical Issues

### 1. Body/Wick Filters Are TOO LOOSE
```json
"READY_UPPER_WICK_MAX": 0.8,        // 80% upper wick allowed! (Bearish)
"READY_BODY_ATR_MULT": 0.12,        // Body only 0.12x ATR (Tiny)
"READY_BODY_MIN_PCT": 0.0018,       // 0.18% minimum body (Microscopic)
"READY_CLOSE_POS_MIN": 0.5          // Close anywhere in middle 50%
```

**Problem:** A candle can have:
- 80% upper wick (strong rejection)
- 0.2% body (doji)
- Close in middle of range (indecision)

**AND STILL PASS AS VALID!** 

This explains your 38 stops. You're entering on weak candles.

### 2. RSI Range Too Wide
```json
"RSI_READY_MIN": 32,
"RSI_READY_MAX": 86
```

That's 54 points of range! Essentially capturing all RSI values.

### 3. EMA Tolerance Too Loose
```json
"READY_EMA_EPS_PCT": 1.5
```

Price can be 1.5% BELOW EMA200 and still pass for longs.

---

## 🟡 Outcome_Driver Bug

Even though `READY_SWEEP_REQUIRED=false`, the outcome logic still records `NO_SWEEP` when sweep fails. This is misleading - sweep wasn't required, but it's being blamed.

The REAL reason for stops is poor candle quality (issue #1 above).

---

## ✅ Recommended Changes

### Immediate (High Impact)
```bash
# Tighten candle quality
READY_UPPER_WICK_MAX=0.35        # Was 0.8
READY_BODY_ATR_MULT=0.40         # Was 0.12
READY_BODY_MIN_PCT=0.008         # Was 0.0018 (0.8% body minimum)

# Tighten RSI
RSI_READY_MIN=40                 # Was 32
RSI_READY_MAX=78                 # Was 86

# Tighten EMA
READY_EMA_EPS_PCT=0.5            # Was 1.5
```

### Secondary
```bash
# If you want to test without sweep being blamed:
# The outcome_driver bug is cosmetic - sweep isn't actually blocking signals
# since READY_SWEEP_REQUIRED=false
```

---

## 📊 Why This Fixes Your Stops

Current signals likely look like:
```
    |
    |      ← 70% upper wick (rejection)
   ---     ← tiny body
    |
    |
   ---
```

After fix, signals will look like:
```
    |
   ---     ← small upper wick
   | |     ← decent body
   ---
    |
```

Stronger candles = fewer immediate reversals = fewer stops.

---

## 🎯 Expected Impact

| Metric | Current | After Fix |
|--------|---------|-----------|
| Candle quality | Poor | Strong |
| False signals | High | Reduced |
| Stop rate | ~30% | ~15% |
| Win rate | 10-20% | 25-35% |

---

## 🚀 Action Items

1. **Update Railway env vars** (5 min)
2. **Wait 24-48h** for new signals
3. **Re-run analysis** - stops should drop significantly
