/**
 * Social posts routes — FB/IG drafts, human approval and image uploads.
 * Admin only: the reviewer role is refused here too, not just by the router.
 * Nothing in these routes talks to Meta (phase 2a).
 * A pinned server (SANDI_ADS_SITE_ID) only serves its own client: a missing
 * siteId means the pin, any other siteId is refused with 403.
 *
 *   GET   /api/posts?siteId=&status=a,b     → { posts }
 *   POST  /api/posts                        → create draft (createdBy 'dashboard')
 *   PATCH /api/posts/:id                    → edit draft (body.siteId must match)
 *   POST  /api/posts/:id/approve|reject|cancel  body { siteId, note? }; approve also needs
 *         { version } (the one the reviewer saw): a changed draft answers 409
 *   POST  /api/media?siteId=<uuid>          → raw image body → StoredMedia (audited)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest, getPinnedSiteId } from '../auth.js';
import {
  socialPostsStore, SocialPostValidationError, SocialPostConflictError, POST_STATUSES, type DraftInput, type PostPlatform, type PostStatus,
} from '../services/social-posts-store.js';
import { storePostImage } from '../services/r2-media.js';
import { sitesStore } from '../services/sites-store.js';
import { auditLog } from '../services/audit-log.js';
import { ErrorCode, MCPError } from '../../types/errors.js';
import { createServiceLogger } from '../../utils/logger.js';
import { sendJson, parseBody, parseRawBody, getParams } from './route-helpers.js';

const log = createServiceLogger('posts-api');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^\/api\/posts\/([0-9a-f-]{36})$/i;
const ACTION_PATTERN = /^\/api\/posts\/([0-9a-f-]{36})\/(approve|reject|cancel)$/i;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const NOTE_MAX = 1000;
const NOT_FOUND = 'Publicación no encontrada para este sitio o ya no admite esa acción.';
const OTHER_CLIENT = 'Este servidor está fijado a otro cliente; no puede gestionar publicaciones de ese cliente.';

type Fields = Partial<Omit<DraftInput, 'siteId' | 'createdBy'>>;

function invalid(res: ServerResponse, details: string[]): void {
  sendJson(res, { error: 'Datos no válidos.', details }, 400);
}

/** Shape-check the editable fields of a JSON body; semantic rules live in validateDraft. */
function readFields(body: Record<string, unknown>, errors: string[]): Fields {
  const out: Fields = {};
  if (body.platforms !== undefined) {
    if (Array.isArray(body.platforms) && body.platforms.every(p => typeof p === 'string')) out.platforms = body.platforms as PostPlatform[];
    else errors.push('platforms debe ser una lista.');
  }
  if (body.message !== undefined) {
    if (typeof body.message === 'string') out.message = body.message;
    else errors.push('message debe ser texto.');
  }
  if (body.imageUrl !== undefined) {
    if (body.imageUrl === null || typeof body.imageUrl === 'string') out.imageUrl = body.imageUrl || null;
    else errors.push('imageUrl debe ser texto.');
  }
  if (body.imageKey !== undefined) {
    if (body.imageKey === null || typeof body.imageKey === 'string') out.imageKey = body.imageKey || null;
    else errors.push('imageKey debe ser texto.');
  }
  if (body.scheduledAt !== undefined) {
    const v = body.scheduledAt;
    const ms = v === null ? null : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : Number.NaN;
    if (ms === null || Number.isFinite(ms)) out.scheduledAt = ms;
    else errors.push('La fecha programada no es válida.');
  }
  return out;
}

function readSiteId(value: unknown, errors: string[]): string {
  if (typeof value === 'string' && UUID_RE.test(value)) return value;
  errors.push('siteId es obligatorio y debe ser un identificador válido.');
  return '';
}

/** Same rule as routes/agent.ts: the pin replaces a missing siteId and forbids any other one. */
function applyPin(requested: unknown): { siteId: unknown; forbidden: boolean } {
  const pinned = getPinnedSiteId()?.trim().toLowerCase();
  if (!pinned || requested === undefined || requested === null || requested === '') return { siteId: pinned || requested, forbidden: false };
  return { siteId: pinned, forbidden: typeof requested !== 'string' || requested.toLowerCase() !== pinned };
}

function sendFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof SocialPostValidationError) return invalid(res, err.details);
  if (err instanceof SocialPostConflictError) return sendJson(res, { error: err.message }, 409);
  if (err instanceof MCPError) {
    if (err.code === ErrorCode.INVALID_INPUT) return sendJson(res, { error: err.message, details: [err.message] }, 400);
    if (err.code.startsWith('AUTH_')) return sendJson(res, { error: err.message, code: 'CREDENTIAL_MISSING' }, 424);
    if (err.code === ErrorCode.EXTERNAL_SERVICE_ERROR) return sendJson(res, { error: err.message }, 502);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith('Request body too large')) return sendJson(res, { error: 'El contenido enviado es demasiado grande.' }, 413);
  if (msg === 'Invalid JSON body') return invalid(res, ['El cuerpo de la solicitud no es JSON válido.']);
  log.error('Posts route failed', { error: err instanceof Error ? err : new Error(msg) });
  sendJson(res, { error: 'Error interno.' }, 500);
}

