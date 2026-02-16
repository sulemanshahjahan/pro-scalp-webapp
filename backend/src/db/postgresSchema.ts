export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_guard (
  key TEXT PRIMARY KEY,
  last_sent_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
);

CREATE TABLE IF NOT EXISTS user_prefs (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,
  min_quote_volume DOUBLE PRECISION DEFAULT 50000000,
  vwap_distance_pct DOUBLE PRECISION DEFAULT 0.3,
  vol_spike_x DOUBLE PRECISION DEFAULT 1.5,
  atr_guard_pct DOUBLE PRECISION DEFAULT 2.0,
  only_best_entry INTEGER DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
);

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL,
  time BIGINT NOT NULL,
  preset TEXT,
  strategy_version TEXT,
  threshold_vwap_distance_pct DOUBLE PRECISION,
  threshold_vol_spike_x DOUBLE PRECISION,
  threshold_atr_guard_pct DOUBLE PRECISION,
  entry_time BIGINT NOT NULL DEFAULT 0,
  entry_candle_open_time BIGINT NOT NULL DEFAULT 0,
  entry_rule TEXT NOT NULL DEFAULT 'signal_close',

  price DOUBLE PRECISION NOT NULL,
  vwap DOUBLE PRECISION,
  ema200 DOUBLE PRECISION,
  rsi9 DOUBLE PRECISION,
  volSpike DOUBLE PRECISION,
  atrPct DOUBLE PRECISION,
  confirm15m INTEGER,
  confirm15_strict INTEGER,
  confirm15_soft INTEGER,
  deltaVwapPct DOUBLE PRECISION,

  stop DOUBLE PRECISION,
  tp1 DOUBLE PRECISION,
  tp2 DOUBLE PRECISION,
  target DOUBLE PRECISION,
  rr DOUBLE PRECISION,
  rr_est DOUBLE PRECISION,
  riskPct DOUBLE PRECISION,

  session_ok INTEGER,
  sweep_ok INTEGER,
  trend_ok INTEGER,
  blocked_by_btc INTEGER,
  would_be_category TEXT,
  btc_gate TEXT,
  btc_gate_reason TEXT,
  gate_snapshot_json TEXT,
  ready_debug_json TEXT,
  best_debug_json TEXT,
  entry_debug_json TEXT,
  config_snapshot_json TEXT,
  config_hash TEXT,
  build_git_sha TEXT,
  run_id TEXT,
  instance_id TEXT,
  blocked_reasons_json TEXT,
  first_failed_gate TEXT,
  gate_score INTEGER,

  btc_bull INTEGER,
  btc_bear INTEGER,
  btc_close DOUBLE PRECISION,
  btc_vwap DOUBLE PRECISION,
  btc_ema200 DOUBLE PRECISION,
  btc_rsi DOUBLE PRECISION,
  btc_delta_vwap DOUBLE PRECISION,

  market_json TEXT,
  reasons_json TEXT,

  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,

  UNIQUE(symbol, category, time, config_hash)
);

