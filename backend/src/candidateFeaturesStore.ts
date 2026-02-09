import { getDb } from './db/db.js';

export type CandidateFeatureRow = {
  runId: string;
  symbol: string;
  preset: string;
  startedAt: number;
  metrics: Record<string, any>;
  computed: Record<string, any>;
};

let schemaReady = false;

function parseJsonField<T>(raw: any): T | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

async function ensureCandidateSchema() {
  if (schemaReady) return;
  const d = getDb();
  if (d.driver === 'sqlite') {
    await d.exec(`
      CREATE TABLE IF NOT EXISTS candidate_features (
        run_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        preset TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
        metrics TEXT NOT NULL,
        computed TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (run_id, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_candidate_features_started_at ON candidate_features(started_at);
      CREATE INDEX IF NOT EXISTS idx_candidate_features_preset ON candidate_features(preset);
    `);
  } else {
    await d.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_candidate_features_started_at ON candidate_features(started_at);
      CREATE INDEX IF NOT EXISTS idx_candidate_features_preset ON candidate_features(preset);
    `);
  }
  schemaReady = true;
}

export async function upsertCandidateFeatures(row: CandidateFeatureRow) {
  await ensureCandidateSchema();
  const d = getDb();
  const metricsJson = JSON.stringify(row.metrics ?? {});
  const computedJson = JSON.stringify(row.computed ?? {});

  if (d.driver === 'sqlite') {
    return d.prepare(`
      INSERT INTO candidate_features (run_id, symbol, preset, started_at, metrics, computed)
      VALUES (@runId, @symbol, @preset, @startedAt, @metrics, @computed)
      ON CONFLICT (run_id, symbol) DO UPDATE
      SET metrics = excluded.metrics,
          computed = excluded.computed,
          started_at = excluded.started_at,
          preset = excluded.preset
    `).run({
      runId: row.runId,
      symbol: row.symbol,
      preset: row.preset,
      startedAt: row.startedAt,
      metrics: metricsJson,
      computed: computedJson,
    });
  }

  return d.prepare(`
    INSERT INTO candidate_features (run_id, symbol, preset, started_at, metrics, computed)
    VALUES (@runId, @symbol, @preset, @startedAt, @metrics::jsonb, @computed::jsonb)
    ON CONFLICT (run_id, symbol) DO UPDATE
    SET metrics = excluded.metrics,
        computed = excluded.computed,
        started_at = excluded.started_at,
        preset = excluded.preset
  `).run({
    runId: row.runId,
    symbol: row.symbol,
    preset: row.preset,
    startedAt: row.startedAt,
    metrics: metricsJson,
    computed: computedJson,
  });
}

export async function listCandidateFeatures(params: {
  runId: string;
  preset?: string;
  limit?: number;
  symbols?: string[] | null;
}) {
  await ensureCandidateSchema();
  const d = getDb();
  const where: string[] = [`run_id = @runId`];
  const bind: any = { runId: params.runId };

  if (params.preset) {
    where.push(`preset = @preset`);
    bind.preset = params.preset;
  }

  if (params.symbols?.length) {
    const cleaned = params.symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);
    if (cleaned.length) {
      where.push(`symbol IN (${cleaned.map((_, i) => `@sym_${i}`).join(',')})`);
      cleaned.forEach((s, i) => { bind[`sym_${i}`] = s; });
    }
  }

  const limit = Math.max(1, Math.min(5000, params.limit ?? 500));
  bind.limit = limit;

  const sql = `
    SELECT
      run_id as "runId",
      symbol,
      preset,
      started_at as "startedAt",
      metrics,
      computed
    FROM candidate_features
    WHERE ${where.join(' AND ')}
    ORDER BY symbol ASC
    LIMIT @limit
  `;

  const rows = await d.prepare(sql).all(bind) as any[];
  return rows.map((r) => ({
    runId: String(r.runId ?? ''),
    symbol: String(r.symbol ?? ''),
    preset: String(r.preset ?? ''),
    startedAt: Number(r.startedAt ?? 0),
    metrics: parseJsonField<Record<string, any>>(r.metrics) ?? {},
    computed: parseJsonField<Record<string, any>>(r.computed) ?? {},
  }));
}

export async function listCandidateFeaturesMulti(params: {
  runIds: string[];
  preset?: string;
  limit?: number;
  symbols?: string[] | null;
}) {
  await ensureCandidateSchema();
  const d = getDb();
  const runIds = (params.runIds || []).map(s => String(s).trim()).filter(Boolean);
  if (!runIds.length) return [];

  const where: string[] = [
    `run_id IN (${runIds.map((_, i) => `@run_${i}`).join(',')})`,
  ];
  const bind: any = {};
  runIds.forEach((r, i) => { bind[`run_${i}`] = r; });

  if (params.preset) {
    where.push(`preset = @preset`);
    bind.preset = params.preset;
  }

  if (params.symbols?.length) {
    const cleaned = params.symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);
    if (cleaned.length) {
      where.push(`symbol IN (${cleaned.map((_, i) => `@sym_${i}`).join(',')})`);
      cleaned.forEach((s, i) => { bind[`sym_${i}`] = s; });
    }
  }

  const limit = Math.max(1, Math.min(50000, params.limit ?? 5000));
  bind.limit = limit;

  const sql = `
    SELECT
      run_id as "runId",
      symbol,
      preset,
      started_at as "startedAt",
      metrics,
      computed
    FROM candidate_features
    WHERE ${where.join(' AND ')}
    ORDER BY started_at DESC, symbol ASC
    LIMIT @limit
  `;

  const rows = await d.prepare(sql).all(bind) as any[];
  return rows.map((r) => ({
    runId: String(r.runId ?? ''),
    symbol: String(r.symbol ?? ''),
    preset: String(r.preset ?? ''),
    startedAt: Number(r.startedAt ?? 0),
    metrics: parseJsonField<Record<string, any>>(r.metrics) ?? {},
    computed: parseJsonField<Record<string, any>>(r.computed) ?? {},
  }));
}

export async function pruneCandidateFeatures(params?: { keepDays?: number }) {
  await ensureCandidateSchema();
  const d = getDb();
  const keepDays = Math.max(1, Math.min(365, params?.keepDays ?? parseInt(process.env.CANDIDATE_FEATURES_RETENTION_DAYS || '3', 10)));
  const cutoff = Date.now() - keepDays * 24 * 60 * 60_000;
  const res = await d.prepare(`DELETE FROM candidate_features WHERE started_at < @cutoff`).run({ cutoff });
  return { keepDays, cutoff, deleted: res.changes };
}
