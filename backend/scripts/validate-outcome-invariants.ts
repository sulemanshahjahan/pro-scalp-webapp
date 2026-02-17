import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const CONSTRAINTS_IN_VALIDATE_ORDER = [
  'so_horizon_min_positive',
  'so_resolved_requires_non_pending',
  'so_complete_requires_resolved_at',
  'so_complete_requires_resolve_version',
  'so_complete_requires_complete_state',
] as const;

const sampleLimit = Math.max(1, Math.min(200, Number(process.env.DB_VALIDATE_SAMPLE_LIMIT) || 20));

const PREFLIGHT_CHECKS: Array<{ name: string; countSql: string; sampleSql: string }> = [
  {
    name: 'so_horizon_min_positive',
    countSql: `
      SELECT COUNT(*)::BIGINT AS n
      FROM signal_outcomes
      WHERE horizon_min <= 0
    `,
    sampleSql: `
      SELECT
        signal_id, horizon_min, window_status, outcome_state,
        resolved_at, resolve_version, invalid_reason
      FROM signal_outcomes
      WHERE horizon_min <= 0
      LIMIT ${sampleLimit}
    `,
  },
  {
    name: 'so_resolved_requires_non_pending',
    countSql: `
      SELECT COUNT(*)::BIGINT AS n
      FROM signal_outcomes
      WHERE resolved_at > 0
        AND outcome_state = 'PENDING'
    `,
    sampleSql: `
      SELECT
        signal_id, horizon_min, window_status, outcome_state,
        resolved_at, resolve_version, invalid_reason
      FROM signal_outcomes
      WHERE resolved_at > 0
        AND outcome_state = 'PENDING'
      LIMIT ${sampleLimit}
    `,
  },
  {
    name: 'so_complete_requires_resolved_at',
    countSql: `
      SELECT COUNT(*)::BIGINT AS n
      FROM signal_outcomes
      WHERE window_status = 'COMPLETE'
        AND resolved_at <= 0
    `,
    sampleSql: `
      SELECT
        signal_id, horizon_min, window_status, outcome_state,
        resolved_at, resolve_version, invalid_reason
      FROM signal_outcomes
      WHERE window_status = 'COMPLETE'
        AND resolved_at <= 0
      LIMIT ${sampleLimit}
    `,
  },
  {
    name: 'so_complete_requires_resolve_version',
    countSql: `
      SELECT COUNT(*)::BIGINT AS n
      FROM signal_outcomes
      WHERE window_status = 'COMPLETE'
        AND (resolve_version IS NULL OR BTRIM(resolve_version) = '')
    `,
    sampleSql: `
      SELECT
        signal_id, horizon_min, window_status, outcome_state,
        resolved_at, resolve_version, invalid_reason
      FROM signal_outcomes
      WHERE window_status = 'COMPLETE'
        AND (resolve_version IS NULL OR BTRIM(resolve_version) = '')
      LIMIT ${sampleLimit}
    `,
  },
  {
    name: 'so_complete_requires_complete_state',
    countSql: `
      SELECT COUNT(*)::BIGINT AS n
      FROM signal_outcomes
      WHERE window_status = 'COMPLETE'
        AND (outcome_state IS NULL OR outcome_state NOT LIKE 'COMPLETE_%')
    `,
    sampleSql: `
      SELECT
        signal_id, horizon_min, window_status, outcome_state,
        resolved_at, resolve_version, invalid_reason
      FROM signal_outcomes
      WHERE window_status = 'COMPLETE'
        AND (outcome_state IS NULL OR outcome_state NOT LIKE 'COMPLETE_%')
      LIMIT ${sampleLimit}
    `,
  },
];

function useSsl(url: string) {
  const sslEnv = String(process.env.PG_SSL || '').toLowerCase();
  if (
    sslEnv === '1' ||
    sslEnv === 'true' ||
    url.includes('sslmode=require') ||
    url.includes('ssl=true')
  ) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

async function main() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({
    connectionString: url,
    ssl: useSsl(url),
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const existing = await pool.query(
      `
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'signal_outcomes'::regclass
          AND conname = ANY($1::text[])
      `,
      [Array.from(CONSTRAINTS_IN_VALIDATE_ORDER)]
    );
    const present = new Set(existing.rows.map((r) => String(r.conname)));
    const missing = Array.from(CONSTRAINTS_IN_VALIDATE_ORDER).filter((name) => !present.has(name));
    if (missing.length) {
      throw new Error(
        `Missing constraints: ${missing.join(', ')}. Run: npm --prefix backend run db:migrate`
      );
    }

    const failedPreflight: Array<{ name: string; n: number }> = [];
    for (const check of PREFLIGHT_CHECKS) {
      const row = await pool.query(check.countSql);
      const n = Number(row.rows?.[0]?.n ?? 0);
      console.log(`[db:validate:outcomes] preflight ${check.name}: ${n}`);
      if (n > 0) {
        failedPreflight.push({ name: check.name, n });
        const sample = await pool.query(check.sampleSql);
        console.log(`[db:validate:outcomes] sample ${check.name} (up to ${sampleLimit})`);
        for (const r of sample.rows) {
          console.log(JSON.stringify(r));
        }
      }
    }

    if (failedPreflight.length) {
      const summary = failedPreflight.map((r) => `${r.name}=${r.n}`).join(', ');
      throw new Error(`Preflight failed: ${summary}`);
    }

    for (const name of CONSTRAINTS_IN_VALIDATE_ORDER) {
      await pool.query(`ALTER TABLE signal_outcomes VALIDATE CONSTRAINT ${name}`);
      console.log(`[db:validate:outcomes] validated ${name}`);
    }
    console.log('[db:validate:outcomes] all constraints validated');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[db:validate:outcomes] failed:', e);
  process.exitCode = 1;
});
