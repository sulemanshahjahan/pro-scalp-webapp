import { getDb } from './db/db.js';

export type ScanRunStatus = 'RUNNING' | 'FINISHED' | 'FAILED';

export type ScanRun = {
  id: number;
  runId: string;
  preset: string;
  configHash: string | null;
  instanceId: string | null;
  status: ScanRunStatus;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  processedSymbols: number | null;
  precheckPassed: number | null;
  fetchedOk: number | null;
  errors429: number | null;
  errorsOther: number | null;
  signalsByCategory: Record<string, number> | null;
  gateStats: any | null;
  errorMessage: string | null;
};

let schemaReady = false;

async function ensureScanSchema() {
  if (schemaReady) return;
  const d = getDb();
  if (d.driver === 'sqlite') {
    await d.exec(`
      CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        preset TEXT NOT NULL,
        config_hash TEXT,
        instance_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        processed_symbols INTEGER,
        precheck_passed INTEGER,
        fetched_ok INTEGER,
        errors_429 INTEGER,
        errors_other INTEGER,
        signals_by_category_json TEXT,
        gate_stats_json TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS scan_lock (
        id INTEGER PRIMARY KEY,
        locked_until INTEGER NOT NULL DEFAULT 0,
        locked_at INTEGER NOT NULL DEFAULT 0,
        locked_by TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON scan_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_finished_at ON scan_runs(finished_at);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_config_hash ON scan_runs(config_hash);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_instance_id ON scan_runs(instance_id);
    `);
  } else {
    await d.exec(`
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
      CREATE TABLE IF NOT EXISTS scan_lock (
        id INTEGER PRIMARY KEY,
        locked_until BIGINT NOT NULL DEFAULT 0,
        locked_at BIGINT NOT NULL DEFAULT 0,
        locked_by TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_scan_runs_started_at ON scan_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_finished_at ON scan_runs(finished_at);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_status ON scan_runs(status);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_config_hash ON scan_runs(config_hash);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_instance_id ON scan_runs(instance_id);
    `);
  }
  try { await d.exec(`ALTER TABLE scan_runs ADD COLUMN config_hash TEXT`); } catch {}
  try { await d.exec(`ALTER TABLE scan_runs ADD COLUMN instance_id TEXT`); } catch {}
  try { await d.exec(`UPDATE scan_runs SET config_hash = 'legacy' WHERE config_hash IS NULL OR trim(config_hash) = ''`); } catch {}
  try { await d.exec(`UPDATE scan_runs SET instance_id = 'legacy' WHERE instance_id IS NULL OR trim(instance_id) = ''`); } catch {}
  try { await d.exec(`CREATE INDEX IF NOT EXISTS idx_scan_runs_config_hash ON scan_runs(config_hash)`); } catch {}
  try { await d.exec(`CREATE INDEX IF NOT EXISTS idx_scan_runs_instance_id ON scan_runs(instance_id)`); } catch {}
  schemaReady = true;
}

function parseJsonField<T>(raw: any): T | null {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function normalizeScanRow(row: any | undefined): ScanRun | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    runId: String(row.runId ?? row.run_id ?? ''),
    preset: String(row.preset ?? ''),
    configHash: row.configHash == null ? null : String(row.configHash ?? row.config_hash),
    instanceId: row.instanceId == null ? null : String(row.instanceId ?? row.instance_id),
    status: String(row.status ?? '') as ScanRunStatus,
    startedAt: Number(row.startedAt ?? row.started_at ?? 0),
    finishedAt: row.finishedAt == null ? null : Number(row.finishedAt ?? row.finished_at),
    durationMs: row.durationMs == null ? null : Number(row.durationMs ?? row.duration_ms),
    processedSymbols: row.processedSymbols == null ? null : Number(row.processedSymbols ?? row.processed_symbols),
    precheckPassed: row.precheckPassed == null ? null : Number(row.precheckPassed ?? row.precheck_passed),
    fetchedOk: row.fetchedOk == null ? null : Number(row.fetchedOk ?? row.fetched_ok),
    errors429: row.errors429 == null ? null : Number(row.errors429 ?? row.errors_429),
    errorsOther: row.errorsOther == null ? null : Number(row.errorsOther ?? row.errors_other),
    signalsByCategory: parseJsonField<Record<string, number>>(row.signalsByCategoryJson ?? row.signals_by_category_json),
    gateStats: parseJsonField<any>(row.gateStatsJson ?? row.gate_stats_json),
    errorMessage: row.errorMessage == null ? null : String(row.errorMessage ?? row.error_message),
  };
}

