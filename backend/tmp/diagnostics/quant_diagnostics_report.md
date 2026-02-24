# Quant Strategy Diagnostic Report

## 1. Live Data Verification

- **Database Host:** [RAILWAY-PROD]
- **Database Name:** railway
- **Latest Signal Timestamp:** 2026-02-21T01:00:00.000Z
- **Total Signals Queried:** 39
- **Tables Queried:** signals, extended_outcomes

## 2. Strategy Diagnostic Summary

### Official Outcomes (24h)
- Total Signals: 38
- Completed: 31
- Pending: 7
- WIN TP2: 13
- WIN TP1: 2
- LOSS STOP: 16
- FLAT TIMEOUT: 0
- Official Win Rate: 48.4%
- Official Stop Rate: 51.6%

### Managed Outcomes (Option B)
- Total Closed: 27
- Managed Avg R/trade: +0.06R
- Managed Net R: +1.64R
- Managed Win Rate: 55.6%
- Stop Before TP1: 12
- TP1 → TP2: 6
- TP1 → BE: 8
- TP1 → Timeout: 1

### Main Leaks
- **Category = READY_TO_BUY**: 16 stops (42.1% stop rate), Avg R: -0.69R
- **Coverage = High (90%+**: 15 stops (41.7% stop rate), Avg R: -0.67R
- **Session = NY**: 9 stops (42.9% stop rate), Avg R: -0.83R
- **RSI = RSI 40-55**: 7 stops (58.3% stop rate), Avg R: -0.79R
- **RSI = RSI 55-70**: 5 stops (62.5% stop rate), Avg R: -1.00R

### Main Strengths
- **Symbol = DOGEUSDT**: Avg R +0.53R, TP2 Rate: 25.0%
- **RSI = RSI 70+**: Avg R +0.43R, TP2 Rate: 53.8%
- **Symbol = BTCUSDT**: Avg R +0.33R, TP2 Rate: 33.3%
- **Symbol = BIOUSDT**: Avg R +0.33R, TP2 Rate: 66.7%
- **Symbol = SUIUSDT**: Avg R +0.13R, TP2 Rate: 25.0%

## 3. Loss Analysis Table

| Dimension | Value | Count | Total Trades | Stop Rate | Net R Damage | Avg R |
|-----------|-------|-------|--------------|-----------|--------------|-------|
| Category | READY_TO_BUY | 16 | 38 | 42.1% | -11.00R | -0.69R |
| Coverage | High (90%+ | 15 | 36 | 41.7% | -10.00R | -0.67R |
| Session | NY | 9 | 21 | 42.9% | -7.50R | -0.83R |
| RSI | RSI 40-55 | 7 | 12 | 58.3% | -5.50R | -0.79R |
| RSI | RSI 55-70 | 5 | 8 | 62.5% | -5.00R | -1.00R |
| Symbol | ENSOUSDT | 3 | 3 | 100.0% | -3.00R | -1.00R |
| Session | London | 4 | 7 | 57.1% | -3.00R | -0.75R |
| Symbol | ARBUSDT | 2 | 4 | 50.0% | -2.00R | -1.00R |
| Symbol | ALLOUSDT | 1 | 1 | 100.0% | -1.00R | -1.00R |
| Symbol | BTCUSDT | 1 | 3 | 33.3% | -1.00R | -1.00R |
| Symbol | BIOUSDT | 1 | 3 | 33.3% | -1.00R | -1.00R |
| Symbol | SOLUSDT | 1 | 2 | 50.0% | -1.00R | -1.00R |
| Symbol | INJUSDT | 1 | 2 | 50.0% | -1.00R | -1.00R |
| Symbol | XRPUSDT | 1 | 3 | 33.3% | -1.00R | -1.00R |
| Coverage | Med (70-90%) | 1 | 2 | 50.0% | -1.00R | -1.00R |
| Session | LowLiquidity | 2 | 8 | 25.0% | -0.50R | -0.25R |
| RSI | RSI 70+ | 4 | 16 | 25.0% | -0.50R | -0.13R |
| Symbol | SUIUSDT | 3 | 4 | 75.0% | +0.00R | +0.00R |
| Symbol | DOGEUSDT | 2 | 4 | 50.0% | +0.00R | +0.00R |
| Session | Asia | 1 | 2 | 50.0% | +0.00R | +0.00R |

## 4. Winner Blueprint Table

| Dimension | Value | Count | TP2 Rate | Stop Rate | Avg R | Net R |
|-----------|-------|-------|----------|-----------|-------|-------|
| Symbol | DOGEUSDT | 4 | 25.0% | 50.0% | +0.53R | +2.14R |
| RSI | RSI 70+ | 13 | 53.8% | 30.8% | +0.43R | +5.64R |
| Symbol | BTCUSDT | 3 | 33.3% | 33.3% | +0.33R | +1.00R |
| Symbol | BIOUSDT | 3 | 66.7% | 33.3% | +0.33R | +1.00R |
| Symbol | SUIUSDT | 4 | 25.0% | 75.0% | +0.13R | +0.50R |
| Session | NY | 18 | 38.9% | 50.0% | +0.01R | +0.14R |
| Session | London | 7 | 42.9% | 57.1% | -0.14R | -1.00R |
| RSI | RSI 50-60 | 9 | 33.3% | 66.7% | -0.17R | -1.50R |
| RSI | RSI<50 | 8 | 37.5% | 62.5% | -0.19R | -1.50R |
| Symbol | ENSOUSDT | 3 | 0.0% | 100.0% | -1.00R | -3.00R |

## 5. TP1 vs TP2 Analysis (Almost Good Trades)

| Metric | TP1 Only | TP2 Winners | Delta |
|--------|----------|-------------|-------|
| Count | 4 | 13 | - |
| Avg MFE% | 3.05% | 5.92% | 2.87% |
| Avg MAE% | 1.48% | 2.56% | 1.08% |
| Avg Coverage% | 122.8% | 913.8% | 791.1% |
| Avg Time to TP1 | 712m | - | - |

## 6. Ranked Filter Recommendations

### Rank 1: Volume Spike Filter
- **Filter Rule:** vol_spike >= 1.5
- **Why:** Requires significant volume confirmation for entries
- **Trades Removed:** 27
- **New Managed Avg R:** +0.58R
- **New Managed Net R:** +4.64R
- **New Managed Win Rate:** 87.5%
- **Confidence:** HIGH
- **ENV Mapping:** THRESHOLD_VOL_SPIKE_X=1.5, READY_VOL_SPIKE_REQUIRED=true

## 7. Safe First Changes (Conservative)

These filters are recommended for immediate testing (high confidence, minimal overfitting risk):

1. **Volume Spike Filter** (vol_spike >= 1.5) - Improves Avg R from +0.06R to +0.58R

---
Report generated: 2026-02-21T01:06:26.686Z