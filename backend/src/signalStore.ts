
import type { Signal } from './types.js';
import { klinesFrom } from './binance.js';
import { getDb } from './db/db.js';
import { buildConfigSnapshot, computeConfigHash, parseEnvValue } from './configSnapshot.js';

const OUTCOME_HORIZONS_MIN = [15, 30, 60, 120, 240] as const;
const OUTCOME_GRACE_MS = 2 * 60_000;
const OUTCOME_BATCH = parseInt(process.env.OUTCOME_BATCH || '25', 10);
const OUTCOME_SLEEP_MS = parseInt(process.env.OUTCOME_SLEEP_MS || '120', 10);
const OUTCOME_INTERVAL_MIN = Math.max(1, parseInt(process.env.OUTCOME_INTERVAL_MIN || '5', 10));
const OUTCOME_INTERVAL = `${OUTCOME_INTERVAL_MIN}m`;
const OUTCOME_BUFFER_CANDLES = Math.max(0, parseInt(process.env.OUTCOME_BUFFER_CANDLES || '2', 10));
const OUTCOME_RETRY_AFTER_MS = parseInt(process.env.OUTCOME_RETRY_AFTER_MS || String(10 * 60_000), 10);
const OUTCOME_RETRY_REASONS = ['API_ERROR', 'BAD_ALIGN', 'NO_DATA_IN_WINDOW', 'NOT_ENOUGH_BARS'];
const OUTCOME_RESOLVE_VERSION = process.env.OUTCOME_RESOLVE_VERSION || 'v2';
const OUTCOME_INTEGRITY_MS = parseInt(process.env.OUTCOME_INTEGRITY_MS || '600000', 10); // 10 min
const OUTCOME_INTEGRITY_DAYS = parseInt(process.env.OUTCOME_INTEGRITY_DAYS || '14', 10);
const OUTCOME_EXPIRE_AFTER_15M = (process.env.OUTCOME_EXPIRE_AFTER_15M ?? 'true').toLowerCase() !== 'false';
const ENTRY_DRIFT_ATR = parseFloat(process.env.ENTRY_DRIFT_ATR || '1.0');
const SIGNAL_INTERVAL_MIN = Math.max(1, parseInt(process.env.SIGNAL_INTERVAL_MIN || '5', 10));
const ENTRY_RULE = process.env.ENTRY_RULE || 'signal_close';
const FEE_BPS = parseFloat(process.env.FEE_BPS || '5');
const SLIPPAGE_BPS = parseFloat(process.env.SLIPPAGE_BPS || '2');
const MIN_RISK_PCT = parseFloat(process.env.MIN_RISK_PCT || '0.2');
const OUTCOME_MIN_COVERAGE_PCT = Math.min(100, Math.max(50, parseFloat(process.env.OUTCOME_MIN_COVERAGE_PCT || '95')));
const STRATEGY_VERSION = process.env.STRATEGY_VERSION || 'v1.0.0';
const ENABLE_TIME_SHIFT = (process.env.MIGRATE_SHIFT_TIME_CLOSE ?? 'false').toLowerCase() === 'true';

const SIGNAL_LOG_CATS = (process.env.SIGNAL_LOG_CATS || 'BEST_ENTRY,READY_TO_BUY')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const BUILD_GIT_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_SHA ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  null;
const INSTANCE_ID = String(
  process.env.INSTANCE_ID ||
  process.env.RAILWAY_REPLICA_ID ||
  process.env.HOSTNAME ||
  'unknown'
).trim() || 'unknown';


function buildReadyDebugSnapshot(sig: Signal) {
  const vwap = Number.isFinite(sig.vwap as number) ? Number(sig.vwap) : null;
  const ema200 = Number.isFinite(sig.ema200 as number) ? Number(sig.ema200) : null;
  const price = Number.isFinite(sig.price as number) ? Number(sig.price) : null;
  const vwapDistPct = (price != null && vwap) ? ((price - vwap) / vwap) * 100 : null;
  const emaDistPct = (price != null && ema200) ? ((price - ema200) / ema200) * 100 : null;
  return {
    ...(sig.readyDebug ?? {}),
    metrics: {
      price,
      vwap,
      vwapDistPct,
      ema200,
      emaDistPct,
      rsi9: sig.rsi9 ?? null,
      atrPct: sig.atrPct ?? null,
      volSpike: sig.volSpike ?? null,
    },
    confirm15: {
      strict: sig.confirm15mStrict ?? null,
      soft: sig.confirm15mSoft ?? null,
      used: sig.confirm15mStrict ? 'strict' : sig.confirm15mSoft ? 'soft' : 'none',
      vwapEpsPct: parseEnvValue(String(process.env.CONFIRM15_VWAP_EPS_PCT ?? '0.20')),
      rollBars: parseEnvValue(String(process.env.CONFIRM15_VWAP_ROLL_BARS ?? '96')),
    },
  };
}

function buildBestDebugSnapshot(sig: Signal) {
  const vwap = Number.isFinite(sig.vwap as number) ? Number(sig.vwap) : null;
  const ema200 = Number.isFinite(sig.ema200 as number) ? Number(sig.ema200) : null;
  const price = Number.isFinite(sig.price as number) ? Number(sig.price) : null;
  const vwapDistPct = (price != null && vwap) ? ((price - vwap) / vwap) * 100 : null;
  const emaDistPct = (price != null && ema200) ? ((price - ema200) / ema200) * 100 : null;
  return {
    ...(sig.bestDebug ?? {}),
    metrics: {
      price,
      vwap,
      vwapDistPct,
      ema200,
      emaDistPct,
      rsi9: sig.rsi9 ?? null,
      atrPct: sig.atrPct ?? null,
      volSpike: sig.volSpike ?? null,
      rr: sig.rr ?? null,
    },
    confirm15: {
      strict: sig.confirm15mStrict ?? null,
      soft: sig.confirm15mSoft ?? null,
      used: sig.confirm15mStrict ? 'strict' : sig.confirm15mSoft ? 'soft' : 'none',
      vwapEpsPct: parseEnvValue(String(process.env.CONFIRM15_VWAP_EPS_PCT ?? '0.20')),
      rollBars: parseEnvValue(String(process.env.CONFIRM15_VWAP_ROLL_BARS ?? '96')),
    },
  };
}

function buildEntrySnapshot(params: {
  sig: Signal;
  preset: string | null | undefined;
  entryTimeAligned: number;
  entryRule: string;
  entryCandleOpenTime: number;
  configSnapshot?: any;
  configHash?: string | null;
}) {
  const { sig, preset, entryTimeAligned, entryRule, entryCandleOpenTime } = params;
  const configSnapshot = params.configSnapshot ?? buildConfigSnapshot({
    preset: preset ?? sig.preset ?? null,
    thresholds: {
      vwapDistancePct: sig.thresholdVwapDistancePct ?? null,
      volSpikeX: sig.thresholdVolSpikeX ?? null,
      atrGuardPct: sig.thresholdAtrGuardPct ?? null,
    },
    buildGitSha: BUILD_GIT_SHA,
  });
  const configHash = params.configHash ?? computeConfigHash(configSnapshot);
  return {
    version: sig.strategyVersion ?? STRATEGY_VERSION,
    build: { gitSha: BUILD_GIT_SHA },
    runId: sig.runId ?? null,
    instanceId: sig.instanceId ?? null,
    preset: preset ?? sig.preset ?? null,
    entry: {
      time: entryTimeAligned,
      candleOpenTime: entryCandleOpenTime,
      rule: entryRule,
      price: sig.price,
    },
    config: configSnapshot,
    configHash,
    metrics: {
      price: sig.price,
      vwap5: sig.vwap ?? null,
      ema200_5: sig.ema200 ?? null,
      rsi9_5: sig.rsi9 ?? null,
      atrPct: sig.atrPct ?? null,
      volSpike: sig.volSpike ?? null,
      rr: sig.rr ?? null,
      deltaVwapPct: sig.deltaVwapPct ?? null,
    },
    confirm15: {
      strict: sig.confirm15mStrict ?? null,
      soft: sig.confirm15mSoft ?? null,
      used: sig.confirm15mStrict ? 'strict' : sig.confirm15mSoft ? 'soft' : 'none',
      vwapEpsPct: parseEnvValue(String(process.env.CONFIRM15_VWAP_EPS_PCT ?? '0.20')),
      rollBars: parseEnvValue(String(process.env.CONFIRM15_VWAP_ROLL_BARS ?? '96')),
    },
    gates: sig.gateSnapshot ?? null,
    firstFailedGate: sig.firstFailedGate ?? null,
    blockedReasons: sig.blockedReasons ?? [],
  };
}

let schemaReady = false;

