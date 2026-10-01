/**
 * Legacy file → Postgres migration runner.
 *
 * The 3 file-backed stores (sites, audit log, conversations) all do the same
 * dance on first boot: resolve a base dir from a cascade of env vars, check
 * if the legacy file exists, skip if the DB already has data, otherwise
 * parse + insert + rename to `.imported`.
 *
 * Before this module: each store implemented the shape inline with slight
 * variations in env-var precedence and error handling. Adding a new env
 * override or changing the rename semantics took 3 edits.
 *
 * Now: each store contributes a `LegacyMigration` spec describing its file
 * shape; the runner owns path resolution, skip logic, and the rename.
 *
 * Path resolution falls back through env vars in declared order. The
 * fallback (`process.cwd()`) is the practical default — it's what the dev
 * setup uses and what the smoke tests assume.
 */

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('migration');

export interface LegacyMigration {
  /** Short name used in log messages. */
  name: string;
  /**
   * Env var names to try in order. `SITES_STORE_PATH` and
   * `CREDENTIAL_STORE_PATH` are recognized fallbacks across all migrations,
   * so most callers only need to declare their own primary var.
   */
  pathEnvVars: string[];
  /** File or directory name appended to the resolved base path. */
  fileName: string;
  /** Returns true if the destination table already has data — skip + rename. */
  isAlreadyPopulated: () => Promise<boolean>;
  /**
   * Called only when the legacy file/dir exists AND the destination is empty.
   * Returns the number of imported rows. Throwing here aborts the migration
   * (file is NOT renamed) so the next boot can retry after a fix.
   */
  importEntries: (filePath: string) => Promise<number>;
}

export interface MigrationResult {
  imported: number;
  skipped: boolean;
}

const COMMON_FALLBACKS = ['SITES_STORE_PATH', 'CREDENTIAL_STORE_PATH'];

function resolveBaseDir(envVars: string[]): string {
  const tried = [...envVars, ...COMMON_FALLBACKS];
  for (const v of tried) {
    const val = process.env[v];
    if (val) return val;
  }
  return process.cwd();
}

function safeRename(from: string, to: string): void {
  try { renameSync(from, to); } catch { /* ignore — best effort */ }
}

/**
 * Apply a legacy migration. Idempotent — safe to call on every boot.
 *
 * Returns `{ imported: 0, skipped: true }` when:
 *   - the file doesn't exist, OR
 *   - the destination table is already populated (file is still renamed)
 */
export async function runLegacyMigration(spec: LegacyMigration): Promise<MigrationResult> {
  const dir = resolveBaseDir(spec.pathEnvVars);
  const filePath = join(dir, spec.fileName);

  if (!existsSync(filePath)) {
    return { imported: 0, skipped: true };
  }

  if (await spec.isAlreadyPopulated()) {
    safeRename(filePath, filePath + '.imported');
    return { imported: 0, skipped: true };
  }

  try {
    const imported = await spec.importEntries(filePath);
    safeRename(filePath, filePath + '.imported');
    log.info(`Imported legacy ${spec.name}`, { imported });
    return { imported, skipped: false };
  } catch (err) {
    log.error(`Legacy ${spec.name} import failed`, {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { imported: 0, skipped: true };
  }
}
