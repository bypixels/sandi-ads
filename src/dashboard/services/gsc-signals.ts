/**
 * GSC signals repository — alert-like records derived from polling GSC API.
 *
 * The watcher (`gsc-monitor.ts`) calls upsertOpen() each time it detects a
 * condition. If an open signal of the same (siteId, type) already exists,
 * its lastSeen + detail get refreshed. When the condition clears, the
 * watcher calls resolveOpen() which sets resolvedAt.
 *
 * Resolved rows are kept as history.
 */

import { and, desc, eq, isNull, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { gscSignals, sites } from '../../db/schema.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('gsc-signals');

export type SignalSeverity = 'info' | 'low' | 'warn' | 'high' | 'critical';

export interface SignalUpsert {
  siteId: string;
  signalType: string;
  severity: SignalSeverity;
  title: string;
  detail: Record<string, unknown>;
}

export interface Signal {
  id: number;
  siteId: string;
  siteName?: string;
  signalType: string;
  severity: SignalSeverity;
  title: string;
  detail: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
  acknowledged: boolean;
}

function rowToSignal(r: typeof gscSignals.$inferSelect, siteName?: string): Signal {
  return {
    id: r.id,
    siteId: r.siteId,
    siteName,
    signalType: r.signalType,
    severity: r.severity as SignalSeverity,
    title: r.title,
    detail: (r.detail as Record<string, unknown>) || {},
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    resolvedAt: r.resolvedAt,
    acknowledged: r.acknowledged,
  };
}

class SignalsRepo {
  /** All open signals, optionally filtered by site. Joins with sites for the name. */
  async listOpen(siteId?: string): Promise<Signal[]> {
    const db = getDb();
    const rows = siteId
      ? await db
          .select({ s: gscSignals, name: sites.name })
          .from(gscSignals)
          .leftJoin(sites, eq(sites.id, gscSignals.siteId))
          .where(and(eq(gscSignals.siteId, siteId), isNull(gscSignals.resolvedAt)))
          .orderBy(desc(gscSignals.lastSeen))
      : await db
          .select({ s: gscSignals, name: sites.name })
          .from(gscSignals)
          .leftJoin(sites, eq(sites.id, gscSignals.siteId))
          .where(isNull(gscSignals.resolvedAt))
          .orderBy(desc(gscSignals.lastSeen));
    return rows.map((r) => rowToSignal(r.s, r.name ?? undefined));
  }

  /** Recent signals (open + resolved), capped, ordered by last_seen desc. */
  async listRecent(limit = 100): Promise<Signal[]> {
    const db = getDb();
    const rows = await db
      .select({ s: gscSignals, name: sites.name })
      .from(gscSignals)
      .leftJoin(sites, eq(sites.id, gscSignals.siteId))
      .orderBy(desc(gscSignals.lastSeen))
      .limit(Math.max(1, Math.min(limit, 500)));
    return rows.map((r) => rowToSignal(r.s, r.name ?? undefined));
  }

  async getById(id: number): Promise<Signal | null> {
    const db = getDb();
    const rows = await db
      .select({ s: gscSignals, name: sites.name })
      .from(gscSignals)
      .leftJoin(sites, eq(sites.id, gscSignals.siteId))
      .where(eq(gscSignals.id, id))
      .limit(1);
    return rows[0] ? rowToSignal(rows[0].s, rows[0].name ?? undefined) : null;
  }

  /**
   * If an open signal of (siteId, signalType) exists → refresh lastSeen + detail.
   * Else → insert a new open signal.
   * Severity and title from the latest detection are always written.
   */
  async upsertOpen(input: SignalUpsert): Promise<Signal> {
    const db = getDb();
    const now = new Date().toISOString();

    const existing = await db
      .select()
      .from(gscSignals)
      .where(
        and(
          eq(gscSignals.siteId, input.siteId),
          eq(gscSignals.signalType, input.signalType),
          isNull(gscSignals.resolvedAt),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const updated = await db
        .update(gscSignals)
        .set({
          severity: input.severity,
          title: input.title,
          detail: input.detail,
          lastSeen: now,
        })
        .where(eq(gscSignals.id, existing[0].id))
        .returning();
      return rowToSignal(updated[0]);
    }

    const inserted = await db
      .insert(gscSignals)
      .values({
        siteId: input.siteId,
        signalType: input.signalType,
        severity: input.severity,
        title: input.title,
        detail: input.detail,
      })
      .returning();
    return rowToSignal(inserted[0]);
  }

  /**
   * Resolve any open signals of given types for a site that are NOT in
   * `keepOpen`. Used by the watcher: after running detectors, anything that
   * was open but no longer triggered gets resolved.
   */
  async resolveStale(siteId: string, openTypes: string[]): Promise<number> {
    const db = getDb();
    const open = await db
      .select()
      .from(gscSignals)
      .where(and(eq(gscSignals.siteId, siteId), isNull(gscSignals.resolvedAt)));

    const stale = open.filter((s) => !openTypes.includes(s.signalType));
    if (stale.length === 0) return 0;

    const now = new Date().toISOString();
    let resolved = 0;
    for (const s of stale) {
      await db.update(gscSignals).set({ resolvedAt: now }).where(eq(gscSignals.id, s.id));
      resolved++;
    }
    log.info('Resolved stale signals', { siteId, count: resolved });
    return resolved;
  }

  /**
   * Scoped reconciliation: resolve open signals whose type ∈ `ownedTypes`
   * AND ∉ `keepOpen`. Use this from producers that only know about a subset
   * of signal kinds (e.g. snapshot-signals owns llms_txt_* + cwv_*; the
   * security monitor owns security_*). Unlike `resolveStale`, this won't
   * touch signals outside the producer's ownership.
   */
  async resolveByTypes(siteId: string, ownedTypes: string[], keepOpen: string[]): Promise<number> {
    if (ownedTypes.length === 0) return 0;
    const db = getDb();
    const open = await db
      .select()
      .from(gscSignals)
      .where(and(eq(gscSignals.siteId, siteId), isNull(gscSignals.resolvedAt)));
    const toResolve = open.filter(
      (s) => ownedTypes.includes(s.signalType) && !keepOpen.includes(s.signalType),
    );
    if (toResolve.length === 0) return 0;
    const now = new Date().toISOString();
    let resolved = 0;
    for (const s of toResolve) {
      await db.update(gscSignals).set({ resolvedAt: now }).where(eq(gscSignals.id, s.id));
      resolved++;
    }
    log.info('Resolved scoped signals', { siteId, ownedTypes, count: resolved });
    return resolved;
  }

  async acknowledge(id: number): Promise<Signal | null> {
    const db = getDb();
    const rows = await db
      .update(gscSignals)
      .set({ acknowledged: true })
      .where(eq(gscSignals.id, id))
      .returning();
    return rows[0] ? rowToSignal(rows[0]) : null;
  }

  /** Counts of open signals by severity, across all sites */
  async openSummary(): Promise<{ total: number; bySeverity: Record<SignalSeverity, number> }> {
    const db = getDb();
    const rows = await db
      .select({ severity: gscSignals.severity })
      .from(gscSignals)
      .where(isNull(gscSignals.resolvedAt));
    const bySeverity: Record<SignalSeverity, number> = { info: 0, low: 0, warn: 0, high: 0, critical: 0 };
    for (const r of rows) {
      bySeverity[r.severity as SignalSeverity]++;
    }
    return { total: rows.length, bySeverity };
  }
}

export const signalsRepo = new SignalsRepo();

// keep import live for future "resolved-only" reports
void isNotNull;