async function ensureSchema() {
  const d = getDb();
  if (d.driver != 'sqlite') return;
  if (schemaReady) return;
  await d.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS outcome_skips (
      signal_id INTEGER NOT NULL,
      horizon_min INTEGER NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(signal_id, horizon_min),
      FOREIGN KEY(signal_id) REFERENCES signals(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      category TEXT NOT NULL,
      time INTEGER NOT NULL,
      preset TEXT,
      strategy_version TEXT,
      threshold_vwap_distance_pct REAL,
      threshold_vol_spike_x REAL,
      threshold_atr_guard_pct REAL,
      entry_time INTEGER NOT NULL DEFAULT 0,
      entry_candle_open_time INTEGER NOT NULL DEFAULT 0,
      entry_rule TEXT NOT NULL DEFAULT 'signal_close',

      price REAL NOT NULL,
      vwap REAL,
      ema200 REAL,
      rsi9 REAL,
      volSpike REAL,
      atrPct REAL,
      confirm15m INTEGER,
      confirm15_strict INTEGER,
      confirm15_soft INTEGER,
      deltaVwapPct REAL,

      stop REAL,
      tp1 REAL,
      tp2 REAL,
      target REAL,
      rr REAL,
      rr_est REAL,
      riskPct REAL,

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
      btc_close REAL,
      btc_vwap REAL,
      btc_ema200 REAL,
      btc_rsi REAL,
      btc_delta_vwap REAL,

      market_json TEXT,
      reasons_json TEXT,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,

      UNIQUE(symbol, category, time)
    );

    CREATE TABLE IF NOT EXISTS signal_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL,
      horizon_min INTEGER NOT NULL,
      entry_time INTEGER NOT NULL,
      entry_candle_open_time INTEGER NOT NULL,
      entry_rule TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      interval_min INTEGER NOT NULL,
      n_candles INTEGER NOT NULL,
      n_candles_expected INTEGER NOT NULL DEFAULT 0,
      coverage_pct REAL NOT NULL DEFAULT 0,
      entry_price REAL NOT NULL DEFAULT 0,
      open_price REAL NOT NULL,
      close_price REAL NOT NULL,
      max_high REAL NOT NULL,
      min_low REAL NOT NULL,
      ret_pct REAL NOT NULL,
      r_mult REAL NOT NULL,
      r_close REAL NOT NULL,
      r_mfe REAL NOT NULL,
      r_mae REAL NOT NULL,
      r_realized REAL NOT NULL DEFAULT 0,
      hit_sl INTEGER NOT NULL DEFAULT 0,
      hit_tp1 INTEGER NOT NULL DEFAULT 0,
      hit_tp2 INTEGER NOT NULL DEFAULT 0,
      tp1_hit_time INTEGER NOT NULL DEFAULT 0,
      sl_hit_time INTEGER NOT NULL DEFAULT 0,
      tp2_hit_time INTEGER NOT NULL DEFAULT 0,
      bars_to_exit INTEGER NOT NULL DEFAULT 0,
      time_to_first_hit_ms INTEGER NOT NULL DEFAULT 0,
      mfe_pct REAL NOT NULL,
      mae_pct REAL NOT NULL,
      result TEXT NOT NULL DEFAULT 'NONE',
      exit_reason TEXT,
      outcome_driver TEXT,
      trade_state TEXT NOT NULL DEFAULT 'PENDING',
      exit_price REAL NOT NULL DEFAULT 0,
      exit_time INTEGER NOT NULL DEFAULT 0,
      window_status TEXT NOT NULL DEFAULT 'PARTIAL',
      outcome_state TEXT NOT NULL DEFAULT 'PENDING',
      invalid_levels INTEGER NOT NULL DEFAULT 0,
      invalid_reason TEXT,
      ambiguous INTEGER NOT NULL DEFAULT 0,
      expired_after_15m INTEGER NOT NULL DEFAULT 0,
      expired_reason TEXT,
      attempted_at INTEGER NOT NULL DEFAULT 0,
      computed_at INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER NOT NULL DEFAULT 0,
      resolve_version TEXT,
      prev_snapshot TEXT,
      outcome_debug_json TEXT,

      UNIQUE(signal_id, horizon_min),
      FOREIGN KEY(signal_id) REFERENCES signals(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(time);
    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_signals_category ON signals(category);
    CREATE INDEX IF NOT EXISTS idx_signals_preset ON signals(preset);
    CREATE INDEX IF NOT EXISTS idx_signals_strategy_version ON signals(strategy_version);
    CREATE INDEX IF NOT EXISTS idx_signals_config_hash ON signals(config_hash);
    CREATE INDEX IF NOT EXISTS idx_outcomes_signal ON signal_outcomes(signal_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_horizon ON signal_outcomes(horizon_min);
    CREATE INDEX IF NOT EXISTS idx_outcomes_window_status ON signal_outcomes(window_status);
    CREATE INDEX IF NOT EXISTS idx_outcomes_result ON signal_outcomes(result);
    CREATE INDEX IF NOT EXISTS idx_outcomes_resolve_state_horizon ON signal_outcomes(resolve_version, outcome_state, horizon_min);
    CREATE INDEX IF NOT EXISTS idx_outcomes_resolved_at ON signal_outcomes(resolved_at);
  `);

  try {
    await d.exec(`
      DELETE FROM signals
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM signals
        GROUP BY symbol, category, time, COALESCE(config_hash, '')
      )
    `);
  } catch {}
  try { await d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedupe ON signals(symbol, category, time, config_hash)`); } catch {}

  schemaReady = true;

  // Backfill for older DBs
  try { await d.exec(`ALTER TABLE signals ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`UPDATE signals SET updated_at = created_at WHERE updated_at = 0`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN tp1 REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN tp2 REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN entry_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN entry_candle_open_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN entry_rule TEXT NOT NULL DEFAULT 'signal_close'`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN strategy_version TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN threshold_vwap_distance_pct REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN threshold_vol_spike_x REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN threshold_atr_guard_pct REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN confirm15_strict INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN confirm15_soft INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN session_ok INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN sweep_ok INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN trend_ok INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN rr_est REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN blocked_by_btc INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN would_be_category TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_gate TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_gate_reason TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN gate_snapshot_json TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN ready_debug_json TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN best_debug_json TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN entry_debug_json TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN config_snapshot_json TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN config_hash TEXT`); } catch {}
  try { await d.exec(`UPDATE signals SET config_hash = 'legacy' WHERE config_hash IS NULL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN build_git_sha TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN run_id TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN instance_id TEXT`); } catch {}
  try { await d.exec(`UPDATE signals SET instance_id = 'legacy' WHERE instance_id IS NULL OR trim(instance_id) = ''`); } catch {}
  try { await d.exec(`CREATE INDEX IF NOT EXISTS idx_signals_instance_id ON signals(instance_id)`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN blocked_reasons_json TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN first_failed_gate TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN gate_score INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_bull INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_bear INTEGER`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_close REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_vwap REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_ema200 REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_rsi REAL`); } catch {}
  try { await d.exec(`ALTER TABLE signals ADD COLUMN btc_delta_vwap REAL`); } catch {}
  try { await d.exec(`UPDATE signals SET entry_time = time WHERE entry_time = 0`); } catch {}
  try { await d.exec(`UPDATE signals SET entry_candle_open_time = entry_time WHERE entry_candle_open_time = 0`); } catch {}

  // Outcomes audit columns
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN start_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN open_price REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN mfe_pct REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN mae_pct REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN entry_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN entry_candle_open_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN entry_rule TEXT NOT NULL DEFAULT 'signal_close'`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN interval_min INTEGER NOT NULL DEFAULT 1`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN n_candles INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN n_candles_expected INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN coverage_pct REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN entry_price REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN r_close REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN r_mfe REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN r_mae REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN r_realized REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN result TEXT NOT NULL DEFAULT 'NONE'`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN exit_reason TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN outcome_driver TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN trade_state TEXT NOT NULL DEFAULT 'PENDING'`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN exit_price REAL NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN exit_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN window_status TEXT NOT NULL DEFAULT 'PARTIAL'`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN outcome_state TEXT NOT NULL DEFAULT 'PENDING'`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN invalid_levels INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN invalid_reason TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN ambiguous INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN expired_after_15m INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN expired_reason TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN attempted_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN tp1_hit_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN sl_hit_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN tp2_hit_time INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN bars_to_exit INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN time_to_first_hit_ms INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN resolved_at INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN resolve_version TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN prev_snapshot TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE signal_outcomes ADD COLUMN outcome_debug_json TEXT`); } catch {}

  // Ensure flags are never NULL
  try { await d.exec(`UPDATE signal_outcomes SET hit_sl = 0 WHERE hit_sl IS NULL`); } catch {}
  try { await d.exec(`UPDATE signal_outcomes SET hit_tp1 = 0 WHERE hit_tp1 IS NULL`); } catch {}
  try { await d.exec(`UPDATE signal_outcomes SET hit_tp2 = 0 WHERE hit_tp2 IS NULL`); } catch {}
  try { await d.exec(`UPDATE signal_outcomes SET r_close = r_mult WHERE r_close = 0 AND r_mult != 0`); } catch {}
  try { await d.exec(`UPDATE signal_outcomes SET window_status = 'PARTIAL' WHERE window_status IN ('INCOMPLETE', 'PENDING')`); } catch {}
  try { await d.exec(`UPDATE signal_outcomes SET computed_at = 0 WHERE window_status = 'PARTIAL'`); } catch {}
  try { await d.exec(`UPDATE signal_outcomes SET attempted_at = computed_at WHERE attempted_at = 0 AND computed_at > 0`); } catch {}

  // One-time migration: force recompute with new outcome logic
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('outcome_logic_v4') as { value?: string } | undefined;
    if (!row?.value) {
      await d.prepare(`
        UPDATE signal_outcomes
        SET window_status = 'PARTIAL',
            trade_state = 'PENDING',
            result = 'NONE',
            hit_sl = 0,
            hit_tp1 = 0,
            hit_tp2 = 0,
            invalid_levels = 0,
            r_close = 0,
            r_mfe = 0,
            r_mae = 0,
            invalid_reason = NULL,
            attempted_at = 0,
            computed_at = 0
      `).run();
      await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('outcome_logic_v4', String(Date.now()));
    }
  } catch {}

  // One-time migration: reset stuck FUTURE_WINDOW invalids back to PARTIAL
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('outcome_logic_v5') as { value?: string } | undefined;
    if (!row?.value) {
      await d.prepare(`
        UPDATE signal_outcomes
        SET window_status = 'PARTIAL',
            invalid_reason = NULL,
            attempted_at = 0,
            computed_at = 0
        WHERE window_status = 'INVALID'
          AND invalid_reason = 'FUTURE_WINDOW'
      `).run();
      await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('outcome_logic_v5', String(Date.now()));
    }
  } catch {}

  // One-time migration: force recompute with outcome logic v6
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('outcome_logic_v6') as { value?: string } | undefined;
    if (!row?.value) {
      await d.prepare(`
        UPDATE signal_outcomes
        SET window_status = 'PARTIAL',
            invalid_reason = 'STALE_LOGIC',
            attempted_at = 0,
            computed_at = 0,
            result = 'NONE',
            exit_reason = NULL,
            hit_sl = 0,
            hit_tp1 = 0,
            hit_tp2 = 0,
            tp1_hit_time = 0,
            sl_hit_time = 0,
            time_to_first_hit_ms = 0,
            r_close = 0,
            r_mfe = 0,
            r_mae = 0,
            r_realized = 0,
            ret_pct = 0,
            mfe_pct = 0,
            mae_pct = 0,
            open_price = 0,
            close_price = 0,
            max_high = 0,
            min_low = 0,
            exit_price = 0,
            exit_time = 0,
            n_candles = 0,
            n_candles_expected = 0,
            coverage_pct = 0
      `).run();
      await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('outcome_logic_v6', String(Date.now()));
    }
  } catch {}

  // One-time migration: backfill outcome_state + resolved fields
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('outcome_state_v1') as { value?: string } | undefined;
    if (!row?.value) {
      await d.prepare(`
        UPDATE signal_outcomes
        SET
          outcome_state = CASE
            WHEN window_status = 'COMPLETE' AND ambiguous = 1 THEN 'COMPLETE_AMBIGUOUS_TP_AND_SL_SAME_CANDLE'
            WHEN window_status = 'COMPLETE' AND exit_reason = 'TP2' THEN 'COMPLETE_HIT_TP2'
            WHEN window_status = 'COMPLETE' AND exit_reason = 'TP1' THEN 'COMPLETE_HIT_TP1'
            WHEN window_status = 'COMPLETE' AND exit_reason = 'STOP' THEN 'COMPLETE_HIT_STOP'
            WHEN window_status = 'COMPLETE' THEN 'COMPLETE_TIMEOUT_NO_HIT'
            WHEN invalid_reason = 'FUTURE_WINDOW' THEN 'PENDING'
            ELSE 'PARTIAL_NOT_ENOUGH_BARS'
          END,
          resolved_at = CASE WHEN window_status = 'COMPLETE' THEN computed_at ELSE 0 END,
          resolve_version = CASE WHEN window_status = 'COMPLETE' THEN @ver ELSE NULL END
      `).run({ ver: OUTCOME_RESOLVE_VERSION });
      await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('outcome_state_v1', String(Date.now()));
    }
  } catch {}

  // One-time migration: force recompute when resolver version changes
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('outcome_resolve_v2') as { value?: string } | undefined;
    if (!row?.value) {
      await d.prepare(`
        UPDATE signal_outcomes
        SET
          window_status = 'PARTIAL',
          outcome_state = 'PENDING',
          invalid_reason = 'STALE_RESOLVE',
          prev_snapshot = json_object(
            'outcome_state', outcome_state,
            'window_status', window_status,
            'result', result,
            'exit_reason', exit_reason,
            'trade_state', trade_state,
            'exit_price', exit_price,
            'exit_time', exit_time,
            'mfe_pct', mfe_pct,
            'mae_pct', mae_pct,
            'bars_to_exit', bars_to_exit,
            'resolved_at', resolved_at,
            'resolve_version', resolve_version
          ),
          attempted_at = 0,
          computed_at = 0,
          resolved_at = 0,
          resolve_version = NULL,
          bars_to_exit = 0,
          tp1_hit_time = 0,
          tp2_hit_time = 0,
          sl_hit_time = 0,
          result = 'PENDING',
          exit_reason = NULL,
          trade_state = 'PENDING',
          exit_price = 0,
          exit_time = 0,
          mfe_pct = 0,
          mae_pct = 0
        WHERE resolve_version IS NULL OR resolve_version != @ver
      `).run({ ver: OUTCOME_RESOLVE_VERSION });
      await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('outcome_resolve_v2', String(Date.now()));
    }
  } catch {}

  // One-time migration: backfill trade_state for existing rows
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('trade_state_v1') as { value?: string } | undefined;
    if (!row?.value) {
      await d.prepare(`
        UPDATE signal_outcomes
        SET trade_state = CASE
          WHEN window_status = 'INVALID' THEN 'INVALIDATED'
          WHEN window_status != 'COMPLETE' THEN 'PENDING'
          WHEN invalid_levels = 1 THEN 'INVALIDATED'
          WHEN result = 'TP2' THEN 'COMPLETED_TP2'
          WHEN result = 'TP1' THEN 'COMPLETED_TP1'
          WHEN result = 'SL' THEN 'FAILED_SL'
          ELSE 'EXPIRED'
        END
      `).run();
      await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('trade_state_v1', String(Date.now()));
    }
  } catch {}

  // One-time migration: if old rows used openTime, shift to closeTime (+5m)
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('time_migrated_close') as { value?: string } | undefined;
    if (!row?.value) {
      if (ENABLE_TIME_SHIFT) {
        await d.prepare(`UPDATE signals SET time = time + 300000`).run();
        await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('time_migrated_close', String(Date.now()));
      } else {
        await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('time_migrated_close', 'SKIPPED');
      }
    }
  } catch {}

  // One-time migration: align entry_time + entry_candle_open_time to candle boundaries
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('entry_time_aligned_v1') as { value?: string } | undefined;
    if (!row?.value) {
      const intervalMs = SIGNAL_INTERVAL_MIN * 60_000;
      await d.prepare(`
        UPDATE signals
        SET
          entry_time = CAST(
            (CASE
              WHEN entry_rule = 'signal_open' THEN time - @interval
              WHEN entry_rule = 'next_open' THEN time
              ELSE time
            END) / @interval AS INTEGER
          ) * @interval,
          entry_candle_open_time = CAST(
            (CASE
              WHEN entry_rule = 'signal_open' THEN time - @interval
              WHEN entry_rule = 'next_open' THEN time
              ELSE time - @interval
            END) / @interval AS INTEGER
          ) * @interval
      `).run({ interval: intervalMs });
      await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('entry_time_aligned_v1', String(Date.now()));
    }
  } catch {}

  // One-time migration: align entry_time rules (v2)
  try {
    const row = await d.prepare(`SELECT value FROM meta WHERE key = ?`).get('entry_time_aligned_v2') as { value?: string } | undefined;
    if (!row?.value) {
      const intervalMs = SIGNAL_INTERVAL_MIN * 60_000;
      await d.prepare(`
        UPDATE signals
        SET
          entry_time = CAST(
            (CASE
              WHEN entry_rule = 'signal_open' THEN time - @interval
              WHEN entry_rule = 'next_open' THEN time
              ELSE time
            END) / @interval AS INTEGER
          ) * @interval,
          entry_candle_open_time = CAST(
            (CASE
              WHEN entry_rule = 'signal_open' THEN time - @interval
              WHEN entry_rule = 'next_open' THEN time
              ELSE time - @interval
            END) / @interval AS INTEGER
          ) * @interval
      `).run({ interval: intervalMs });
      await d.prepare(`INSERT INTO meta(key, value) VALUES(?, ?)`).run('entry_time_aligned_v2', String(Date.now()));
    }
  } catch {}
}

