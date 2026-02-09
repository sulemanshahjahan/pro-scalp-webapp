# pro-scalp-webapp

**Environment**

**No-Lookahead Guards (Candle Integrity)**
To avoid lookahead from partially-formed candles (and to make historical recompute safe), the scanner + logic enforce closed-candle only.

- `CLOCK_SKEW_MS` (ms): waits after candle close before accepting the latest bar. Default `1500`. Set `0` for fastest acceptance. Negative values are clamped to `0`.
- `STRICT_NO_LOOKAHEAD`: if `true`, throws when data contains candles at/after the entry boundary. Default `false`.
- `NO_LOOKAHEAD_LOG`: if `true`, logs only when trimming removes candles. Default `false`.
- `NO_LOOKAHEAD_LOG_BUDGET`: cap on trim logs before silence. Default `0` (unlimited). Example `50`.

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
