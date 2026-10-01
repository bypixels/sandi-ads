/**
 * Agent API routes — SSE chat + conversation history.
 *
 * POST /api/agent/chat                      → SSE stream of agent events
 * GET  /api/agent/status                    → { configured, model, mutations }
 * GET  /api/agent/conversations[?siteId=x]  → list summaries
 * GET  /api/agent/conversations/:id         → full conversation
 * DELETE /api/agent/conversations/:id       → remove
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest, getPinnedSiteId } from '../auth.js';
import { runAgentTurn, isAgentConfigured, type AgentEvent } from '../services/agent.js';
import * as approvalGate from '../services/approval-gate.js';
import { conversationStore } from '../services/agent-conversations.js';
import { getMutationsStatus } from '../services/mutations.js';
import { createServiceLogger } from '../../utils/logger.js';
import { sendJson, parseBody, getParams } from './route-helpers.js';

const log = createServiceLogger('agent-api');

export async function handleAgentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    sendJson(res, { error: auth.reason || 'Unauthorized' }, 401);
    return true;
  }

  // GET /api/agent/status
  if (pathname === '/api/agent/status' && req.method === 'GET') {
    sendJson(res, {
      configured: isAgentConfigured(),
      model: process.env.AGENT_MODEL || 'claude-sonnet-4-6',
      mutations: getMutationsStatus(),
    });
    return true;
  }

  // GET /api/agent/conversations
  if (pathname === '/api/agent/conversations' && req.method === 'GET') {
    const siteIdParam = getParams(req).get('siteId');
    // null sentinel: ?siteId=__none__ → conversations with siteId === null
    let siteId: string | null | undefined;
    if (siteIdParam === '__none__') siteId = null;
    else if (siteIdParam) siteId = siteIdParam;
    else siteId = undefined; // all
    sendJson(res, { conversations: await conversationStore.list(siteId) });
    return true;
  }

  // POST /api/agent/approve — resolve a pending approval
  if (pathname === '/api/agent/approve' && req.method === 'POST') {
    try {
      const body = (await parseBody(req)) as { toolUseId?: string; approve?: boolean; reason?: string; siteId?: string };
      if (typeof body.toolUseId !== 'string' || !body.toolUseId || typeof body.approve !== 'boolean'
        || (body.reason !== undefined && typeof body.reason !== 'string')) {
        sendJson(res, { error: 'Se requiere toolUseId, approve booleano y reason de texto opcional.' }, 400);
        return true;
      }
      const siteId = getPinnedSiteId() || (auth.role === 'admin' ? body.siteId : undefined);
      if (!siteId || (body.siteId && body.siteId !== siteId)) {
        sendJson(res, { error: 'Se requiere el cliente autorizado para aprobar.' }, 403);
        return true;
      }
      const ok = await approvalGate.resolve(body.toolUseId, body.approve, body.reason, siteId);
      if (!ok) {
        sendJson(res, { error: 'No pending approval matches that toolUseId (may have timed out)' }, 404);
        return true;
      }
      sendJson(res, { ok: true });
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : 'Bad request' }, 400);
    }
    return true;
  }

  // GET /api/agent/pending-approvals[?conversationId=X]
  if (pathname === '/api/agent/pending-approvals' && req.method === 'GET') {
    const cid = getParams(req).get('conversationId') || undefined;
    const siteId = getPinnedSiteId()
      || (auth.role === 'admin' ? getParams(req).get('siteId') || undefined : undefined);
    sendJson(res, { pending: await approvalGate.list({ conversationId: cid, siteId }) });
    return true;
  }

  // /api/agent/conversations/:id
  const convMatch = pathname.match(/^\/api\/agent\/conversations\/([a-zA-Z0-9-]+)$/);
  if (convMatch) {
    const id = convMatch[1];
    if (req.method === 'GET') {
      const conv = await conversationStore.get(id);
      if (!conv) {
        sendJson(res, { error: 'Conversation not found' }, 404);
        return true;
      }
      sendJson(res, { conversation: conv });
      return true;
    }
    if (req.method === 'DELETE') {
      const ok = await conversationStore.remove(id);
      if (!ok) {
        sendJson(res, { error: 'Conversation not found' }, 404);
        return true;
      }
      sendJson(res, { message: 'Conversation removed' });
      return true;
    }
  }

  // POST /api/agent/chat (SSE)
  if (pathname === '/api/agent/chat' && req.method === 'POST') {
    let body: { conversationId?: string | null; siteId?: string | null; message?: string };
    try {
      body = (await parseBody(req)) as typeof body;
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : 'Bad request' }, 400);
      return true;
    }

    const message = (body.message || '').trim();
    if (!message) {
      sendJson(res, { error: 'message is required' }, 400);
      return true;
    }

    if (!isAgentConfigured()) {
      sendJson(res, { error: 'ANTHROPIC_API_KEY no configurado. Agregá tu key en Settings.' }, 400);
      return true;
    }

    // Open SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const writeEvent = (event: AgentEvent) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client disconnected */
      }
    };

    // Heartbeat to keep proxies from closing the connection
    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n'); } catch { /* noop */ }
    }, 15000);

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      await runAgentTurn(
        {
          conversationId: body.conversationId || null,
          siteId: body.siteId || null,
          userMessage: message,
        },
        (event) => {
          if (aborted) return;
          writeEvent(event);
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Agent turn failed', { error: err instanceof Error ? err : new Error(msg) });
      writeEvent({ type: 'error', message: msg });
    } finally {
      clearInterval(heartbeat);
      try { res.end(); } catch { /* noop */ }
    }
    return true;
  }

  return false;
}