function safeJsonParse<T>(s: any): T | null {
  if (typeof s !== 'string' || !s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

async function getDbReady() {
  const d = getDb();
  await ensureSchema();
  return d;
}

export function shouldLogCategory(cat: string) {
  return SIGNAL_LOG_CATS.includes(cat);
}

export function getLoggedCategories() {
  return [...SIGNAL_LOG_CATS];
}

export async function recordSignal(sig: Signal, preset?: string): Promise<number | null> {
  if (!shouldLogCategory(sig.category)) return null;

  const d = await getDbReady();
  const now = Date.now();
  const signalIntervalMs = SIGNAL_INTERVAL_MIN * 60_000;
  const signalCloseRaw = sig.time;
  const signalClose = alignDown(signalCloseRaw, signalIntervalMs);
  const signalOpen = signalClose - signalIntervalMs;
  let entryTime = signalClose;
  let entryCandleOpenTime = signalOpen;
  if (ENTRY_RULE === 'signal_open') {
    entryTime = signalOpen;
    entryCandleOpenTime = signalOpen;
  } else if (ENTRY_RULE === 'next_open') {
    entryTime = signalClose;
    entryCandleOpenTime = signalClose;
  }
  const entryTimeAligned = alignDown(entryTime, signalIntervalMs);

  const configSnapshot = buildConfigSnapshot({
    preset: preset ?? sig.preset ?? null,
    thresholds: {
      vwapDistancePct: sig.thresholdVwapDistancePct ?? null,
      volSpikeX: sig.thresholdVolSpikeX ?? null,
      atrGuardPct: sig.thresholdAtrGuardPct ?? null,
    },
    buildGitSha: BUILD_GIT_SHA,
  });
  const configHash = String(sig.configHash || '').trim() || computeConfigHash(configSnapshot);
  (configSnapshot as any).configHash = configHash;
  const instanceId = String(sig.instanceId || INSTANCE_ID || '').trim() || 'unknown';

  const entrySnapshot = buildEntrySnapshot({
    sig,
    preset,
    entryTimeAligned,
    entryRule: ENTRY_RULE,
    entryCandleOpenTime,
    configSnapshot,
    configHash,
  });

  const conflictTarget = d.driver === 'sqlite'
    ? '(symbol, category, time)'
    : '(symbol, category, time, config_hash)';

  await d.prepare(`
    INSERT INTO signals (
      symbol, category, time, preset, strategy_version,
      threshold_vwap_distance_pct, threshold_vol_spike_x, threshold_atr_guard_pct,
      entry_time, entry_candle_open_time, entry_rule,
      price, vwap, ema200, rsi9, volSpike, atrPct, confirm15m, deltaVwapPct,
      confirm15_strict, confirm15_soft, rr_est,
      stop, tp1, tp2, target, rr, riskPct,
      session_ok, sweep_ok, trend_ok, blocked_by_btc, would_be_category, btc_gate, btc_gate_reason,
      gate_snapshot_json, ready_debug_json, best_debug_json, entry_debug_json, config_snapshot_json, config_hash, build_git_sha, run_id, instance_id, blocked_reasons_json, first_failed_gate, gate_score,
      btc_bull, btc_bear, btc_close, btc_vwap, btc_ema200, btc_rsi, btc_delta_vwap,
      market_json, reasons_json,
      created_at, updated_at
    ) VALUES (
      @symbol, @category, @time, @preset, @strategy_version,
      @threshold_vwap_distance_pct, @threshold_vol_spike_x, @threshold_atr_guard_pct,
      @entry_time, @entry_candle_open_time, @entry_rule,
      @price, @vwap, @ema200, @rsi9, @volSpike, @atrPct, @confirm15m, @deltaVwapPct,
      @confirm15_strict, @confirm15_soft, @rr_est,
      @stop, @tp1, @tp2, @target, @rr, @riskPct,
      @session_ok, @sweep_ok, @trend_ok, @blocked_by_btc, @would_be_category, @btc_gate, @btc_gate_reason,
      @gate_snapshot_json, @ready_debug_json, @best_debug_json, @entry_debug_json, @config_snapshot_json, @config_hash, @build_git_sha, @run_id, @instance_id, @blocked_reasons_json, @first_failed_gate, @gate_score,
      @btc_bull, @btc_bear, @btc_close, @btc_vwap, @btc_ema200, @btc_rsi, @btc_delta_vwap,
      @market_json, @reasons_json,
      @created_at, @updated_at
    )
    ON CONFLICT ${conflictTarget} DO UPDATE SET
      preset=excluded.preset,
      strategy_version=excluded.strategy_version,
      threshold_vwap_distance_pct=excluded.threshold_vwap_distance_pct,
      threshold_vol_spike_x=excluded.threshold_vol_spike_x,
      threshold_atr_guard_pct=excluded.threshold_atr_guard_pct,
      entry_time=excluded.entry_time,
      entry_candle_open_time=excluded.entry_candle_open_time,
      entry_rule=excluded.entry_rule,
      price=excluded.price,
      vwap=excluded.vwap,
      ema200=excluded.ema200,
      rsi9=excluded.rsi9,
      volSpike=excluded.volSpike,
      atrPct=excluded.atrPct,
      confirm15m=excluded.confirm15m,
      confirm15_strict=excluded.confirm15_strict,
      confirm15_soft=excluded.confirm15_soft,
      deltaVwapPct=excluded.deltaVwapPct,
      rr_est=excluded.rr_est,
      stop=excluded.stop,
      tp1=excluded.tp1,
      tp2=excluded.tp2,
      target=excluded.target,
      rr=excluded.rr,
      riskPct=excluded.riskPct,
      session_ok=excluded.session_ok,
      sweep_ok=excluded.sweep_ok,
      trend_ok=excluded.trend_ok,
      blocked_by_btc=excluded.blocked_by_btc,
      would_be_category=excluded.would_be_category,
      btc_gate=excluded.btc_gate,
      btc_gate_reason=excluded.btc_gate_reason,
      gate_snapshot_json=excluded.gate_snapshot_json,
      ready_debug_json=excluded.ready_debug_json,
      best_debug_json=excluded.best_debug_json,
      entry_debug_json=excluded.entry_debug_json,
      config_snapshot_json=excluded.config_snapshot_json,
      config_hash=excluded.config_hash,
      build_git_sha=excluded.build_git_sha,
      run_id=excluded.run_id,
      instance_id=excluded.instance_id,
      blocked_reasons_json=excluded.blocked_reasons_json,
      first_failed_gate=excluded.first_failed_gate,
      gate_score=excluded.gate_score,
      btc_bull=excluded.btc_bull,
      btc_bear=excluded.btc_bear,
      btc_close=excluded.btc_close,
      btc_vwap=excluded.btc_vwap,
      btc_ema200=excluded.btc_ema200,
      btc_rsi=excluded.btc_rsi,
      btc_delta_vwap=excluded.btc_delta_vwap,
      market_json=excluded.market_json,
      reasons_json=excluded.reasons_json,
      updated_at=excluded.updated_at
  `).run({
    symbol: sig.symbol,
    category: sig.category,
    time: signalClose,
    preset: preset || sig.preset || null,
    strategy_version: sig.strategyVersion || STRATEGY_VERSION,
    threshold_vwap_distance_pct: sig.thresholdVwapDistancePct ?? null,
    threshold_vol_spike_x: sig.thresholdVolSpikeX ?? null,
    threshold_atr_guard_pct: sig.thresholdAtrGuardPct ?? null,
    entry_time: entryTimeAligned,
    entry_candle_open_time: entryCandleOpenTime,
    entry_rule: ENTRY_RULE,

    price: sig.price,
    vwap: sig.vwap ?? null,
    ema200: sig.ema200 ?? null,
    rsi9: sig.rsi9 ?? null,
    volSpike: sig.volSpike ?? null,
    atrPct: sig.atrPct ?? null,
    confirm15m: sig.confirm15m ? 1 : 0,
    deltaVwapPct: sig.deltaVwapPct ?? null,
    confirm15_strict: sig.confirm15mStrict == null ? null : (sig.confirm15mStrict ? 1 : 0),
    confirm15_soft: sig.confirm15mSoft == null ? null : (sig.confirm15mSoft ? 1 : 0),
    rr_est: sig.rrEstimate ?? null,

    stop: sig.stop ?? null,
    tp1: sig.tp1 ?? null,
    tp2: sig.tp2 ?? null,
    target: sig.target ?? null,
    rr: sig.rr ?? null,
    riskPct: sig.riskPct ?? null,
    session_ok: sig.sessionOk == null ? null : (sig.sessionOk ? 1 : 0),
    sweep_ok: sig.sweepOk == null ? null : (sig.sweepOk ? 1 : 0),
    trend_ok: sig.trendOk == null ? null : (sig.trendOk ? 1 : 0),
    blocked_by_btc: sig.blockedByBtc == null ? null : (sig.blockedByBtc ? 1 : 0),
    would_be_category: sig.wouldBeCategory ?? null,
    btc_gate: sig.btcGate ?? null,
    btc_gate_reason: sig.btcGateReason ?? null,
    gate_snapshot_json: sig.gateSnapshot ? JSON.stringify(sig.gateSnapshot) : null,
    ready_debug_json: JSON.stringify(buildReadyDebugSnapshot(sig)),
    best_debug_json: JSON.stringify(buildBestDebugSnapshot(sig)),
    entry_debug_json: JSON.stringify(entrySnapshot),
    config_snapshot_json: JSON.stringify(configSnapshot),
    config_hash: configHash,
    build_git_sha: BUILD_GIT_SHA,
    run_id: sig.runId ?? null,
    instance_id: instanceId,
    blocked_reasons_json: sig.blockedReasons ? JSON.stringify(sig.blockedReasons) : null,
    first_failed_gate: sig.firstFailedGate ?? null,
    gate_score: sig.gateScore ?? null,
    btc_bull: sig.market?.btcBull15m == null ? null : (sig.market?.btcBull15m ? 1 : 0),
    btc_bear: sig.market?.btcBear15m == null ? null : (sig.market?.btcBear15m ? 1 : 0),
    btc_close: sig.market?.btcClose15m ?? null,
    btc_vwap: sig.market?.btcVwap15m ?? null,
    btc_ema200: sig.market?.btcEma200_15m ?? null,
    btc_rsi: sig.market?.btcRsi9_15m ?? null,
    btc_delta_vwap: sig.market?.btcDeltaVwapPct15m ?? null,

    market_json: sig.market ? JSON.stringify(sig.market) : null,
    reasons_json: sig.reasons ? JSON.stringify(sig.reasons) : null,

    created_at: now,
    updated_at: now,
  });

  const row = await d
    .prepare(`SELECT id FROM signals WHERE symbol=? AND category=? AND time=? AND config_hash=?`)
    .get(sig.symbol, sig.category, sig.time, configHash) as { id: number } | undefined;

  return row?.id ?? null;
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function alignDown(ts: number, intervalMs: number) {
  return Math.floor(ts / intervalMs) * intervalMs;
}

function resolveTimeRange(params: { days?: number; start?: number; end?: number; maxDays?: number }) {
  const now = Date.now();
  const end = Number.isFinite(params.end) ? Number(params.end) : now;
  const maxDays = params.maxDays ?? 365;
  const days = Math.max(1, Math.min(maxDays, params.days ?? 30));
  const start = Number.isFinite(params.start) ? Number(params.start) : (end - days * 24 * 60 * 60_000);
  return { start, end, days };
}

function applySignalFilters(
  where: string[],
  bind: Record<string, any>,
  params: {
    category?: string;
    categories?: string[];
    symbol?: string;
    preset?: string;
    strategyVersion?: string;
    blockedByBtc?: boolean;
    btcState?: string;
  },
  alias = 's'
) {
  if (params.category) {
    where.push(`${alias}.category = @category`);
    bind.category = params.category;
  }
  if (params.categories?.length) {
    where.push(`${alias}.category IN (${params.categories.map((_, i) => `@cat_${i}`).join(',')})`);
    params.categories.forEach((c, i) => { bind[`cat_${i}`] = c; });
  }
  if (params.symbol) {
    where.push(`${alias}.symbol = @symbol`);
    bind.symbol = params.symbol.toUpperCase();
  }
  if (params.preset) {
    where.push(`${alias}.preset = @preset`);
    bind.preset = params.preset;
  }
  if (params.strategyVersion) {
    where.push(`${alias}.strategy_version = @strategyVersion`);
    bind.strategyVersion = params.strategyVersion;
  }
  if (params.blockedByBtc != null) {
    where.push(`${alias}.blocked_by_btc = @blockedByBtc`);
    bind.blockedByBtc = params.blockedByBtc ? 1 : 0;
  }
  if (params.btcState) {
    const state = String(params.btcState).toUpperCase();
    if (state === 'BULL') {
      where.push(`${alias}.btc_bull = 1`);
    } else if (state === 'BEAR') {
      where.push(`${alias}.btc_bear = 1`);
    } else if (state === 'NEUTRAL') {
      where.push(`(${alias}.btc_bull IS NULL OR ${alias}.btc_bull = 0) AND (${alias}.btc_bear IS NULL OR ${alias}.btc_bear = 0)`);
    }
  }
}

function applyEntryCost(price: number) {
  const cost = (FEE_BPS + SLIPPAGE_BPS) / 10000;
  return price * (1 + cost);
}

function applyExitCost(price: number) {
  const cost = (FEE_BPS + SLIPPAGE_BPS) / 10000;
  return price * (1 - cost);
}

export function calcOutcomeFromCandles(params: {
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  entryTime: number;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number }>;
}) {
  const { entry, stop, tp1, tp2, entryTime, candles } = params;

  if (!candles.length) {
    return {
      maxHigh: entry,
      minLow: entry,
      lastClose: entry,
      retPct: 0,
      rClose: 0,
      rMfe: 0,
      rMae: 0,
      rRealized: 0,
      hitSL: 0,
      hitTP1: 0,
      hitTP2: 0,
      tp1HitTime: 0,
      slHitTime: 0,
      timeToFirstHitMs: 0,
      mfePct: 0,
      maePct: 0,
      result: 'NONE' as const,
      exitReason: 'TIMEOUT' as const,
      exitPrice: entry,
      exitTime: 0,
      ambiguous: 0,
      exitIndex: -1,
    };
  }

  const entryAdj = applyEntryCost(entry);
  const stopAdj = applyExitCost(stop);
  const tp1Adj = applyExitCost(tp1);
  const tp2Adj = applyExitCost(tp2);
  const risk = entryAdj - stopAdj;

  let maxHigh = -Infinity;
  let minLow = Infinity;
  let tp1HitTime = 0;
  let slHitTime = 0;
  let tp2HitTime = 0;

  let result: 'WIN' | 'LOSS' | 'NONE' = 'NONE';
  let exitReason: 'TP1' | 'TP2' | 'STOP' | 'TIMEOUT' = 'TIMEOUT';
  let ambiguous = 0;
  let exitPrice = candles[candles.length - 1]?.close ?? entry;
  let exitTime = candles[candles.length - 1]?.time ?? 0;
  let exitIndex = candles.length - 1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.high > maxHigh) maxHigh = c.high;
    if (c.low < minLow) minLow = c.low;
    if (!tp1HitTime && c.high >= tp1) tp1HitTime = c.time;
    if (!slHitTime && c.low <= stop) slHitTime = c.time;
    if (!tp2HitTime && c.high >= tp2) tp2HitTime = c.time;

    const hitSLInBar = c.low <= stop;
    const hitTP2InBar = c.high >= tp2;
    const hitTP1InBar = c.high >= tp1;

      if (hitSLInBar && (hitTP2InBar || hitTP1InBar)) {
        // Conservative long: assume SL first if both sides hit in same candle
        ambiguous = 1;
        if (slHitTime === 0) slHitTime = c.time;
        if (hitTP2InBar && tp2HitTime === 0) tp2HitTime = c.time;
        if (hitTP1InBar && tp1HitTime === 0) tp1HitTime = c.time;
        result = 'LOSS';
        exitReason = 'STOP';
        exitPrice = stop;
      exitTime = c.time;
      exitIndex = i;
      break;
    }
    if (hitSLInBar) {
      result = 'LOSS';
      exitReason = 'STOP';
      exitPrice = stop;
      exitTime = c.time;
      exitIndex = i;
      break;
    }
    if (hitTP2InBar) {
      result = 'WIN';
      exitReason = 'TP2';
      exitPrice = tp2;
      exitTime = c.time;
      exitIndex = i;
      break;
    }
    if (hitTP1InBar) {
      result = 'WIN';
      exitReason = 'TP1';
      exitPrice = tp1;
      exitTime = c.time;
      exitIndex = i;
      break;
    }
  }

  if (exitIndex < candles.length - 1) {
    // Freeze max up/down at exit candle.
    const slice = candles.slice(0, exitIndex + 1);
    maxHigh = Math.max(...slice.map(c => c.high));
    minLow = Math.min(...slice.map(c => c.low));
  }

  const lastClose = candles[candles.length - 1]?.close ?? entry;
  const hitSL = minLow <= stop ? 1 : 0;
  const hitTP1 = maxHigh >= tp1 ? 1 : 0;
  const hitTP2 = maxHigh >= tp2 ? 1 : 0;

  const exitAdj = applyExitCost(exitPrice);
  const maxHighAdj = applyExitCost(maxHigh);
  const minLowAdj = applyExitCost(minLow);
  const retPct = entryAdj ? ((exitAdj - entryAdj) / entryAdj) * 100 : 0;
  const rClose = risk > 0 ? (exitAdj - entryAdj) / risk : 0;
  const rMfe = risk > 0 ? (maxHighAdj - entryAdj) / risk : 0;
  const rMae = risk > 0 ? (minLowAdj - entryAdj) / risk : 0;
  const mfePct = entry ? ((maxHigh - entry) / entry) * 100 : 0;
  const maePct = entry ? ((minLow - entry) / entry) * 100 : 0;
  const rRealized =
    result === 'LOSS' ? -1 :
    result === 'WIN' && exitReason === 'TP2' ? 2 :
    result === 'WIN' ? 1 : 0;
  const tp1Delta = tp1HitTime > 0 ? Math.max(0, tp1HitTime - entryTime) : 0;
  const slDelta = slHitTime > 0 ? Math.max(0, slHitTime - entryTime) : 0;
  const tp2Delta = tp2HitTime > 0 ? Math.max(0, tp2HitTime - entryTime) : 0;
  const timeToFirstHitMs =
    tp1Delta && slDelta ? Math.min(tp1Delta, slDelta) :
    tp1Delta || slDelta || tp2Delta || 0;
  const barsToExit = Math.max(1, exitIndex + 1);

  return {
    maxHigh,
    minLow,
    lastClose,
    retPct,
    rClose,
    rMfe,
    rMae,
    rRealized,
    hitSL,
    hitTP1,
    hitTP2,
    tp1HitTime,
    slHitTime,
    tp2HitTime,
    timeToFirstHitMs,
    barsToExit,
    mfePct,
    maePct,
    result,
    exitReason,
    exitPrice,
    exitTime,
    ambiguous,
    exitIndex,
  };
}

export function evaluateOutcomeWindow(params: {
  startTime: number;
  endTime: number;
  intervalMs: number;
  needed: number;
  minCoveragePct: number;
  candles: Array<{ time: number; openTime?: number; open: number; high: number; low: number; close: number }>;
}) {
  const { startTime, endTime, intervalMs, needed, minCoveragePct, candles } = params;
  const getTime = (c: { time: number; openTime?: number }) => Number.isFinite(c.openTime) ? Number(c.openTime) : Number(c.time);
  const window = candles
    .filter(c => getTime(c) >= startTime && getTime(c) <= endTime)
    .sort((a, b) => getTime(a) - getTime(b));

  const windowSlice = window.slice(0, needed);
  const nCandles = windowSlice.length;
  const coveragePct = needed > 0 ? (nCandles / needed) * 100 : 0;

  if (nCandles === 0) {
    return {
      windowStatus: 'INVALID' as const,
      invalidReason: 'NO_DATA_IN_WINDOW',
      windowSlice,
      nCandles,
      coveragePct,
    };
  }

  if (coveragePct < minCoveragePct) {
    return {
      windowStatus: 'PARTIAL' as const,
      invalidReason: 'NOT_ENOUGH_BARS',
      windowSlice,
      nCandles,
      coveragePct,
    };
  }

  let aligned = true;
  if (getTime(windowSlice[0] as any) !== startTime) aligned = false;
  if (getTime(windowSlice[windowSlice.length - 1] as any) !== endTime) aligned = false;
  for (let i = 1; i < windowSlice.length; i++) {
    if (getTime(windowSlice[i] as any) - getTime(windowSlice[i - 1] as any) !== intervalMs) {
      aligned = false;
      break;
    }
  }

  if (!aligned) {
    return {
      windowStatus: 'PARTIAL' as const,
      invalidReason: 'BAD_ALIGN',
      windowSlice,
      nCandles,
      coveragePct,
    };
  }

  return {
    windowStatus: 'COMPLETE' as const,
    invalidReason: null,
    windowSlice,
    nCandles,
    coveragePct,
  };
}

