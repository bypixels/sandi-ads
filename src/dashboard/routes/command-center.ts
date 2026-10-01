/**
 * Command Center routes — `/api/cc/*`.
 *
 * Consumed by the Command Center UI (`ui/index.html` `#cmdcenter`). One
 * round-trip rather than N: the SPA hits `/api/cc/site/:id` once and gets
 * site + profile + cached snapshots + agent summary together.
 *
 * Backed by three deepening modules:
 *   - `agent-catalog.ts` — signal → agent typed mapping + summary builder
 *   - `snapshots.ts`     — generic (siteId, kind) cache for tool output
 *   - `site-profile.ts`  — marketer-facing metadata, separate from bindings
 *
 * Routes don't talk to tool handlers directly except through the snapshot
 * read-through cache (Lighthouse takes 30-60s — no inline-on-GET).
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, parseBody, getParams } from './route-helpers.js';
import { authenticateRequest } from '../auth.js';
import { sitesStore, type Site } from '../services/sites-store.js';
import { signalsRepo } from '../services/gsc-signals.js';
import {
  AGENT_DEFS,
  buildAgentSummary,
  buildAgentDetail,
  type AgentId,
} from '../services/agent-catalog.js';
import { snapshotsRepo, isKnownSnapshotKind, type SnapshotKind } from '../services/snapshots.js';
import { siteProfileRepo, profilePatchSchema } from '../services/site-profile.js';
import { executeToolByName } from '../services/dashboard-data.js';
import { resolveDocument, isDocType } from '../services/documents.js';
import { resolveTab, isTabName } from '../services/analytics-tabs.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('cc-routes');

/**
 * The /snapshot endpoint overrides the default body cap because tool outputs
 * (Lighthouse, SEO audit) routinely run 300-800KB and need headroom.
 * All other CC endpoints use the route-helpers default (100KB).
 */
const SNAPSHOT_MAX_BODY_SIZE = 1024 * 1024 * 4;   // 4MB

// ---------------------------------------------------------------------------
// Refresh jobs — in-memory. Each /refresh POST returns a jobId immediately
// and the producers run in the background. Clients poll /refresh/:jobId.
//
// In-memory only (no DB persistence) for the same reason approval-gate is:
// jobs die on restart but the snapshots they produce are durable, so the
// next page load shows fresh data anyway. See ADR-0001 for the precedent.
//
// Dedup per site: if a job is already running for siteId, POST returns the
// existing jobId — avoids duplicate parallel Lighthouse runs.
// ---------------------------------------------------------------------------

type ProducerStatus = 'pending' | 'success' | { error: string };

interface RefreshJob {
  id: string;
  siteId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'done' | 'partial' | 'failed';
  producers: Record<string, ProducerStatus>;
}

const REFRESH_JOB_TTL_MS = 10 * 60 * 1000; // 10 min — long enough for a slow poll to catch up
const refreshJobs = new Map<string, RefreshJob>();
const refreshJobBySite = new Map<string, string>(); // siteId → active jobId

function getOrStartRefreshJob(site: Site): RefreshJob {
  const existingId = refreshJobBySite.get(site.id);
  if (existingId) {
    const existing = refreshJobs.get(existingId);
    if (existing && existing.status === 'running') return existing;
  }

  const id = randomUUID();
  const job: RefreshJob = {
    id,
    siteId: site.id,
    startedAt: new Date().toISOString(),
    status: 'running',
    producers: {
      lighthouse_mobile: 'pending',
      lighthouse_desktop: 'pending',
      llms_txt_probe: 'pending',
    },
  };
  refreshJobs.set(id, job);
  refreshJobBySite.set(site.id, id);

  // Kick off producers in background — caller does NOT await
  void runRefreshJob(job, site);

  return job;
}

