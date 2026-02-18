import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { DB_DIR, DB_PATH } from '../dbPath.js';
import { POSTGRES_CONCURRENT_INDEXES, POSTGRES_SCHEMA } from './postgresSchema.js';

const { Pool } = pg;

export type DbDriver = 'sqlite' | 'postgres';
export type DbParams = Record<string, any> | any[] | undefined;

type RunResult = { changes: number };

export interface DbStmt {
  get(...params: any[]): Promise<any | undefined>;
  all(...params: any[]): Promise<any[]>;
  run(...params: any[]): Promise<RunResult>;
}

export interface DbConn {
  driver: DbDriver;
  exec(sql: string): Promise<void>;
  prepare(sql: string): DbStmt;
  transaction<T>(fn: (...args: any[]) => Promise<T>): (...args: any[]) => Promise<T>;
  close?: () => Promise<void>;
}

let db: DbConn | null = null;

const driverEnv = String(process.env.DB_DRIVER || '').toLowerCase();
const driver: DbDriver =
  driverEnv === 'postgres' || driverEnv === 'pg'
    ? 'postgres'
    : driverEnv === 'sqlite'
      ? 'sqlite'
      : process.env.DATABASE_URL
        ? 'postgres'
        : 'sqlite';

const REQUIRED_PG_TABLES = [
  'meta',
  'signals',
  'signal_events',
  'signal_outcomes',
  'outcome_skips',
] as const;

const REQUIRED_PG_OUTCOME_CHECKS = [
  'so_horizon_min_positive',
  'so_resolved_requires_non_pending',
  'so_complete_requires_resolved_at',
  'so_complete_requires_resolve_version',
  'so_complete_requires_complete_state',
  'so_complete_requires_complete_reason',
] as const;
type RequiredPgOutcomeCheck = (typeof REQUIRED_PG_OUTCOME_CHECKS)[number];

const PG_OUTCOME_CHECK_ENSURE_SQL: Record<RequiredPgOutcomeCheck, string> = {
  so_horizon_min_positive: `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'so_horizon_min_positive'
          AND conrelid = 'signal_outcomes'::regclass
      ) THEN
        ALTER TABLE signal_outcomes
          ADD CONSTRAINT so_horizon_min_positive
          CHECK (horizon_min > 0)
          NOT VALID;
      END IF;
    END $$;
  `,
  so_resolved_requires_non_pending: `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'so_resolved_requires_non_pending'
          AND conrelid = 'signal_outcomes'::regclass
      ) THEN
        ALTER TABLE signal_outcomes
          ADD CONSTRAINT so_resolved_requires_non_pending
          CHECK (resolved_at = 0 OR outcome_state <> 'PENDING')
          NOT VALID;
      END IF;
    END $$;
  `,
  so_complete_requires_resolved_at: `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'so_complete_requires_resolved_at'
          AND conrelid = 'signal_outcomes'::regclass
      ) THEN
        ALTER TABLE signal_outcomes
          ADD CONSTRAINT so_complete_requires_resolved_at
          CHECK (window_status <> 'COMPLETE' OR resolved_at > 0)
          NOT VALID;
      END IF;
    END $$;
  `,
  so_complete_requires_resolve_version: `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'so_complete_requires_resolve_version'
          AND conrelid = 'signal_outcomes'::regclass
      ) THEN
        ALTER TABLE signal_outcomes
          ADD CONSTRAINT so_complete_requires_resolve_version
          CHECK (window_status <> 'COMPLETE' OR resolve_version IS NOT NULL)
          NOT VALID;
      END IF;
    END $$;
  `,
  so_complete_requires_complete_state: `
    DO $$
    DECLARE def TEXT;
    BEGIN
      SELECT pg_get_constraintdef(c.oid)
      INTO def
      FROM pg_constraint c
      WHERE c.conname = 'so_complete_requires_complete_state'
        AND c.conrelid = 'signal_outcomes'::regclass;

      IF def IS NULL THEN
        ALTER TABLE signal_outcomes
          ADD CONSTRAINT so_complete_requires_complete_state
          CHECK (window_status <> 'COMPLETE' OR outcome_state = 'COMPLETE')
          NOT VALID;
      ELSIF def NOT LIKE '%outcome_state = ''COMPLETE''%' THEN
        ALTER TABLE signal_outcomes
          DROP CONSTRAINT so_complete_requires_complete_state;
        ALTER TABLE signal_outcomes
          ADD CONSTRAINT so_complete_requires_complete_state
          CHECK (window_status <> 'COMPLETE' OR outcome_state = 'COMPLETE')
          NOT VALID;
      END IF;
    END $$;
  `,
  so_complete_requires_complete_reason: `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'so_complete_requires_complete_reason'
          AND conrelid = 'signal_outcomes'::regclass
      ) THEN
        ALTER TABLE signal_outcomes
          ADD CONSTRAINT so_complete_requires_complete_reason
          CHECK (window_status <> 'COMPLETE' OR complete_reason IS NOT NULL)
          NOT VALID;
      END IF;
    END $$;
  `,
};

