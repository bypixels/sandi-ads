/**
 * Meta Graph API client (read-only).
 *
 * Deliberately exposes GET helpers only: no POST/DELETE capability exists in
 * this module.
 */

import { createHmac } from 'node:crypto';
import { MCPError } from '../../types/errors.js';
import { rateLimiter } from '../../utils/rate-limiter.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('meta');

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

async function request<T>(path: string, params: Params): Promise<T> {
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
  return rateLimiter.execute('meta', async () => {
    let res: Response;
    try {
      res = await fetch(url.toString(), { method: 'GET' });
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
    return body as T;
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