async function runRefreshJob(job: RefreshJob, site: Site): Promise<void> {
  const url = site.primaryUrl;

  const wrap = (kind: keyof typeof job.producers, fn: () => Promise<unknown>) =>
    fn()
      .then(() => { job.producers[kind] = 'success'; })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        job.producers[kind] = { error: message };
      });

  await Promise.allSettled([
    wrap('lighthouse_mobile', () =>
      snapshotsRepo.getOrFresh({
        siteId: site.id,
        kind: 'lighthouse_mobile',
        maxAgeSeconds: 0,
        force: true,
        producer: () => lighthouseProducer(url, 'mobile'),
      }),
    ),
    wrap('lighthouse_desktop', () =>
      snapshotsRepo.getOrFresh({
        siteId: site.id,
        kind: 'lighthouse_desktop',
        maxAgeSeconds: 0,
        force: true,
        producer: () => lighthouseProducer(url, 'desktop'),
      }),
    ),
    wrap('llms_txt_probe', () =>
      snapshotsRepo.getOrFresh({
        siteId: site.id,
        kind: 'llms_txt_probe',
        maxAgeSeconds: 0,
        force: true,
        producer: () => llmsTxtProducer(url),
      }),
    ),
  ]);

  const states = Object.values(job.producers);
  const allOk = states.every((s) => s === 'success');
  const anyOk = states.some((s) => s === 'success');
  job.status = allOk ? 'done' : anyOk ? 'partial' : 'failed';
  job.completedAt = new Date().toISOString();

  log.info('Refresh job complete', { jobId: job.id, siteId: site.id, status: job.status });

  // Schedule cleanup; the polling client has 10 min to fetch the final state.
  setTimeout(() => {
    refreshJobs.delete(job.id);
    if (refreshJobBySite.get(site.id) === job.id) {
      refreshJobBySite.delete(site.id);
    }
  }, REFRESH_JOB_TTL_MS);
}

const SNAPSHOT_KINDS_FOR_SITE: SnapshotKind[] = [
  'lighthouse_mobile',
  'lighthouse_desktop',
  'llms_txt_probe',
];

/**
 * Per-kind max age used for the headline payload `/api/cc/site/:id`. Only the
 * three kinds the Site card consumes need entries; analytics-tabs has its own
 * (broader) freshness map for the other kinds.
 */
const SNAPSHOT_MAX_AGE_SECONDS: Partial<Record<SnapshotKind, number>> = {
  lighthouse_mobile: 60 * 60 * 6,
  lighthouse_desktop: 60 * 60 * 6,
  llms_txt_probe: 60 * 60 * 24,
};
const DEFAULT_MAX_AGE = 60 * 60 * 12;

// HTTP utilities (sendJson, parseBody, getParams) live in ./route-helpers.ts
// and are imported at the top of this file.

// ---------------------------------------------------------------------------
// Tool producers
// ---------------------------------------------------------------------------

async function lighthouseProducer(url: string, formFactor: 'mobile' | 'desktop'): Promise<unknown> {
  return executeToolByName('lighthouse_audit', {
    url,
    formFactor,
    categories: ['performance', 'accessibility', 'best-practices', 'seo'],
  });
}