async function computeOneOutcome(
  signalRow: any,
  horizonMin: number,
  fetchCandles: (symbol: string, startTime: number, limitCandles: number) => Promise<any[]>,
  now: number
) {
  const d = await getDbReady();
  const configSnapshot = safeJsonParse<any>(signalRow.config_snapshot_json) ?? null;
  const configEnv = (configSnapshot?.env ?? {}) as Record<string, any>;
  const configThresholds = (configSnapshot?.thresholds ?? {}) as Record<string, any>;
  const envNum = (key: string, fallback?: number) => {
    const raw = configEnv[key];
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    if (Number.isFinite(Number(fallback))) return Number(fallback);
    const fromProcess = Number(process.env[key]);
    return Number.isFinite(fromProcess) ? fromProcess : NaN;
  };
  const category = String(signalRow.category || '');
  const entryRule = String(signalRow.entry_rule || ENTRY_RULE);
  const intervalMs = OUTCOME_INTERVAL_MIN * 60_000;
  const entryTimeRaw = Number(signalRow.entry_time) || Number(signalRow.time);
  const entryCandleOpenTimeRaw = Number(signalRow.entry_candle_open_time) || entryTimeRaw;
  const entryTime = alignDown(entryTimeRaw, intervalMs);
  const entryCandleOpenTime = alignDown(entryCandleOpenTimeRaw, intervalMs);
  const needed = Math.max(1, Math.ceil(horizonMin / OUTCOME_INTERVAL_MIN));
  const startTime = entryTime;
  const endTime = startTime + (needed - 1) * intervalMs;
  const readyAt = endTime + intervalMs + OUTCOME_GRACE_MS + OUTCOME_BUFFER_CANDLES * intervalMs;

  let windowStatus: 'PARTIAL' | 'COMPLETE' | 'INVALID' = 'PARTIAL';
  let invalidReason: string | null = null;
  let windowSlice: Array<any> = [];
  let nCandles = 0;
  let coveragePct = 0;
  let expiredAfter15m = 0;
  let expiredReason: string | null = null;
  let expiredOut: any | null = null;

  if (now < readyAt) {
    windowStatus = 'PARTIAL';
    invalidReason = 'FUTURE_WINDOW';
  } else {
    if (OUTCOME_EXPIRE_AFTER_15M && horizonMin > 15) {
      const short = await d.prepare(`
        SELECT
          outcome_state, window_status, resolve_version,
          entry_price, open_price, close_price,
          min_low, max_high,
          ret_pct, r_close, r_mfe, r_mae, r_realized,
          mfe_pct, mae_pct,
          exit_price, exit_time
        FROM signal_outcomes
        WHERE signal_id = ? AND horizon_min = 15
      `).get(signalRow.id) as any;

      if (
        short &&
        short.outcome_state === 'COMPLETE_TIMEOUT_NO_HIT' &&
        short.window_status === 'COMPLETE' &&
        short.resolve_version === OUTCOME_RESOLVE_VERSION
      ) {
        const entryShort = Number.isFinite(Number(short.entry_price)) ? Number(short.entry_price) : Number(signalRow.price);
        const closeShort = Number.isFinite(Number(short.close_price)) ? Number(short.close_price) : entryShort;
        const stop = Number(signalRow.stop);
        const minLow = Number(short.min_low);
        const vwap = Number(signalRow.vwap);
        const atrPct = Number(signalRow.atrPct);
        const atrPrice = Number.isFinite(atrPct) ? (entryShort * (atrPct / 100)) : NaN;
        const driftLimit = Number.isFinite(atrPrice) ? (ENTRY_DRIFT_ATR * atrPrice) : NaN;

        const notStopped = Number.isFinite(stop) ? (Number.isFinite(minLow) ? minLow > stop : true) : true;
        const stillNearEntry = Number.isFinite(driftLimit) ? (Math.abs(closeShort - entryShort) <= driftLimit) : true;
        const structureNotBroken = Number.isFinite(vwap) ? (closeShort >= vwap) : true;
        const alive = notStopped && stillNearEntry && structureNotBroken;

        if (!alive) {
          expiredAfter15m = 1;
          expiredReason = !notStopped ? 'STOP' : (!stillNearEntry ? 'DRIFT' : 'STRUCTURE');
          windowStatus = 'COMPLETE';
          invalidReason = null;
          nCandles = needed;
          coveragePct = 100;
          windowSlice = [];
          expiredOut = {
            maxHigh: Number.isFinite(Number(short.max_high)) ? Number(short.max_high) : entryShort,
            minLow: Number.isFinite(Number(short.min_low)) ? Number(short.min_low) : entryShort,
            lastClose: closeShort,
            retPct: Number.isFinite(Number(short.ret_pct)) ? Number(short.ret_pct) : 0,
            rClose: Number.isFinite(Number(short.r_close)) ? Number(short.r_close) : 0,
            rMfe: Number.isFinite(Number(short.r_mfe)) ? Number(short.r_mfe) : 0,
            rMae: Number.isFinite(Number(short.r_mae)) ? Number(short.r_mae) : 0,
            rRealized: Number.isFinite(Number(short.r_realized)) ? Number(short.r_realized) : 0,
            hitSL: 0,
            hitTP1: 0,
            hitTP2: 0,
            tp1HitTime: 0,
            slHitTime: 0,
            tp2HitTime: 0,
            timeToFirstHitMs: 0,
            barsToExit: needed,
            mfePct: Number.isFinite(Number(short.mfe_pct)) ? Number(short.mfe_pct) : 0,
            maePct: Number.isFinite(Number(short.mae_pct)) ? Number(short.mae_pct) : 0,
            result: 'NONE' as const,
            exitReason: 'EXPIRED_AFTER_15M' as const,
            exitPrice: Number.isFinite(Number(short.exit_price)) ? Number(short.exit_price) : closeShort,
            exitTime: Number.isFinite(Number(short.exit_time)) ? Number(short.exit_time) : endTime,
            ambiguous: 0,
            openPrice: Number.isFinite(Number(short.open_price)) ? Number(short.open_price) : entryShort,
          };
        }
      }
    }

    if (!expiredOut) {
      const rangeStart = Math.max(0, startTime - OUTCOME_BUFFER_CANDLES * intervalMs);
      const neededWithBuffer = needed + OUTCOME_BUFFER_CANDLES * 2;
      const candles = await fetchCandles(signalRow.symbol, rangeStart, neededWithBuffer);

      const assessed = evaluateOutcomeWindow({
        startTime,
        endTime,
        intervalMs,
        needed,
        minCoveragePct: OUTCOME_MIN_COVERAGE_PCT,
        candles,
      });
      windowStatus = assessed.windowStatus;
      invalidReason = assessed.invalidReason;
      windowSlice = assessed.windowSlice;
      nCandles = assessed.nCandles;
      coveragePct = assessed.coveragePct;
    }
  }

  const entryClose = Number(signalRow.price);
  const stop = signalRow.stop == null ? NaN : Number(signalRow.stop);
  const tp1 = signalRow.tp1 == null ? NaN : Number(signalRow.tp1);
  const tp2 = signalRow.tp2 == null ? NaN : Number(signalRow.tp2);
  const openPrice = expiredOut?.openPrice ?? windowSlice[0]?.open ?? entryClose;
  let entry = entryClose;
  if (entryRule === 'signal_open' || entryRule === 'next_open') {
    entry = openPrice;
  }

  const levelsFinite = Number.isFinite(entry) && Number.isFinite(stop) && Number.isFinite(tp1) && Number.isFinite(tp2);
  let invalidLevels = false;
  if (windowStatus === 'COMPLETE') {
    if (!levelsFinite) {
      invalidLevels = true;
      invalidReason = 'NO_PLAN';
    } else if (!(stop < entry && tp1 > entry && tp2 > tp1)) {
      invalidLevels = true;
      invalidReason = 'BAD_LEVELS';
    } else if (MIN_RISK_PCT > 0) {
      const riskPct = ((entry - stop) / entry) * 100;
      if (riskPct < MIN_RISK_PCT) {
        invalidLevels = true;
        invalidReason = 'RISK_TOO_SMALL';
      }
    }
    if (invalidLevels) {
      windowStatus = 'INVALID';
    }
  }

  const canCompute = windowStatus === 'COMPLETE' && !invalidLevels;
  let out = canCompute ? (expiredOut ?? calcOutcomeFromCandles({
    entry,
    stop,
    tp1,
    tp2,
    entryTime,
    candles: windowSlice.map(c => ({
      time: Number.isFinite(c.openTime) ? Number(c.openTime) : c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  })) : {
    maxHigh: entry,
    minLow: entry,
    lastClose: entry,
    retPct: 0,
    rClose: 0,
    rMfe: 0,
    rMae: 0,
    rRealized: 0,
    hitSL: 0,
    hitTP1: 0,
    hitTP2: 0,
    tp1HitTime: 0,
    slHitTime: 0,
    tp2HitTime: 0,
    timeToFirstHitMs: 0,
    barsToExit: 0,
    mfePct: 0,
    maePct: 0,
    result: 'NONE' as const,
    exitReason: 'INVALID' as const,
    exitPrice: entry,
    exitTime: startTime,
    ambiguous: 0,
    exitIndex: -1,
  };

  // Normalize non-hit exits to correct boundary times (prevents -1 candle stamps).
  if (canCompute) {
    const hitExit =
      out.exitReason === 'TP1' ||
      out.exitReason === 'TP2' ||
      out.exitReason === 'STOP';
    if (!hitExit) {
      const capMinutes = 15;
      const capMs = capMinutes * 60_000;
      const capBars = Math.max(1, Math.ceil(capMinutes / OUTCOME_INTERVAL_MIN));
      if (out.exitReason === 'EXPIRED_AFTER_15M' || expiredAfter15m) {
        out.exitReason = 'EXPIRED_AFTER_15M' as const;
        out.exitTime = entryTime + capMs;
        out.barsToExit = capBars;
      } else {
        out.exitReason = 'TIMEOUT' as const;
        out.exitTime = endTime;
        if (!Number.isFinite(out.exitIndex)) {
          out.exitIndex = nCandles > 0 ? (nCandles - 1) : -1;
        }
      }
    }
  }

  const exitCandle = (canCompute && out.exitIndex >= 0 && out.exitIndex < windowSlice.length)
    ? windowSlice[out.exitIndex]
    : null;
  const outcomeDebug = {
    window: {
      startTimeMs: startTime,
      endTimeMs: endTime,
      intervalMs,
      needed,
      nCandles,
      coveragePct,
    },
    resolution: {
      result: canCompute ? out.result : 'PENDING',
      reason: canCompute ? out.exitReason : (invalidReason ?? 'PENDING'),
      ambiguous: canCompute ? Boolean(out.ambiguous) : false,
    },
    hits: {
      tp1HitTime: out.tp1HitTime,
      tp2HitTime: out.tp2HitTime,
      slHitTime: out.slHitTime,
      timeToFirstHitMs: out.timeToFirstHitMs,
    },
    exit: {
      price: canCompute ? out.exitPrice : entry,
      time: canCompute ? out.exitTime : startTime,
      index: out.exitIndex,
    },
    exitCandle: exitCandle ? {
      openTime: Number.isFinite(exitCandle.openTime) ? Number(exitCandle.openTime) : Number(exitCandle.time),
      open: exitCandle.open,
      high: exitCandle.high,
      low: exitCandle.low,
      close: exitCandle.close,
    } : null,
    excursions: {
      mfePct: out.mfePct,
      maePct: out.maePct,
      rMfe: out.rMfe,
      rMae: out.rMae,
    },
    windowStatus,
    invalidReason,
  };

  let tradeState = 'PENDING';
  if (windowStatus === 'INVALID') tradeState = 'INVALIDATED';
  else if (windowStatus === 'COMPLETE' && !invalidLevels) {
    if (out.exitReason === 'TP2') tradeState = 'COMPLETED_TP2';
    else if (out.exitReason === 'TP1') tradeState = 'COMPLETED_TP1';
    else if (out.exitReason === 'STOP') tradeState = 'FAILED_SL';
    else tradeState = 'EXPIRED';
  }

  let outcomeState = 'PENDING';
  if (windowStatus === 'COMPLETE' && !invalidLevels) {
    if (out.ambiguous) outcomeState = 'COMPLETE_AMBIGUOUS_TP_AND_SL_SAME_CANDLE';
    else if (out.exitReason === 'TP2') outcomeState = 'COMPLETE_HIT_TP2';
    else if (out.exitReason === 'TP1') outcomeState = 'COMPLETE_HIT_TP1';
    else if (out.exitReason === 'STOP') outcomeState = 'COMPLETE_HIT_STOP';
    else outcomeState = 'COMPLETE_TIMEOUT_NO_HIT';
  } else if (invalidReason === 'FUTURE_WINDOW') {
    outcomeState = 'PENDING';
  } else if (windowStatus !== 'COMPLETE') {
    outcomeState = 'PARTIAL_NOT_ENOUGH_BARS';
  }

  let outcomeDriver: string | null = null;
  if (windowStatus === 'COMPLETE' && !invalidLevels && tradeState === 'FAILED_SL') {
    const rr = Number(signalRow.rr);
    const deltaVwapPct = Number(signalRow.deltaVwapPct);
    const volSpike = Number(signalRow.volSpike);
    const rsi = Number(signalRow.rsi9);
    const sweepOk = signalRow.sweep_ok != null ? Boolean(signalRow.sweep_ok) : null;
    const sessionOk = signalRow.session_ok != null ? Boolean(signalRow.session_ok) : null;
    const btcBear = signalRow.btc_bear != null ? Boolean(signalRow.btc_bear) : null;

    const rrMin = category === 'BEST_ENTRY'
      ? envNum('RR_MIN_BEST', Number(signalRow.rr_est))
      : envNum('READY_MIN_RR');
    const vwapMax = category === 'BEST_ENTRY'
      ? envNum('BEST_VWAP_MAX_PCT')
      : envNum('READY_VWAP_MAX_PCT');
    const rsiMin = category === 'BEST_ENTRY'
      ? envNum('RSI_BEST_MIN')
      : envNum('RSI_READY_MIN');
    const rsiMax = category === 'BEST_ENTRY'
      ? envNum('RSI_BEST_MAX')
      : envNum('RSI_READY_MAX');
    const volSpikeMin = Number.isFinite(Number(configThresholds.volSpikeX))
      ? Number(configThresholds.volSpikeX)
      : envNum('THRESHOLD_VOL_SPIKE_X');

    const rrBelowMin = Number.isFinite(rr) && Number.isFinite(rrMin) && rr < rrMin;
    const vwapTooFar = Number.isFinite(deltaVwapPct) && Number.isFinite(vwapMax) && Math.abs(deltaVwapPct) > vwapMax;
    const noSweep = sweepOk === false;
    const volSpikeNotMet = Number.isFinite(volSpikeMin) && Number.isFinite(volSpike) && volSpike < volSpikeMin;
    const rsiNotInWindow = Number.isFinite(rsi) && Number.isFinite(rsiMin) && Number.isFinite(rsiMax) && (rsi < rsiMin || rsi > rsiMax);
    const btcContra = btcBear === true && (category === 'READY_TO_BUY' || category === 'BEST_ENTRY');
    const sessionOff = sessionOk === false;

    if (rrBelowMin) outcomeDriver = 'RR_BELOW_MIN';
    else if (vwapTooFar) outcomeDriver = 'VWAP_TOO_FAR';
    else if (noSweep) outcomeDriver = 'NO_SWEEP';
    else if (volSpikeNotMet) outcomeDriver = 'VOL_SPIKE_NOT_MET';
    else if (rsiNotInWindow) outcomeDriver = 'RSI_NOT_IN_WINDOW';
    else if (btcContra) outcomeDriver = 'BTC_CONTRA_TREND';
    else if (sessionOff) outcomeDriver = 'SESSION_OFF';
    else outcomeDriver = 'OTHER';
  }

  const resolvedAt = (windowStatus === 'COMPLETE' && !invalidLevels) ? Date.now() : 0;

  const attemptedAt = Date.now();
  const computedAt = windowStatus === 'PARTIAL' ? 0 : Date.now();

  await d.prepare(`
    INSERT INTO signal_outcomes (
      signal_id, horizon_min, entry_time, entry_candle_open_time, entry_rule, start_time, end_time,
      interval_min, n_candles, n_candles_expected, coverage_pct,
      entry_price, open_price, close_price, max_high, min_low,
      ret_pct, r_mult, r_close, r_mfe, r_mae, r_realized,
      hit_sl, hit_tp1, hit_tp2,
      tp1_hit_time, sl_hit_time, tp2_hit_time, time_to_first_hit_ms,
      bars_to_exit,
      mfe_pct, mae_pct,
      result, exit_reason, outcome_driver, trade_state, exit_price, exit_time,
      window_status, outcome_state, invalid_levels, invalid_reason, ambiguous,
      expired_after_15m, expired_reason,
      attempted_at, computed_at, resolved_at, resolve_version,
      outcome_debug_json
    ) VALUES (
      @signal_id, @horizon_min, @entry_time, @entry_candle_open_time, @entry_rule, @start_time, @end_time,
      @interval_min, @n_candles, @n_candles_expected, @coverage_pct,
      @entry_price, @open_price, @close_price, @max_high, @min_low,
      @ret_pct, @r_mult, @r_close, @r_mfe, @r_mae, @r_realized,
      @hit_sl, @hit_tp1, @hit_tp2,
      @tp1_hit_time, @sl_hit_time, @tp2_hit_time, @time_to_first_hit_ms,
      @bars_to_exit,
      @mfe_pct, @mae_pct,
      @result, @exit_reason, @outcome_driver, @trade_state, @exit_price, @exit_time,
      @window_status, @outcome_state, @invalid_levels, @invalid_reason, @ambiguous,
      @expired_after_15m, @expired_reason,
      @attempted_at, @computed_at, @resolved_at, @resolve_version,
      @outcome_debug_json
    )
    ON CONFLICT(signal_id, horizon_min) DO UPDATE SET
      entry_time=excluded.entry_time,
      entry_candle_open_time=excluded.entry_candle_open_time,
      entry_rule=excluded.entry_rule,
      start_time=excluded.start_time,
      end_time=excluded.end_time,
      interval_min=excluded.interval_min,
      n_candles=excluded.n_candles,
      n_candles_expected=excluded.n_candles_expected,
      coverage_pct=excluded.coverage_pct,
      entry_price=excluded.entry_price,
      open_price=excluded.open_price,
      close_price=excluded.close_price,
      max_high=excluded.max_high,
      min_low=excluded.min_low,
      ret_pct=excluded.ret_pct,
      r_mult=excluded.r_mult,
      r_close=excluded.r_close,
      r_mfe=excluded.r_mfe,
      r_mae=excluded.r_mae,
      r_realized=excluded.r_realized,
      hit_sl=excluded.hit_sl,
      hit_tp1=excluded.hit_tp1,
      hit_tp2=excluded.hit_tp2,
      tp1_hit_time=excluded.tp1_hit_time,
      sl_hit_time=excluded.sl_hit_time,
      tp2_hit_time=excluded.tp2_hit_time,
      time_to_first_hit_ms=excluded.time_to_first_hit_ms,
      bars_to_exit=excluded.bars_to_exit,
      mfe_pct=excluded.mfe_pct,
      mae_pct=excluded.mae_pct,
      result=excluded.result,
      exit_reason=excluded.exit_reason,
      outcome_driver=excluded.outcome_driver,
      trade_state=excluded.trade_state,
      exit_price=excluded.exit_price,
      exit_time=excluded.exit_time,
      window_status=excluded.window_status,
      outcome_state=excluded.outcome_state,
      invalid_levels=excluded.invalid_levels,
      invalid_reason=excluded.invalid_reason,
      ambiguous=excluded.ambiguous,
      expired_after_15m=excluded.expired_after_15m,
      expired_reason=excluded.expired_reason,
      attempted_at=excluded.attempted_at,
      computed_at=CASE
        WHEN excluded.window_status = 'PARTIAL' THEN signal_outcomes.computed_at
        ELSE excluded.computed_at
      END,
      resolved_at=excluded.resolved_at,
      resolve_version=excluded.resolve_version,
      outcome_debug_json=excluded.outcome_debug_json
  `).run({
    signal_id: signalRow.id,
    horizon_min: horizonMin,
    entry_time: entryTime,
    entry_candle_open_time: entryCandleOpenTime,
    entry_rule: entryRule,
    start_time: startTime,
    end_time: endTime,
    interval_min: OUTCOME_INTERVAL_MIN,
    n_candles: nCandles,
    n_candles_expected: needed,
    coverage_pct: coveragePct,
    entry_price: entry,
    open_price: openPrice,
    close_price: out.lastClose,
    max_high: out.maxHigh,
    min_low: out.minLow,
    ret_pct: out.retPct,
    // r_mult kept for backward compat; equals r_close (exit-based)
    r_mult: out.rClose,
    r_close: out.rClose,
    r_mfe: out.rMfe,
    r_mae: out.rMae,
    r_realized: out.rRealized,
    hit_sl: canCompute ? out.hitSL : 0,
    hit_tp1: canCompute ? out.hitTP1 : 0,
    hit_tp2: canCompute ? out.hitTP2 : 0,
    tp1_hit_time: canCompute ? out.tp1HitTime : 0,
    sl_hit_time: canCompute ? out.slHitTime : 0,
    tp2_hit_time: canCompute ? out.tp2HitTime : 0,
    time_to_first_hit_ms: canCompute ? out.timeToFirstHitMs : 0,
    bars_to_exit: canCompute ? out.barsToExit : 0,
    mfe_pct: out.mfePct,
    mae_pct: out.maePct,
    result: canCompute ? out.result : 'PENDING',
    exit_reason: canCompute ? out.exitReason : null,
    outcome_driver: outcomeDriver,
    trade_state: tradeState,
    exit_price: canCompute ? out.exitPrice : entry,
    exit_time: canCompute ? out.exitTime : startTime,
    window_status: windowStatus,
    outcome_state: outcomeState,
    invalid_levels: invalidLevels ? 1 : 0,
    invalid_reason: windowStatus === 'COMPLETE' ? null : invalidReason,
    ambiguous: canCompute ? out.ambiguous : 0,
    expired_after_15m: expiredAfter15m,
    expired_reason: expiredReason,
    attempted_at: attemptedAt,
    computed_at: computedAt,
    resolved_at: resolvedAt,
    resolve_version: resolvedAt ? OUTCOME_RESOLVE_VERSION : null,
    outcome_debug_json: JSON.stringify(outcomeDebug),
  });

  return true;
}

export async function updateOutcomesOnce() {
  if (outcomesRunning) return;
  outcomesRunning = true;
  const d = await getDbReady();
  const now = Date.now();
  const runStart = Date.now();
  let processed = 0;
  const cache = new Map<string, { start: number; end: number; candles: any[] }>();
  const intervalMs = OUTCOME_INTERVAL_MIN * 60_000;

  async function fetchCandles(symbol: string, startTime: number, limitCandles: number) {
    const maxLimit = Math.max(1, Math.min(1000, limitCandles));
    const key = `${symbol}|${OUTCOME_INTERVAL}|${startTime}|${maxLimit}`;
    const cached = cache.get(key);
    if (cached) return cached.candles;
    const candles = await klinesFrom(symbol, OUTCOME_INTERVAL, startTime, maxLimit);
    cache.set(key, { start: startTime, end: startTime + maxLimit * intervalMs, candles });
    return candles;
  }

  try {
    const horizons = [...OUTCOME_HORIZONS_MIN].sort((a, b) => a - b);
    for (const horizonMin of horizons) {
      const needed = Math.max(1, Math.ceil(horizonMin / OUTCOME_INTERVAL_MIN));
      const windowMs = needed * intervalMs;
      const readyEntryBefore = now - (windowMs + OUTCOME_GRACE_MS + OUTCOME_BUFFER_CANDLES * intervalMs);
      const retryBefore = now - OUTCOME_RETRY_AFTER_MS;

      const rows = await d.prepare(`
        SELECT s.*
        FROM signals s
        LEFT JOIN signal_outcomes o
          ON o.signal_id = s.id AND o.horizon_min = ?
        WHERE COALESCE(NULLIF(s.entry_time, 0), s.time) <= ?
          AND s.category IN (${SIGNAL_LOG_CATS.map(() => '?').join(',')})
          AND NOT EXISTS (
            SELECT 1 FROM outcome_skips k
            WHERE k.signal_id = s.id AND k.horizon_min = ?
          )
          AND (
            o.id IS NULL
            OR o.window_status = 'PARTIAL'
            OR (o.window_status = 'COMPLETE' AND o.computed_at < s.updated_at)
            OR (
              o.window_status = 'INVALID'
              AND o.invalid_reason IN (${OUTCOME_RETRY_REASONS.map(() => '?').join(',')})
              AND (o.attempted_at IS NULL OR o.attempted_at = 0 OR o.attempted_at < ?)
            )
          )
        ORDER BY s.time DESC
        LIMIT ?
      `).all(
        horizonMin,
        readyEntryBefore,
        ...SIGNAL_LOG_CATS,
        horizonMin,
        ...OUTCOME_RETRY_REASONS,
        retryBefore,
        OUTCOME_BATCH
      ) as any[];

      for (const row of rows) {
        try {
          await computeOneOutcome(row, horizonMin, fetchCandles, now);
          processed += 1;
        } catch (e) {
          try {
            // Record API errors as partial for visibility
            await d.prepare(`
              INSERT INTO signal_outcomes (
                signal_id, horizon_min, entry_time, entry_candle_open_time, entry_rule, start_time, end_time,
                interval_min, n_candles, n_candles_expected, coverage_pct,
                entry_price, open_price, close_price, max_high, min_low,
                ret_pct, r_mult, r_close, r_mfe, r_mae, r_realized,
                hit_sl, hit_tp1, hit_tp2,
                tp1_hit_time, sl_hit_time, tp2_hit_time, time_to_first_hit_ms,
                mfe_pct, mae_pct,
                result, exit_reason, trade_state, exit_price, exit_time,
                window_status, outcome_state, invalid_levels, invalid_reason, ambiguous,
                attempted_at, computed_at, resolved_at, resolve_version
              ) VALUES (
                @signal_id, @horizon_min, @entry_time, @entry_candle_open_time, @entry_rule, @start_time, @end_time,
                @interval_min, @n_candles, @n_candles_expected, @coverage_pct,
                0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0,
                0, 0, 0,
                0, 0, 0, 0,
                0, 0,
                'PENDING', NULL, 'PENDING', 0, 0,
                'PARTIAL', 'PENDING', 0, 'API_ERROR', 0,
                @attempted_at, @computed_at, 0, NULL
              )
              ON CONFLICT(signal_id, horizon_min) DO UPDATE SET
                window_status=excluded.window_status,
                outcome_state=excluded.outcome_state,
                invalid_reason=excluded.invalid_reason,
                attempted_at=excluded.attempted_at,
                computed_at=excluded.computed_at
            `).run({
              signal_id: row.id,
              horizon_min: horizonMin,
              entry_time: Number(row.entry_time) || Number(row.time),
              entry_candle_open_time: Number(row.entry_candle_open_time) || Number(row.time),
              entry_rule: ENTRY_RULE,
              start_time: Number(row.time),
              end_time: Number(row.time) + horizonMin * 60_000,
              interval_min: OUTCOME_INTERVAL_MIN,
              n_candles: 0,
              n_candles_expected: Math.max(1, Math.ceil(horizonMin / OUTCOME_INTERVAL_MIN)),
              coverage_pct: 0,
              attempted_at: Date.now(),
              computed_at: Date.now(),
            });
          } catch {}
          console.warn('[outcomes] compute failed', row.symbol, horizonMin, String(e));
        }
        if (OUTCOME_SLEEP_MS > 0) await sleep(OUTCOME_SLEEP_MS);
      }
    }
    const now2 = Date.now();
    if (OUTCOME_INTEGRITY_MS > 0 && (now2 - lastIntegrityCheckAt) >= OUTCOME_INTEGRITY_MS) {
      lastIntegrityCheckAt = now2;
      try {
        const health = await getStatsHealth({ days: OUTCOME_INTEGRITY_DAYS });
        if (!health.ok) {
          console.warn('[health] resolver_integrity_failed', health);
        }
      } catch (e) {
        console.warn('[health] resolver_integrity_error', String(e));
      }
    }
  } finally {
    const runEnd = Date.now();
    lastOutcomesHealth = {
      startedAt: runStart,
      finishedAt: runEnd,
      durationMs: runEnd - runStart,
      processed,
    };
    outcomesRunning = false;
  }
}

let updaterStarted = false;
let outcomesRunning = false;
let lastIntegrityCheckAt = 0;
let lastOutcomesHealth: {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  processed: number;
} | null = null;

export function getOutcomesHealth() {
  return lastOutcomesHealth;
}

export async function getOutcomesBacklogCount(params: {
  days?: number;
  start?: number;
  end?: number;
} = {}) {
  const d = await getDbReady();
  const { start, end } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });
  const row = await d.prepare(`
    SELECT COUNT(*) as n
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE s.time >= @start AND s.time <= @end
      AND o.window_status != 'COMPLETE'
  `).get({ start, end }) as { n: number };
  return row?.n ?? 0;
}

export function startOutcomeUpdater() {
  if (updaterStarted) return;
  updaterStarted = true;

  updateOutcomesOnce().catch(() => {});
  setInterval(() => {
    updateOutcomesOnce().catch(() => {});
  }, 60_000);
}

export async function getStats(params: {
  days?: number;
  start?: number;
  end?: number;
  category?: string;
  categories?: string[];
  symbol?: string;
  preset?: string;
  strategyVersion?: string;
} = {}) {
  const d = await getDbReady();
  const { start, end, days } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });

  const whereSignals: string[] = [`time >= @start`, `time <= @end`];
  const bind: any = { start, end, resolveVersion: OUTCOME_RESOLVE_VERSION };
  if (params.category) {
    whereSignals.push(`category = @category`);
    bind.category = params.category;
  }
  if (params.categories?.length) {
    whereSignals.push(`category IN (${params.categories.map((_, i) => `@cat_${i}`).join(',')})`);
    params.categories.forEach((c, i) => { bind[`cat_${i}`] = c; });
  }
  if (params.symbol) {
    whereSignals.push(`symbol = @symbol`);
    bind.symbol = params.symbol.toUpperCase();
  }
  if (params.preset) {
    whereSignals.push(`preset = @preset`);
    bind.preset = params.preset;
  }
  if (params.strategyVersion) {
    whereSignals.push(`strategy_version = @strategyVersion`);
    bind.strategyVersion = params.strategyVersion;
  }

  const totals = await d.prepare(`
    SELECT category, COUNT(*) as n
    FROM signals
    WHERE ${whereSignals.join(' AND ')}
    GROUP BY category
    ORDER BY n DESC
  `).all(bind);

  const byCatH = await d.prepare(`
    WITH sig_totals AS (
      SELECT
        category,
        COUNT(*) as totalSignals
      FROM signals
      WHERE time >= @start AND time <= @end
        ${params.category ? 'AND category = @category' : ''}
        ${params.categories?.length ? `AND category IN (${params.categories.map((_, i) => `@cat_${i}`).join(',')})` : ''}
        ${params.symbol ? 'AND symbol = @symbol' : ''}
        ${params.preset ? 'AND preset = @preset' : ''}
        ${params.strategyVersion ? 'AND strategy_version = @strategyVersion' : ''}
      GROUP BY category
    )
    SELECT
      s.category as category,
      o.horizon_min as horizonMin,
      COUNT(o.id) as totalN,
      COALESCE(st.totalSignals, 0) as totalSignals,
      SUM(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN 1 ELSE 0 END) as eligibleN,
      SUM(CASE WHEN o.window_status = 'PARTIAL' THEN 1 ELSE 0 END) as partialN,
      SUM(CASE WHEN o.window_status = 'INVALID' OR o.trade_state = 'INVALIDATED' THEN 1 ELSE 0 END) as invalidN,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.ret_pct END) as avgRetPct,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_close END) as avgR,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_mfe END) as avgRMfe,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_mae END) as avgRMae,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
        THEN CASE WHEN o.exit_reason = 'STOP' THEN 1.0 ELSE 0 END END) as firstHitSlRate,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
        THEN CASE WHEN o.exit_reason = 'TP1' THEN 1.0 ELSE 0 END END) as firstHitTp1Rate,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
        THEN CASE WHEN o.exit_reason = 'TP2' THEN 1.0 ELSE 0 END END) as firstHitTp2Rate,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
        THEN CASE WHEN o.trade_state = 'EXPIRED' THEN 1.0 ELSE 0 END END) as noHitRate,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
        THEN CASE WHEN o.min_low <= s.stop THEN 1.0 ELSE 0 END END) as touchSlRate,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
        THEN CASE WHEN o.max_high >= s.tp1 THEN 1.0 ELSE 0 END END) as touchTp1Rate,
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
        THEN CASE WHEN o.max_high >= s.tp2 THEN 1.0 ELSE 0 END END) as touchTp2Rate
      FROM signal_outcomes o
      JOIN signals s ON s.id = o.signal_id
      LEFT JOIN sig_totals st ON st.category = s.category
      WHERE s.time >= @start AND s.time <= @end
        AND o.resolve_version = @resolveVersion
        ${params.category ? 'AND s.category = @category' : ''}
        ${params.categories?.length ? `AND s.category IN (${params.categories.map((_, i) => `@cat_${i}`).join(',')})` : ''}
        ${params.symbol ? 'AND s.symbol = @symbol' : ''}
        ${params.preset ? 'AND s.preset = @preset' : ''}
        ${params.strategyVersion ? 'AND s.strategy_version = @strategyVersion' : ''}
    GROUP BY s.category, o.horizon_min
    ORDER BY s.category, o.horizon_min
  `).all(bind);

  const topSymbols = await d.prepare(`
    SELECT symbol, COUNT(*) as n
    FROM signals
    WHERE ${whereSignals.join(' AND ')}
    GROUP BY symbol
    ORDER BY n DESC
    LIMIT 20
  `).all(bind);

  return {
    start,
    end,
    days,
    categoriesLogged: SIGNAL_LOG_CATS,
    totals,
    byCategoryAndHorizon: byCatH,
    topSymbols,
  };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function listStrategyVersions(params: {
  days?: number;
  start?: number;
  end?: number;
} = {}) {
  const d = await getDbReady();
  const { start, end, days } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });
  const rows = await d.prepare(`
    SELECT strategy_version as "version", COUNT(*) as "n", MAX(updated_at) as "latestAt"
    FROM signals
    WHERE time >= @start AND time <= @end
      AND strategy_version IS NOT NULL
      AND strategy_version != ''
    GROUP BY strategy_version
    ORDER BY "latestAt" DESC
  `).all({ start, end }) as Array<{ version: string; n: number; latestAt: number }>;
  const latest = rows[0]?.version ?? null;
  return { start, end, days, latest, versions: rows };
}

