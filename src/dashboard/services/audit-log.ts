/**
 * Audit log for mutating actions invoked through the dashboard.
 *
 * Backed by Postgres (`audit_events` table). Inputs are persisted verbatim
 * except for keys that look like secrets, which are masked.
 *
 * Note: API is now async. Callers that previously did `auditLog.append(e)`
 * synchronously can either await the call or fire-and-forget it
 * (`void auditLog.append(...)`). Errors are logged but never thrown — a
 * failed audit write must not break the actual operation.
 */

import { readFileSync } from 'node:fs';
import { desc, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { auditEvents } from '../../db/schema.js';
import { createServiceLogger } from '../../utils/logger.js';
import { runLegacyMigration, type MigrationResult } from './migration.js';

const log = createServiceLogger('audit-log');

const SECRET_KEY_RE = /token|secret|key|password|authorization/i;
const MAX_VALUE_LEN = 500;

export interface AuditEntry {
  timestamp: string;
  tool: string;
  siteId?: string;
  input: unknown;
  status: 'success' | 'error' | 'blocked';
  durationMs: number;
  error?: string;
  resultSummary?: string;
}

function maskSecrets(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LEN ? value.slice(0, MAX_VALUE_LEN) + '…' : value;
  }
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) out[k] = '***masked***';
      else out[k] = maskSecrets(v);
    }
    return out;
  }
  return value;
}

class AuditLog {
  async append(entry: AuditEntry): Promise<void> {
    try {
      await getDb().insert(auditEvents).values({
        timestamp: entry.timestamp,
        tool: entry.tool,
        siteId: entry.siteId ?? null,
        input: maskSecrets(entry.input),
        status: entry.status,
        durationMs: entry.durationMs,
        error: entry.error ?? null,
        resultSummary: entry.resultSummary ?? null,
      });
    } catch (err) {
      log.error('Failed to write audit entry', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /** Read the most recent N entries (latest first) */
  async readRecent(limit = 100): Promise<AuditEntry[]> {
    try {
      const rows = await getDb()
        .select()
        .from(auditEvents)
        .orderBy(desc(auditEvents.timestamp))
        .limit(Math.max(1, Math.min(limit, 1000)));
      return rows.map((r) => ({
        timestamp: r.timestamp,
        tool: r.tool,
        siteId: r.siteId ?? undefined,
        input: r.input,
        status: r.status as AuditEntry['status'],
        durationMs: r.durationMs,
        error: r.error ?? undefined,
        resultSummary: r.resultSummary ?? undefined,
      }));
    } catch (err) {
      log.error('Failed to read audit log', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return [];
    }
  }

  /**
   * Import existing JSONL file into Postgres on first run.
   * Renames the file to `.imported` afterwards so re-runs skip it.
   * Idempotent — safe to call on every boot.
   */
  async importLegacyJsonl(): Promise<MigrationResult> {
    return runLegacyMigration({
      name: 'audit JSONL',
      pathEnvVars: ['AUDIT_LOG_PATH'],
      fileName: '.website-ops-audit.jsonl',
      isAlreadyPopulated: async () => {
        const existing = await getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(auditEvents);
        return (existing[0]?.count ?? 0) > 0;
      },
      importEntries: async (filePath) => {
        const raw = readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n').filter((l) => l.trim());
        let imported = 0;
        for (const line of lines) {
          try {
            const e = JSON.parse(line) as AuditEntry;
            await this.append(e);
            imported++;
          } catch {
            // skip corrupt lines
          }
        }
        return imported;
      },
    });
  }
}

export const auditLog = new AuditLog();

/** Build a one-line summary from arbitrary tool output for display */
export function summarizeResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result.slice(0, 200);
  if (typeof result !== 'object') return String(result);
  const obj = result as Record<string, unknown>;
  // Common ID fields
  for (const key of ['id', 'name', 'path', 'resourceName', 'reviewId', 'recordId']) {
    if (typeof obj[key] === 'string') return `${key}=${obj[key]}`;
  }
  // First scalar value
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return `${k}=${v}`;
    }
  }
  return Object.keys(obj).slice(0, 3).join(',');
}