async function llmsTxtProducer(siteUrl: string): Promise<unknown> {
  try {
    const origin = new URL(siteUrl).origin;
    return await executeToolByName('geo_validate_llms_txt', { baseUrl: origin });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Aggregation helper — the snapshot view a route or refresh returns
// ---------------------------------------------------------------------------

interface SnapshotView {
  capturedAt: string;
  data: unknown;
  ageSeconds: number;
  isStale: boolean;
}

function toView(s: { data: unknown; capturedAt: string } | null, maxAge: number): SnapshotView | null {
  if (!s) return null;
  const ageSeconds = (Date.now() - new Date(s.capturedAt).getTime()) / 1000;
  return { capturedAt: s.capturedAt, data: s.data, ageSeconds, isStale: ageSeconds >= maxAge };
}

async function loadSitePayload(site: Site) {
  const [profile, snapshots, openSignals] = await Promise.all([
    siteProfileRepo.get(site.id),
    snapshotsRepo.getMany(site.id, SNAPSHOT_KINDS_FOR_SITE),
    signalsRepo.listOpen(site.id),
  ]);

  const snapshotViews: Partial<Record<SnapshotKind, SnapshotView | null>> = {};
  for (const kind of SNAPSHOT_KINDS_FOR_SITE) {
    snapshotViews[kind] = toView(snapshots[kind] ?? null, SNAPSHOT_MAX_AGE_SECONDS[kind] ?? DEFAULT_MAX_AGE);
  }

  return {
    site: {
      id: site.id,
      name: site.name,
      primaryUrl: site.primaryUrl,
      bindings: site.bindings,
    },
    profile,
    snapshots: snapshotViews,
    agents: buildAgentSummary(openSignals),
    openSignalCount: openSignals.length,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleCommandCenterRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const auth = authenticateRequest(req);
  if (!auth.authenticated) {
    sendJson(res, { error: auth.reason || 'Unauthorized' }, 401);
    return true;
  }

  // GET /api/cc/site/:siteId — full payload
  const siteMatch = pathname.match(/^\/api\/cc\/site\/([0-9a-f-]+)$/i);
  if (siteMatch && req.method === 'GET') {
    const site = await sitesStore.get(siteMatch[1]);
    if (!site) {
      sendJson(res, { error: 'Site not found' }, 404);
      return true;
    }
    sendJson(res, await loadSitePayload(site));
    return true;
  }

  // PUT /api/cc/site/:siteId/profile — merge-update profile
  const profileMatch = pathname.match(/^\/api\/cc\/site\/([0-9a-f-]+)\/profile$/i);
  if (profileMatch && req.method === 'PUT') {
    const site = await sitesStore.get(profileMatch[1]);
    if (!site) {
      sendJson(res, { error: 'Site not found' }, 404);
      return true;
    }
    try {
      const body = (await parseBody(req)) as unknown;
      const patch = profilePatchSchema.parse(body);
      const updated = await siteProfileRepo.update(site.id, patch);
      sendJson(res, { profile: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Bad request';
      sendJson(res, { error: msg }, 400);
    }
    return true;
  }

  // POST /api/cc/site/:siteId/refresh — kick off fresh snapshots (async).
  // Returns the jobId immediately; client polls GET /refresh/:jobId for status.
  // Dedupes per site: a second POST while a job is running returns the same id.
  const refreshMatch = pathname.match(/^\/api\/cc\/site\/([0-9a-f-]+)\/refresh$/i);
  if (refreshMatch && req.method === 'POST') {
    const site = await sitesStore.get(refreshMatch[1]);
    if (!site) {
      sendJson(res, { error: 'Site not found' }, 404);
      return true;
    }
    if (!site.primaryUrl) {
      sendJson(res, { error: 'Site has no primaryUrl' }, 400);
      return true;
    }

    log.info('CC refresh requested', { siteId: site.id, url: site.primaryUrl });
    const job = getOrStartRefreshJob(site);
    sendJson(res, {
      jobId: job.id,
      status: job.status,
      siteId: site.id,
      startedAt: job.startedAt,
      pollUrl: `/api/cc/site/${site.id}/refresh/${job.id}`,
      // Hint to the client: Lighthouse normally completes in 30-90s
      expectedDurationSeconds: 90,
    }, 202);
    return true;
  }

  // GET /api/cc/site/:siteId/refresh/:jobId — poll job status.
  // Returns the live job state; when terminal (done|partial|failed), also
  // includes a fresh `payload` so the client can re-render without another
  // round-trip to GET /api/cc/site/:id.
  const refreshPollMatch = pathname.match(/^\/api\/cc\/site\/([0-9a-f-]+)\/refresh\/([0-9a-f-]+)$/i);
  if (refreshPollMatch && req.method === 'GET') {
    const [, siteId, jobId] = refreshPollMatch;
    const job = refreshJobs.get(jobId);
    if (!job || job.siteId !== siteId) {
      sendJson(res, { error: 'Job not found (may have expired)' }, 404);
      return true;
    }
    const site = await sitesStore.get(siteId);
    if (!site) {
      sendJson(res, { error: 'Site not found' }, 404);
      return true;
    }
    const includePayload = job.status !== 'running';
    sendJson(res, {
      job,
      payload: includePayload ? await loadSitePayload(site) : undefined,
    });
    return true;
  }

  // POST /api/cc/site/:siteId/snapshot — persist a tool result as a snapshot.
  // Used by the analytics-tabs UI: when the user clicks a widget action button,
  // the tool runs via /api/tool/:name, and the result is sent here to be cached
  // so the next tab open shows it without re-running.
  //
  // Uses an enlarged body cap (4MB) because tool outputs like Lighthouse and
  // report_seo_audit routinely exceed 50KB. Validates `kind` against the
  // SnapshotKind whitelist so frontend bugs can't pollute the snapshots table.
  const snapshotMatch = pathname.match(/^\/api\/cc\/site\/([0-9a-f-]+)\/snapshot$/i);
  if (snapshotMatch && req.method === 'POST') {
    const site = await sitesStore.get(snapshotMatch[1]);
    if (!site) {
      sendJson(res, { error: 'Site not found' }, 404);
      return true;
    }
    try {
      const body = (await parseBody(req, SNAPSHOT_MAX_BODY_SIZE)) as { kind?: string; data?: unknown };
      if (!body.kind || typeof body.kind !== 'string') {
        sendJson(res, { error: 'kind required' }, 400);
        return true;
      }
      if (!isKnownSnapshotKind(body.kind)) {
        sendJson(res, { error: `Unknown snapshot kind: ${body.kind}` }, 400);
        return true;
      }
      const saved = await snapshotsRepo.save({
        siteId: site.id,
        kind: body.kind,
        data: body.data ?? null,
      });
      sendJson(res, { ok: true, capturedAt: saved.capturedAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      sendJson(res, { error: msg }, 400);
    }
    return true;
  }

  // GET /api/cc/site/:siteId/tab/:tabName — Links/Technical/GEO tab payload
  const tabMatch = pathname.match(/^\/api\/cc\/site\/([0-9a-f-]+)\/tab\/([a-z]+)$/i);
  if (tabMatch && req.method === 'GET') {
    const [, siteId, tabName] = tabMatch;
    if (!isTabName(tabName)) {
      sendJson(res, { error: 'Unknown tabName', accepted: ['links', 'technical', 'geo'] }, 404);
      return true;
    }
    try {
      const payload = await resolveTab(siteId, tabName);
      sendJson(res, { tab: payload });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resolve failed';
      sendJson(res, { error: msg }, /not found/i.test(msg) ? 404 : 500);
    }
    return true;
  }

  // GET /api/cc/site/:siteId/docs/:docType — drill-down for a single doc
  const docMatch = pathname.match(/^\/api\/cc\/site\/([0-9a-f-]+)\/docs\/([a-z-]+)$/i);
  if (docMatch && req.method === 'GET') {
    const [, siteId, docType] = docMatch;
    if (!isDocType(docType)) {
      sendJson(res, { error: 'Unknown docType', accepted: ['brand-voice', 'competitor-analysis', 'seo-audit', 'site-health', 'llms-txt', 'content-briefs', 'articles'] }, 404);
      return true;
    }
    try {
      const payload = await resolveDocument(siteId, docType);
      sendJson(res, { document: payload });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Resolve failed';
      sendJson(res, { error: msg }, /not found/i.test(msg) ? 404 : 500);
    }
    return true;
  }

  // GET /api/cc/agents?siteId=X — agent summary (defaults to all sites if no siteId)
  if (pathname === '/api/cc/agents' && req.method === 'GET') {
    const siteId = getParams(req).get('siteId') || undefined;
    const signals = await signalsRepo.listOpen(siteId);
    sendJson(res, {
      siteId: siteId ?? null,
      agents: buildAgentSummary(signals),
      openSignalCount: signals.length,
    });
    return true;
  }

  // GET /api/cc/agents/:agentId?siteId=X — drill-down
  const agentMatch = pathname.match(/^\/api\/cc\/agents\/([a-z0-9]+)$/i);
  if (agentMatch && req.method === 'GET') {
    const agentId = agentMatch[1] as AgentId;
    if (!(agentId in AGENT_DEFS)) {
      sendJson(res, { error: 'Unknown agent id', knownAgents: Object.keys(AGENT_DEFS) }, 404);
      return true;
    }
    const siteId = getParams(req).get('siteId') || undefined;
    const signals = await signalsRepo.listOpen(siteId);
    sendJson(res, { siteId: siteId ?? null, agent: buildAgentDetail(agentId, signals) });
    return true;
  }

  return false;
}
