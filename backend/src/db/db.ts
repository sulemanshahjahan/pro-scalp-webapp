import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { DB_DIR, DB_PATH } from '../dbPath.js';
import { POSTGRES_SCHEMA } from './postgresSchema.js';

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

  const sslEnv = String(process.env.PG_SSL || '').toLowerCase();
  const ssl =
    sslEnv === '1' ||
    sslEnv === 'true' ||
    url.includes('sslmode=require') ||
    url.includes('ssl=true')
      ? { rejectUnauthorized: false }
      : undefined;

  const pool = new Pool({ connectionString: url, ssl });

  const pgExec = async (sql: string, params?: DbParams) => {
    const { text, values } = compileSql(sql, params);
    return pool.query(text, values);
  };

  const ensureSchemaOnce = async () => {
    await pgExec(POSTGRES_SCHEMA);
  };

  let schemaReady = false;

  const ensureSchema = async () => {
    if (schemaReady) return;
    await ensureSchemaOnce();
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