export async function getStatsHealth(params: { days?: number } = {}) {
  const d = await getDbReady();
  const now = Date.now();
  const days = Number.isFinite(params.days) ? Number(params.days) : undefined;
  const start = days ? (now - days * 24 * 60 * 60_000) : 0;
  const resolvedWhere = days ? `AND (resolved_at >= @start OR resolved_at IS NULL)` : '';
  const bind: any = days ? { start } : {};

  const staleComplete = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signal_outcomes
    WHERE outcome_state LIKE 'COMPLETE_%'
      AND COALESCE(resolve_version,'') <> @ver
      ${resolvedWhere}
  `).get({ ...bind, ver: OUTCOME_RESOLVE_VERSION }) as { n: number };

  const missing = await d.prepare(`
    SELECT
      SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS missing_resolved_at,
      SUM(CASE WHEN resolve_version IS NULL THEN 1 ELSE 0 END) AS missing_resolve_version
    FROM signal_outcomes
    WHERE outcome_state LIKE 'COMPLETE_%'
      ${resolvedWhere}
  `).get(bind) as { missing_resolved_at: number | null; missing_resolve_version: number | null };

  const badBars = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signal_outcomes
    WHERE outcome_state LIKE 'COMPLETE_%'
      AND (bars_to_exit IS NULL OR bars_to_exit <= 0 OR bars_to_exit > n_candles)
      ${resolvedWhere}
  `).get(bind) as { n: number };

  const badTimeout = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signal_outcomes
    WHERE outcome_state = 'COMPLETE_TIMEOUT_NO_HIT'
      AND bars_to_exit <> n_candles
      ${resolvedWhere}
  `).get(bind) as { n: number };

  const badTimeoutExitTime = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signal_outcomes
    WHERE outcome_state = 'COMPLETE_TIMEOUT_NO_HIT'
      AND exit_time <> end_time
      ${resolvedWhere}
  `).get(bind) as { n: number };

  const badTimeoutMinusOneCandle = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signal_outcomes
    WHERE exit_reason = 'TIMEOUT'
      AND ABS(((exit_time - entry_time) / 60000.0) - (horizon_min - interval_min)) < 0.0001
      ${resolvedWhere}
  `).get(bind) as { n: number };

  const badExpired15mMinusOneCandle = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signal_outcomes
    WHERE exit_reason = 'EXPIRED_AFTER_15M'
      AND ABS(((exit_time - entry_time) / 60000.0) - (15 - interval_min)) < 0.0001
      ${resolvedWhere}
  `).get(bind) as { n: number };

  const bindSignals: any = days ? { start } : {};
  const blockedBtcMissingReason = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signals
    WHERE blocked_by_btc = 1
      AND (
        blocked_reasons_json IS NULL
        OR blocked_reasons_json = ''
        OR blocked_reasons_json NOT LIKE '%BTC%'
      )
      ${days ? 'AND time >= @start' : ''}
  `).get(bindSignals) as { n: number };

  const badAmbiguous = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signal_outcomes
    WHERE outcome_state = 'COMPLETE_AMBIGUOUS_TP_AND_SL_SAME_CANDLE'
      AND COALESCE(ambiguous,0) <> 1
      ${resolvedWhere}
  `).get(bind) as { n: number };

  const badAmbiguousMissingHits = await d.prepare(`
    SELECT COUNT(*) AS n
    FROM signal_outcomes
    WHERE outcome_state = 'COMPLETE_AMBIGUOUS_TP_AND_SL_SAME_CANDLE'
      AND (sl_hit_time IS NULL OR (tp1_hit_time IS NULL AND tp2_hit_time IS NULL))
      ${resolvedWhere}
  `).get(bind) as { n: number };

  const checks = {
    stale_complete: staleComplete?.n ?? 0,
    missing_resolved_at: Number(missing?.missing_resolved_at || 0),
    missing_resolve_version: Number(missing?.missing_resolve_version || 0),
    bad_bars_to_exit: badBars?.n ?? 0,
    bad_timeout_rows: badTimeout?.n ?? 0,
    bad_timeout_exit_time: badTimeoutExitTime?.n ?? 0,
    bad_timeout_minus_one_candle: badTimeoutMinusOneCandle?.n ?? 0,
    bad_expired15m_minus_one_candle: badExpired15mMinusOneCandle?.n ?? 0,
    bad_ambiguous_rows: badAmbiguous?.n ?? 0,
    bad_ambiguous_missing_hits: badAmbiguousMissingHits?.n ?? 0,
    blocked_btc_missing_reason: blockedBtcMissingReason?.n ?? 0,
  };

  const ok = Object.values(checks).every(n => n === 0);
  return { ok, currentResolveVersion: OUTCOME_RESOLVE_VERSION, checks, days: days ?? null };
}

