import { getDb } from './db/db.js';

export type TuningBundleRow = {
  id: number;
  createdAt: number;
  windowHours: number;
  windowStartMs: number;
  windowEndMs: number;
  configHash: string | null;
  buildGitSha: string | null;
  scanRunId: string | null;
  payload: any;
  reportMd: string;
  error: string | null;
};

let schemaReady = false;

function parseJsonField<T>(raw: any): T | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

async function ensureSchema() {
  if (schemaReady) return;
  const d = getDb();
  if (d.driver === 'sqlite') {
    await d.exec(`
      CREATE TABLE IF NOT EXISTS tuning_bundles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
        window_hours INTEGER NOT NULL,
        window_start_ms INTEGER NOT NULL,
        window_end_ms INTEGER NOT NULL,
        config_hash TEXT,
        build_git_sha TEXT,
        scan_run_id TEXT,
        payload_json TEXT NOT NULL,
        report_md TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tuning_bundles_created_at ON tuning_bundles(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tuning_bundles_window_end ON tuning_bundles(window_end_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_tuning_bundles_config_hash ON tuning_bundles(config_hash);
    `);
    try { await d.exec(`ALTER TABLE tuning_bundles ADD COLUMN config_hash TEXT`); } catch {}
  } else {
    await d.exec(`
      CREATE TABLE IF NOT EXISTS tuning_bundles (
        id BIGSERIAL PRIMARY KEY,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
        window_hours INTEGER NOT NULL,
        window_start_ms BIGINT NOT NULL,
        window_end_ms BIGINT NOT NULL,
        config_hash TEXT,
        build_git_sha TEXT,
        scan_run_id TEXT,
        payload_json JSONB NOT NULL,
        report_md TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tuning_bundles_created_at ON tuning_bundles(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tuning_bundles_window_end ON tuning_bundles(window_end_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_tuning_bundles_config_hash ON tuning_bundles(config_hash);
    `);
    try { await d.exec(`ALTER TABLE tuning_bundles ADD COLUMN config_hash TEXT`); } catch {}
  }
  schemaReady = true;
}

export async function insertTuningBundle(input: {
  windowHours: number;
  windowStartMs: number;
  windowEndMs: number;
  configHash?: string | null;
  buildGitSha?: string | null;
  scanRunId?: string | null;
  payload: any;
  reportMd: string;
  error?: string | null;
}) {
  await ensureSchema();
  const d = getDb();
  const payloadJson = JSON.stringify(input.payload ?? {});
  const baseParams = {
    windowHours: input.windowHours,
    windowStartMs: input.windowStartMs,
    windowEndMs: input.windowEndMs,
    configHash: input.configHash ?? null,
    buildGitSha: input.buildGitSha ?? null,
    scanRunId: input.scanRunId ?? null,
    payloadJson,
    reportMd: input.reportMd ?? '',
    error: input.error ?? null,
  };

  if (d.driver === 'sqlite') {
    return d.prepare(`
      INSERT INTO tuning_bundles (
        window_hours,
        window_start_ms,
        window_end_ms,
        config_hash,
        build_git_sha,
        scan_run_id,
        payload_json,
        report_md,
        error
      )
      VALUES (
        @windowHours,
        @windowStartMs,
        @windowEndMs,
        @configHash,
        @buildGitSha,
        @scanRunId,
        @payloadJson,
        @reportMd,
        @error
      )
    `).run(baseParams);
  }

  return d.prepare(`
    INSERT INTO tuning_bundles (
      window_hours,
      window_start_ms,
      window_end_ms,
      config_hash,
      build_git_sha,
      scan_run_id,
      payload_json,
      report_md,
      error
    )
    VALUES (
      @windowHours,
      @windowStartMs,
      @windowEndMs,
      @configHash,
      @buildGitSha,
      @scanRunId,
      @payloadJson::jsonb,
      @reportMd,
      @error
    )
  `).run(baseParams);
}

