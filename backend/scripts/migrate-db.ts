import 'dotenv/config';
import pg from 'pg';
import { POSTGRES_CONCURRENT_INDEXES, POSTGRES_SCHEMA } from '../src/db/postgresSchema.js';

const { Pool } = pg;

function sqlPreview(sql: string) {
  return sql.replace(/\s+/g, ' ').trim();
}

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
    const client = await pool.connect();
    try {
      await client.query(POSTGRES_SCHEMA);
      for (let i = 0; i < POSTGRES_CONCURRENT_INDEXES.length; i++) {
        const sql = POSTGRES_CONCURRENT_INDEXES[i];
        const label = `${i + 1}/${POSTGRES_CONCURRENT_INDEXES.length}`;
        const startedAt = Date.now();
        console.log(`[db:migrate] concurrent index ${label} start: ${sqlPreview(sql)}`);
        await client.query(sql);
        console.log(`[db:migrate] concurrent index ${label} done in ${Date.now() - startedAt}ms`);
      }
    } finally {
      client.release();
    }
    console.log('[db:migrate] applied postgres schema + concurrent indexes');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[db:migrate] failed:', e);
  process.exitCode = 1;
});