export async function getStatsSummary(params: {
  days?: number;
  start?: number;
  end?: number;
  preset?: string;
  strategyVersion?: string;
  category?: string;
  categories?: string[];
  symbol?: string;
  horizonMin?: number;
  blockedByBtc?: boolean;
  btcState?: string;
} = {}) {
  const d = await getDbReady();
  const { start, end, days } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });

  const whereSignals: string[] = [`s.time >= @start`, `s.time <= @end`];
  const bind: any = { start, end };
  applySignalFilters(whereSignals, bind, params, 's');

  const whereOutcomes = [...whereSignals];
  if (Number.isFinite(params.horizonMin)) {
    whereOutcomes.push(`o.horizon_min = @horizonMin`);
    bind.horizonMin = params.horizonMin;
  }
  whereOutcomes.push(`o.resolve_version = @resolveVersion`);
  bind.resolveVersion = OUTCOME_RESOLVE_VERSION;

  const totalSignalsRow = await d.prepare(`
    SELECT COUNT(*) as n
    FROM signals s
    WHERE ${whereSignals.join(' AND ')}
  `).get(bind) as { n: number } | undefined;
  const totalSignals = Number(totalSignalsRow?.n ?? 0);

  let eligibleSignals: number | null = null;
  let immatureSignals: number | null = null;
  let eligibleCutoff: number | null = null;
  if (Number.isFinite(params.horizonMin)) {
    const horizonMin = Number(params.horizonMin);
    const rangeEnd = Math.min(end, Date.now());
    eligibleCutoff = rangeEnd - horizonMin * 60_000;
    const eligibleWhere = [...whereSignals, `s.time <= @eligibleCutoff`];
    const eligibleRow = await d.prepare(`
      SELECT COUNT(*) as n
      FROM signals s
      WHERE ${eligibleWhere.join(' AND ')}
    `).get({ ...bind, eligibleCutoff }) as { n: number } | undefined;
    eligibleSignals = Number(eligibleRow?.n ?? 0);
    immatureSignals = Math.max(0, totalSignals - eligibleSignals);
  }

  const totals = await d.prepare(`
    SELECT s.category as category, COUNT(*) as n
    FROM signals s
    WHERE ${whereSignals.join(' AND ')}
    GROUP BY s.category
    ORDER BY n DESC
  `).all(bind);

  const agg = await d.prepare(`
    SELECT
      SUM(CASE WHEN o.outcome_state LIKE 'COMPLETE_%'
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN 1 ELSE 0 END) as "completeN",
      SUM(CASE WHEN o.window_status = 'PARTIAL' THEN 1 ELSE 0 END) as "partialN",
      SUM(CASE WHEN o.window_status = 'INVALID' OR o.trade_state = 'INVALIDATED' THEN 1 ELSE 0 END) as "invalidN",
      SUM(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0 AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2') THEN 1 ELSE 0 END) as "winN",
      SUM(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0 AND o.trade_state = 'FAILED_SL' THEN 1 ELSE 0 END) as "lossN",
      SUM(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0 AND o.trade_state = 'EXPIRED' THEN 1 ELSE 0 END) as "noneN",
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_close END) as "avgR",
      SUM(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_close END) as "netR",
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.mfe_pct END) as "avgMfePct",
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.mae_pct END) as "avgMaePct"
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${whereOutcomes.join(' AND ')}
    `).get(bind) as any;

  const sampleRows = await d.prepare(`
    SELECT
      o.r_close as "rClose",
      o.time_to_first_hit_ms as "timeToFirstHitMs",
      o.exit_reason as "exitReason"
      FROM signal_outcomes o
      JOIN signals s ON s.id = o.signal_id
      WHERE ${whereOutcomes.join(' AND ')}
        AND o.outcome_state LIKE 'COMPLETE_%'
        AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
    `).all(bind) as Array<{ rClose: number; timeToFirstHitMs: number; exitReason: string | null }>;

  const rVals = sampleRows.map(r => Number((r as any).rClose)).filter(n => Number.isFinite(n));
  const tp1Times = sampleRows
    .filter(r => r.exitReason === 'TP1' || r.exitReason === 'TP2')
    .map(r => Number(r.timeToFirstHitMs))
    .filter(n => Number.isFinite(n) && n > 0);

  const medianR = median(rVals);
  const medianTimeToTp1 = median(tp1Times);

  const winLossAgg = await d.prepare(`
    SELECT
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2') THEN o.r_close END) as "avgWinR",
      AVG(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state = 'FAILED_SL' THEN o.r_close END) as "avgLossR",
      SUM(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2') THEN o.r_close END) as "sumWinR",
      SUM(CASE WHEN o.outcome_state LIKE 'COMPLETE_%' AND o.invalid_levels = 0
        AND o.trade_state = 'FAILED_SL' THEN o.r_close END) as "sumLossR"
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${whereOutcomes.join(' AND ')}
  `).get(bind) as any;

  const seriesRows = await d.prepare(`
    SELECT
      s.entry_time as "entryTime",
      o.r_close as "rClose",
      o.trade_state as "tradeState"
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${whereOutcomes.join(' AND ')}
      AND o.outcome_state LIKE 'COMPLETE_%'
      AND o.invalid_levels = 0
      AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
    ORDER BY s.entry_time ASC
  `).all(bind) as Array<{ entryTime: number; rClose: number; tradeState: string }>;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  for (const row of seriesRows) {
    const r = Number(row.rClose);
    if (Number.isFinite(r)) {
      equity += r;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    if (row.tradeState === 'COMPLETED_TP1' || row.tradeState === 'COMPLETED_TP2') {
      winStreak += 1;
      lossStreak = 0;
    } else if (row.tradeState === 'FAILED_SL') {
      lossStreak += 1;
      winStreak = 0;
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
    if (winStreak > maxWinStreak) maxWinStreak = winStreak;
    if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;
  }

  const lossRows = await d.prepare(`
    SELECT
      o.r_close as "rClose",
      o.outcome_driver as "outcomeDriver",
      o.exit_reason as "exitReason",
      s.first_failed_gate as "firstFailedGate",
      s.blocked_reasons_json as "blockedReasonsJson"
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${whereOutcomes.join(' AND ')}
      AND o.outcome_state LIKE 'COMPLETE_%'
      AND o.invalid_levels = 0
      AND o.trade_state = 'FAILED_SL'
  `).all(bind) as Array<{ rClose: number; outcomeDriver?: string | null; exitReason?: string | null; firstFailedGate?: string | null; blockedReasonsJson?: string | null }>;

  const driverPriority = [
    'RR_BELOW_MIN',
    'VWAP_TOO_FAR',
    'NO_SWEEP',
    'VOL_SPIKE_NOT_MET',
    'RSI_NOT_IN_WINDOW',
    'BTC_CONTRA_TREND',
    'SESSION_OFF',
    'OTHER',
  ];
  const driverMatch = (reasons: string[] | null) => {
    if (!reasons?.length) return null;
    const joined = reasons.join(' | ').toLowerCase();
    const has = (s: string) => joined.includes(s);
    if (has('r:r') || has('rr')) return 'RR_BELOW_MIN';
    if (has('vwap')) return 'VWAP_TOO_FAR';
    if (has('sweep')) return 'NO_SWEEP';
    if (has('vol')) return 'VOL_SPIKE_NOT_MET';
    if (has('rsi')) return 'RSI_NOT_IN_WINDOW';
    if (has('btc')) return 'BTC_CONTRA_TREND';
    if (has('session')) return 'SESSION_OFF';
    return null;
  };
  const driverFromGate = (gate: string | null | undefined) => {
    if (!gate) return null;
    const g = gate.toLowerCase();
    if (g.includes('rr')) return 'RR_BELOW_MIN';
    if (g.includes('vwap')) return 'VWAP_TOO_FAR';
    if (g.includes('sweep')) return 'NO_SWEEP';
    if (g.includes('vol')) return 'VOL_SPIKE_NOT_MET';
    if (g.includes('rsi')) return 'RSI_NOT_IN_WINDOW';
    if (g.includes('btc')) return 'BTC_CONTRA_TREND';
    if (g.includes('session')) return 'SESSION_OFF';
    return null;
  };

  const lossDriverMap = new Map<string, { driver: string; count: number; netR: number }>();
  for (const row of lossRows) {
    const reasons = safeJsonParse<string[]>(row.blockedReasonsJson) ?? null;
    const driver =
      row.outcomeDriver ||
      driverMatch(reasons) ||
      driverFromGate(row.firstFailedGate ?? null) ||
      row.exitReason ||
      'OTHER';
    const key = driverPriority.includes(driver) ? driver : String(driver || 'OTHER');
    const entry = lossDriverMap.get(key) ?? { driver: key, count: 0, netR: 0 };
    entry.count += 1;
    entry.netR += Number.isFinite(Number(row.rClose)) ? Number(row.rClose) : 0;
    lossDriverMap.set(key, entry);
  }
  const lossDrivers = Array.from(lossDriverMap.values())
    .map((d) => ({ ...d, avgR: d.count ? d.netR / d.count : 0 }))
    .sort((a, b) => (b.count - a.count) || (b.netR - a.netR));

  const btcOverrideRows = await d.prepare(`
    SELECT
      CASE WHEN s.category = 'READY_TO_BUY' AND s.btc_bear = 1 THEN 1 ELSE 0 END as "overrideOn",
      COUNT(*) as n,
      SUM(CASE WHEN o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2') THEN 1 ELSE 0 END) as winN,
      SUM(CASE WHEN o.trade_state = 'FAILED_SL' THEN 1 ELSE 0 END) as lossN,
      SUM(CASE WHEN o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_close END) as netR,
      AVG(CASE WHEN o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_close END) as avgR
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${whereOutcomes.join(' AND ')}
      AND o.outcome_state LIKE 'COMPLETE_%'
      AND o.invalid_levels = 0
      AND s.category = 'READY_TO_BUY'
    GROUP BY 1
  `).all(bind) as any[];

  const perfByHourRows = await d.prepare(`
    SELECT
      CAST(s.entry_time / 3600000 AS BIGINT) * 3600000 as "hourStart",
      COUNT(*) as n,
      SUM(CASE WHEN o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2') THEN 1 ELSE 0 END) as winN,
      SUM(CASE WHEN o.trade_state = 'FAILED_SL' THEN 1 ELSE 0 END) as lossN,
      SUM(CASE WHEN o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_close END) as netR,
      AVG(CASE WHEN o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED') THEN o.r_close END) as avgR
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${whereOutcomes.join(' AND ')}
      AND o.outcome_state LIKE 'COMPLETE_%'
      AND o.invalid_levels = 0
      AND o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')
    GROUP BY 1
    ORDER BY 1
  `).all(bind) as any[];

  const signalsPerHour = await d.prepare(`
    SELECT
      CAST(s.time / 3600000 AS BIGINT) * 3600000 as "hourStart",
      COUNT(*) as n
    FROM signals s
    WHERE ${whereSignals.join(' AND ')}
    GROUP BY 1
    ORDER BY 1
  `).all(bind);

    return {
    start,
    end,
    days,
    currentResolveVersion: OUTCOME_RESOLVE_VERSION,
    totalSignals,
    eligibleSignals,
    immatureSignals,
    eligibleCutoff,
    totals,
    outcomes: {
      completeN: agg?.completeN ?? 0,
      partialN: agg?.partialN ?? 0,
      invalidN: agg?.invalidN ?? 0,
      winN: agg?.winN ?? 0,
      lossN: agg?.lossN ?? 0,
      noneN: agg?.noneN ?? 0,
      avgR: agg?.avgR ?? null,
      netR: agg?.netR ?? null,
      medianR,
      medianTimeToTp1Ms: medianTimeToTp1,
      avgMfePct: agg?.avgMfePct ?? null,
      avgMaePct: agg?.avgMaePct ?? null,
      winRate: (agg?.completeN ?? 0) ? (Number(agg?.winN ?? 0) / Number(agg?.completeN ?? 0)) : 0,
      avgWinR: winLossAgg?.avgWinR ?? null,
      avgLossR: winLossAgg?.avgLossR ?? null,
      expectancy: agg?.avgR ?? null,
      profitFactor: (Number(winLossAgg?.sumLossR) < 0)
        ? (Number(winLossAgg?.sumWinR) / Math.abs(Number(winLossAgg?.sumLossR)))
        : null,
      maxDrawdownR: maxDrawdown,
      longestWinStreak: maxWinStreak,
      longestLossStreak: maxLossStreak,
      tradesN: seriesRows.length,
    },
    signalsPerHour,
    lossDrivers,
    btcOverride: btcOverrideRows,
    performanceByHour: perfByHourRows,
  };
}

export async function getStatsMatrixBtc(params: {
  days?: number;
  start?: number;
  end?: number;
  preset?: string;
  strategyVersion?: string;
  category?: string;
  categories?: string[];
  symbol?: string;
  horizonMin?: number;
  blockedByBtc?: boolean;
  btcState?: string;
} = {}) {
  const d = await getDbReady();
  const { start, end, days } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });
  const where: string[] = [`s.time >= @start`, `s.time <= @end`];
  const bind: any = { start, end };
  applySignalFilters(where, bind, params, 's');
  if (Number.isFinite(params.horizonMin)) {
    where.push(`o.horizon_min = @horizonMin`);
    bind.horizonMin = params.horizonMin;
  }
  where.push(`o.resolve_version = @resolveVersion`);
  bind.resolveVersion = OUTCOME_RESOLVE_VERSION;
  where.push(`o.outcome_state LIKE 'COMPLETE_%'`);
  where.push(`o.invalid_levels = 0`);
  where.push(`o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')`);

  const rows = await d.prepare(`
    SELECT
      CASE
        WHEN s.btc_bull = 1 THEN 'BULL'
        WHEN s.btc_bear = 1 THEN 'BEAR'
        ELSE 'NEUTRAL'
      END as "btcState",
      s.category as "category",
      COUNT(*) as "n",
      AVG(CASE WHEN o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2') THEN 1.0 ELSE 0 END) as "winRate",
      AVG(CASE WHEN o.exit_reason = 'STOP' THEN 1.0 ELSE 0 END) as "stopRate",
      SUM(o.r_close) as "netR",
      AVG(o.r_close) as "avgR"
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
    GROUP BY "btcState", s.category
    ORDER BY "btcState", s.category
  `).all(bind);

    return { start, end, days, currentResolveVersion: OUTCOME_RESOLVE_VERSION, rows };
}