export async function startScanRun(
  preset: string,
  opts?: { configHash?: string | null; instanceId?: string | null }
) {
  await ensureScanSchema();
  const d = getDb();
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const configHash = String(opts?.configHash || '').trim() || 'legacy';
  const instanceId = String(opts?.instanceId || process.env.INSTANCE_ID || process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'unknown').trim() || 'unknown';
  await d.prepare(`
    INSERT INTO scan_runs (run_id, preset, config_hash, instance_id, status, started_at)
    VALUES (@runId, @preset, @configHash, @instanceId, 'RUNNING', @startedAt)
  `).run({ runId, preset, configHash, instanceId, startedAt });
  return { runId, preset, configHash, instanceId, startedAt };
}

export async function tryStartScanRun(
  preset: string,
  lockMs: number,
  opts?: { configHash?: string | null; instanceId?: string | null }
) {
  await ensureScanSchema();
  const d = getDb();
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const configHash = String(opts?.configHash || '').trim() || 'legacy';
  const instanceId = String(opts?.instanceId || process.env.INSTANCE_ID || process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || 'unknown').trim() || 'unknown';
  const lockedUntil = startedAt + Math.max(10_000, lockMs);

  const acquire = d.transaction(async () => {
    await d.prepare(`
      INSERT INTO scan_lock (id, locked_until, locked_at, locked_by)
      VALUES (1, 0, 0, '')
      ON CONFLICT (id) DO NOTHING
    `).run();

    const res = await d.prepare(`
      UPDATE scan_lock
      SET locked_until = @lockedUntil,
          locked_at = @startedAt,
          locked_by = @runId
      WHERE id = 1 AND locked_until <= @startedAt
    `).run({ lockedUntil, startedAt, runId });

    if (!res.changes) return null;

    await d.prepare(`
      INSERT INTO scan_runs (run_id, preset, config_hash, instance_id, status, started_at)
      VALUES (@runId, @preset, @configHash, @instanceId, 'RUNNING', @startedAt)
    `).run({ runId, preset, configHash, instanceId, startedAt });

    return { runId, preset, configHash, instanceId, startedAt };
  });

  return acquire();
}

export async function finishScanRun(runId: string, data: {
  finishedAt: number;
  durationMs: number;
  processedSymbols: number;
  precheckPassed: number;
  fetchedOk: number;
  errors429: number;
  errorsOther: number;
  signalsByCategory: Record<string, number>;
  gateStats: any;
}) {
  await ensureScanSchema();
  const d = getDb();
  await d.prepare(`
    UPDATE scan_runs
    SET status = 'FINISHED',
        finished_at = @finishedAt,
        duration_ms = @durationMs,
        processed_symbols = @processedSymbols,
        precheck_passed = @precheckPassed,
        fetched_ok = @fetchedOk,
        errors_429 = @errors429,
        errors_other = @errorsOther,
        signals_by_category_json = @signalsByCategoryJson,
        gate_stats_json = @gateStatsJson,
        error_message = NULL
    WHERE run_id = @runId
  `).run({
    runId,
    finishedAt: data.finishedAt,
    durationMs: data.durationMs,
    processedSymbols: data.processedSymbols,
    precheckPassed: data.precheckPassed,
    fetchedOk: data.fetchedOk,
    errors429: data.errors429,
    errorsOther: data.errorsOther,
    signalsByCategoryJson: JSON.stringify(data.signalsByCategory ?? {}),
    gateStatsJson: JSON.stringify(data.gateStats ?? {}),
  });

  await d.prepare(`
    UPDATE scan_lock
    SET locked_until = 0, locked_by = ''
    WHERE id = 1 AND locked_by = @runId
  `).run({ runId });
}

export async function failScanRun(runId: string, errorMessage: string, data: {
  finishedAt: number;
  durationMs: number;
  processedSymbols: number;
  precheckPassed: number;
  fetchedOk: number;
  errors429: number;
  errorsOther: number;
  signalsByCategory: Record<string, number>;
  gateStats: any;
}) {
  await ensureScanSchema();
  const d = getDb();
  await d.prepare(`
    UPDATE scan_runs
    SET status = 'FAILED',
        finished_at = @finishedAt,
        duration_ms = @durationMs,
        processed_symbols = @processedSymbols,
        precheck_passed = @precheckPassed,
        fetched_ok = @fetchedOk,
        errors_429 = @errors429,
        errors_other = @errorsOther,
        signals_by_category_json = @signalsByCategoryJson,
        gate_stats_json = @gateStatsJson,
        error_message = @errorMessage
    WHERE run_id = @runId
  `).run({
    runId,
    finishedAt: data.finishedAt,
    durationMs: data.durationMs,
    processedSymbols: data.processedSymbols,
    precheckPassed: data.precheckPassed,
    fetchedOk: data.fetchedOk,
    errors429: data.errors429,
    errorsOther: data.errorsOther,
    signalsByCategoryJson: JSON.stringify(data.signalsByCategory ?? {}),
    gateStatsJson: JSON.stringify(data.gateStats ?? {}),
    errorMessage,
  });

  await d.prepare(`
    UPDATE scan_lock
    SET locked_until = 0, locked_by = ''
    WHERE id = 1 AND locked_by = @runId
  `).run({ runId });
}

