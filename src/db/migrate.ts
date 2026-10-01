/**
 * Migration runner — applies SQL files under `drizzle/` in lexical order.
 *
 * Tracks applied migrations in a `_migrations` table. Each migration runs
 * inside a transaction so partial failures don't leave the schema dirty.
 * Idempotent — safe to call on every boot.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './index.js';
import { createServiceLogger } from '../utils/logger.js';

const log = createServiceLogger('db-migrate');

/**
 * Locate the drizzle/ directory. Works in dev (tsx — sources next to repo
 * root) and prod (tsup bundle in dist/, drizzle/ stays at repo root).
 */
function findMigrationsDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.DRIZZLE_DIR,
    resolve(currentDir, '..', '..', 'drizzle'),    // src/db/migrate.ts → ../../drizzle
    resolve(currentDir, '..', 'drizzle'),          // dist/index.js → ../drizzle (same dir)
    resolve(currentDir, 'drizzle'),
    resolve(process.cwd(), 'drizzle'),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Could not locate drizzle/ migrations directory. Tried: ${candidates.join(', ')}`);
}

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          serial PRIMARY KEY,
      filename    text NOT NULL UNIQUE,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listApplied(): Promise<Set<string>> {
  const r = await getPool().query<{ filename: string }>('SELECT filename FROM _migrations');
  return new Set(r.rows.map((row) => row.filename));
}

export async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await listApplied();
  const dir = findMigrationsDir();

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let appliedCount = 0;
  const pool = getPool();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf-8');
    log.info(`Applying migration ${file}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      appliedCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${file} failed: ${msg}`);
    } finally {
      client.release();
    }
  }

  if (appliedCount === 0) {
    log.info('No new migrations to apply');
  } else {
    log.info(`Applied ${appliedCount} migration(s)`);
  }
}