export async function getStatsBuckets(params: {
  days?: number;
  start?: number;
  end?: number;
  preset?: string;
  strategyVersion?: string;
  category?: string;
  categories?: string[];
  symbol?: string;
  horizonMin?: number;
  blockedByBtc?: boolean;
  btcState?: string;
} = {}) {
  const d = await getDbReady();
  const { start, end, days } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });
  const where: string[] = [
    `s.time >= @start`,
    `s.time <= @end`,
    `o.resolve_version = @resolveVersion`,
    `o.outcome_state LIKE 'COMPLETE_%'`,
    `o.invalid_levels = 0`,
    `o.trade_state IN ('COMPLETED_TP1','COMPLETED_TP2','FAILED_SL','EXPIRED')`,
  ];
  const bind: any = { start, end, resolveVersion: OUTCOME_RESOLVE_VERSION };
  applySignalFilters(where, bind, params, 's');
  if (Number.isFinite(params.horizonMin)) {
    where.push(`o.horizon_min = @horizonMin`);
    bind.horizonMin = params.horizonMin;
  }

  const rows = await d.prepare(`
    SELECT
      s.deltaVwapPct as "deltaVwapPct",
      s.rsi9 as "rsi9",
      s.atrPct as "atrPct",
      s.volSpike as "volSpike",
      s.rr as "rr",
      o.r_close as "rClose",
      o.trade_state as "tradeState"
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
  `).all(bind) as Array<{
    deltaVwapPct: number;
    rsi9: number;
    atrPct: number;
    volSpike: number;
    rr: number;
    rClose: number;
    tradeState: string;
  }>;

  const bucketEdges = {
    deltaVwapPct: [-1, -0.5, 0, 0.25, 0.5, 1, 2, 3],
    rsi9: [40, 45, 50, 55, 60, 65, 70, 75, 80],
    atrPct: [0.1, 0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0, 4.0],
    volSpike: [1, 1.2, 1.5, 2, 3, 5],
    rr: [0.5, 1, 1.5, 2, 2.5, 3, 4],
  } as const;

  function bucketLabel(edges: number[], idx: number) {
    if (idx <= 0) return `<${edges[0]}`;
    if (idx >= edges.length) return `>=${edges[edges.length - 1]}`;
    return `${edges[idx - 1]}-${edges[idx]}`;
  }

  function bucketize(value: number, edges: number[]) {
    if (!Number.isFinite(value)) return null;
    let idx = 0;
    while (idx < edges.length && value >= edges[idx]) idx++;
    return idx;
  }

  function buildBuckets(key: keyof typeof bucketEdges) {
    const edges = bucketEdges[key];
    const buckets = new Map<number, { label: string; count: number; win: number; netR: number }>();
    for (let i = 0; i <= edges.length; i++) {
      buckets.set(i, { label: bucketLabel(edges as unknown as number[], i), count: 0, win: 0, netR: 0 });
    }

    for (const row of rows) {
      const idx = bucketize(Number(row[key]), edges as unknown as number[]);
      if (idx == null) continue;
      const b = buckets.get(idx)!;
      b.count += 1;
      if ((row.tradeState === 'COMPLETED_TP1' || row.tradeState === 'COMPLETED_TP2')) b.win += 1;
      if (Number.isFinite(row.rClose)) b.netR += Number(row.rClose);
    }

    const out = Array.from(buckets.values()).map(b => ({
      label: b.label,
      count: b.count,
      winPct: b.count ? (b.win / b.count) : 0,
      netR: b.netR,
      avgR: b.count ? b.netR / b.count : 0,
    }));

    return out;
  }

    return {
      start,
      end,
      days,
      currentResolveVersion: OUTCOME_RESOLVE_VERSION,
      buckets: {
        deltaVwapPct: buildBuckets('deltaVwapPct'),
        rsi9: buildBuckets('rsi9'),
        atrPct: buildBuckets('atrPct'),
        volSpike: buildBuckets('volSpike'),
        rr: buildBuckets('rr'),
      },
    };
}

export async function getInvalidReasons(params: {
  days?: number;
  start?: number;
  end?: number;
  preset?: string;
  strategyVersion?: string;
  category?: string;
  categories?: string[];
  symbol?: string;
  horizonMin?: number;
  blockedByBtc?: boolean;
  btcState?: string;
} = {}) {
  const d = await getDbReady();
  const { start, end, days } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });
  const where: string[] = [`s.time >= @start`, `s.time <= @end`];
  const bind: any = { start, end };
  applySignalFilters(where, bind, params, 's');
  if (Number.isFinite(params.horizonMin)) {
    where.push(`o.horizon_min = @horizonMin`);
    bind.horizonMin = params.horizonMin;
  }
  where.push(`o.window_status IN ('PARTIAL', 'INVALID')`);

  const rows = await d.prepare(`
    SELECT
      o.window_status as status,
      COALESCE(o.invalid_reason, '') as reason,
      COUNT(*) as n
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
    GROUP BY o.window_status, o.invalid_reason
    ORDER BY n DESC
  `).all(bind);

  return { start, end, days, rows };
}

export async function listOutcomes(params: {
  days?: number;
  start?: number;
  end?: number;
  limit?: number;
  offset?: number;
  category?: string;
  categories?: string[];
  horizonMin?: number;
  symbol?: string;
  preset?: string;
  strategyVersion?: string;
  blockedByBtc?: boolean;
  btcState?: string;
  windowStatus?: string;
  result?: string;
  invalidReason?: string;
  sort?: string;
}) {
  const d = await getDbReady();

  const { start, end, days } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });
  const limit = Math.max(1, Math.min(1000, params.limit ?? 200));
  const offset = Math.max(0, Math.min(50_000, params.offset ?? 0));

  const where: string[] = [`s.time >= @start`, `s.time <= @end`];
  const bind: any = { start, end, limit, offset };

  if (params.category) {
    where.push(`s.category = @category`);
    bind.category = params.category;
  }
  if (params.categories?.length) {
    where.push(`s.category IN (${params.categories.map((_, i) => `@cat_${i}`).join(',')})`);
    params.categories.forEach((c, i) => { bind[`cat_${i}`] = c; });
  }
  if (params.symbol) {
    where.push(`s.symbol = @symbol`);
    bind.symbol = params.symbol.toUpperCase();
  }
  if (params.preset) {
    where.push(`s.preset = @preset`);
    bind.preset = params.preset;
  }
  if (params.strategyVersion) {
    where.push(`s.strategy_version = @strategyVersion`);
    bind.strategyVersion = params.strategyVersion;
  }
  if (params.blockedByBtc != null) {
    where.push(`s.blocked_by_btc = @blockedByBtc`);
    bind.blockedByBtc = params.blockedByBtc ? 1 : 0;
  }
  if (params.btcState) {
    const state = String(params.btcState).toUpperCase();
    if (state === 'BULL') where.push(`s.btc_bull = 1`);
    else if (state === 'BEAR') where.push(`s.btc_bear = 1`);
    else if (state === 'NEUTRAL') where.push(`(s.btc_bull IS NULL OR s.btc_bull = 0) AND (s.btc_bear IS NULL OR s.btc_bear = 0)`);
  }
  if (Number.isFinite(params.horizonMin)) {
    where.push(`o.horizon_min = @horizonMin`);
    bind.horizonMin = params.horizonMin;
  }
  if (params.windowStatus) {
    where.push(`o.window_status = @windowStatus`);
    bind.windowStatus = params.windowStatus;
  }
  if (params.result) {
    where.push(`o.result = @result`);
    bind.result = params.result;
  }
  if (params.invalidReason) {
    where.push(`o.invalid_reason = @invalidReason`);
    bind.invalidReason = params.invalidReason;
  }

  const sort = String(params.sort || 'time_desc').toLowerCase();
  let orderBy = `
    (CASE WHEN o.computed_at > 0 THEN o.computed_at ELSE s.time END) DESC,
    s.time DESC
  `;
  if (sort === 'r_desc') {
    orderBy = `o.r_close DESC, s.time DESC`;
  } else if (sort === 'mfe_desc') {
    orderBy = `o.mfe_pct DESC, s.time DESC`;
  } else if (sort === 'mae_desc') {
    orderBy = `o.mae_pct ASC, s.time DESC`;
  } else if (sort === 'time_asc') {
    orderBy = `s.time ASC`;
  }

  const sql = `
    SELECT
      s.id as "signalId",
      s.symbol, s.category, s.time, s.preset, s.strategy_version as "strategyVersion",
      s.blocked_by_btc as "blockedByBtc", s.would_be_category as "wouldBeCategory",
      s.gate_score as "gateScore",
      s.first_failed_gate as "firstFailedGate",
      s.blocked_reasons_json as "blockedReasonsJson",
      s.btc_bull as "btcBull", s.btc_bear as "btcBear",
      s.price, s.stop, s.tp1, s.tp2, s.target, s.rr, s.riskPct as "riskPct",
      o.horizon_min as "horizonMin",
      o.entry_time as "entryTime",
      o.entry_candle_open_time as "entryCandleOpenTime",
      o.entry_rule as "entryRule",
      o.start_time as "startTime",
      o.end_time as "endTime",
      o.interval_min as "intervalMin",
      o.n_candles as "nCandles",
      o.n_candles_expected as "nCandlesExpected",
      o.coverage_pct as "coveragePct",
      o.entry_price as "entryPrice",
      o.open_price as "openPrice",
      o.close_price as "closePrice",
      o.max_high as "maxHigh",
      o.min_low as "minLow",
      o.ret_pct as "retPct",
      o.r_close as "rClose",
      o.r_mfe as "rMfe",
      o.r_mae as "rMae",
      o.r_realized as "rRealized",
      o.hit_sl as "hitSL",
      o.hit_tp1 as "hitTP1",
      o.hit_tp2 as "hitTP2",
      o.tp1_hit_time as "tp1HitTime",
      o.sl_hit_time as "slHitTime",
      o.tp2_hit_time as "tp2HitTime",
      o.time_to_first_hit_ms as "timeToFirstHitMs",
      o.bars_to_exit as "barsToExit",
      o.mfe_pct as "mfePct",
      o.mae_pct as "maePct",
      o.result as "result",
      o.exit_reason as "exitReason",
      o.outcome_driver as "outcomeDriver",
      o.trade_state as "tradeState",
      o.exit_price as "exitPrice",
      o.exit_time as "exitTime",
      o.window_status as "windowStatus",
      o.outcome_state as "outcomeState",
      o.invalid_levels as "invalidLevels",
      o.invalid_reason as "invalidReason",
      o.ambiguous as "ambiguous",
      o.attempted_at as "attemptedAt",
      o.computed_at as "computedAt",
      o.resolved_at as "resolvedAt",
      o.resolve_version as "resolveVersion"
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `;

  const rawRows = await d.prepare(sql).all(bind) as any[];
  const rows = rawRows.map((r) => {
    const intervalMin = Number(r.intervalMin);
    const horizonMin = Number(r.horizonMin);
    const expected = Number(r.nCandlesExpected);
    const neededCandles = Number.isFinite(expected) && expected > 0
      ? expected
      : (intervalMin > 0 ? Math.ceil(horizonMin / intervalMin) : 0);
    const coveragePct = Number.isFinite(Number(r.coveragePct))
      ? Number(r.coveragePct)
      : (neededCandles > 0 ? (Number(r.nCandles) / neededCandles) * 100 : 0);
    const blockedReasons = safeJsonParse<string[]>(r.blockedReasonsJson) ?? null;
    return { ...r, neededCandles, coveragePct, blockedReasons };
  });

  const countSql = `
    SELECT COUNT(*) as n
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
  `;
  const totalRow = await d.prepare(countSql).get(bind) as { n: number };

  return { start, end, days, limit, offset, total: totalRow.n, rows };
}

export async function listRecentOutcomes(params: {
  hours?: number;
  limit?: number;
  filter?: string[];
  result?: string[];
  category?: string;
  categories?: string[];
  configHash?: string;
}) {
  const d = await getDbReady();
  const hours = Math.max(1, Math.min(168, Number(params.hours) || 6));
  const start = Date.now() - hours * 60 * 60_000;
  const limit = Math.max(1, Math.min(500, Number(params.limit) || 200));
  const filter = (params.result ?? params.filter ?? []).map(s => s.trim()).filter(Boolean);
  const categories = params.categories?.length
    ? params.categories
    : (params.category ? [params.category] : []);
  const configHash = String(params.configHash || '').trim();

  const where: string[] = [`COALESCE(NULLIF(s.entry_time, 0), s.time) >= @start`];
  const bind: Record<string, any> = { start, limit };

  if (categories.length) {
    const keys = categories.map((_, i) => `@cat_${i}`);
    categories.forEach((v, i) => { bind[`cat_${i}`] = v; });
    where.push(`s.category IN (${keys.join(',')})`);
  }

  if (filter.length) {
    const keys = filter.map((_, i) => `@f_${i}`);
    filter.forEach((v, i) => { bind[`f_${i}`] = v; });
    where.push(`(
      o.exit_reason IN (${keys.join(',')})
      OR o.result IN (${keys.join(',')})
      OR o.window_status IN (${keys.join(',')})
      OR o.outcome_state IN (${keys.join(',')})
    )`);
  }
  if (configHash) {
    where.push(`s.config_hash = @configHash`);
    bind.configHash = configHash;
  }

  const rows = await d.prepare(`
    SELECT
      s.id as "signalId",
      s.symbol as "symbol",
      s.category as "category",
      s.time as "time",
      s.entry_time as "entryTime",
      s.entry_candle_open_time as "entryCandleOpenTime",
      s.entry_rule as "entryRule",
      s.price as "price",
      s.stop as "stop",
      s.tp1 as "tp1",
      s.tp2 as "tp2",
      s.target as "target",
      s.config_hash as "configHash",
      s.confirm15_strict as "confirm15Strict",
      s.confirm15_soft as "confirm15Soft",
      s.gate_snapshot_json as "gateSnapshotJson",
      s.ready_debug_json as "readyDebugJson",
      s.best_debug_json as "bestDebugJson",
      s.entry_debug_json as "entryDebugJson",
      s.config_snapshot_json as "configSnapshotJson",
      s.build_git_sha as "buildGitSha",
      s.run_id as "runId",
      s.instance_id as "instanceId",
      o.horizon_min as "horizonMin",
      o.window_status as "windowStatus",
      o.outcome_state as "outcomeState",
      o.result as "result",
      o.exit_reason as "exitReason",
      o.mfe_pct as "mfePct",
      o.mae_pct as "maePct",
      o.bars_to_exit as "barsToExit",
      o.outcome_debug_json as "outcomeDebugJson"
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.time DESC
    LIMIT @limit
  `).all(bind) as any[];

  return rows.map((r) => ({
    ...r,
    gateSnapshot: safeJsonParse<any>(r.gateSnapshotJson),
    readyDebug: safeJsonParse<any>(r.readyDebugJson),
    bestDebug: safeJsonParse<any>(r.bestDebugJson),
    entryDebug: safeJsonParse<any>(r.entryDebugJson),
    configSnapshot: safeJsonParse<any>(r.configSnapshotJson),
    outcomeDebug: safeJsonParse<any>(r.outcomeDebugJson),
  }));
}

