/**
 * Snapshots — generic cache layer for expensive tool output, keyed by
 * (siteId, kind).
 *
 * Why this module exists:
 *   - Lighthouse, llms.txt probes, comprehensive audits each take 10-120s.
 *     The Command Center routes can't run them inline on every page load.
 *   - Before this module: nothing. Every route that wanted cache would have
 *     invented its own table + TTL math. With three caching consumers planned
 *     (Lighthouse mobile, Lighthouse desktop, llms.txt) and more coming, the
 *     policy needs to live in one place.
 *
 * The interface is intentionally small:
 *   - `getOrFresh` — read-through cache: if fresh, return cached; if stale or
 *     missing, run producer, store, return.
 *   - `getLatest` — pure read, no producer fallback. For "show me what we have."
 *   - `getMany` — batch read; one DB query for N kinds. The route uses this.
 *   - `invalidate` — explicit refresh trigger (UI "refresh" button).
 *
 * Failure policy (`getOrFresh`):
 *   - Producer throws AND no prior snapshot → throw.
 *   - Producer throws AND prior snapshot exists → return stale data with
 *     `isStale: true` + the producer error. Graceful degradation: the UI
 *     can keep showing yesterday's score and surface the error inline.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { siteSnapshots } from '../../db/schema.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('snapshots');

/**
 * Snapshot kinds. The const array is the runtime whitelist; the type is
 * derived from it. Routes that receive a `kind` from untrusted input must
 * call `isKnownSnapshotKind()` before casting. Adding a kind = append here +
 * (optionally) wire its TTL in the consumer.
 */
export const SNAPSHOT_KINDS = [
  'lighthouse_mobile',
  'lighthouse_desktop',
  'cwv_mobile',
  'cwv_desktop',
  'llms_txt_probe',
  'security_audit',
  'seo_audit',
  'site_health',
  // Analytics tabs (Links/Technical/GEO) cache these per-tool outputs
  'gsc_top_queries',
  'gsc_top_pages',
  'broken_links',
  'seo_robots',
  'seo_sitemap_status',
  'seo_structured_data',
  'security_headers',
  'security_ssl',
  'geo_audit',
] as const;

export type SnapshotKind = typeof SNAPSHOT_KINDS[number];

export function isKnownSnapshotKind(value: string): value is SnapshotKind {
  return (SNAPSHOT_KINDS as readonly string[]).includes(value);
}

export interface Snapshot<T = unknown> {
  id: number;
  siteId: string;
  kind: SnapshotKind;
  data: T;
  capturedAt: string;
}

export interface GetOrFreshOptions<T> {
  siteId: string;
  kind: SnapshotKind;
  /** Max age in seconds before the snapshot is considered stale. */
  maxAgeSeconds: number;
  /** Called when the cache is stale or missing. Result is persisted. */
  producer: () => Promise<T>;
  /** If true, bypass cache and run producer (UI refresh button). */
  force?: boolean;
}

export interface FreshResult<T> {
  data: T;
  capturedAt: string;
  /** True when the producer was called this turn (cache miss or forced). */
  wasFresh: boolean;
  /**
   * True when the data returned is from cache because the producer failed.
   * Caller decides whether to surface the producerError to the user.
   */
  isStale: boolean;
  producerError?: string;
}

function ageSeconds(capturedAt: string): number {
  return (Date.now() - new Date(capturedAt).getTime()) / 1000;
}

