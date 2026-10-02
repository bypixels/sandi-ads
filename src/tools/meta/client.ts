/**
 * Meta Graph API client.
 *
 * Tools only get the GET helpers (metaGet/metaGetAll). The single write path,
 * `metaWrite`, accepts a closed set of operations whose URL is built here from
 * numeric ids; it is reserved for the dashboard publisher
 * (services/social-publisher.ts) and must never be wired into an MCP tool
 * (tests/unit/meta-write-boundary.test.ts enforces it).
 */

import { createHmac } from 'node:crypto';
import { ErrorCode, MCPError } from '../../types/errors.js';
import { rateLimiter } from '../../utils/rate-limiter.js';
import { createServiceLogger } from '../../utils/logger.js';
import { isMutationAllowed } from '../../dashboard/services/mutations.js';

const log = createServiceLogger('meta');
const READ_TIMEOUT_MS = 20_000;

/** Bounds queue wait, fetch and body consumption; abandoned queued callbacks cannot send later. */
async function withinDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Meta superó el tiempo máximo de espera.');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** No HTTP request was sent. Keep this distinct from an ambiguous provider outcome. */
export class MetaWriteCancelledError extends Error {
  constructor() { super('El envío a Meta se canceló antes de salir.'); }
}


export const META_GRAPH_VERSION = 'v25.0';
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

type Params = Record<string, string | number | undefined>;

interface MetaErrorBody {
  message?: string;
  code?: number;
  fbtrace_id?: string;
}

interface MetaPage<T> {
  data?: T[];
  paging?: { next?: string };
  error?: MetaErrorBody;
}

/** Only plain `/segment/segment` paths: no query, fragment or traversal can reach the URL. */
const SAFE_PATH = /^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;

/** Graph API honors `method=POST|DELETE` on GET; token params are set by this module only. */
const FORBIDDEN_PARAMS = new Set(['method', 'access_token', 'appsecret_proof']);

/** Numeric Graph object ID (page, IG user) -> same ID, else validation error. */
export function assertNumericId(id: string, field: string): string {
  if (!/^\d+$/.test(id)) {
    throw MCPError.validationError(`${field} must be numeric`);
  }
  return id;
}

/** '123' or 'act_123' -> 'act_123' */
export function normalizeAdAccountId(id: string): string {
  if (!/^(act_)?\d+$/.test(id)) {
    throw MCPError.validationError('adAccountId must be numeric, optionally prefixed with "act_"');
  }
  return id.startsWith('act_') ? id : `act_${id}`;
}

