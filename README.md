# pro-scalp-webapp

**Environment**

**No-Lookahead Guards (Candle Integrity)**
To avoid lookahead from partially-formed candles (and to make historical recompute safe), the scanner + logic enforce closed-candle only.

- `CLOCK_SKEW_MS` (ms): waits after candle close before accepting the latest bar. Default `1500`. Set `0` for fastest acceptance. Negative values are clamped to `0`.
- `STRICT_NO_LOOKAHEAD`: if `true`, throws when data contains candles at/after the entry boundary. Default `false`.
- `NO_LOOKAHEAD_LOG`: if `true`, logs only when trimming removes candles. Default `false`.
- `NO_LOOKAHEAD_LOG_BUDGET`: cap on trim logs before silence. Default `0` (unlimited). Example `50`.

**READY Filters**
- `READY_MIN_RISK_PCT`: minimum risk% (entry-stop)/entry*100 required for READY signals. Default `0` (disabled).
- `READY_VOL_SPIKE_MAX`: maximum volume spike allowed for READY signals. Default unset (disabled).

**Stops**
- `STOP_ATR_FLOOR_MULT`: minimum ATR multiple used as a floor for swing-low stops (prevents micro-stops). Default `1.0`.
- `STOP_ATR_MULT`: ATR multiple for ATR-based fallback stop. Default `1.5`.

**Tuning Bundle Automation**
Generate a periodic “tuning bundle” (JSON + Markdown) for monitoring outcomes.

- `TUNING_BUNDLE_RETENTION_DAYS`: how long to keep bundles. Default `14`.
- `TUNING_HOURS`: default analysis window in hours. Default `6`.
- `TUNING_LIMIT`: max outcomes sampled. Default `200`.
- `TUNING_CATEGORIES`: categories included. Default `READY_TO_BUY,BEST_ENTRY`.
- `TUNING_RESULTS`: results filtered for samples. Default `STOP,TIMEOUT`.
- `TUNING_SYMBOL_LIMIT`: sample rows to include. Default `10`.

Run manually:
`npm --prefix backend run tuning:bundle -- --hours=6`

**Env Snapshots (User-Provided)**
```env
previous logic:
DATABASE_URL="<redacted>"
DB_DRIVER="postgres"
SCAN_INTERVAL_MS="90000"
SESSION_FILTER_ENABLED="false"
SIGNAL_LOG_CATS="BEST_ENTRY,READY_TO_BUY"
PRECHECK_EMA_SOFT_PCT="100"
PRECHECK_VWAP_MAX_PCT="100"
RSI_PRECHECK_MIN="0"
RSI_PRECHECK_MAX="100"
RSI_EARLY_MIN="30"
RSI_EARLY_MAX="90"
READY_BTC_REQUIRED="false"
READY_CONFIRM15_REQUIRED="true"
READY_VOL_SPIKE_REQUIRED="false"
READY_SWEEP_REQUIRED="false"
CONFIRM15_VWAP_EPS_PCT="0.30"
CONFIRM15_VWAP_ROLL_BARS="96"
CLOCK_SKEW_MS="1500"
STRICT_NO_LOOKAHEAD="false"
NO_LOOKAHEAD_LOG="false"
NO_LOOKAHEAD_LOG_BUDGET="0"
READY_TREND_REQUIRED="true"
READY_RECLAIM_REQUIRED="true"
READY_VWAP_MAX_PCT="0.40"
THRESHOLD_VOL_SPIKE_X="1.6"
READY_BODY_PCT="0.09"
READY_CLOSE_POS_MIN="0.64"
READY_UPPER_WICK_MAX="0.35"
RSI_DELTA_STRICT="0.25"
RSI_READY_MIN="42"
RSI_READY_MAX="78"
READY_MIN_RR="1.0"
READY_MIN_RISK_PCT="0"
READY_VOL_SPIKE_MAX="2.5"
STOP_ATR_FLOOR_MULT="1.0"

current logic:
DATABASE_URL="<redacted>"
DB_DRIVER="postgres"
SCAN_INTERVAL_MS="90000"
SESSION_FILTER_ENABLED="false"
SIGNAL_LOG_CATS="BEST_ENTRY,READY_TO_BUY"
PRECHECK_EMA_SOFT_PCT="100"
PRECHECK_VWAP_MAX_PCT="100"
RSI_PRECHECK_MIN="0"
RSI_PRECHECK_MAX="100"
RSI_EARLY_MIN="30"
RSI_EARLY_MAX="90"
READY_BTC_REQUIRED="false"
READY_CONFIRM15_REQUIRED="true"
READY_VOL_SPIKE_REQUIRED="false"
READY_SWEEP_REQUIRED="false"
CONFIRM15_VWAP_EPS_PCT="0.30"
CONFIRM15_VWAP_ROLL_BARS="96"
CLOCK_SKEW_MS="1500"
STRICT_NO_LOOKAHEAD="false"
NO_LOOKAHEAD_LOG="false"
NO_LOOKAHEAD_LOG_BUDGET="0"
READY_TREND_REQUIRED="true"
READY_RECLAIM_REQUIRED="true"
READY_VWAP_MAX_PCT="0.90"
THRESHOLD_VOL_SPIKE_X="1.6"
READY_BODY_PCT="0.06"
READY_CLOSE_POS_MIN="0.55"
READY_UPPER_WICK_MAX="0.48"
RSI_DELTA_STRICT="0.20"
RSI_READY_MIN="40"
RSI_READY_MAX="82"
READY_MIN_RR="1.35"
READY_MIN_RISK_PCT="0"
READY_VOL_SPIKE_MAX="3.5"
STOP_ATR_FLOOR_MULT="1.0"
READY_VWAP_EPS_PCT="0.25"

current logic:
{
  "READY_BTC_REQUIRED": false,
  "READY_CONFIRM15_REQUIRED": true,
  "READY_VOL_SPIKE_REQUIRED": false,
  "READY_SWEEP_REQUIRED": false,
  "READY_TREND_REQUIRED": true,
  "READY_RECLAIM_REQUIRED": true,
  "READY_VWAP_MAX_PCT": 0.90,
  "READY_VWAP_EPS_PCT": 0.25,
  "READY_BODY_PCT": 0.06,
  "READY_CLOSE_POS_MIN": 0.55,
  "READY_UPPER_WICK_MAX": 0.48,
  "RSI_READY_MIN": 40,
  "RSI_READY_MAX": 82,
  "RSI_DELTA_STRICT": 0.20,
  "READY_MIN_RR": 1.35,
  "READY_MIN_RISK_PCT": 0,
  "READY_VOL_SPIKE_MAX": 3.5
}
```
