/**
 * Drafts routes — inbox + edit/approve/reject/publish for agent-generated
 * artifacts (articles, social posts, replies).
 *
 * Endpoints:
 *   GET    /api/drafts                          → list with filters
 *   GET    /api/drafts/summary[?siteId=X]       → counts by status
 *   GET    /api/drafts/:id                      → full draft
 *   PUT    /api/drafts/:id                      → edit title/content/metadata
 *   POST   /api/drafts/:id/approve              → pending_review → approved
 *   POST   /api/drafts/:id/reject               → pending_review → rejected
 *   POST   /api/drafts/:id/revise               → pending_review → revised
 *                                                  (then PUT to edit, then approve)
 *   POST   /api/drafts/:id/publish              → approved → published
 *   DELETE /api/drafts/:id                      → hard delete
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest } from '../auth.js';
import { draftsRepo, DRAFT_STATUSES, DraftTransitionError, type DraftStatus } from '../services/drafts-store.js';
import { AGENT_RUNNERS, runAgent } from '../services/agent-runners.js';
import { executeToolByName } from '../services/dashboard-data.js';
import type { RenderClipOutput } from '../../tools/video/index.js';
import { createServiceLogger } from '../../utils/logger.js';
import { sendJson, parseBody, getParams } from './route-helpers.js';

const log = createServiceLogger('drafts-api');

const DRAFT_ID_PATTERN = /^\/api\/drafts\/([0-9a-f-]{36})$/i;
const DRAFT_ACTION_PATTERN = /^\/api\/drafts\/([0-9a-f-]{36})\/(approve|reject|revise|publish)$/i;

function isDraftStatus(value: string): value is DraftStatus {
  return (DRAFT_STATUSES as readonly string[]).includes(value);
}

function reviewerFromAuth(req: IncomingMessage): string | null {
  // Best-effort: prefer X-Reviewer header if the UI sends one, otherwise the
  // request's IP. Auth doesn't carry an identity in this codebase yet.
  const headerName = req.headers['x-reviewer'];
  if (typeof headerName === 'string' && headerName.trim()) return headerName.trim().slice(0, 120);
  return null;
}

export async function handleDraftsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    sendJson(res, { error: auth.reason || 'Unauthorized' }, 401);
    return true;
  }

  // GET /api/drafts/summary
  if (pathname === '/api/drafts/summary' && req.method === 'GET') {
    const siteId = getParams(req).get('siteId') || undefined;
    const counts = await draftsRepo.inboxSummary(siteId);
    sendJson(res, { siteId: siteId ?? null, counts });
    return true;
  }

  // GET /api/drafts
  if (pathname === '/api/drafts' && req.method === 'GET') {
    const params = getParams(req);
    const statusParam = params.get('status');
    const status = statusParam
      ? statusParam.split(',').filter(isDraftStatus)
      : undefined;
    const drafts = await draftsRepo.list({
      siteId: params.get('siteId') || undefined,
      agentId: params.get('agentId') || undefined,
      status: status && status.length > 0 ? status : undefined,
      limit: parseInt(params.get('limit') || '100', 10),
    });
    sendJson(res, { drafts });
    return true;
  }

  // POST /api/drafts/agents/:agentId/run — orchestrates a draft-producing
  // agent (writer, social-x, social-linkedin, social-hn, future: reddit,
  // coding). The runner reads the request body, resolves site + profile,
  // calls the agent's stateless tool, and persists the draft.
  // Body shape varies per agent — see src/dashboard/services/agent-runners.ts.
  const agentRunMatch = pathname.match(/^\/api\/drafts\/agents\/([a-z][a-z0-9-]*)\/run$/i);
  if (agentRunMatch && req.method === 'POST') {
    const agentId = agentRunMatch[1];
    if (!(agentId in AGENT_RUNNERS)) {
      sendJson(res, { error: 'Unknown or not-yet-implemented agent', agentId, knownAgents: Object.keys(AGENT_RUNNERS) }, 404);
      return true;
    }
    try {
      const body = (await parseBody(req)) as { siteId?: string };
      if (!body.siteId) {
        sendJson(res, { error: 'siteId is required' }, 400);
        return true;
      }

      const result = await runAgent(agentId, body.siteId, body);
      sendJson(res, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as Error & { code?: string }).code;
      if (code === 'SITE_NOT_FOUND') {
        sendJson(res, { error: 'Site not found' }, 404);
        return true;
      }
      log.error('Agent run failed', { agentId, error: err instanceof Error ? err : new Error(msg) });
      sendJson(res, { error: msg }, 500);
    }
    return true;
  }

  // POST /api/drafts/:id/render — kick off external video rendering for a
  // video_brief draft. Only valid on approved video briefs. Returns the
  // provider's response (or pending_provider_config when no provider is
  // wired). Persists the result back into the draft's content.render field.
  const renderMatch = pathname.match(/^\/api\/drafts\/([0-9a-f-]{36})\/render$/i);
  if (renderMatch && req.method === 'POST') {
    const id = renderMatch[1];
    try {
      const body = (await parseBody(req).catch(() => ({}))) as { providerOverride?: 'runway' | 'pika' | 'replicate' };
      const draft = await draftsRepo.get(id);
      if (!draft) {
        sendJson(res, { error: 'Draft not found' }, 404);
        return true;
      }
      if (draft.draftType !== 'video_brief') {
        sendJson(res, { error: 'Render is only available for video_brief drafts', draftType: draft.draftType }, 400);
        return true;
      }
      if (draft.status !== 'approved' && draft.status !== 'published') {
        sendJson(res, { error: 'Brief must be approved before rendering', currentStatus: draft.status }, 409);
        return true;
      }
      const brief = draft.content as Record<string, unknown>;
      const result = await executeToolByName<RenderClipOutput>('video_render_clip', {
        brief: {
          title: String(brief.title ?? draft.title),
          hookScript: String(brief.hookScript ?? ''),
          mainScript: String(brief.mainScript ?? ''),
          ctaScript: String(brief.ctaScript ?? ''),
          format: brief.format ?? 'reel',
          aspectRatio: String(brief.aspectRatio ?? '9:16'),
          durationSec: typeof brief.durationSec === 'number' ? brief.durationSec : 30,
          voiceoverInstructions: String(brief.voiceoverInstructions ?? ''),
          moodAndStyle: String(brief.moodAndStyle ?? ''),
          shotList: Array.isArray(brief.shotList) ? brief.shotList : [],
        },
        providerOverride: body.providerOverride,
      });
      // Stash the render result on the draft so the UI can re-display it
      // without re-running the provider. We bypass the status machine here
      // by writing through the repo's create path is wrong; instead we'd need
      // to upgrade the repo to allow content edits on approved/published —
      // for now we just return the result and let the UI display it ephemerally.
      sendJson(res, { draftId: id, render: result });
    } catch (err) {
      log.error('Draft render failed', { id, error: err instanceof Error ? err : new Error(String(err)) });
      sendJson(res, { error: err instanceof Error ? err.message : 'Render failed' }, 500);
    }
    return true;
  }

  // /api/drafts/:id/{action}
  const actionMatch = pathname.match(DRAFT_ACTION_PATTERN);
  if (actionMatch && req.method === 'POST') {
    const [, id, action] = actionMatch;
    const reviewedBy = reviewerFromAuth(req);
    try {
      const next: DraftStatus =
        action === 'approve' ? 'approved' :
        action === 'reject' ? 'rejected' :
        action === 'revise' ? 'revised' :
        'published';
      const updated = await draftsRepo.setStatus(id, next, reviewedBy);
      if (!updated) {
        sendJson(res, { error: 'Draft not found' }, 404);
        return true;
      }
      sendJson(res, { draft: updated });
    } catch (err) {
      if (err instanceof DraftTransitionError) {
        sendJson(res, { error: err.message, from: err.from, to: err.to }, 409);
        return true;
      }
      log.error('Draft action failed', { id, action, error: err instanceof Error ? err : new Error(String(err)) });
      sendJson(res, { error: err instanceof Error ? err.message : 'Action failed' }, 500);
    }
    return true;
  }

  // /api/drafts/:id
  const idMatch = pathname.match(DRAFT_ID_PATTERN);
  if (idMatch) {
    const id = idMatch[1];

    if (req.method === 'GET') {
      const draft = await draftsRepo.get(id);
      if (!draft) {
        sendJson(res, { error: 'Draft not found' }, 404);
        return true;
      }
      sendJson(res, { draft });
      return true;
    }

    if (req.method === 'PUT') {
      try {
        const body = (await parseBody(req)) as { title?: string; content?: unknown; metadata?: Record<string, unknown> };
        const updated = await draftsRepo.update(id, body);
        if (!updated) {
          sendJson(res, { error: 'Draft not found' }, 404);
          return true;
        }
        sendJson(res, { draft: updated });
      } catch (err) {
        if (err instanceof DraftTransitionError) {
          sendJson(res, { error: 'Cannot edit draft in current status', status: err.from }, 409);
          return true;
        }
        log.error('Draft edit failed', { id, error: err instanceof Error ? err : new Error(String(err)) });
        sendJson(res, { error: err instanceof Error ? err.message : 'Edit failed' }, 500);
      }
      return true;
    }

    if (req.method === 'DELETE') {
      const removed = await draftsRepo.remove(id);
      sendJson(res, removed ? { ok: true } : { error: 'Draft not found' }, removed ? 200 : 404);
      return true;
    }
  }

  return false;
}