export async function getLatestScanRuns() {
  await ensureScanSchema();
  const d = getDb();
  const lastFinished = await d.prepare(`
    SELECT
      id,
      run_id as "runId",
      preset,
      config_hash as "configHash",
      instance_id as "instanceId",
      status,
      started_at as "startedAt",
      finished_at as "finishedAt",
      duration_ms as "durationMs",
      processed_symbols as "processedSymbols",
      precheck_passed as "precheckPassed",
      fetched_ok as "fetchedOk",
      errors_429 as "errors429",
      errors_other as "errorsOther",
      signals_by_category_json as "signalsByCategoryJson",
      gate_stats_json as "gateStatsJson",
      error_message as "errorMessage"
    FROM scan_runs
    WHERE status = 'FINISHED'
    ORDER BY finished_at DESC
    LIMIT 1
  `).get();

  const lastRunning = await d.prepare(`
    SELECT
      id,
      run_id as "runId",
      preset,
      config_hash as "configHash",
      instance_id as "instanceId",
      status,
      started_at as "startedAt",
      finished_at as "finishedAt",
      duration_ms as "durationMs",
      processed_symbols as "processedSymbols",
      precheck_passed as "precheckPassed",
      fetched_ok as "fetchedOk",
      errors_429 as "errors429",
      errors_other as "errorsOther",
      signals_by_category_json as "signalsByCategoryJson",
      gate_stats_json as "gateStatsJson",
      error_message as "errorMessage"
    FROM scan_runs
    WHERE status = 'RUNNING'
    ORDER BY started_at DESC
    LIMIT 1
  `).get();

  return {
    lastFinished: normalizeScanRow(lastFinished),
    lastRunning: normalizeScanRow(lastRunning),
  };
}

export async function listScanRuns(limit = 50) {
  await ensureScanSchema();
  const d = getDb();
  const rows = await d.prepare(`
    SELECT
      id,
      run_id as "runId",
      preset,
      config_hash as "configHash",
      instance_id as "instanceId",
      status,
      started_at as "startedAt",
      finished_at as "finishedAt",
      duration_ms as "durationMs",
      processed_symbols as "processedSymbols",
      precheck_passed as "precheckPassed",
      fetched_ok as "fetchedOk",
      errors_429 as "errors429",
      errors_other as "errorsOther",
      signals_by_category_json as "signalsByCategoryJson",
      gate_stats_json as "gateStatsJson",
      error_message as "errorMessage"
    FROM scan_runs
    ORDER BY started_at DESC
    LIMIT @limit
  `).all({ limit });

  return rows.map(normalizeScanRow).filter(Boolean);
}

export async function getScanRunByRunId(runId: string) {
  if (!runId) return null;
  await ensureScanSchema();
  const d = getDb();
  const row = await d.prepare(`
    SELECT
      id,
      run_id as "runId",
      preset,
      config_hash as "configHash",
      instance_id as "instanceId",
      status,
      started_at as "startedAt",
      finished_at as "finishedAt",
      duration_ms as "durationMs",
      processed_symbols as "processedSymbols",
      precheck_passed as "precheckPassed",
      fetched_ok as "fetchedOk",
      errors_429 as "errors429",
      errors_other as "errorsOther",
      signals_by_category_json as "signalsByCategoryJson",
      gate_stats_json as "gateStatsJson",
      error_message as "errorMessage"
    FROM scan_runs
    WHERE run_id = @runId
    LIMIT 1
  `).get({ runId });
  return normalizeScanRow(row);
}

export async function pruneScanRuns(limit = 2000) {
  await ensureScanSchema();
  const d = getDb();
  await d.prepare(`
    DELETE FROM scan_runs
    WHERE id NOT IN (
      SELECT id FROM scan_runs
      ORDER BY started_at DESC
      LIMIT @limit
    )
  `).run({ limit });
}
