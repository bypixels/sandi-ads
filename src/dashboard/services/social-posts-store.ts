/**
 * Social posts store — own publishing queue for Facebook + Instagram.
 *
 * Phase 2a: drafts + durable human approval only; nothing here talks to Meta.
 *
 *   draft ──▶ approved ──▶ (2b worker: publishing → published | failed | needs_review)
 *     │          │
 *     ├──▶ rejected         late ──▶ cancelled
 *     └──▶ cancelled ◀──────┘
 *
 * Every transition is a single UPDATE guarded by `site_id` and the allowed
 * source statuses, so two concurrent decisions can't both win. `FROM_STATUSES`
 * is the one place those rules live (used by the pre-check and the SQL guard).
 */

import { createHash } from 'node:crypto';
import { getPool } from '../../db/index.js';
import { sitesStore, type SiteBindings } from './sites-store.js';
import { auditLog } from './audit-log.js';

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

function audit(action: Decision | 'create' | 'update', post: SocialPost, actor: string, note?: string): Promise<void> {
  return auditLog.append({
    timestamp: new Date().toISOString(),
    tool: `social_post_${action}`,
    siteId: post.siteId,
    input: {
      postId: post.id, action, actor, platforms: post.platforms,
      ...(action === 'approve' || action === 'update' ? { snapshot: contentSnapshot(post) } : {}),
      ...(note ? { note } : {}),
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
};
