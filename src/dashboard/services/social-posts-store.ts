/**
 * Social posts store — own publishing queue for Facebook + Instagram.
 *
 * Nothing here talks to Meta: services/social-publisher.ts does, through the
 * publisher-only methods below (claimNext … finishPublishing).
 *
 *   draft ──▶ approved ──▶ publishing ──▶ published | failed | needs_review
 *     │          │  ▲ └──▶ late (due while the publisher was off)
 *     ├──▶ rejected  └── publish-now (late) · retry (failed) · resolve not_published (needs_review)
 *     └──▶ cancelled ◀── draft | approved | late       resolve published: needs_review ──▶ published
 *
 * Every transition is a single UPDATE guarded by `site_id` and the allowed
 * source statuses, so two concurrent decisions can't both win. `FROM_STATUSES`
 * is the one place those rules live (used by the pre-check and the SQL guard).
 */

import { createHash } from 'node:crypto';
import { getPool } from '../../db/index.js';
import { sitesStore, type SiteBindings } from './sites-store.js';
import { auditLog } from './audit-log.js';

// One shared queue: even pinned and unpinned instances must not recover each other's live work.
const PUBLISHER_LOCK = [1935765092, 1886741100] as const;

export type PostPlatform = 'facebook' | 'instagram';
export type PostStatus = 'draft' | 'approved' | 'rejected' | 'cancelled' | 'publishing' | 'published' | 'failed' | 'needs_review' | 'late';

export const POST_PLATFORMS: readonly PostPlatform[] = ['facebook', 'instagram'];
export const POST_STATUSES: readonly PostStatus[] = ['draft', 'approved', 'rejected', 'cancelled', 'publishing', 'published', 'failed', 'needs_review', 'late'];

export interface SocialPost {
  id: string; siteId: string; platforms: PostPlatform[]; message: string;
  imageUrl: string | null; imageKey: string | null; scheduledAt: number | null; status: PostStatus;
  createdBy: string; approvedBy: string | null; approvedAt: number | null; decisionNote: string | null;
  remoteIds: Record<string, string>; lastError: string | null; createdAt: number; updatedAt: number;
  /** Optimistic-lock counter: bumped on every edit and decision. */
  version: number;
}

export interface DraftInput {
  siteId: string; platforms: PostPlatform[]; message: string;
  imageUrl?: string | null; imageKey?: string | null; scheduledAt?: number | null; createdBy: string;
}

type DraftFields = Omit<DraftInput, 'createdBy'>;

/** Thrown when a draft fails validation; `details` holds Spanish, user-facing messages. */
export class SocialPostValidationError extends Error {
  constructor(public readonly details: string[]) {
    super('La publicación no es válida.');
    this.name = 'SocialPostValidationError';
  }
}

/** Thrown when the draft changed after the reviewer loaded it (stale `version`). */
export class SocialPostConflictError extends Error {
  constructor() {
    super('La publicación cambió desde que la revisaste; revísala de nuevo.');
    this.name = 'SocialPostConflictError';
  }
}

const IG_CAPTION_MAX = 2200;
const FB_MESSAGE_MAX = 63206;
const MIN_LEAD_MS = 5 * 60_000;
const MAX_LEAD_MS = 60 * 86_400_000;
const MESSAGE_PREVIEW_CHARS = 200;
/** Exact shape of what storePostImage writes after `sites/<siteId>/`; anything else (incl. `%`) is refused. */
const IMAGE_PATH_RE = /^\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/** Public R2 base URL without trailing slash, or null when not configured. */
export function r2PublicBase(): string | null {
  const base = process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  return base ? base : null;
}

/**
 * Pure validation. Returns Spanish error messages (empty = valid).
 * `forApproval` drops the minimum-lead rule: a schedule that already passed
 * is still approvable and the worker treats it as due.
 */