export function appSecretProof(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

async function request<T>(path: string, params: Params, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  if (!SAFE_PATH.test(path)) {
    throw MCPError.validationError('Meta path must be plain "/segment/segment" (letters, digits, underscore)');
  }
  for (const k of Object.keys(params)) {
    if (FORBIDDEN_PARAMS.has(k.toLowerCase())) {
      throw MCPError.validationError(`Meta param "${k}" is not allowed`);
    }
  }
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw MCPError.authError('Falta META_ACCESS_TOKEN: configúralo en Credenciales');
  }
  const secret = process.env.META_APP_SECRET;

  const url = new URL(`${META_GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('access_token', token);
  if (secret) url.searchParams.set('appsecret_proof', appSecretProof(token, secret));

  const secrets = [token, secret];
  return withinDeadline(signal => rateLimiter.execute('meta', async () => {
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(url.toString(), { method: 'GET', signal });
    } catch (err) {
      const msg = scrub(err instanceof Error ? err.message : String(err), secrets);
      throw MCPError.externalServiceError('Meta', `Network error: ${msg}`);
    }

    let body: (T & { error?: MetaErrorBody }) | undefined;
    try {
      body = (await res.json()) as T & { error?: MetaErrorBody };
    } catch {
      body = undefined;
    }

    if (!res.ok || body?.error) {
      const e = body?.error;
      const detail = scrub(
        `${e?.message ?? `HTTP ${res.status}`} (code ${e?.code ?? 'n/a'}, fbtrace_id ${e?.fbtrace_id ?? 'n/a'})`,
        secrets,
      );
      throw MCPError.externalServiceError('Meta', detail, res.status >= 500 || res.status === 429);
    }
    signal.throwIfAborted();
    return body as T;
  }), timeoutMs).catch((err: unknown) => {
    if (err instanceof MCPError) throw err;
    throw MCPError.externalServiceError('Meta', scrub(err instanceof Error ? err.message : String(err), secrets), false);
  });
}

export async function metaGet<T>(path: string, params: Params = {}): Promise<T> {
  return request<T>(path, params);
}

/** Follows paging.next (same Graph host only) and concatenates data[]. */
export async function metaGetAll<T>(path: string, params: Params = {}, maxPages = 5): Promise<T[]> {
  const all: T[] = [];
  let nextPath = path;
  let nextParams: Params = params;

  for (let page = 1; ; page++) {
    const body = await request<MetaPage<T>>(nextPath, nextParams);
    all.push(...(body.data ?? []));

    const next = body.paging?.next;
    if (!next) return all;
    if (page >= maxPages) {
      log.warn('Meta pagination truncated at maxPages', { path, maxPages });
      return all;
    }

    const nextUrl = new URL(next);
    if (!nextUrl.href.startsWith(`${META_GRAPH_BASE}/`)) {
      throw MCPError.externalServiceError('Meta', 'paging.next points outside the Graph API', false);
    }
    nextPath = nextUrl.pathname.slice(`/${META_GRAPH_VERSION}`.length);
    nextParams = {};
    for (const [k, v] of nextUrl.searchParams) {
      const key = k.toLowerCase();
      if (key === 'access_token' || key === 'appsecret_proof') continue;
      if (FORBIDDEN_PARAMS.has(key)) {
        throw MCPError.externalServiceError('Meta', 'paging.next contains a forbidden parameter', false);
      }
      nextParams[k] = v;
    }
  }
}

/** Graph object field fetched with the system-user token. */
async function getField<T>(id: string, field: string, timeoutMs = READ_TIMEOUT_MS): Promise<T | undefined> {
  const body = await request<Record<string, unknown>>(`/${assertNumericId(id, 'id')}`, { fields: field }, timeoutMs);
  return body[field] as T | undefined;
}

/** Page access token for publishing as the Page. Never log it or return it to a tool. */
export async function getPageAccessToken(pageId: string): Promise<string> {
  const token = await getField<string>(assertNumericId(pageId, 'pageId'), 'access_token');
  if (!token) {
    throw MCPError.authError('El usuario del sistema de Meta no puede administrar esta página; revisa sus permisos en el Business Manager.');
  }
  return token;
}

/** IG media container status_code: IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED. */
export async function getIgContainerStatus(containerId: string, timeoutMs = READ_TIMEOUT_MS): Promise<string> {
  return String((await getField<string>(assertNumericId(containerId, 'containerId'), 'status_code', timeoutMs)) ?? '');
}

/** Media published in the last 24 h vs. the account's limit. */
export async function getIgPublishingQuota(igUserId: string): Promise<{ usage: number; total: number }> {
  const body = await request<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
    `/${assertNumericId(igUserId, 'igUserId')}/content_publishing_limit`, { fields: 'quota_usage,config' },
  );
  const row = body.data?.[0];
  return { usage: Number(row?.quota_usage ?? 0), total: Number(row?.config?.quota_total ?? 100) };
}

export async function getIgPermalink(mediaId: string): Promise<string | null> {
  return (await getField<string>(assertNumericId(mediaId, 'mediaId'), 'permalink')) ?? null;
}

export type MetaWriteOp =
  | { kind: 'page_photo'; pageId: string; url: string; caption: string }
  | { kind: 'page_feed'; pageId: string; message: string }
  | { kind: 'ig_container'; igUserId: string; imageUrl: string; caption: string }
  | { kind: 'ig_publish'; igUserId: string; creationId: string };

const WRITE_TIMEOUT_MS = 30_000;

function writeTarget(op: MetaWriteOp): { path: string; fields: Record<string, string> } {
  switch (op.kind) {
    case 'page_photo':
      return { path: `/${assertNumericId(op.pageId, 'pageId')}/photos`, fields: { url: op.url, caption: op.caption } };
    case 'page_feed':
      return { path: `/${assertNumericId(op.pageId, 'pageId')}/feed`, fields: { message: op.message } };
    case 'ig_container':
      return { path: `/${assertNumericId(op.igUserId, 'igUserId')}/media`, fields: { image_url: op.imageUrl, caption: op.caption } };
    case 'ig_publish':
      return {
        path: `/${assertNumericId(op.igUserId, 'igUserId')}/media_publish`,
        fields: { creation_id: assertNumericId(op.creationId, 'creationId') },
      };
    default:
      throw MCPError.validationError('Unknown Meta write operation');
  }
}

/**
 * Meta may or may not have applied the write (network failure, 5xx, 200 without id):
 * the caller must not retry blindly.
 */
function uncertainError(message: string): MCPError {
  return new MCPError({
    code: ErrorCode.EXTERNAL_SERVICE_ERROR, message: `Meta: ${message}`, retryable: false, service: 'Meta', details: { uncertain: true },
  });
}

/**
 * The only POST to Meta. Path built from the op; token + appsecret_proof travel
 * in the form body, never in the URL. Errors are scrubbed and never retryable.
 */
export async function metaWrite(
  op: MetaWriteOp, token: string, beforeSend: () => Promise<void> = async () => {},
): Promise<{ id: string; postId?: string }> {
  const { path, fields } = writeTarget(op);
  if (!SAFE_PATH.test(path)) throw MCPError.validationError('Meta write path is not plain');
  if (!token) throw MCPError.authError('Falta el token de acceso de Meta para publicar.');
  const secret = process.env.META_APP_SECRET;
  const form = new URLSearchParams(fields);
  form.set('access_token', token);
  if (secret) form.set('appsecret_proof', appSecretProof(token, secret));
  const secrets = [token, secret, process.env.META_ACCESS_TOKEN];

  let sent = false;
  return withinDeadline(signal => rateLimiter.execute('meta', async () => {
    signal.throwIfAborted();
    if (!isMutationAllowed('meta_publish')) throw new MetaWriteCancelledError();
    await beforeSend();
    // Recheck after the async claim/lease check, immediately at the provider boundary.
    signal.throwIfAborted();
    if (!isMutationAllowed('meta_publish')) throw new MetaWriteCancelledError();
    let res: Response;
    try {
      sent = true;
      res = await fetch(`${META_GRAPH_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal,
      });
    } catch (err) {
      throw uncertainError(`Network error: ${scrub(err instanceof Error ? err.message : String(err), secrets)}`);
    }

    let body: { id?: string | number; post_id?: string; error?: MetaErrorBody } | undefined;
    try {
      body = (await res.json()) as typeof body;
    } catch {
      body = undefined;
    }

    if (!res.ok || body?.error) {
      const e = body?.error;
      const detail = scrub(
        `${e?.message ?? `HTTP ${res.status}`} (code ${e?.code ?? 'n/a'}, fbtrace_id ${e?.fbtrace_id ?? 'n/a'})`,
        secrets,
      );
      if (res.status >= 500 || !e) throw uncertainError(detail);
      throw MCPError.externalServiceError('Meta', detail, false);
    }
    if (body?.id === undefined || body.id === null || body.id === '') {
      throw uncertainError('Meta answered without an id');
    }
    signal.throwIfAborted();
    return { id: String(body.id), ...(body.post_id ? { postId: String(body.post_id) } : {}) };
  }), WRITE_TIMEOUT_MS).catch((err: unknown) => {
    if (err instanceof MetaWriteCancelledError || err instanceof MCPError) throw err;
    const detail = scrub(err instanceof Error ? err.message : String(err), secrets);
    if (sent) throw uncertainError(detail);
    throw MCPError.externalServiceError('Meta', detail, false);
  });
}
