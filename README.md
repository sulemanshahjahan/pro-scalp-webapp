# pro-scalp-webapp

**Environment**

**No-Lookahead Guards (Candle Integrity)**
To avoid lookahead from partially-formed candles (and to make historical recompute safe), the scanner + logic enforce closed-candle only.

- `CLOCK_SKEW_MS` (ms): waits after candle close before accepting the latest bar. Default `1500`. Set `0` for fastest acceptance. Negative values are clamped to `0`.
- `STRICT_NO_LOOKAHEAD`: if `true`, throws when data contains candles at/after the entry boundary. Default `false`.
- `NO_LOOKAHEAD_LOG`: if `true`, logs only when trimming removes candles. Default `false`.
- `NO_LOOKAHEAD_LOG_BUDGET`: cap on trim logs before silence. Default `0` (unlimited). Example `50`.
