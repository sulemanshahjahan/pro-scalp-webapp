# Blacklist vs Whitelist Analysis

## Historical Data Breakdown

### Top 15 Symbols (Trade These)
| Symbol | Trades | Total R | Avg R | Win Rate |
|--------|--------|---------|-------|----------|
| SOLUSDT | 28 | +7.0R | +0.25R | 50% |
| ADAUSDT | 30 | +7.0R | +0.23R | 53% |
| SUIUSDT | 32 | +7.0R | +0.22R | 56% |
| BCHUSDT | 4 | +6.0R | +1.50R | 100% |
| AAVEUSDT | 8 | +6.0R | +0.75R | 75% |
| LINKUSDT | 32 | +4.5R | +0.14R | 47% |
| NEARUSDT | 26 | +4.0R | +0.15R | 46% |
| GIGGLEUSDT | 2 | +3.0R | +1.50R | 100% |
| ACXUSDT | 2 | +3.0R | +1.50R | 100% |
| OPUSDT | 2 | +3.0R | +1.50R | 100% |
| JTOUSDT | 2 | +3.0R | +1.50R | 100% |
| OPNUSDT | 8 | +3.0R | +0.38R | 75% |
| DOTUSDT | 10 | +3.0R | +0.30R | 60% |
| AVAXUSDT | 34 | +2.5R | +0.07R | 44% |
| ZROUSDT | 4 | +2.0R | +0.50R | 50% |

**Subtotal:** 204 trades, +59.5R total

### Bottom 15 Symbols (BLOCK THESE)
| Symbol | Trades | Total R | Avg R | Win Rate |
|--------|--------|---------|-------|----------|
| ZECUSDT | 36 | -12.5R | -0.35R | 36% |
| ENSOUSDT | 14 | -8.0R | -0.57R | 29% |
| ESPUSDT | 6 | -6.0R | -1.00R | 0% |
| PUMPUSDT | 14 | -5.0R | -0.36R | 29% |
| TAOUSDT | 24 | -4.5R | -0.19R | 29% |
| KITEUSDT | 14 | -4.5R | -0.32R | 36% |
| BARDUSDT | 6 | -4.0R | -0.67R | 0% |
| ALLOUSDT | 4 | -4.0R | -1.00R | 0% |
| ARBUSDT | 8 | -3.0R | -0.38R | 25% |
| XPLUSDT | 10 | -3.0R | -0.30R | 40% |
| UNIUSDT | 6 | -3.0R | -0.50R | 33% |
| TRUMPUSDT | 8 | -3.0R | -0.38R | 25% |
| BNBUSDT | 18 | -2.0R | -0.11R | 33% |
| ASTERUSDT | 10 | -2.0R | -0.10R | 40% |
| LTCUSDT | 10 | -2.0R | -0.10R | 40% |

**Subtotal:** 200 trades, -65.5R total

### Middle 20 Symbols (Borderline)
These are break-even or small +/-:
- ETHUSDT: 0R
- BTCUSDT: 0R
- FETUSDT: 0R
- ICPUSDT: 0R
- DOGEUSDT: -0.865R
- XRPUSDT: -1R
- PIXELUSDT: -1R
- WLDUSDT: -1R
- WLFIUSDT: -1R
- ONTUSDT: -2R
- INJUSDT: +1R
- BIOUSDT: +1R
- APTUSDT: +1R
- FILUSDT: +1R
- NIGHTUSDT: +1R

**Subtotal:** ~165 trades, -4.8R total

---

## COMPARISON SUMMARY

### Option A: Whitelist Top 5
- Symbols: 5
- Trades: ~120 (17/month)
- Total R: +33R
- **Monthly: +4.7R**
- Win Rate: ~57%

### Option B: Blacklist Worst 15
- Symbols: ~35 allowed
- Trades: ~369 (53/month)
- Total R: -5.87R + 65.5R = **+59.6R**
- **Monthly: +8.5R**
- Win Rate: ~52%

### Option C: Blacklist Worst 10 + Time Filter
- Symbols: ~40 allowed
- Trades: ~250 (36/month)
- Total R: ~+35R
- **Monthly: +5R**
- Win Rate: ~55%

---

## RECOMMENDATION: BLACKLIST WORST 10

```
SIGNAL_GATE_USE_WHITELIST=false
SIGNAL_GATE_BLOCK_SYMBOLS=ZECUSDT,ENSOUSDT,ESPUSDT,PUMPUSDT,TAOUSDT,KITEUSDT,BARDUSDT,ALLOUSDT,ARBUSDT,XPLUSDT
```

**Why this is best:**
1. **More signals** (~36/month vs 17/month)
2. **Similar profit** (+5R/month)
3. **Less FOMO** - you won't feel like you're missing out
4. **Diversification** - not dependent on just 5 coins

**Plus time filter on best hours:**
- Block: 0,1,3,4,6,9,10,12,13,14,15,16,17,18,19,20,21,22,23
- Trade: 2,5,7,8,11 UTC

**Expected: ~15-20 high-quality signals/month, +5R**