export function getDb(): DbConn {
  if (db) return db;
  if (driver === 'postgres') {
    db = createPostgresDb();
  } else {
    db = createSqliteDb();
  }
  return db;
}

function createSqliteDb(): DbConn {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  return {
    driver: 'sqlite',
    async exec(sql: string) {
      sqlite.exec(sql);
    },
    prepare(sql: string) {
      const stmt = sqlite.prepare(sql);
      return {
        async get(...params: any[]) {
          return params.length === 0 ? stmt.get() : stmt.get(...params);
        },
        async all(...params: any[]) {
          return params.length === 0 ? stmt.all() : stmt.all(...params);
        },
        async run(...params: any[]) {
          const res = params.length === 0 ? stmt.run() : stmt.run(...params);
          return { changes: res.changes };
        },
      };
    },
    transaction<T>(fn: (...args: any[]) => Promise<T>) {
      return async (...args: any[]) => {
        sqlite.exec('BEGIN');
        try {
          const result = await fn(...args);
          sqlite.exec('COMMIT');
          return result;
        } catch (e) {
          try { sqlite.exec('ROLLBACK'); } catch {}
          throw e;
        }
      };
    },
    async close() {
      sqlite.close();
    },
  };
}

function createPostgresDb(): DbConn {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for postgres DB_DRIVER');
  }

  const autoSchema = readBoolEnv('PG_AUTO_SCHEMA', process.env.NODE_ENV !== 'production');
  const autoRepairOutcomeChecks = readBoolEnv('PG_AUTO_REPAIR_OUTCOME_CHECKS', true);
  const autoSchemaConcurrentIndexes = readBoolEnv('PG_AUTO_SCHEMA_CONCURRENT_INDEXES', true);
  const autoSchemaConcurrentIndexLock = readBoolEnv('PG_AUTO_SCHEMA_CONCURRENT_INDEX_LOCK', true);
  const autoSchemaConcurrentIndexLockKey = readIntEnv(
    'PG_AUTO_SCHEMA_CONCURRENT_INDEX_LOCK_KEY',
    deriveAutoSchemaConcurrentIndexLockKey(url),
    1,
    2147483647
  );
  const autoSchemaConcurrentIndexLockRetries = readIntEnv(
    'PG_AUTO_SCHEMA_CONCURRENT_INDEX_LOCK_RETRIES',
    2,
    0,
    20
  );
  const autoSchemaConcurrentIndexLockRetryMs = readIntEnv(
    'PG_AUTO_SCHEMA_CONCURRENT_INDEX_LOCK_RETRY_MS',
    250,
    50,
    10_000
  );

  const sslEnv = String(process.env.PG_SSL || '').toLowerCase();
  const ssl =
    sslEnv === '1' ||
    sslEnv === 'true' ||
    url.includes('sslmode=require') ||
    url.includes('ssl=true')
      ? { rejectUnauthorized: false }
      : undefined;

  const pool = new Pool({
    connectionString: url,
    ssl,
    max: readIntEnv('PG_POOL_MAX', 10, 1, 100),
    idleTimeoutMillis: readIntEnv('PG_IDLE_TIMEOUT_MS', 30_000, 1_000, 300_000),
    connectionTimeoutMillis: readIntEnv('PG_CONNECT_TIMEOUT_MS', 5_000, 500, 120_000),
  });

  const pgExec = async (sql: string, params?: DbParams) => {
    const { text, values } = compileSql(sql, params);
    return pool.query(text, values);
  };

  const applyConcurrentIndexes = async (client: any) => {
    for (let i = 0; i < POSTGRES_CONCURRENT_INDEXES.length; i++) {
      const sql = POSTGRES_CONCURRENT_INDEXES[i];
      const label = `${i + 1}/${POSTGRES_CONCURRENT_INDEXES.length}`;
      const startedAt = Date.now();
      console.info(`[db] auto-schema concurrent index ${label} start: ${sqlPreview(sql)}`);
      await client.query(sql);
      console.info(`[db] auto-schema concurrent index ${label} done in ${Date.now() - startedAt}ms`);
    }
  };

  const runConcurrentIndexesWithAdvisoryLock = async () => {
    if (!autoSchemaConcurrentIndexes) return;
    const client = await pool.connect();
    let locked = false;
    try {
      if (!autoSchemaConcurrentIndexLock) {
        await applyConcurrentIndexes(client);
        return;
      }

      for (let attempt = 0; attempt <= autoSchemaConcurrentIndexLockRetries; attempt++) {
        const row = await client.query(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [autoSchemaConcurrentIndexLockKey]
        );
        locked = Boolean(row.rows?.[0]?.locked);
        if (locked) break;
        if (attempt < autoSchemaConcurrentIndexLockRetries) {
          await sleep(autoSchemaConcurrentIndexLockRetryMs);
        }
      }

      if (!locked) {
        console.info(
          `[db] auto-schema concurrent indexes skipped; lock held by another replica (key=${autoSchemaConcurrentIndexLockKey})`
        );
        return;
      }

      await applyConcurrentIndexes(client);
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [autoSchemaConcurrentIndexLockKey]);
        } catch (e) {
          console.warn('[db] auto-schema advisory unlock failed', String(e));
        }
      }
      client.release();
    }
  };

  const ensureSchemaOnce = async () => {
    if (!autoSchema) return;
    await pgExec(POSTGRES_SCHEMA);
    await runConcurrentIndexesWithAdvisoryLock();
  };

  const verifySchemaOnce = async () => {
    const requiredTables = Array.from(REQUIRED_PG_TABLES);
    const tableRows = await pool.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
      `,
      [requiredTables]
    );
    const present = new Set(tableRows.rows.map((r: any) => String(r.table_name)));
    const missing = requiredTables.filter((name) => !present.has(name));
    if (missing.length) {
      throw new Error(
        `[db] missing postgres tables (${missing.join(', ')}). Run: npm --prefix backend run db:migrate`
      );
    }

    const parsePgArrayString = (raw: string) => {
      const input = String(raw || '').trim();
      if (!input) return [] as string[];
      if (!(input.startsWith('{') && input.endsWith('}'))) return [input];
      const body = input.slice(1, -1);
      if (!body) return [] as string[];

      const out: string[] = [];
      let token = '';
      let inQuotes = false;
      let escaped = false;

      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (escaped) {
          token += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inQuotes = !inQuotes;
          continue;
        }
        if (ch === ',' && !inQuotes) {
          out.push(token);
          token = '';
          continue;
        }
        token += ch;
      }
      out.push(token);
      return out;
    };

    const normalizeColumns = (columns: unknown) => {
      const source = Array.isArray(columns)
        ? columns
        : (typeof columns === 'string' ? parsePgArrayString(columns) : []);
      return source
        .map((col) => String(col || '').replace(/"/g, '').trim().toLowerCase())
        .filter(Boolean);
    };

    const sameColumns = (actual: string[], expected: string[]) => {
      if (actual.length !== expected.length) return false;
      if (actual.every((col, i) => col === expected[i])) return true;
      const left = [...actual].sort();
      const right = [...expected].sort();
      return left.every((col, i) => col === right[i]);
    };

    const hasUniqueOnColumns = async (table: string, columnsCsvNoSpaces: string) => {
      const expectedColumns = normalizeColumns(columnsCsvNoSpaces.split(','));
      const rows = await pool.query(
        `
          WITH unique_sets AS (
            SELECT ARRAY_AGG(att.attname ORDER BY ck.ord) AS cols
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS ck(attnum, ord) ON TRUE
            JOIN pg_attribute att ON att.attrelid = t.oid AND att.attnum = ck.attnum
            WHERE n.nspname = current_schema()
              AND t.relname = $1
              AND c.contype = 'u'
            GROUP BY c.oid

            UNION ALL

            SELECT ARRAY_AGG(att.attname ORDER BY ik.ord) AS cols
            FROM pg_index i
            JOIN pg_class t ON t.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS ik(attnum, ord) ON TRUE
            JOIN pg_attribute att ON att.attrelid = t.oid AND att.attnum = ik.attnum
            WHERE n.nspname = current_schema()
              AND t.relname = $1
              AND i.indisunique = TRUE
              AND i.indpred IS NULL
              AND i.indexprs IS NULL
              AND ik.attnum > 0
              AND ik.ord <= i.indnkeyatts
            GROUP BY i.indexrelid
          )
          SELECT cols
          FROM unique_sets
        `,
        [table]
      );

      return rows.rows.some((row: { cols?: unknown }) => {
        const cols = normalizeColumns(row?.cols ?? []);
        return sameColumns(cols, expectedColumns);
      });
    };

    const hasSignalConflictTarget = await hasUniqueOnColumns('signals', 'symbol,category,time,config_hash');
    if (!hasSignalConflictTarget) {
      throw new Error(
        '[db] signals unique key (symbol,category,time,config_hash) is missing. Run: npm --prefix backend run db:migrate'
      );
    }

    const hasOutcomeConflictTarget = await hasUniqueOnColumns('signal_outcomes', 'signal_id,horizon_min');
    if (!hasOutcomeConflictTarget) {
      throw new Error(
        '[db] signal_outcomes unique key (signal_id,horizon_min) is missing. Run: npm --prefix backend run db:migrate'
      );
    }

    const loadPresentOutcomeChecks = async () => {
      const checkRows = await pool.query(
        `
          SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'signal_outcomes'
            AND c.contype = 'c'
            AND c.conname = ANY($1::text[])
        `,
        [Array.from(REQUIRED_PG_OUTCOME_CHECKS)]
      );
      return new Set(checkRows.rows.map((r: any) => String(r.conname)));
    };

    let presentChecks = await loadPresentOutcomeChecks();
    let missingChecks = Array.from(REQUIRED_PG_OUTCOME_CHECKS).filter((name) => !presentChecks.has(name));
    if (autoRepairOutcomeChecks) {
      const missingBefore = [...missingChecks];
      try {
        for (const checkName of REQUIRED_PG_OUTCOME_CHECKS) {
          await pool.query(PG_OUTCOME_CHECK_ENSURE_SQL[checkName as RequiredPgOutcomeCheck]);
        }
        presentChecks = await loadPresentOutcomeChecks();
        missingChecks = Array.from(REQUIRED_PG_OUTCOME_CHECKS).filter((name) => !presentChecks.has(name));
        if (!missingChecks.length && missingBefore.length) {
          console.info('[db] auto-repaired missing signal_outcomes invariant checks');
        }
      } catch (e) {
        console.warn('[db] auto-repair of signal_outcomes invariant checks failed', String(e));
      }
    }

    if (missingChecks.length) {
      throw new Error(
        `[db] signal_outcomes invariant checks missing (${missingChecks.join(', ')}). Run: npm --prefix backend run db:migrate`
      );
    }
  };

  let schemaReady = false;

  const ensureSchema = async () => {
    if (schemaReady) return;
    await ensureSchemaOnce();
    await verifySchemaOnce();
    schemaReady = true;
  };

  return {
    driver: 'postgres',
    async exec(sql: string) {
      await ensureSchema();
      await pgExec(sql);
    },
    prepare(sql: string) {
      return {
        async get(...params: any[]) {
          await ensureSchema();
          const res = await pgExec(sql, normalizeParams(params));
          return res.rows[0];
        },
        async all(...params: any[]) {
          await ensureSchema();
          const res = await pgExec(sql, normalizeParams(params));
          return res.rows;
        },
        async run(...params: any[]) {
          await ensureSchema();
          const res = await pgExec(sql, normalizeParams(params));
          return { changes: res.rowCount || 0 };
        },
      };
    },
    transaction<T>(fn: (...args: any[]) => Promise<T>) {
      return async (...args: any[]) => {
        await ensureSchema();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const wrapped: DbConn = {
            driver: 'postgres',
            async exec(sql: string) {
              const { text, values } = compileSql(sql);
              await client.query(text, values);
            },
            prepare(sql: string) {
              return {
                async get(...params: any[]) {
                  const { text, values } = compileSql(sql, normalizeParams(params));
                  const res = await client.query(text, values);
                  return res.rows[0];
                },
                async all(...params: any[]) {
                  const { text, values } = compileSql(sql, normalizeParams(params));
                  const res = await client.query(text, values);
                  return res.rows;
                },
                async run(...params: any[]) {
                  const { text, values } = compileSql(sql, normalizeParams(params));
                  const res = await client.query(text, values);
                  return { changes: res.rowCount || 0 };
                },
              };
            },
            transaction<TInner>(inner: (...args: any[]) => Promise<TInner>) {
              return inner;
            },
          };
          const result = await fn.apply(wrapped as any, args);
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      };
    },
    async close() {
      await pool.end();
    },
  };
}

function compileSql(sql: string, params?: DbParams) {
  let text = normalizeSqlForPg(sql);
  if (!params) return { text, values: [] as any[] };

  if (Array.isArray(params)) {
    let i = 0;
    text = text.replace(/\?/g, () => `$${++i}`);
    return { text, values: params };
  }

  const values: any[] = [];
  const indexMap = new Map<string, number>();
  text = text.replace(/@([a-zA-Z0-9_]+)/g, (_m, key: string) => {
    if (!indexMap.has(key)) {
      indexMap.set(key, values.length + 1);
      values.push((params as Record<string, any>)[key]);
    }
    return `$${indexMap.get(key)}`;
  });

  return { text, values };
}

function normalizeParams(params: any[]) {
  if (params.length === 0) return undefined;
  if (params.length === 1) {
    const p = params[0];
    if (Array.isArray(p)) return p;
    if (p && typeof p === 'object') return p;
    return [p];
  }
  return params;
}

function normalizeSqlForPg(sql: string) {
  let text = sql;
  const hadIgnore = /insert\s+or\s+ignore\s+into/i.test(text);
  if (hadIgnore) {
    text = text.replace(/insert\s+or\s+ignore\s+into/gi, 'INSERT INTO');
    if (!/on\s+conflict/i.test(text)) {
      text = text.replace(/;\s*$/, '');
      text = `${text} ON CONFLICT DO NOTHING`;
    }
  }
  text = text.replace(/json_object\s*\(/gi, 'jsonb_build_object(');
  return text;
}

function readBoolEnv(name: string, fallback: boolean) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function readIntEnv(name: string, fallback: number, min?: number, max?: number) {
  const raw = Number(process.env[name]);
  let out = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  if (typeof min === 'number') out = Math.max(min, out);
  if (typeof max === 'number') out = Math.min(max, out);
  return out;
}

function hashLockSeed(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash * 31) + seed.charCodeAt(i)) | 0;
  }
  const normalized = Math.abs(hash);
  return normalized > 0 ? normalized : 240615;
}

function deriveAutoSchemaConcurrentIndexLockKey(url: string) {
  let dbName = 'local';
  try {
    const u = new URL(url);
    dbName = String(u.pathname || '').replace(/^\//, '') || dbName;
  } catch {}
  const envName = String(process.env.NODE_ENV || process.env.RAILWAY_ENVIRONMENT || 'development');
  const seed = `pg_auto_schema_indexes|${envName}|${dbName}`;
  return hashLockSeed(seed);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sqlPreview(sql: string) {
  return sql.replace(/\s+/g, ' ').trim();
}
