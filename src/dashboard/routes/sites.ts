/**
 * Sites API routes — CRUD + auto-discovery
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest } from '../auth.js';
import { sitesStore, type SiteInput, type SitePatch } from '../services/sites-store.js';
import { discoverSiteBindings } from '../services/sites-discover.js';
import { createServiceLogger } from '../../utils/logger.js';
import { sendJson, parseBody } from './route-helpers.js';

const log = createServiceLogger('sites-api');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validateInput(body: unknown, partial: boolean): { ok: true; value: SiteInput | SitePatch } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: 'Body must be a JSON object' };

  const out: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { ok: false, error: 'name must be a non-empty string' };
    out.name = body.name;
  } else if (!partial) {
    return { ok: false, error: 'name is required' };
  }

  if (body.primaryUrl !== undefined) {
    if (typeof body.primaryUrl !== 'string' || !body.primaryUrl.trim()) return { ok: false, error: 'primaryUrl must be a non-empty string' };
    try {
      new URL(body.primaryUrl);
    } catch {
      return { ok: false, error: 'primaryUrl is not a valid URL' };
    }
    out.primaryUrl = body.primaryUrl;
  } else if (!partial) {
    return { ok: false, error: 'primaryUrl is required' };
  }

  if (body.bindings !== undefined) {
    if (!isPlainObject(body.bindings)) return { ok: false, error: 'bindings must be an object' };
    const allowed = [
      'ga4PropertyId', 'gscSiteUrl',
      'gtmAccountId', 'gtmContainerId',
      'adsCustomerId',
      'gbpAccountId', 'gbpLocationName',
      'cloudflareZoneId',
      'metaAdAccountId', 'metaPageId', 'metaIgUserId',
    ];
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.bindings)) {
      if (!allowed.includes(k)) return { ok: false, error: `Unknown binding: ${k}` };
      if (v != null && typeof v !== 'string') return { ok: false, error: `Binding ${k} must be a string` };
      if (typeof v === 'string' && v.trim()) cleaned[k] = v.trim();
    }
    out.bindings = cleaned;
  } else if (!partial) {
    out.bindings = {};
  }

  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') return { ok: false, error: 'notes must be a string' };
    out.notes = body.notes ?? undefined;
  }

  return { ok: true, value: out as SiteInput | SitePatch };
}

export async function handleSitesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    sendJson(res, { error: auth.reason || 'Unauthorized' }, 401);
    return true;
  }

  // POST /api/sites/discover — auto-discover bindings for a URL (no persistence)
  if (pathname === '/api/sites/discover' && req.method === 'POST') {
    try {
      const body = (await parseBody(req)) as { url?: string };
      const url = (body.url || '').trim();
      if (!url) {
        sendJson(res, { error: 'url is required' }, 400);
        return true;
      }
      try {
        new URL(url);
      } catch {
        sendJson(res, { error: 'url is not a valid URL' }, 400);
        return true;
      }
      const result = await discoverSiteBindings(url);
      sendJson(res, result);
    } catch (error) {
      log.error('Discovery failed', { error: error instanceof Error ? error : new Error(String(error)) });
      // Details stay in the server log; the client gets a generic message.
      sendJson(res, { error: 'Discovery failed' }, 500);
    }
    return true;
  }

  // GET /api/sites — list all
  if (pathname === '/api/sites' && req.method === 'GET') {
    sendJson(res, { sites: await sitesStore.list() });
    return true;
  }

  // POST /api/sites — create
  if (pathname === '/api/sites' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const v = validateInput(body, false);
      if (!v.ok) {
        sendJson(res, { error: v.error }, 400);
        return true;
      }
      const site = await sitesStore.create(v.value as SiteInput);
      log.info('Site created', { id: site.id, name: site.name });
      sendJson(res, { site }, 201);
    } catch (error) {
      sendJson(res, { error: error instanceof Error ? error.message : 'Failed to create site' }, 500);
    }
    return true;
  }

  // /api/sites/:id (GET / PUT / DELETE)
  const idMatch = pathname.match(/^\/api\/sites\/([a-zA-Z0-9-]+)$/);
  if (idMatch) {
    const id = idMatch[1];

    if (req.method === 'GET') {
      const site = await sitesStore.get(id);
      if (!site) {
        sendJson(res, { error: 'Site not found' }, 404);
        return true;
      }
      sendJson(res, { site });
      return true;
    }

    if (req.method === 'PUT') {
      try {
        const body = await parseBody(req);
        const v = validateInput(body, true);
        if (!v.ok) {
          sendJson(res, { error: v.error }, 400);
          return true;
        }
        const site = await sitesStore.update(id, v.value as SitePatch);
        if (!site) {
          sendJson(res, { error: 'Site not found' }, 404);
          return true;
        }
        log.info('Site updated', { id, name: site.name });
        sendJson(res, { site });
      } catch (error) {
        sendJson(res, { error: error instanceof Error ? error.message : 'Failed to update site' }, 500);
      }
      return true;
    }

    if (req.method === 'DELETE') {
      const ok = await sitesStore.remove(id);
      if (!ok) {
        sendJson(res, { error: 'Site not found' }, 404);
        return true;
      }
      log.info('Site removed', { id });
      sendJson(res, { message: 'Site removed' });
      return true;
    }
  }

  return false;
}
