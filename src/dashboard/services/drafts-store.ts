/**
 * Drafts store — agent-generated artifacts awaiting human review.
 *
 * Status machine (enforced here, not at the DB):
 *
 *   pending_review ──▶ approved ──▶ published
 *        │                │
 *        ├──▶ revised ──▶ pending_review (resubmit cycle)
 *        └──▶ rejected (terminal)
 *
 * Why state machine logic lives in the repo rather than as CHECK constraints:
 * we want to evolve transitions (e.g. allow "revise approved") without
 * migrations, and centralizing the rules makes the rules legible.
 *
 * Drafts are owned by agents. The producer (e.g. content_write_article) calls
 * `create()`. Reviewers call `update()` to edit, `setStatus()` to advance,
 * `remove()` to hard-delete (no soft-delete today — drafts that get rejected
 * stay around as audit history; if you don't want them in the inbox, the UI
 * filters by status).
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { drafts, type DraftRow } from '../../db/schema.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('drafts');

export const DRAFT_STATUSES = [
  'pending_review',
  'approved',
  'published',
  'rejected',
  'revised',
] as const;

export type DraftStatus = typeof DRAFT_STATUSES[number];

/** Closed set of agents that can own a draft. Add as new producers ship. */
export const DRAFT_AGENT_IDS = ['writer', 'social-x', 'social-linkedin', 'social-hn', 'reddit', 'coding'] as const;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type DraftAgentId = typeof DRAFT_AGENT_IDS[number];

export interface Draft {
  id: string;
  siteId: string;
  agentId: string;
  draftType: string;
  status: DraftStatus;
  title: string;
  content: unknown;
  sourceRef: unknown;
  metadata: Record<string, unknown>;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  publishedAt: string | null;
}

function rowToDraft(r: DraftRow): Draft {
  return {
    id: r.id,
    siteId: r.siteId,
    agentId: r.agentId,
    draftType: r.draftType,
    status: r.status as DraftStatus,
    title: r.title,
    content: r.content,
    sourceRef: r.sourceRef,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    reviewedBy: r.reviewedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    reviewedAt: r.reviewedAt,
    publishedAt: r.publishedAt,
  };
}

/**
 * Legal transitions. The current status maps to the set of next statuses
 * it can move into. Terminal states (published, rejected) have empty sets.
 */
const TRANSITIONS: Record<DraftStatus, Set<DraftStatus>> = {
  pending_review: new Set(['approved', 'revised', 'rejected']),
  approved: new Set(['published']),
  revised: new Set(['pending_review']),
  published: new Set(),
  rejected: new Set(),
};

export class DraftTransitionError extends Error {
  constructor(public from: DraftStatus, public to: DraftStatus) {
    super(`Illegal draft transition: ${from} → ${to}`);
    this.name = 'DraftTransitionError';
  }
}

export interface CreateDraftInput {
  siteId: string;
  agentId: string;
  draftType: string;
  title: string;
  content: unknown;
  sourceRef?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ListDraftsOptions {
  siteId?: string;
  agentId?: string;
  status?: DraftStatus | DraftStatus[];
  limit?: number;
}

export class DraftsRepo {
  async create(input: CreateDraftInput): Promise<Draft> {
    const rows = await getDb()
      .insert(drafts)
      .values({
        siteId: input.siteId,
        agentId: input.agentId,
        draftType: input.draftType,
        title: input.title,
        content: input.content as Record<string, unknown>,
        sourceRef: (input.sourceRef ?? null) as Record<string, unknown> | null,
        metadata: input.metadata ?? {},
      })
      .returning();
    log.info('Draft created', { id: rows[0].id, siteId: input.siteId, agentId: input.agentId, draftType: input.draftType });
    return rowToDraft(rows[0]);
  }

  async get(id: string): Promise<Draft | null> {
    const rows = await getDb().select().from(drafts).where(eq(drafts.id, id)).limit(1);
    return rows[0] ? rowToDraft(rows[0]) : null;
  }

  async list(opts: ListDraftsOptions = {}): Promise<Draft[]> {
    const conditions = [];
    if (opts.siteId) conditions.push(eq(drafts.siteId, opts.siteId));
    if (opts.agentId) conditions.push(eq(drafts.agentId, opts.agentId));
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      conditions.push(inArray(drafts.status, statuses));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = await getDb()
      .select()
      .from(drafts)
      .where(where)
      .orderBy(desc(drafts.createdAt))
      .limit(limit);
    return rows.map(rowToDraft);
  }

  /**
   * Edit a draft's title or content while it's pending review or revised.
   * Editing an approved/published/rejected draft is rejected — those states
   * are immutable history.
   */
  async update(id: string, patch: { title?: string; content?: unknown; metadata?: Record<string, unknown> }): Promise<Draft | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (current.status !== 'pending_review' && current.status !== 'revised') {
      throw new DraftTransitionError(current.status, current.status);
    }
    const merged: Partial<DraftRow> = { updatedAt: new Date().toISOString() };
    if (patch.title !== undefined) merged.title = patch.title;
    if (patch.content !== undefined) merged.content = patch.content as Record<string, unknown>;
    if (patch.metadata !== undefined) merged.metadata = { ...current.metadata, ...patch.metadata };
    const rows = await getDb().update(drafts).set(merged).where(eq(drafts.id, id)).returning();
    return rows[0] ? rowToDraft(rows[0]) : null;
  }

  /**
   * Advance a draft along the state machine. Validates the transition is
   * legal; throws DraftTransitionError otherwise.
   * `reviewedBy` is recorded on transitions that imply human action
   * (approved / rejected / published). Pass null for system transitions.
   */
  async setStatus(id: string, to: DraftStatus, reviewedBy: string | null = null): Promise<Draft | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (!TRANSITIONS[current.status].has(to)) {
      throw new DraftTransitionError(current.status, to);
    }
    const now = new Date().toISOString();
    const patch: Partial<DraftRow> = { status: to, updatedAt: now };
    if (to === 'approved' || to === 'rejected' || to === 'revised') {
      patch.reviewedAt = now;
      if (reviewedBy) patch.reviewedBy = reviewedBy;
    }
    if (to === 'published') {
      patch.publishedAt = now;
      if (reviewedBy) patch.reviewedBy = reviewedBy;
    }
    const rows = await getDb().update(drafts).set(patch).where(eq(drafts.id, id)).returning();
    log.info('Draft status transitioned', { id, from: current.status, to, reviewedBy });
    return rows[0] ? rowToDraft(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const deleted = await getDb().delete(drafts).where(eq(drafts.id, id)).returning({ id: drafts.id });
    return deleted.length > 0;
  }

  /** Inbox summary: { pending, approved, published, rejected } counts per site. */
  async inboxSummary(siteId?: string): Promise<Record<DraftStatus, number>> {
    const conditions = siteId ? eq(drafts.siteId, siteId) : undefined;
    const rows = await getDb()
      .select({ status: drafts.status })
      .from(drafts)
      .where(conditions);
    const counts: Record<DraftStatus, number> = {
      pending_review: 0,
      approved: 0,
      published: 0,
      rejected: 0,
      revised: 0,
    };
    for (const r of rows) {
      const s = r.status as DraftStatus;
      counts[s]++;
    }
    return counts;
  }
}

export const draftsRepo = new DraftsRepo();
