/**
 * GSC signals routes — list / acknowledge / manual scan / autopilot.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest } from '../auth.js';
import { signalsRepo } from '../services/gsc-signals.js';
import { runMonitorAll, runMonitorForSite } from '../services/gsc-monitor.js';
import { sitesStore } from '../services/sites-store.js';
import { runAgentTurn, isAgentConfigured, type AgentEvent } from '../services/agent.js';
import { createServiceLogger } from '../../utils/logger.js';
import { sendJson, parseBody, getParams } from './route-helpers.js';

const log = createServiceLogger('signals-api');

export async function handleSignalsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    sendJson(res, { error: auth.reason || 'Unauthorized' }, 401);
    return true;
  }

  // GET /api/signals?siteId=X&open=true
  if (pathname === '/api/signals' && req.method === 'GET') {
    const params = getParams(req);
    const siteId = params.get('siteId') || undefined;
    const onlyOpen = params.get('open') !== 'false';
    const summary = await signalsRepo.openSummary();
    const list = onlyOpen
      ? await signalsRepo.listOpen(siteId)
      : await signalsRepo.listRecent(parseInt(params.get('limit') || '100', 10));
    sendJson(res, { signals: list, summary });
    return true;
  }

  // POST /api/signals/run — trigger a manual scan, optionally for one site
  if (pathname === '/api/signals/run' && req.method === 'POST') {
    try {
      const body = (await parseBody(req)) as { siteId?: string };
      if (body.siteId) {
        const site = await sitesStore.get(body.siteId);
        if (!site) {
          sendJson(res, { error: 'Site not found' }, 404);
          return true;
        }
        const result = await runMonitorForSite(site);
        sendJson(res, { result });
      } else {
        const results = await runMonitorAll();
        sendJson(res, { results });
      }
    } catch (err) {
      log.error('Manual scan failed', { error: err instanceof Error ? err : new Error(String(err)) });
      sendJson(res, { error: err instanceof Error ? err.message : 'Scan failed' }, 500);
    }
    return true;
  }

  // POST /api/signals/:id/ack
  const ackMatch = pathname.match(/^\/api\/signals\/(\d+)\/ack$/);
  if (ackMatch && req.method === 'POST') {
    const id = parseInt(ackMatch[1], 10);
    const updated = await signalsRepo.acknowledge(id);
    if (!updated) {
      sendJson(res, { error: 'Signal not found' }, 404);
      return true;
    }
    sendJson(res, { signal: updated });
    return true;
  }

  // POST /api/signals/autopilot — Claude reviews and resolves open signals
  if (pathname === '/api/signals/autopilot' && req.method === 'POST') {
    if (!isAgentConfigured()) {
      sendJson(res, { error: 'Agent (Anthropic) no configurado en Settings' }, 400);
      return true;
    }

    let body: { siteId?: string };
    try {
      body = (await parseBody(req)) as { siteId?: string };
    } catch (err) {
      sendJson(res, { error: err instanceof Error ? err.message : 'Bad request' }, 400);
      return true;
    }

    const targetSiteId = body.siteId || null;
    const open = await signalsRepo.listOpen(targetSiteId || undefined);
    if (open.length === 0) {
      sendJson(res, { ok: true, message: 'No hay alertas abiertas para revisar', conversationId: null });
      return true;
    }

    // Build a directive prompt for the agent
    const message = [
      'AUTOPILOT — modo agente autónomo.',
      '',
      `Hay ${open.length} alerta(s) abiertas en el dashboard:`,
      ...open.map(
        (s) =>
          `- [${s.severity.toUpperCase()}] ${s.signalType} en sitio ${s.siteName || s.siteId}: ${s.title}`,
      ),
      '',
      'Tu tarea:',
      '1. Investigá cada alerta llamando las tools relevantes (URL inspection en URLs sample, search analytics, etc).',
      '2. Diagnosticá la causa raíz cuando puedas.',
      '3. Si hay una acción mutativa que la resuelva (ej. re-submit sitemap), proponela — el sistema te pedirá aprobación.',
      '4. Cuando una alerta no requiere acción mutativa o requiere intervención fuera del sistema (ej. cambios de contenido), explicá qué tiene que hacer el humano.',
      '5. Cerrá tu informe con un resumen ejecutivo: alertas revisadas, acciones propuestas, alertas pendientes de intervención humana.',
      '',
      'Sé conciso pero exhaustivo. No reintentes tools que fallen — pasá a la siguiente alerta.',
    ].join('\n');

    // Open SSE stream so the caller can watch the autopilot run
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const writeEvent = (event: AgentEvent) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* noop */ }
    };

    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n'); } catch { /* noop */ }
    }, 15000);

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      await runAgentTurn(
        { conversationId: null, siteId: targetSiteId, userMessage: message },
        (event) => { if (!aborted) writeEvent(event); },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Autopilot run failed', { error: err instanceof Error ? err : new Error(msg) });
      writeEvent({ type: 'error', message: msg });
    } finally {
      clearInterval(heartbeat);
      try { res.end(); } catch { /* noop */ }
    }
    return true;
  }

  return false;
}