export async function handlePostsRoute(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    sendJson(res, { error: auth.reason || 'Unauthorized' }, 401);
    return true;
  }
  if (auth.role !== 'admin') {
    sendJson(res, { error: 'Solo el administrador puede gestionar publicaciones.' }, 403);
    return true;
  }

  try {
    if (pathname === '/api/media' && req.method === 'POST') {
      const scope = applyPin(getParams(req).get('siteId') || undefined);
      if (scope.forbidden) {
        sendJson(res, { error: OTHER_CLIENT }, 403);
        return true;
      }
      const siteId = typeof scope.siteId === 'string' ? scope.siteId.toLowerCase() : '';
      if (!UUID_RE.test(siteId)) {
        invalid(res, ['siteId es obligatorio y debe ser un identificador válido.']);
        return true;
      }
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) {
        sendJson(res, { error: 'Formato no admitido: use JPEG, PNG o WebP.' }, 415);
        return true;
      }
      if (!(await sitesStore.get(siteId))) {
        sendJson(res, { error: 'El sitio no existe.' }, 404);
        return true;
      }
      const media = await storePostImage(siteId, await parseRawBody(req));
      await auditLog.append({
        timestamp: new Date().toISOString(),
        tool: 'social_post_media_upload',
        siteId,
        input: { action: 'media_upload', actor: 'admin', key: media.key, bytes: media.bytes },
        status: 'success',
        durationMs: 0,
        resultSummary: `key=${media.key}`,
      });
      sendJson(res, media, 201);
      return true;
    }

    if (pathname === '/api/posts' && req.method === 'GET') {
      const params = getParams(req);
      const scope = applyPin(params.get('siteId') || undefined);
      if (scope.forbidden) {
        sendJson(res, { error: OTHER_CLIENT }, 403);
        return true;
      }
      const siteId = scope.siteId as string | undefined;
      if (siteId && !UUID_RE.test(siteId)) {
        invalid(res, ['siteId no es un identificador válido.']);
        return true;
      }
      const status = (params.get('status') ?? '').split(',')
        .filter((s): s is PostStatus => (POST_STATUSES as readonly string[]).includes(s));
      sendJson(res, { posts: await socialPostsStore.list({ siteId, status: status.length > 0 ? status : undefined }) });
      return true;
    }

    if (pathname === '/api/posts' && req.method === 'POST') {
      const body = (await parseBody(req)) as Record<string, unknown>;
      const scope = applyPin(body.siteId);
      if (scope.forbidden) {
        sendJson(res, { error: OTHER_CLIENT }, 403);
        return true;
      }
      const errors: string[] = [];
      const siteId = readSiteId(scope.siteId, errors);
      const fields = readFields(body, errors);
      if (errors.length > 0) {
        invalid(res, errors);
        return true;
      }
      const post = await socialPostsStore.createDraft({
        siteId, platforms: fields.platforms ?? [], message: fields.message ?? '',
        imageUrl: fields.imageUrl ?? null, imageKey: fields.imageKey ?? null, scheduledAt: fields.scheduledAt ?? null,
        createdBy: 'dashboard',
      });
      sendJson(res, { post }, 201);
      return true;
    }

    const idMatch = pathname.match(ID_PATTERN);
    if (idMatch && req.method === 'PATCH') {
      const body = (await parseBody(req)) as Record<string, unknown>;
      const scope = applyPin(body.siteId);
      if (scope.forbidden) {
        sendJson(res, { error: OTHER_CLIENT }, 403);
        return true;
      }
      const errors: string[] = [];
      const siteId = readSiteId(scope.siteId, errors);
      const fields = readFields(body, errors);
      if (errors.length > 0) {
        invalid(res, errors);
        return true;
      }
      const post = await socialPostsStore.updateDraft(idMatch[1], siteId, fields, 'admin');
      sendJson(res, post ? { post } : { error: NOT_FOUND }, post ? 200 : 404);
      return true;
    }

    const actionMatch = pathname.match(ACTION_PATTERN);
    if (actionMatch && req.method === 'POST') {
      const [, id, action] = actionMatch;
      const body = (await parseBody(req)) as Record<string, unknown>;
      const scope = applyPin(body.siteId);
      if (scope.forbidden) {
        sendJson(res, { error: OTHER_CLIENT }, 403);
        return true;
      }
      const errors: string[] = [];
      const siteId = readSiteId(scope.siteId, errors);
      if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > NOTE_MAX)) {
        errors.push(`La nota debe ser texto de hasta ${NOTE_MAX} caracteres.`);
      }
      if (action === 'approve' && !Number.isInteger(body.version)) errors.push('version es obligatoria: indica la versión de la publicación que revisaste.');
      if (errors.length > 0) {
        invalid(res, errors);
        return true;
      }
      const note = (body.note as string | undefined)?.trim() || undefined;
      const post = action === 'approve' ? await socialPostsStore.approve(id, siteId, 'admin', body.version as number, note)
        : action === 'reject' ? await socialPostsStore.reject(id, siteId, 'admin', note)
          : await socialPostsStore.cancel(id, siteId, 'admin');
      sendJson(res, post ? { post } : { error: NOT_FOUND }, post ? 200 : 404);
      return true;
    }
  } catch (err) {
    sendFailure(res, err);
    return true;
  }

  return false;
}