export function validateDraft(
  input: DraftFields,
  site: { bindings: SiteBindings } | null | undefined,
  now: number,
  opts: { forApproval?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const platforms = input.platforms ?? [];
  const message = input.message ?? '';
  const imageUrl = input.imageUrl ?? null;
  const hasFb = platforms.includes('facebook');
  const hasIg = platforms.includes('instagram');

  if (!Array.isArray(platforms) || platforms.length === 0) errors.push('Debe elegir al menos una plataforma (Facebook o Instagram).');
  for (const p of platforms) {
    if (!POST_PLATFORMS.includes(p)) errors.push(`Plataforma no válida: ${String(p)}.`);
  }
  if (new Set(platforms).size !== platforms.length) errors.push('Cada plataforma solo puede elegirse una vez; hay una plataforma repetida.');
  if (hasIg && !imageUrl) errors.push('Instagram requiere una imagen.');
  if (hasFb && !message.trim() && !imageUrl) errors.push('Facebook requiere un mensaje o una imagen.');
  if (hasIg && message.length > IG_CAPTION_MAX) errors.push(`El mensaje supera los ${IG_CAPTION_MAX} caracteres permitidos por Instagram.`);
  if (hasFb && message.length > FB_MESSAGE_MAX) errors.push(`El mensaje supera los ${FB_MESSAGE_MAX} caracteres permitidos por Facebook.`);

  const at = input.scheduledAt;
  if (at != null) {
    if (!Number.isFinite(at)) errors.push('La fecha programada no es válida.');
    else if (at > now + MAX_LEAD_MS) errors.push('La fecha programada no puede ser más de 60 días en el futuro.');
    else if (!opts.forApproval && at < now + MIN_LEAD_MS) errors.push('La fecha programada debe ser al menos 5 minutos en el futuro.');
  }

  if (!site) errors.push('El sitio no existe.');
  else {
    if (hasFb && !site.bindings.metaPageId) errors.push('El sitio no tiene una página de Facebook vinculada.');
    if (hasIg && !site.bindings.metaIgUserId) errors.push('El sitio no tiene una cuenta de Instagram vinculada.');
  }

  if (imageUrl) {
    const base = r2PublicBase();
    const prefix = `${base}/sites/${input.siteId}/`;
    if (!base) errors.push('El almacenamiento de imágenes (R2) no está configurado.');
    else if (!imageUrl.startsWith(prefix) || !IMAGE_PATH_RE.test(imageUrl.slice(prefix.length))) {
      errors.push('La imagen debe subirse primero al almacenamiento del sitio; no se aceptan URL externas.');
    } else if (input.imageKey && input.imageKey !== `sites/${input.siteId}/${imageUrl.slice(prefix.length)}`) {
      errors.push('La clave de la imagen no coincide con su URL.');
    }
  }
  return errors;
}

/** Allowed source statuses per decision. */
const FROM_STATUSES = {
  approve: ['draft'],
  reject: ['draft'],
  cancel: ['draft', 'approved', 'late'],
} satisfies Record<string, PostStatus[]>;

type Decision = keyof typeof FROM_STATUSES;

/** Human actions after the publisher ran: one source and one target status each. */
const RECOVERY = {
  publish_now: { from: 'late', to: 'approved' },
  retry: { from: 'failed', to: 'approved' },
  resolve_published: { from: 'needs_review', to: 'published' },
  resolve_not_published: { from: 'needs_review', to: 'approved' },
} satisfies Record<string, { from: PostStatus; to: PostStatus }>;

type Recovery = keyof typeof RECOVERY;
const REMOTE_ID_RE = /^\d+(_\d+)?$/;
const DECISION_TARGET: Record<Decision, PostStatus> = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' };

interface PostRow {
  id: string; site_id: string; platforms: string[]; message: string; image_url: string | null; image_key: string | null;
  scheduled_at: Date | null; status: string; created_by: string; approved_by: string | null; approved_at: Date | null;
  decision_note: string | null; remote_ids: Record<string, string> | null; last_error: string | null;
  created_at: Date; updated_at: Date; version: number;
}

const toMs = (v: Date | string | null): number | null => (v == null ? null : new Date(v).getTime());

function rowToPost(r: PostRow): SocialPost {
  return {
    id: r.id, siteId: r.site_id, platforms: r.platforms as PostPlatform[], message: r.message,
    imageUrl: r.image_url, imageKey: r.image_key, scheduledAt: toMs(r.scheduled_at), status: r.status as PostStatus,
    createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: toMs(r.approved_at), decisionNote: r.decision_note,
    remoteIds: r.remote_ids ?? {}, lastError: r.last_error, createdAt: toMs(r.created_at)!, updatedAt: toMs(r.updated_at)!,
    version: r.version,
  };
}

/** Derive the R2 object key from a validated image URL when the caller didn't pass one. */
function keyFor(fields: DraftFields): string | null {
  if (!fields.imageUrl) return null;
  if (fields.imageKey) return fields.imageKey;
  const base = r2PublicBase();
  return base && fields.imageUrl.startsWith(`${base}/`) ? fields.imageUrl.slice(base.length + 1) : null;
}

async function assertValid(fields: DraftFields, opts: { forApproval?: boolean } = {}): Promise<void> {
  const site = await sitesStore.get(fields.siteId);
  const errors = validateDraft(fields, site ?? null, Date.now(), opts);
  if (errors.length > 0) throw new SocialPostValidationError(errors);
}

/** What exactly was approved, so the audit trail proves the content the worker later publishes. */
function contentSnapshot(post: SocialPost) {
  return {
    platforms: post.platforms,
    messageSha256: createHash('sha256').update(post.message).digest('hex'),
    messagePreview: post.message.slice(0, MESSAGE_PREVIEW_CHARS),
    imageKey: post.imageKey,
    scheduledAt: post.scheduledAt == null ? null : new Date(post.scheduledAt).toISOString(),
    version: post.version,
  };
}

function audit(
  action: Decision | 'create' | 'update' | 'publish_now' | 'retry' | 'resolve', post: SocialPost, actor: string, note?: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  return auditLog.append({
    timestamp: new Date().toISOString(),
    tool: `social_post_${action}`,
    siteId: post.siteId,
    input: {
      postId: post.id, action, actor, platforms: post.platforms,
      ...(action === 'approve' || action === 'update' ? { snapshot: contentSnapshot(post) } : {}),
      ...(note ? { note } : {}),
      ...extra,
    },
    status: 'success',
    durationMs: 0,
    resultSummary: `status=${post.status}`,
  });
}

async function get(id: string): Promise<SocialPost | null> {
  const r = await getPool().query<PostRow>('SELECT * FROM social_posts WHERE id = $1', [id]);
  return r.rows[0] ? rowToPost(r.rows[0]) : null;
}

/**
 * `expectedVersion` is the version the reviewer saw (approve only). The UPDATE
 * repeats the check, so an edit landing after the validated read can't be approved unseen.
 */
async function decide(
  decision: Decision, id: string, siteId: string, actor: string, note?: string, expectedVersion?: number,
): Promise<SocialPost | null> {
  const from: PostStatus[] = FROM_STATUSES[decision];
  const current = await get(id);
  if (!current || current.siteId !== siteId || !from.includes(current.status)) return null;
  if (decision === 'approve') {
    if (current.version !== expectedVersion) throw new SocialPostConflictError();
    await assertValid(current, { forApproval: true });
  }
  const r = await getPool().query<PostRow>(
    `UPDATE social_posts SET status = $3::text, approved_by = COALESCE($5::text, approved_by),
       approved_at = CASE WHEN $3::text = 'approved' THEN now() ELSE approved_at END,
       decision_note = $6::text, version = version + 1, updated_at = now()
     WHERE id = $1 AND site_id = $2 AND status = ANY($4::text[])
       AND ($7::integer IS NULL OR version = $7::integer) RETURNING *`,
    [id, siteId, DECISION_TARGET[decision], from, decision === 'approve' ? actor : null, note ?? null, expectedVersion ?? null],
  );
  if (!r.rows[0]) {
    if (decision === 'approve') {
      const now = await get(id);
      if (now && now.siteId === siteId && now.status === 'draft' && now.version !== expectedVersion) throw new SocialPostConflictError();
    }
    return null;
  }
  const post = rowToPost(r.rows[0]);
  await audit(decision, post, actor, note);
  return post;
}

/**
 * Human transition after the publisher (version required: the one the admin saw).
 * Leaving to 'approved' clears the schedule, so the post is due now and never re-marked late.
 */
async function recover(
  kind: Recovery, id: string, siteId: string, expectedVersion: number, actor: string, remoteIds: Record<string, string> = {},
): Promise<SocialPost | null> {
  const { from, to } = RECOVERY[kind];
  const r = await getPool().query<PostRow>(
    `UPDATE social_posts SET status = $4::text, scheduled_at = CASE WHEN $4::text = 'approved' THEN NULL ELSE scheduled_at END,
       remote_ids = remote_ids || $6::jsonb, last_error = NULL, version = version + 1, updated_at = now()
     WHERE id = $1 AND site_id = $2 AND status = $3::text AND version = $5::integer RETURNING *`,
    [id, siteId, from, to, expectedVersion, JSON.stringify(remoteIds)],
  );
  if (!r.rows[0]) {
    const now = await get(id);
    if (now && now.siteId === siteId && now.status === from && now.version !== expectedVersion) throw new SocialPostConflictError();
    return null;
  }
  const post = rowToPost(r.rows[0]);
  const action = kind.startsWith('resolve') ? 'resolve' : kind as 'publish_now' | 'retry';
  await audit(action, post, actor, undefined, action === 'resolve' ? { outcome: kind.slice('resolve_'.length), remoteIds } : {});
  return post;
}

export const socialPostsStore = {
  async createDraft(input: DraftInput): Promise<SocialPost> {
    await assertValid(input);
    const r = await getPool().query<PostRow>(
      `INSERT INTO social_posts (site_id, platforms, message, image_url, image_key, scheduled_at, created_by)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000.0), $7) RETURNING *`,
      [input.siteId, [...new Set(input.platforms)], input.message, input.imageUrl ?? null, keyFor(input), input.scheduledAt ?? null, input.createdBy],
    );
    const post = rowToPost(r.rows[0]);
    await audit('create', post, input.createdBy);
    return post;
  },

  /** Edits a draft of the given site; returns null if missing, other site, or no longer a draft. */
  async updateDraft(
    id: string, siteId: string, patch: Partial<Omit<DraftInput, 'siteId' | 'createdBy'>>, actor: string,
  ): Promise<SocialPost | null> {
    const current = await get(id);
    if (!current || current.siteId !== siteId || current.status !== 'draft') return null;
    const imageChanged = patch.imageUrl !== undefined;
    const merged: DraftFields = {
      siteId,
      platforms: patch.platforms ?? current.platforms,
      message: patch.message ?? current.message,
      imageUrl: imageChanged ? patch.imageUrl : current.imageUrl,
      imageKey: patch.imageKey !== undefined ? patch.imageKey : imageChanged ? null : current.imageKey,
      scheduledAt: patch.scheduledAt !== undefined ? patch.scheduledAt : current.scheduledAt,
    };
    await assertValid(merged);
    const r = await getPool().query<PostRow>(
      `UPDATE social_posts SET platforms = $3, message = $4, image_url = $5, image_key = $6,
         scheduled_at = to_timestamp($7::double precision / 1000.0), version = version + 1, updated_at = now()
       WHERE id = $1 AND site_id = $2 AND status = 'draft' RETURNING *`,
      [id, siteId, [...new Set(merged.platforms)], merged.message, merged.imageUrl ?? null, keyFor(merged), merged.scheduledAt ?? null],
    );
    if (!r.rows[0]) return null;
    const post = rowToPost(r.rows[0]);
    await audit('update', post, actor);
    return post;
  },

  async list(filter: { siteId?: string; status?: PostStatus[] }): Promise<SocialPost[]> {
    const r = await getPool().query<PostRow>(
      `SELECT * FROM social_posts WHERE ($1::uuid IS NULL OR site_id = $1)
         AND ($2::text[] IS NULL OR status = ANY($2::text[])) ORDER BY created_at DESC LIMIT 200`,
      [filter.siteId ?? null, filter.status && filter.status.length > 0 ? filter.status : null],
    );
    return r.rows.map(rowToPost);
  },

  get,

  approve: (id: string, siteId: string, approvedBy: string, expectedVersion: number, note?: string) =>
    decide('approve', id, siteId, approvedBy, note, expectedVersion),
  reject: (id: string, siteId: string, by: string, note?: string) => decide('reject', id, siteId, by, note),
  cancel: (id: string, siteId: string, by: string) => decide('cancel', id, siteId, by),

  /** late → approved, due now. */
  publishNow: (id: string, siteId: string, version: number, by: string) => recover('publish_now', id, siteId, version, by),
  /** failed → approved; remote ids are kept so the publisher skips platforms already published. */
  retry: (id: string, siteId: string, version: number, by: string) => recover('retry', id, siteId, version, by),

  /** needs_review → published (the admin confirmed it in Meta) or → approved (it was not published). */
  async resolve(
    id: string, siteId: string, version: number, outcome: 'published' | 'not_published', by: string, remoteIds: Record<string, string> = {},
  ): Promise<SocialPost | null> {
    const current = await get(id);
    if (!current || current.siteId !== siteId) return null;
    const errors: string[] = [];
    for (const [platform, remoteId] of Object.entries(remoteIds)) {
      if (!current.platforms.includes(platform as PostPlatform)) errors.push(`La publicación no incluye la plataforma ${platform}.`);
      else if (typeof remoteId !== 'string' || !REMOTE_ID_RE.test(remoteId)) errors.push(`El identificador de ${platform} no es válido.`);
    }
    if (errors.length > 0) throw new SocialPostValidationError(errors);
    return recover(outcome === 'published' ? 'resolve_published' : 'resolve_not_published', id, siteId, version, by, remoteIds);
  },

  // ── Publisher only (services/social-publisher.ts). Times come from the caller's clock. ──

  /** Hold a session lock for the whole turn, including recovery and external writes. */
  async withPublisherLock(work: (isHeld: () => Promise<boolean>) => Promise<void>): Promise<boolean> {
    const client = await getPool().connect();
    // Supported by pg at runtime but absent from @types/pg's per-query interface.
    const queryDeadline = { query_timeout: 5000 };
    let alive = true;
    let acquired = false;
    const onError = () => { alive = false; };
    client.on('error', onError);
    try {
      const lock = await client.query<{ acquired: boolean }>({
        text: 'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
        values: [...PUBLISHER_LOCK], ...queryDeadline,
      }).catch((err: unknown) => {
        // The server may have acquired the lock even if its acknowledgement was lost.
        alive = false;
        throw err;
      });
      acquired = lock.rows[0]?.acquired === true;
      if (!acquired) return false;
      await work(async () => {
        if (!alive) return false;
        try {
          await client.query({ text: 'SELECT 1', ...queryDeadline });
          return alive;
        } catch {
          alive = false;
          return false;
        }
      });
      return true;
    } finally {
      if (acquired && alive) {
        try {
          await client.query({
            text: 'SELECT pg_advisory_unlock($1::integer, $2::integer)',
            values: [...PUBLISHER_LOCK], ...queryDeadline,
          });
        } catch { alive = false; }
      }
      client.removeListener('error', onError);
      // Never return a connection with a possibly-held session lock to the pool.
      client.release(!alive);
    }
  },

  async isPublishing(post: SocialPost): Promise<boolean> {
    const current = await get(post.id);
    return current?.siteId === post.siteId && current.status === 'publishing' && current.version === post.version;
  },

  /** Atomically takes the next due approved post; concurrent callers never get the same row. */
  async claimNext(nowMs: number, siteId: string | null = null): Promise<SocialPost | null> {
    const r = await getPool().query<PostRow>(
      `UPDATE social_posts SET status = 'publishing', publishing_started_at = to_timestamp($1::double precision / 1000.0),
         version = version + 1, updated_at = now()
       WHERE status = 'approved' AND id = (
         SELECT id FROM social_posts WHERE status = 'approved'
           AND ($2::uuid IS NULL OR site_id = $2)
           AND (scheduled_at IS NULL OR scheduled_at <= to_timestamp($1::double precision / 1000.0))
         ORDER BY coalesce(scheduled_at, approved_at), created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [nowMs, siteId],
    );
    return r.rows[0] ? rowToPost(r.rows[0]) : null;
  },

  /** publishing → needs_review for posts started before the cutoff (null = all of them). */
  async recoverInterrupted(startedBeforeMs: number | null, lastError: string, siteId: string | null = null): Promise<SocialPost[]> {
    const r = await getPool().query<PostRow>(
      `UPDATE social_posts SET status = 'needs_review', last_error = $1, version = version + 1, updated_at = now()
       WHERE status = 'publishing' AND ($3::uuid IS NULL OR site_id = $3)
         AND ($2::double precision IS NULL OR publishing_started_at IS NULL
         OR publishing_started_at < to_timestamp($2::double precision / 1000.0)) RETURNING *`,
      [lastError, startedBeforeMs, siteId],
    );
    return r.rows.map(rowToPost);
  },

  /** approved → late for posts scheduled before the cutoff. */
  async markLate(scheduledBeforeMs: number, lastError: string, siteId: string | null = null): Promise<SocialPost[]> {
    const r = await getPool().query<PostRow>(
      `UPDATE social_posts SET status = 'late', last_error = $1, version = version + 1, updated_at = now()
       WHERE status = 'approved' AND ($3::uuid IS NULL OR site_id = $3)
         AND scheduled_at < to_timestamp($2::double precision / 1000.0) RETURNING *`,
      [lastError, scheduledBeforeMs, siteId],
    );
    return r.rows.map(rowToPost);
  },

  /** Merges remote ids into a post this publisher still holds; null if the claim was lost. */
  async recordRemoteIds(post: SocialPost, ids: Record<string, string>): Promise<SocialPost | null> {
    const r = await getPool().query<PostRow>(
      `UPDATE social_posts SET remote_ids = remote_ids || $4::jsonb, updated_at = now()
       WHERE id = $1 AND site_id = $2 AND version = $3 AND status = 'publishing' RETURNING *`,
      [post.id, post.siteId, post.version, JSON.stringify(ids)],
    );
    return r.rows[0] ? rowToPost(r.rows[0]) : null;
  },

  /** Ends a claim: publishing → published | failed | needs_review | approved (kill switch). */
  async finishPublishing(
    post: SocialPost, status: 'published' | 'failed' | 'needs_review' | 'approved', lastError: string | null,
  ): Promise<SocialPost | null> {
    const r = await getPool().query<PostRow>(
      `UPDATE social_posts SET status = $4::text, last_error = $5::text, version = version + 1, updated_at = now()
       WHERE id = $1 AND site_id = $2 AND version = $3 AND status = 'publishing' RETURNING *`,
      [post.id, post.siteId, post.version, status, lastError],
    );
    return r.rows[0] ? rowToPost(r.rows[0]) : null;
  },
};
