/**
 * Postgres connection and Drizzle client.
 *
 * Single shared pool. The first call to `getDb()` creates it; subsequent
 * calls reuse the same instance. Connection settings come from
 * DATABASE_URL — required for the dashboard to start.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createServiceLogger } from '../utils/logger.js';
import * as schema from './schema.js';

const log = createServiceLogger('db');

const DEFAULT_URL = 'postgres://sandi_ads:sandi_ads_dev@localhost:5434/sandi_ads';

let pool: pg.Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL || DEFAULT_URL;
  pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    log.error('Postgres pool error', { error: err });
  });
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  db = drizzle(getPool(), { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

/**
 * Verify connection at startup. Throws a friendly error if Postgres is down.
 */
export async function pingDb(): Promise<void> {
  const p = getPool();
  try {
    const r = await p.query('SELECT 1 AS ok');
    if (r.rows[0]?.ok !== 1) throw new Error('unexpected response');
    log.info('Postgres connection OK');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const url = new URL(process.env.DATABASE_URL || DEFAULT_URL);
    const target = `${url.hostname}:${url.port || '5432'}${url.pathname}`;
    throw new Error(
      `Cannot connect to Postgres at ${target}. ` +
      `Run \`docker compose up -d\` to start the local instance. (${msg})`,
    );
  }
}