CREATE TABLE IF NOT EXISTS signal_events (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT,
  run_id TEXT,
  instance_id TEXT,
  symbol TEXT NOT NULL,
  category TEXT NOT NULL,
  time BIGINT NOT NULL,
  preset TEXT,
  config_hash TEXT,
  gate_snapshot_json TEXT,
  ready_debug_json TEXT,
  best_debug_json TEXT,
  entry_debug_json TEXT,
  config_snapshot_json TEXT,
  blocked_reasons_json TEXT,
  first_failed_gate TEXT,
  signal_json TEXT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY(signal_id) REFERENCES signals(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS signal_outcomes (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT NOT NULL,
  horizon_min INTEGER NOT NULL,
  entry_time BIGINT NOT NULL,
  entry_candle_open_time BIGINT NOT NULL,
  entry_rule TEXT NOT NULL,
  start_time BIGINT NOT NULL,
  end_time BIGINT NOT NULL,
  interval_min INTEGER NOT NULL,
  n_candles INTEGER NOT NULL,
  n_candles_expected INTEGER NOT NULL DEFAULT 0,
  coverage_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  open_price DOUBLE PRECISION NOT NULL,
  close_price DOUBLE PRECISION NOT NULL,
  max_high DOUBLE PRECISION NOT NULL,
  min_low DOUBLE PRECISION NOT NULL,
  ret_pct DOUBLE PRECISION NOT NULL,
  r_mult DOUBLE PRECISION NOT NULL,
  r_close DOUBLE PRECISION NOT NULL,
  r_mfe DOUBLE PRECISION NOT NULL,
  r_mae DOUBLE PRECISION NOT NULL,
  r_realized DOUBLE PRECISION NOT NULL DEFAULT 0,
  hit_sl INTEGER NOT NULL DEFAULT 0,
  hit_tp1 INTEGER NOT NULL DEFAULT 0,
  hit_tp2 INTEGER NOT NULL DEFAULT 0,
  tp1_hit_time BIGINT NOT NULL DEFAULT 0,
  sl_hit_time BIGINT NOT NULL DEFAULT 0,
  tp2_hit_time BIGINT NOT NULL DEFAULT 0,
  bars_to_exit INTEGER NOT NULL DEFAULT 0,
  time_to_first_hit_ms BIGINT NOT NULL DEFAULT 0,
  mfe_pct DOUBLE PRECISION NOT NULL,
  mae_pct DOUBLE PRECISION NOT NULL,
  result TEXT NOT NULL DEFAULT 'NONE',
  exit_reason TEXT,
  outcome_driver TEXT,
  trade_state TEXT NOT NULL DEFAULT 'PENDING',
  exit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  exit_time BIGINT NOT NULL DEFAULT 0,
  window_status TEXT NOT NULL DEFAULT 'PARTIAL',
  outcome_state TEXT NOT NULL DEFAULT 'PENDING',
  invalid_levels INTEGER NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  expired_after_15m INTEGER NOT NULL DEFAULT 0,
  expired_reason TEXT,
  attempted_at BIGINT NOT NULL DEFAULT 0,
  computed_at BIGINT NOT NULL DEFAULT 0,
  resolved_at BIGINT NOT NULL DEFAULT 0,
  resolve_version TEXT,
  prev_snapshot TEXT,
  outcome_debug_json TEXT,

  UNIQUE(signal_id, horizon_min),
  FOREIGN KEY(signal_id) REFERENCES signals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outcome_skips (
  signal_id BIGINT NOT NULL,
  horizon_min INTEGER NOT NULL,
  reason TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE(signal_id, horizon_min),
  FOREIGN KEY(signal_id) REFERENCES signals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  preset TEXT NOT NULL,
  config_hash TEXT,
  instance_id TEXT,
  status TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  duration_ms BIGINT,
  processed_symbols INTEGER,
  precheck_passed INTEGER,
  fetched_ok INTEGER,
  errors_429 INTEGER,
  errors_other INTEGER,
  signals_by_category_json TEXT,
  gate_stats_json TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS tuning_bundles (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_hours INTEGER NOT NULL,
  window_start_ms BIGINT NOT NULL,
  window_end_ms BIGINT NOT NULL,
  build_git_sha TEXT,
  scan_run_id TEXT,
  payload_json JSONB NOT NULL,
  report_md TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS candidate_features (
  run_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  preset TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metrics JSONB NOT NULL,
  computed JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON scan_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_scan_runs_finished_at ON scan_runs(finished_at);
CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status);
CREATE INDEX IF NOT EXISTS idx_tuning_bundles_created_at ON tuning_bundles(created_at);
CREATE INDEX IF NOT EXISTS idx_tuning_bundles_window_end ON tuning_bundles(window_end_ms);
CREATE INDEX IF NOT EXISTS idx_candidate_features_started_at ON candidate_features(started_at);
CREATE INDEX IF NOT EXISTS idx_candidate_features_created_at ON candidate_features(created_at);
CREATE INDEX IF NOT EXISTS idx_candidate_features_preset ON candidate_features(preset);

ALTER TABLE signals ADD COLUMN IF NOT EXISTS config_hash TEXT;
ALTER TABLE signals ALTER COLUMN config_hash SET DEFAULT 'legacy';
UPDATE signals SET config_hash = 'legacy' WHERE config_hash IS NULL;
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_symbol_category_time_key;
DELETE FROM signals a
USING signals b
WHERE a.id > b.id
  AND a.symbol = b.symbol
  AND a.category = b.category
  AND a.time = b.time
  AND COALESCE(a.config_hash,'') = COALESCE(b.config_hash,'');
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedupe ON signals(symbol, category, time, config_hash);
CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(time);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_category ON signals(category);
CREATE INDEX IF NOT EXISTS idx_signals_preset ON signals(preset);
CREATE INDEX IF NOT EXISTS idx_signals_strategy_version ON signals(strategy_version);
CREATE INDEX IF NOT EXISTS idx_signals_config_hash ON signals(config_hash);
CREATE INDEX IF NOT EXISTS idx_signal_events_run_id ON signal_events(run_id);
CREATE INDEX IF NOT EXISTS idx_signal_events_created_at ON signal_events(created_at);
CREATE INDEX IF NOT EXISTS idx_signal_events_symbol_category_time ON signal_events(symbol, category, time);
CREATE INDEX IF NOT EXISTS idx_signal_events_signal_id ON signal_events(signal_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_signal ON signal_outcomes(signal_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_horizon ON signal_outcomes(horizon_min);
CREATE INDEX IF NOT EXISTS idx_outcomes_window_status ON signal_outcomes(window_status);
CREATE INDEX IF NOT EXISTS idx_outcomes_result ON signal_outcomes(result);
CREATE INDEX IF NOT EXISTS idx_outcomes_resolve_state_horizon ON signal_outcomes(resolve_version, outcome_state, horizon_min);
CREATE INDEX IF NOT EXISTS idx_outcomes_resolved_at ON signal_outcomes(resolved_at);
CREATE INDEX IF NOT EXISTS idx_outcome_skips_signal_horizon ON outcome_skips(signal_id, horizon_min);

-- Backfill columns that were added later (safe if they already exist)
ALTER TABLE signals ADD COLUMN IF NOT EXISTS gate_snapshot_json TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS ready_debug_json TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS best_debug_json TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS entry_debug_json TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS config_snapshot_json TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS build_git_sha TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS instance_id TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS blocked_reasons_json TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS first_failed_gate TEXT;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS gate_score INTEGER;
ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS outcome_debug_json TEXT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS config_hash TEXT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS instance_id TEXT;
CREATE INDEX IF NOT EXISTS idx_scan_runs_config_hash ON scan_runs(config_hash);
CREATE INDEX IF NOT EXISTS idx_scan_runs_instance_id ON scan_runs(instance_id);
CREATE INDEX IF NOT EXISTS idx_signals_instance_id ON signals(instance_id);
UPDATE scan_runs SET config_hash = 'legacy' WHERE config_hash IS NULL OR BTRIM(config_hash) = '';
UPDATE scan_runs SET instance_id = 'legacy' WHERE instance_id IS NULL OR BTRIM(instance_id) = '';
UPDATE signals SET instance_id = 'legacy' WHERE instance_id IS NULL OR BTRIM(instance_id) = '';
`;