class SnapshotsRepo {
  /**
   * Read-through cache. See module docstring for failure semantics.
   */
  async getOrFresh<T>(opts: GetOrFreshOptions<T>): Promise<FreshResult<T>> {
    const latest = opts.force ? null : await this.getLatest<T>(opts.siteId, opts.kind);

    if (latest && !opts.force && ageSeconds(latest.capturedAt) < opts.maxAgeSeconds) {
      return { data: latest.data, capturedAt: latest.capturedAt, wasFresh: false, isStale: false };
    }

    try {
      const data = await opts.producer();
      const saved = await this.save({ siteId: opts.siteId, kind: opts.kind, data });
      return { data: saved.data, capturedAt: saved.capturedAt, wasFresh: true, isStale: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Snapshot producer failed', { siteId: opts.siteId, kind: opts.kind, error: message });
      if (latest) {
        return {
          data: latest.data,
          capturedAt: latest.capturedAt,
          wasFresh: false,
          isStale: true,
          producerError: message,
        };
      }
      throw err;
    }
  }

  /** Pure read. Returns null when no snapshot of this kind exists for the site. */
  async getLatest<T>(siteId: string, kind: SnapshotKind): Promise<Snapshot<T> | null> {
    const rows = await getDb()
      .select()
      .from(siteSnapshots)
      .where(and(eq(siteSnapshots.siteId, siteId), eq(siteSnapshots.kind, kind)))
      .orderBy(desc(siteSnapshots.capturedAt))
      .limit(1);
    return rows[0]
      ? {
          id: rows[0].id,
          siteId: rows[0].siteId,
          kind: rows[0].kind as SnapshotKind,
          data: rows[0].data as T,
          capturedAt: rows[0].capturedAt,
        }
      : null;
  }

  /**
   * Batch read: one row per kind (the latest). Fans out into N parallel
   * `getLatest` calls — each one hits the (site_id, kind, captured_at DESC)
   * index with LIMIT 1, so total work is N index seeks regardless of total
   * snapshot history. For 3-15 kinds this is faster and simpler than a
   * DISTINCT ON query, and avoids SQL placeholder escaping issues with
   * array parameters.
   */
  async getMany(siteId: string, kinds: SnapshotKind[]): Promise<Partial<Record<SnapshotKind, Snapshot>>> {
    if (kinds.length === 0) return {};
    const results = await Promise.all(kinds.map((k) => this.getLatest(siteId, k)));
    const out: Partial<Record<SnapshotKind, Snapshot>> = {};
    for (let i = 0; i < kinds.length; i++) {
      const s = results[i];
      if (s) out[kinds[i]] = s;
    }
    return out;
  }

  /**
   * Drop all snapshots of a given (siteId, kind). The next getOrFresh will
   * miss the cache and call its producer. Use this from "force refresh"
   * paths; for read-through that just needs fresh data, pass `force: true`
   * to getOrFresh instead (which keeps the old row as history).
   */
  async invalidate(siteId: string, kind: SnapshotKind): Promise<number> {
    const deleted = await getDb()
      .delete(siteSnapshots)
      .where(and(eq(siteSnapshots.siteId, siteId), eq(siteSnapshots.kind, kind)))
      .returning({ id: siteSnapshots.id });
    log.info('Snapshots invalidated (deleted)', { siteId, kind, count: deleted.length });
    return deleted.length;
  }

  /**
   * Retention: drop snapshots older than `olderThanDays`, but keep the
   * latest per (siteId, kind) regardless of age. Returns the count deleted.
   *
   * Keeping the latest preserves the "show me what we have" path even if
   * no fresh capture has happened in months — staleness is signaled via
   * isStale, not by absence.
   */
  async pruneOlderThan(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const cutoffIso = cutoff.toISOString();

    const result = await getDb().execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM site_snapshots
        WHERE captured_at < ${cutoffIso}
          AND id NOT IN (
            SELECT DISTINCT ON (site_id, kind) id
            FROM site_snapshots
            ORDER BY site_id, kind, captured_at DESC
          )
        RETURNING id
      )
      SELECT count(*) AS count FROM deleted
    `);
    const count = parseInt(result.rows[0]?.count ?? '0', 10);
    log.info('Snapshots pruned', { olderThanDays, deleted: count });
    return count;
  }

  /** Persist a fresh snapshot. Returns the saved row. */
  async save<T>(input: { siteId: string; kind: SnapshotKind; data: T }): Promise<Snapshot<T>> {
    const rows = await getDb()
      .insert(siteSnapshots)
      .values({ siteId: input.siteId, kind: input.kind, data: input.data as unknown as Record<string, unknown> })
      .returning();
    const r = rows[0];
    const snap: Snapshot<T> = {
      id: r.id,
      siteId: r.siteId,
      kind: r.kind as SnapshotKind,
      data: r.data as T,
      capturedAt: r.capturedAt,
    };
    fireSaveHooks(snap);
    return snap;
  }
}

export const snapshotsRepo = new SnapshotsRepo();

// ---------------------------------------------------------------------------
// Save hooks — let downstream modules (e.g. snapshot-signals) react to new
// snapshots without snapshots.ts importing them. Fire-and-forget; hook errors
// are logged but never block the save.
// ---------------------------------------------------------------------------

type SnapshotSaveHook = (snap: Snapshot) => void | Promise<void>;
const saveHooks: SnapshotSaveHook[] = [];

export function onSnapshotSaved(handler: SnapshotSaveHook): void {
  saveHooks.push(handler);
}

function fireSaveHooks(snap: Snapshot): void {
  for (const hook of saveHooks) {
    try {
      const r = hook(snap);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err: unknown) =>
          log.warn('Snapshot save hook failed', {
            siteId: snap.siteId,
            kind: snap.kind,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    } catch (err) {
      log.warn('Snapshot save hook threw synchronously', {
        siteId: snap.siteId,
        kind: snap.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Retention scheduler — runs at boot + every 24h. Idempotent.
// ---------------------------------------------------------------------------

let pruneInterval: NodeJS.Timeout | null = null;

export function startSnapshotPruner(): void {
  if (process.env.SNAPSHOT_PRUNE_DISABLED === 'true') {
    log.info('Snapshot pruner disabled via env');
    return;
  }
  if (pruneInterval) return;

  const days = parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '30', 10);
  const intervalHours = parseInt(process.env.SNAPSHOT_PRUNE_INTERVAL_HOURS || '24', 10);
  const initialDelayMs = parseInt(process.env.SNAPSHOT_PRUNE_INITIAL_DELAY_MS || '60000', 10); // 1 min

  log.info('Snapshot pruner scheduler started', { retentionDays: days, intervalHours });

  setTimeout(() => {
    void snapshotsRepo.pruneOlderThan(days).catch((err) =>
      log.error('Initial snapshot prune failed', { error: err instanceof Error ? err : new Error(String(err)) }),
    );
  }, initialDelayMs);

  pruneInterval = setInterval(() => {
    void snapshotsRepo.pruneOlderThan(days).catch((err) =>
      log.error('Scheduled snapshot prune failed', { error: err instanceof Error ? err : new Error(String(err)) }),
    );
  }, intervalHours * 60 * 60 * 1000);
}

export function stopSnapshotPruner(): void {
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
    log.info('Snapshot pruner stopped');
  }
}

// Keep import live; `lt` not used today but reserved for the next time we
// need range queries (e.g. trend reports).
void lt;