export async function getOutcomesReport(params: { hours?: number; configHash?: string }) {
  const d = await getDbReady();
  const hours = Math.max(1, Math.min(168, Number(params.hours) || 6));
  const start = Date.now() - hours * 60 * 60_000;
  const configHash = String(params.configHash || '').trim();

  const where: string[] = [`COALESCE(NULLIF(s.entry_time, 0), s.time) >= @start`];
  const bind: any = { start };
  if (configHash) {
    where.push(`s.config_hash = @configHash`);
    bind.configHash = configHash;
  }

  const totals = await d.prepare(`
    SELECT
      COUNT(1) as total,
      SUM(CASE WHEN o.window_status = 'COMPLETE' THEN 1 ELSE 0 END) as completeN,
      SUM(CASE WHEN o.window_status = 'PARTIAL' THEN 1 ELSE 0 END) as partialN,
      SUM(CASE WHEN o.window_status = 'INVALID' OR o.trade_state = 'INVALIDATED' THEN 1 ELSE 0 END) as invalidN,
      SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) as winN,
      SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END) as lossN,
      SUM(CASE WHEN o.result = 'NONE' THEN 1 ELSE 0 END) as noneN,
      AVG(CASE WHEN o.window_status = 'COMPLETE' THEN o.mfe_pct END) as avgMfePct,
      AVG(CASE WHEN o.window_status = 'COMPLETE' THEN o.mae_pct END) as avgMaePct,
      AVG(CASE WHEN o.window_status = 'COMPLETE' THEN o.bars_to_exit END) as avgBars,
      AVG(CASE WHEN o.window_status = 'COMPLETE' THEN o.r_close END) as avgR
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
  `).get(bind) as any;

  const exitReasons = await d.prepare(`
    SELECT o.exit_reason as reason, COUNT(1) as n
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
      AND o.window_status = 'COMPLETE'
      AND o.exit_reason IS NOT NULL
    GROUP BY o.exit_reason
    ORDER BY n DESC
    LIMIT 10
  `).all(bind) as any[];

  const byConfirm15 = await d.prepare(`
    SELECT
      s.confirm15_strict as confirm15Strict,
      SUM(CASE WHEN o.result = 'WIN' THEN 1 ELSE 0 END) as winN,
      SUM(CASE WHEN o.result = 'LOSS' THEN 1 ELSE 0 END) as lossN,
      SUM(CASE WHEN o.result = 'NONE' THEN 1 ELSE 0 END) as noneN,
      COUNT(1) as total
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
      AND o.window_status = 'COMPLETE'
    GROUP BY s.confirm15_strict
  `).all(bind) as any[];

  const vwapByResult = await d.prepare(`
    SELECT
      AVG(CASE WHEN o.result = 'WIN' THEN s.deltaVwapPct END) as winAvgDeltaVwap,
      AVG(CASE WHEN o.result = 'LOSS' THEN s.deltaVwapPct END) as lossAvgDeltaVwap,
      AVG(CASE WHEN o.result = 'NONE' THEN s.deltaVwapPct END) as noneAvgDeltaVwap
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
      AND o.window_status = 'COMPLETE'
  `).get(bind) as any;

  return {
    hours,
    start,
    totals,
    exitReasons,
    byConfirm15,
    vwapByResult,
  };
}

async function markOutcomeSkips(items: Array<{ signalId: number; horizonMin: number }>, reason = 'user_delete') {
  if (!items.length) return 0;
  const d = await getDbReady();
  const stmt = d.prepare(`
    INSERT OR IGNORE INTO outcome_skips(signal_id, horizon_min, reason, created_at)
    VALUES(?, ?, ?, ?)
  `);
  let inserted = 0;
  const now = Date.now();
  for (const r of items) {
    inserted += (await stmt.run(r.signalId, r.horizonMin, reason, now)).changes;
  }
  return inserted;
}

export async function deleteOutcome(signalId: number, horizonMin: number) {
  const d = await getDbReady();
  const tx = d.transaction(async (sid: number, h: number) => {
    await markOutcomeSkips([{ signalId: sid, horizonMin: h }]);
    return (await d.prepare(`DELETE FROM signal_outcomes WHERE signal_id = ? AND horizon_min = ?`).run(sid, h)).changes;
  });
  return tx(signalId, horizonMin);
}

export async function deleteOutcomesBulk(items: Array<{ signalId: number; horizonMin: number }>) {
  if (!items.length) return 0;
  const d = await getDbReady();
  const stmt = d.prepare(`DELETE FROM signal_outcomes WHERE signal_id = ? AND horizon_min = ?`);
  const tx = d.transaction(async (rows: Array<{ signalId: number; horizonMin: number }>) => {
    await markOutcomeSkips(rows);
    let deleted = 0;
    for (const r of rows) deleted += (await stmt.run(r.signalId, r.horizonMin)).changes;
    return deleted;
  });
  return tx(items);
}

export async function deleteOutcomesByFilter(params: {
  days?: number;
  start?: number;
  end?: number;
  category?: string;
  categories?: string[];
  horizonMin?: number;
  symbol?: string;
  preset?: string;
  strategyVersion?: string;
  blockedByBtc?: boolean;
  windowStatus?: string;
  result?: string;
}) {
  const d = await getDbReady();
  const { start, end } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });

  const where: string[] = [`s.time >= @start`, `s.time <= @end`];
  const bind: any = { start, end };

  applySignalFilters(where, bind, params, 's');
  if (Number.isFinite(params.horizonMin)) {
    where.push(`o.horizon_min = @horizonMin`);
    bind.horizonMin = params.horizonMin;
  }
  if (params.windowStatus) {
    where.push(`o.window_status = @windowStatus`);
    bind.windowStatus = params.windowStatus;
  }
  if (params.result) {
    where.push(`o.result = @result`);
    bind.result = params.result;
  }

  const insertSql = `
    INSERT OR IGNORE INTO outcome_skips(signal_id, horizon_min, reason, created_at)
    SELECT o.signal_id, o.horizon_min, 'user_delete', @now
    FROM signal_outcomes o
    JOIN signals s ON s.id = o.signal_id
    WHERE ${where.join(' AND ')}
  `;
  const deleteSql = `
    DELETE FROM signal_outcomes
    WHERE id IN (
      SELECT o.id
      FROM signal_outcomes o
      JOIN signals s ON s.id = o.signal_id
      WHERE ${where.join(' AND ')}
    )
  `;
  bind.now = Date.now();
  const tx = d.transaction(async () => {
    await d.prepare(insertSql).run(bind);
    return (await d.prepare(deleteSql).run(bind)).changes;
  });
  return tx();
}

export async function rebuildOutcomesByFilter(params: {
  days?: number;
  start?: number;
  end?: number;
  category?: string;
  categories?: string[];
  horizonMin?: number;
  symbol?: string;
  preset?: string;
  strategyVersion?: string;
  blockedByBtc?: boolean;
  result?: string;
}) {
  const d = await getDbReady();
  const { start, end } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });

  const where: string[] = [`s.time >= @start`, `s.time <= @end`, `o.window_status = 'COMPLETE'`];
  const bind: any = { start, end };

  applySignalFilters(where, bind, params, 's');
  if (Number.isFinite(params.horizonMin)) {
    where.push(`o.horizon_min = @horizonMin`);
    bind.horizonMin = params.horizonMin;
  }
  if (params.result) {
    where.push(`o.result = @result`);
    bind.result = params.result;
  }

  const updateSql = `
    UPDATE signal_outcomes
    SET window_status = 'PARTIAL',
        result = 'NONE',
        hit_sl = 0,
        hit_tp1 = 0,
        hit_tp2 = 0,
        invalid_levels = 0,
        invalid_reason = NULL,
        attempted_at = 0,
        computed_at = 0,
        ret_pct = 0,
        r_mult = 0,
        r_close = 0,
        r_mfe = 0,
        r_mae = 0,
        mfe_pct = 0,
        mae_pct = 0,
        open_price = 0,
        close_price = 0,
        max_high = 0,
        min_low = 0,
        exit_price = 0,
        exit_time = 0,
        n_candles = 0
    WHERE id IN (
      SELECT o.id
      FROM signal_outcomes o
      JOIN signals s ON s.id = o.signal_id
      WHERE ${where.join(' AND ')}
    )
  `;

  return (await d.prepare(updateSql).run(bind)).changes;
}

export async function clearAllSignalsData() {
  const d = await getDbReady();
  const tx = d.transaction(async () => {
    const outcomes = (await d.prepare(`DELETE FROM signal_outcomes`).run()).changes;
    const skips = (await d.prepare(`DELETE FROM outcome_skips`).run()).changes;
    const signals = (await d.prepare(`DELETE FROM signals`).run()).changes;
    return { signals, outcomes, skips };
  });
  return tx();
}

/** âœ… NEW: list signals */
export async function listSignals(params: {
  days?: number;
  start?: number;
  end?: number;
  limit?: number;
  offset?: number;
  category?: string;
  symbol?: string;
  unique?: boolean;
  preset?: string;
  strategyVersion?: string;
  blockedByBtc?: boolean;
  categories?: string[];
  btcState?: string;
}) {
  const d = await getDbReady();

  const { start, end, days } = resolveTimeRange({ days: params.days, start: params.start, end: params.end, maxDays: 365 });
  const limit = Math.max(1, Math.min(1000, params.limit ?? 200));
  const offset = Math.max(0, Math.min(50_000, params.offset ?? 0));

  const where: string[] = [`time >= @start`, `time <= @end`];
  const bind: any = { start, end, limit, offset };

  if (params.category) {
    where.push(`category = @category`);
    bind.category = params.category;
  }
  if (params.categories?.length) {
    where.push(`category IN (${params.categories.map((_, i) => `@cat_${i}`).join(',')})`);
    params.categories.forEach((c, i) => { bind[`cat_${i}`] = c; });
  }
  if (params.symbol) {
    where.push(`symbol = @symbol`);
    bind.symbol = params.symbol.toUpperCase();
  }
  if (params.preset) {
    where.push(`preset = @preset`);
    bind.preset = params.preset;
  }
  if (params.strategyVersion) {
    where.push(`strategy_version = @strategyVersion`);
    bind.strategyVersion = params.strategyVersion;
  }
  if (params.blockedByBtc != null) {
    where.push(`blocked_by_btc = @blockedByBtc`);
    bind.blockedByBtc = params.blockedByBtc ? 1 : 0;
  }
  if (params.btcState) {
    const state = String(params.btcState).toUpperCase();
    if (state === 'BULL') where.push(`btc_bull = 1`);
    else if (state === 'BEAR') where.push(`btc_bear = 1`);
    else if (state === 'NEUTRAL') where.push(`(btc_bull IS NULL OR btc_bull = 0) AND (btc_bear IS NULL OR btc_bear = 0)`);
  }

  let rows: any[] = [];
  let totalRow: { n: number };

  if (params.unique) {
    const sql = `
      WITH ranked AS (
        SELECT
          id, symbol, category, time, preset,
          strategy_version,
          price, stop, tp1, tp2, target, rr, riskPct,
          deltaVwapPct, rsi9, volSpike, atrPct, confirm15m,
          confirm15_strict,
          confirm15_soft,
          threshold_vwap_distance_pct,
          threshold_vol_spike_x,
          threshold_atr_guard_pct,
          session_ok,
          sweep_ok,
          trend_ok,
          blocked_by_btc,
          would_be_category,
          created_at, updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY symbol, category
            ORDER BY updated_at DESC, time DESC
          ) as rn
        FROM signals
        WHERE ${where.join(' AND ')}
      )
      SELECT
        id, symbol, category, time, preset,
        strategy_version as strategyVersion,
        price, stop, tp1, tp2, target, rr, riskPct,
        deltaVwapPct, rsi9, volSpike, atrPct, confirm15m,
        confirm15_strict as confirm15Strict,
        confirm15_soft as confirm15Soft,
        threshold_vwap_distance_pct as thresholdVwapDistancePct,
        threshold_vol_spike_x as thresholdVolSpikeX,
        threshold_atr_guard_pct as thresholdAtrGuardPct,
        session_ok as sessionOk,
        sweep_ok as sweepOk,
        trend_ok as trendOk,
        blocked_by_btc as blockedByBtc,
        would_be_category as wouldBeCategory,
        created_at, updated_at
      FROM ranked
      WHERE rn = 1
      ORDER BY updated_at DESC, time DESC
      LIMIT @limit OFFSET @offset
    `;
    rows = await d.prepare(sql).all(bind);

    const countSql = `
      SELECT COUNT(*) as n
      FROM (
        SELECT 1
        FROM signals
        WHERE ${where.join(' AND ')}
        GROUP BY symbol, category
      )
    `;
    totalRow = await d.prepare(countSql).get(bind) as { n: number };
  } else {
    const sql = `
      SELECT
        id, symbol, category, time, preset,
        strategy_version as strategyVersion,
        price, stop, tp1, tp2, target, rr, riskPct,
        deltaVwapPct, rsi9, volSpike, atrPct, confirm15m,
        confirm15_strict as confirm15Strict,
        confirm15_soft as confirm15Soft,
        threshold_vwap_distance_pct as thresholdVwapDistancePct,
        threshold_vol_spike_x as thresholdVolSpikeX,
        threshold_atr_guard_pct as thresholdAtrGuardPct,
        session_ok as sessionOk,
        sweep_ok as sweepOk,
        trend_ok as trendOk,
        blocked_by_btc as blockedByBtc,
        would_be_category as wouldBeCategory,
        created_at, updated_at
      FROM signals
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, time DESC
      LIMIT @limit OFFSET @offset
    `;
    rows = await d.prepare(sql).all(bind);

    const countSql = `
      SELECT COUNT(*) as n
      FROM signals
      WHERE ${where.join(' AND ')}
    `;
    totalRow = await d.prepare(countSql).get(bind) as { n: number };
  }

  return { start, end, days, limit, offset, total: totalRow.n, rows };
}

/** âœ… NEW: get one signal + outcomes */
export async function getSignalById(id: number) {
  const d = await getDbReady();

  const s = await d.prepare(`SELECT * FROM signals WHERE id=?`).get(id) as any;
  if (!s) return null;

  const rawOutcomes = await d.prepare(`
    SELECT
      horizon_min as horizonMin,
      entry_time as entryTime,
      entry_candle_open_time as entryCandleOpenTime,
      entry_rule as entryRule,
      start_time as startTime,
      end_time as endTime,
      interval_min as intervalMin,
      n_candles as nCandles,
      n_candles_expected as nCandlesExpected,
      coverage_pct as coveragePct,
      entry_price as entryPrice,
      open_price as openPrice,
      close_price as closePrice,
      max_high as maxHigh,
      min_low as minLow,
      ret_pct as retPct,
      r_close as rClose,
      r_mfe as rMfe,
      r_mae as rMae,
      r_realized as rRealized,
      hit_sl as hitSL,
      hit_tp1 as hitTP1,
      hit_tp2 as hitTP2,
      tp1_hit_time as tp1HitTime,
      sl_hit_time as slHitTime,
      tp2_hit_time as tp2HitTime,
      time_to_first_hit_ms as timeToFirstHitMs,
      bars_to_exit as barsToExit,
      mfe_pct as mfePct,
      mae_pct as maePct,
      result as result,
      exit_reason as exitReason,
      outcome_driver as outcomeDriver,
      trade_state as tradeState,
      exit_price as exitPrice,
      exit_time as exitTime,
      window_status as windowStatus,
      outcome_state as outcomeState,
      invalid_levels as invalidLevels,
      invalid_reason as invalidReason,
      ambiguous as ambiguous,
      outcome_debug_json as outcomeDebugJson,
      attempted_at as attemptedAt,
      computed_at as computedAt,
      resolved_at as resolvedAt,
      resolve_version as resolveVersion
    FROM signal_outcomes
    WHERE signal_id=?
    ORDER BY horizon_min ASC
  `).all(id);
  const outcomes = (rawOutcomes as any[]).map((o) => {
    const intervalMin = Number(o.intervalMin);
    const horizonMin = Number(o.horizonMin);
    const expected = Number(o.nCandlesExpected);
    const neededCandles = Number.isFinite(expected) && expected > 0
      ? expected
      : (intervalMin > 0 ? Math.ceil(horizonMin / intervalMin) : 0);
    const coveragePct = Number.isFinite(Number(o.coveragePct))
      ? Number(o.coveragePct)
      : (neededCandles > 0 ? (Number(o.nCandles) / neededCandles) * 100 : 0);
    return { ...o, neededCandles, coveragePct, outcomeDebug: safeJsonParse<any>(o.outcomeDebugJson) };
  });

  const toTri = (v: any) => (v == null ? null : Boolean(v));

  return {
    ...s,
    confirm15m: toTri(s.confirm15m),
    confirm15Strict: toTri(s.confirm15_strict),
    confirm15Soft: toTri(s.confirm15_soft),
    sessionOk: toTri(s.session_ok),
    sweepOk: toTri(s.sweep_ok),
    trendOk: toTri(s.trend_ok),
    blockedByBtc: toTri(s.blocked_by_btc),
    btcBull: toTri(s.btc_bull),
    btcBear: toTri(s.btc_bear),
    strategyVersion: s.strategy_version ?? null,
    thresholdVwapDistancePct: s.threshold_vwap_distance_pct ?? null,
    thresholdVolSpikeX: s.threshold_vol_spike_x ?? null,
    thresholdAtrGuardPct: s.threshold_atr_guard_pct ?? null,
    rrEstimate: s.rr_est ?? null,
    wouldBeCategory: s.would_be_category ?? null,
    btcGate: s.btc_gate ?? null,
    btcGateReason: s.btc_gate_reason ?? null,
    gateSnapshot: safeJsonParse<any>(s.gate_snapshot_json),
    readyDebug: safeJsonParse<any>(s.ready_debug_json),
    bestDebug: safeJsonParse<any>(s.best_debug_json),
    entryDebug: safeJsonParse<any>(s.entry_debug_json),
    configSnapshot: safeJsonParse<any>(s.config_snapshot_json),
    buildGitSha: s.build_git_sha ?? null,
    runId: s.run_id ?? null,
    instanceId: s.instance_id ?? null,
    blockedReasons: safeJsonParse<string[]>(s.blocked_reasons_json) ?? null,
    firstFailedGate: s.first_failed_gate ?? null,
    gateScore: s.gate_score ?? null,
    reasons: safeJsonParse<string[]>(s.reasons_json) ?? [],
    market: safeJsonParse<any>(s.market_json),
    outcomes,
  };
}


