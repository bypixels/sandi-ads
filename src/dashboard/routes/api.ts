/**
 * Dashboard REST API route handlers
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest } from '../auth.js';
import {
  getDashboardData,
  getReportData,
  listTools,
} from '../services/dashboard-data.js';
import { authManager } from '../../auth/index.js';
import { cacheStats } from '../../utils/cache.js';
import { rateLimiter } from '../../utils/rate-limiter.js';
import { MCPError, ErrorCode } from '../../types/errors.js';
import { getMutationsStatus } from '../services/mutations.js';
import { auditLog } from '../services/audit-log.js';
import { streamSuggestions, isSuggestConfigured, type SuggestEvent } from '../services/dashboard-suggest.js';
import { guardedExecute } from '../services/guarded-execution.js';
import { sendJson, sendError, parseBody, getParams } from './route-helpers.js';

/**
 * Route API requests. Returns true if handled, false if not matched.
 */
export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  // All API routes require auth
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    sendError(res, auth.reason || 'Unauthorized', 401);
    return true;
  }

  // GET /api/health
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, {
      status: 'ok',
      uptime: process.uptime(),
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // GET /api/tools
  if (pathname === '/api/tools' && req.method === 'GET') {
    sendJson(res, { tools: listTools() });
    return true;
  }

  // GET /api/dashboard?url=X
  if (pathname === '/api/dashboard' && req.method === 'GET') {
    const url = getParams(req).get('url');
    if (!url) {
      sendError(res, 'Missing url parameter', 400);
      return true;
    }
    try {
      const data = await getDashboardData(url);
      sendJson(res, data);
    } catch (error) {
      const msg = error instanceof MCPError ? error.message : String(error);
      sendError(res, msg, error instanceof MCPError ? 400 : 500);
    }
    return true;
  }

  // POST /api/dashboard/suggest — SSE stream of Claude's interpretation
  if (pathname === '/api/dashboard/suggest' && req.method === 'POST') {
    if (!isSuggestConfigured()) {
      sendError(res, 'ANTHROPIC_API_KEY no configurado en Settings', 400);
      return true;
    }
    let body: { url?: string; analysis?: unknown };
    try {
      body = (await parseBody(req)) as typeof body;
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Bad request', 400);
      return true;
    }
    if (!body.url || !body.analysis) {
      sendError(res, 'url y analysis son requeridos', 400);
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const writeEvent = (event: SuggestEvent) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
    };
    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n'); } catch { /* noop */ }
    }, 15000);

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      await streamSuggestions(
        { url: body.url, analysis: body.analysis },
        (event) => { if (!aborted) writeEvent(event); },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeEvent({ type: 'error', message: msg });
    } finally {
      clearInterval(heartbeat);
      try { res.end(); } catch { /* noop */ }
    }
    return true;
  }

  // GET /api/report/site-health?url=X
  if (pathname === '/api/report/site-health' && req.method === 'GET') {
    const url = getParams(req).get('url');
    if (!url) {
      sendError(res, 'Missing url parameter', 400);
      return true;
    }
    try {
      const data = await getReportData('site-health', { url });
      sendJson(res, data);
    } catch (error) {
      const msg = error instanceof MCPError ? error.message : String(error);
      sendError(res, msg, error instanceof MCPError ? 400 : 500);
    }
    return true;
  }

  // GET /api/report/seo-audit?url=X
  if (pathname === '/api/report/seo-audit' && req.method === 'GET') {
    const url = getParams(req).get('url');
    if (!url) {
      sendError(res, 'Missing url parameter', 400);
      return true;
    }
    try {
      const data = await getReportData('seo-audit', { url });
      sendJson(res, data);
    } catch (error) {
      const msg = error instanceof MCPError ? error.message : String(error);
      sendError(res, msg, error instanceof MCPError ? 400 : 500);
    }
    return true;
  }

  // POST /api/tool/:name — all policy/audit lives in guardedExecute.
  // Authentication is not approval: writes wait for the shared approval gate.
  const toolMatch = pathname.match(/^\/api\/tool\/([a-z0-9_-]+)$/);
  if (toolMatch && req.method === 'POST') {
    const toolName = toolMatch[1];
    const siteIdHeader = req.headers['x-site-id'];
    const siteId = typeof siteIdHeader === 'string' ? siteIdHeader : undefined;

    let body: unknown = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      sendError(res, err instanceof Error ? err.message : 'Invalid body', 400);
      return true;
    }

    const guarded = await guardedExecute(toolName, body, {
      source: { kind: 'http', siteId },
    });

    if (guarded.status === 'blocked' || guarded.status === 'denied') {
      sendError(res, guarded.error ?? 'Escritura bloqueada.', 403);
      return true;
    }
    if (guarded.status === 'error') {
      const msg = guarded.error ?? 'Tool execution failed';
      // 400 for known MCP/validation errors; 500 for everything else.
      const status = guarded.errorDetails?.code === ErrorCode.INVALID_PARAMS
        || guarded.errorDetails?.code === ErrorCode.NOT_IMPLEMENTED ? 400 : 500;
      sendError(res, msg, status);
      return true;
    }
    sendJson(res, guarded.result);
    return true;
  }

  // GET /api/audit?limit=N
  if (pathname === '/api/audit' && req.method === 'GET') {
    const limit = parseInt(getParams(req).get('limit') || '100', 10);
    sendJson(res, { entries: await auditLog.readRecent(Math.min(Math.max(limit, 1), 1000)) });
    return true;
  }

  // GET /api/mutations/status
  if (pathname === '/api/mutations/status' && req.method === 'GET') {
    sendJson(res, getMutationsStatus());
    return true;
  }

  // GET /api/status/auth
  if (pathname === '/api/status/auth' && req.method === 'GET') {
    try {
      const status = await authManager.getStatus();
      sendJson(res, status);
    } catch {
      sendError(res, 'Failed to retrieve auth status');
    }
    return true;
  }

  // GET /api/status/cache
  if (pathname === '/api/status/cache' && req.method === 'GET') {
    sendJson(res, cacheStats());
    return true;
  }

  // GET /api/status/rate-limits
  if (pathname === '/api/status/rate-limits' && req.method === 'GET') {
    try {
      const status = await rateLimiter.getAllStatus();
      sendJson(res, status);
    } catch {
      sendError(res, 'Failed to retrieve rate limit status');
    }
    return true;
  }

  return false; // Not matched
}