function normalizeBundleRow(row: any): TuningBundleRow | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    createdAt: Number(row.createdAt ?? row.created_at ?? 0),
    windowHours: Number(row.windowHours ?? row.window_hours ?? 0),
    windowStartMs: Number(row.windowStartMs ?? row.window_start_ms ?? 0),
    windowEndMs: Number(row.windowEndMs ?? row.window_end_ms ?? 0),
    configHash: row.configHash ?? row.config_hash ?? null,
    buildGitSha: row.buildGitSha ?? row.build_git_sha ?? null,
    scanRunId: row.scanRunId ?? row.scan_run_id ?? null,
    payload: parseJsonField<any>(row.payloadJson ?? row.payload_json) ?? {},
    reportMd: String(row.reportMd ?? row.report_md ?? ''),
    error: row.error ?? row.error ?? null,
  };
}

export async function getLatestTuningBundle(params?: { windowHours?: number; configHash?: string }) {
  await ensureSchema();
  const d = getDb();
  const where: string[] = [];
  const bind: any = {};
  if (Number.isFinite(params?.windowHours)) {
    where.push(`window_hours = @windowHours`);
    bind.windowHours = params!.windowHours;
  }
  if (params?.configHash) {
    where.push(`config_hash = @configHash`);
    bind.configHash = params.configHash;
  }
  const row = await d.prepare(`
    SELECT
      id,
      created_at as "createdAt",
      window_hours as "windowHours",
      window_start_ms as "windowStartMs",
      window_end_ms as "windowEndMs",
      config_hash as "configHash",
      build_git_sha as "buildGitSha",
      scan_run_id as "scanRunId",
      payload_json as "payloadJson",
      report_md as "reportMd",
      error
    FROM tuning_bundles
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT 1
  `).get(bind);
  return normalizeBundleRow(row);
}

export async function listRecentTuningBundles(params?: { limit?: number; configHash?: string }) {
  await ensureSchema();
  const d = getDb();
  const limit = Math.max(1, Math.min(200, params?.limit ?? 50));
  const where: string[] = [];
  const bind: any = { limit };
  if (params?.configHash) {
    where.push(`config_hash = @configHash`);
    bind.configHash = params.configHash;
  }
  const rows = await d.prepare(`
    SELECT
      id,
      created_at as "createdAt",
      window_hours as "windowHours",
      window_start_ms as "windowStartMs",
      window_end_ms as "windowEndMs",
      config_hash as "configHash",
      build_git_sha as "buildGitSha",
      scan_run_id as "scanRunId",
      payload_json as "payloadJson",
      report_md as "reportMd",
      error
    FROM tuning_bundles
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT @limit
  `).all(bind);
  return rows.map(normalizeBundleRow).filter(Boolean) as TuningBundleRow[];
}

export async function getTuningBundleById(id: number) {
  await ensureSchema();
  const d = getDb();
  const row = await d.prepare(`
    SELECT
      id,
      created_at as "createdAt",
      window_hours as "windowHours",
      window_start_ms as "windowStartMs",
      window_end_ms as "windowEndMs",
      config_hash as "configHash",
      build_git_sha as "buildGitSha",
      scan_run_id as "scanRunId",
      payload_json as "payloadJson",
      report_md as "reportMd",
      error
    FROM tuning_bundles
    WHERE id = @id
    LIMIT 1
  `).get({ id });
  return normalizeBundleRow(row);
}

export async function pruneTuningBundles(params?: { keepDays?: number }) {
  await ensureSchema();
  const d = getDb();
  const keepDays = Math.max(1, Math.min(365, params?.keepDays ?? parseInt(process.env.TUNING_BUNDLE_RETENTION_DAYS || '14', 10)));
  const cutoff = Date.now() - keepDays * 24 * 60 * 60_000;
  const res = await d.prepare(`DELETE FROM tuning_bundles WHERE window_end_ms < @cutoff`).run({ cutoff });
  return { keepDays, cutoff, deleted: res.changes };
}
