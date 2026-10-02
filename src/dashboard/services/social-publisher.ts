/**
 * Social publisher — turns approved social_posts into real Facebook Page /
 * Instagram posts. Runs inside the dashboard process.
 *
 * Safety rules (owner decisions):
 *  - Only 'approved' rows are claimed, one atomic UPDATE per claim (claimNext).
 *  - Content, bindings and image prefix are re-validated against the site right
 *    before sending: a post can only go to the Page / IG account of its own site.
 *  - Each platform's remote id is persisted before the next platform starts, and
 *    a platform that already has a remote id is never sent again.
 *  - Never auto-retries. An ambiguous outcome (network/5xx, crash mid-publish)
 *    becomes 'needs_review' for a human; a definitive Meta error becomes 'failed'.
 *  - Posts that became due while the publisher was off become 'late'.
 *  - Kill switch: MUTATIONS_META / MUTATIONS_ENABLED, checked before claiming and
 *    before every write.
 *
 * Tokens: Facebook uses the Page access token (fetched per tick, memory only).
 * Instagram uses the system-user token (META_ACCESS_TOKEN), which carries
 * instagram_content_publish and works for IG accounts with no Page binding.
 */

import {
  metaWrite, MetaWriteCancelledError, getPageAccessToken, getIgContainerStatus, getIgPublishingQuota, getIgPermalink, type MetaWriteOp,
} from '../../tools/meta/client.js';
import { socialPostsStore, validateDraft, POST_PLATFORMS, type SocialPost, type PostPlatform } from './social-posts-store.js';
import { sitesStore, type Site } from './sites-store.js';
import { auditLog, type AuditEntry } from './audit-log.js';
import { recordSuccess, recordFailure } from './monitor-health.js';
import { MCPError } from '../../types/errors.js';
import { createServiceLogger } from '../../utils/logger.js';
import { getPinnedSiteId } from '../auth.js';

const log = createServiceLogger('social-publisher');

const STALE_PUBLISHING_MS = 10 * 60_000;
const LATE_GRACE_MS = 15 * 60_000;
const MAX_PER_TICK = 3;
const IG_POLL_MS = 2_000;
const IG_POLL_MAX_MS = 60_000;

export const INTERRUPTED_MESSAGE = 'Interrumpido durante la publicación; verifica en Meta si se publicó antes de reintentar.';
const LATE_MESSAGE = 'Su hora programada pasó mientras el publicador estaba apagado; decide si publicarla ahora o cancelarla.';
const SWITCHED_OFF_MESSAGE = 'Las publicaciones en Meta se desactivaron mientras se publicaba; no se envió nada más.';
const PLATFORM_NAME: Record<PostPlatform, string> = { facebook: 'Facebook', instagram: 'Instagram' };

export interface PublisherDeps {
  now(): number;
  store: Pick<typeof socialPostsStore, 'claimNext' | 'recoverInterrupted' | 'markLate' | 'recordRemoteIds' | 'finishPublishing' | 'withPublisherLock' | 'isPublishing'>;
  meta: {
    write(op: MetaWriteOp, token: string, beforeSend: () => Promise<void>): Promise<{ id: string; postId?: string }>;
    pageToken(pageId: string): Promise<string>;
    userToken(): string;
    igStatus(containerId: string, timeoutMs?: number): Promise<string>;
    igQuota(igUserId: string): Promise<{ usage: number; total: number }>;
    igPermalink(mediaId: string): Promise<string | null>;
  };
  audit(entry: AuditEntry): Promise<void>;
  sitesStore: { get(id: string): Promise<Site | undefined> };
  isEnabled(): boolean;
  hasLease?: () => Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

/** Same resolution as isMutationAllowed for the 'meta' category. */
export function isMetaPublishingEnabled(): boolean {
  const perService = process.env.MUTATIONS_META;
  return perService === 'true' || (perService !== 'false' && process.env.MUTATIONS_ENABLED === 'true');
}

/** Thrown when the kill switch turns off between claiming and sending. */
class SwitchedOff extends Error {}
class ClaimLost extends Error {}

function publisherSiteId(): string | null {
  const pinned = getPinnedSiteId();
  if (pinned === undefined) return null;
  const normalized = pinned.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error('El cliente fijado del publicador no es válido.');
  }
  return normalized;
}

async function assertCanSend(deps: PublisherDeps, post: SocialPost): Promise<void> {
  if (!deps.isEnabled()) throw new SwitchedOff();
  const pin = publisherSiteId();
  if ((pin !== null && pin !== post.siteId) || (deps.hasLease && !(await deps.hasLease()))
    || !(await deps.store.isPublishing(post))) throw new ClaimLost();
  if (!deps.isEnabled()) throw new SwitchedOff();
}

/** A platform that could not be published; `uncertain` = Meta may have published it anyway. */
class PlatformFailure extends Error {
  constructor(message: string, public readonly uncertain = false) {
    super(message);
  }
}

function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of [...secrets, process.env.META_ACCESS_TOKEN, process.env.META_APP_SECRET]) {
    if (s) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isUncertain = (err: unknown) => (err as { details?: { uncertain?: unknown } } | null)?.details?.uncertain === true;

function auditEvent(
  deps: PublisherDeps, post: SocialPost, tool: string, status: AuditEntry['status'], input: Record<string, unknown>,
  resultSummary: string, error?: string,
): Promise<void> {
  return deps.audit({
    timestamp: new Date(deps.now()).toISOString(),
    tool,
    siteId: post.siteId,
    input: { postId: post.id, actor: 'publisher', ...input },
    status,
    durationMs: 0,
    resultSummary,
    ...(error ? { error } : {}),
  });
}

export async function recoverInterrupted(deps: PublisherDeps, opts: { all?: boolean } = {}): Promise<number> {
  if (!deps.hasLease) {
    let count = 0;
    await deps.store.withPublisherLock(async hasLease => {
      count = await recoverInterrupted({ ...deps, hasLease }, opts);
    });
    return count;
  }
  if (!(await deps.hasLease())) throw new ClaimLost();
  const rows = await deps.store.recoverInterrupted(opts.all ? null : deps.now() - STALE_PUBLISHING_MS, INTERRUPTED_MESSAGE, publisherSiteId());
  for (const post of rows) {
    log.warn('Interrupted publication moved to needs_review', { postId: post.id, siteId: post.siteId });
    await auditEvent(deps, post, 'social_post_needs_review', 'error', { phase: 'recover', remoteIds: post.remoteIds }, 'status=needs_review', INTERRUPTED_MESSAGE);
  }
  return rows.length;
}

export async function markLate(deps: PublisherDeps): Promise<number> {
  const rows = await deps.store.markLate(deps.now() - LATE_GRACE_MS, LATE_MESSAGE, publisherSiteId());
  for (const post of rows) {
    await auditEvent(deps, post, 'social_post_late', 'blocked', { phase: 'late' }, 'status=late', LATE_MESSAGE);
  }
  return rows.length;
}

export async function claimNext(deps: PublisherDeps): Promise<SocialPost | null> {
  if (!deps.isEnabled()) return null;
  return deps.store.claimNext(deps.now(), publisherSiteId());
}

async function finish(deps: PublisherDeps, post: SocialPost, status: 'published' | 'failed' | 'needs_review' | 'approved', lastError: string | null) {
  const done = await deps.store.finishPublishing(post, status, lastError);
  if (!done) throw new ClaimLost('El publicador perdió la reserva antes de guardar el resultado.');
  await auditEvent(deps, post, 'social_post_publish', status === 'published' ? 'success' : 'error',
    { phase: 'result', remoteIds: done.remoteIds }, `status=${status}`, lastError ?? undefined);
  if (status === 'published') recordSuccess('publisher', 'meta');
  else if (status !== 'approved') recordFailure('publisher', 'meta', lastError ?? status, { pausable: false });
}

/** Sends one write; checks the kill switch first and classifies Meta errors. */
async function send(deps: PublisherDeps, post: SocialPost, op: MetaWriteOp, token: string, secrets: string[]) {
  await assertCanSend(deps, post);
  try {
    return await deps.meta.write(op, token, () => assertCanSend(deps, post));
  } catch (err) {
    if (err instanceof SwitchedOff || err instanceof ClaimLost) throw err;
    if (err instanceof MetaWriteCancelledError) throw new SwitchedOff();
    const uncertain = isUncertain(err) && op.kind !== 'ig_container'; // a container is not a publication
    throw new PlatformFailure(scrub(messageOf(err), secrets), uncertain);
  }
}

async function publishFacebook(deps: PublisherDeps, post: SocialPost, site: Site, secrets: string[]): Promise<Record<string, string>> {
  const pageId = site.bindings.metaPageId!;
  let token: string;
  try {
    token = await deps.meta.pageToken(pageId);
  } catch (err) {
    throw new PlatformFailure(scrub(messageOf(err), secrets));
  }
  secrets.push(token);
  const op: MetaWriteOp = post.imageUrl
    ? { kind: 'page_photo', pageId, url: post.imageUrl, caption: post.message }
    : { kind: 'page_feed', pageId, message: post.message };
  const r = await send(deps, post, op, token, secrets);
  const remoteId = r.postId ?? r.id;
  return { facebook: remoteId, facebook_permalink: `https://www.facebook.com/${remoteId}` };
}

async function publishInstagram(deps: PublisherDeps, post: SocialPost, site: Site, secrets: string[]): Promise<Record<string, string>> {
  const igUserId = site.bindings.metaIgUserId!;
  let token: string;
  try {
    token = deps.meta.userToken();
    const quota = await deps.meta.igQuota(igUserId);
    if (quota.usage >= quota.total) {
      throw new PlatformFailure(`se alcanzó la cuota de publicaciones de las últimas 24 h (${quota.usage}/${quota.total}).`);
    }
  } catch (err) {
    if (err instanceof PlatformFailure) throw err;
    throw new PlatformFailure(scrub(messageOf(err), secrets));
  }
  const container = await send(deps, post, { kind: 'ig_container', igUserId, imageUrl: post.imageUrl!, caption: post.message }, token, secrets);
  const deadline = deps.now() + IG_POLL_MAX_MS;
  for (;;) {
    await assertCanSend(deps, post);
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new PlatformFailure('Meta tardó más de 60 segundos en procesar la imagen.');
    let status: string;
    try {
      status = await deps.meta.igStatus(container.id, Math.min(20_000, remaining));
    } catch (err) {
      throw new PlatformFailure(scrub(messageOf(err), secrets));
    }
    if (deps.now() >= deadline) throw new PlatformFailure('Meta tardó más de 60 segundos en procesar la imagen.');
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new PlatformFailure(`Meta no pudo procesar la imagen (estado ${status}).`);
    await deps.sleep(Math.min(IG_POLL_MS, deadline - deps.now()));
  }
  const media = await send(deps, post, { kind: 'ig_publish', igUserId, creationId: container.id }, token, secrets);
  return { instagram: media.id };
}

/** Best-effort: the IG permalink is a convenience, its absence never fails a publication. */
async function addIgPermalink(deps: PublisherDeps, post: SocialPost, secrets: string[]): Promise<SocialPost> {
  try {
    const permalink = await deps.meta.igPermalink(post.remoteIds.instagram);
    if (!permalink) return post;
    return (await deps.store.recordRemoteIds(post, { instagram_permalink: permalink })) ?? post;
  } catch (err) {
    log.warn('Instagram permalink unavailable', { postId: post.id, error: scrub(messageOf(err), secrets) });
    return post;
  }
}

export async function publishOne(deps: PublisherDeps, post: SocialPost): Promise<void> {
  const pin = publisherSiteId();
  if (pin !== null && pin !== post.siteId) throw new ClaimLost();
  const site = await deps.sitesStore.get(post.siteId);
  const invalid = validateDraft(post, site ?? null, deps.now(), { forApproval: true });
  if (!site || invalid.length > 0) {
    await finish(deps, post, 'failed', `No se publicó: ${invalid.join(' ')}`);
    return;
  }

  const secrets: string[] = [];
  const failures: string[] = [];
  let uncertain = false;
  let current = post;
  for (const platform of post.platforms) {
    if (current.remoteIds[platform]) continue;
    const name = PLATFORM_NAME[platform];
    await auditEvent(deps, current, 'social_post_publish', 'success', { phase: 'attempt', platform }, `attempt=${platform}`);
    let ids: Record<string, string>;
    try {
      ids = platform === 'facebook' ? await publishFacebook(deps, current, site, secrets) : await publishInstagram(deps, current, site, secrets);
    } catch (err) {
      if (err instanceof SwitchedOff) {
        const sent = POST_PLATFORMS.some(p => current.remoteIds[p]);
        await finish(deps, current, uncertain ? 'needs_review' : sent ? 'failed' : 'approved',
          uncertain ? failures.join(' ') : sent ? SWITCHED_OFF_MESSAGE : null);
        return;
      }
      if (!(err instanceof PlatformFailure)) throw err;
      uncertain ||= err.uncertain;
      const text = err.uncertain
        ? `${name}: no se confirmó si se publicó (${err.message}); verifica en Meta antes de reintentar.`
        : `${name}: no se pudo publicar (${err.message}).`;
      failures.push(text);
      await auditEvent(deps, current, 'social_post_publish', 'error', { phase: err.uncertain ? 'uncertain' : 'error', platform }, `failed=${platform}`, text);
      continue;
    }
    // Persist before anything else can fail: a crash from here on must never lose this success.
    const saved = await deps.store.recordRemoteIds(current, ids);
    if (!saved) throw new Error(`Publisher lost its claim after publishing ${platform}`);
    current = saved;
    await auditEvent(deps, current, 'social_post_publish', 'success', { phase: 'sent', platform, remoteId: ids[platform] }, `sent=${platform}`);
    if (platform === 'instagram') current = await addIgPermalink(deps, current, secrets);
  }

  if (uncertain) await finish(deps, current, 'needs_review', failures.join(' '));
  else if (failures.length > 0) await finish(deps, current, 'failed', failures.join(' '));
  else await finish(deps, current, 'published', null);
}

export async function tick(deps: PublisherDeps, opts: { recoverAll?: boolean } = {}): Promise<boolean> {
  return deps.store.withPublisherLock(async hasLease => {
    await runTick({ ...deps, hasLease }, opts);
  });
}

async function runTick(deps: PublisherDeps, opts: { recoverAll?: boolean }): Promise<void> {
  await recoverInterrupted(deps, { all: opts.recoverAll });
  await markLate(deps);
  if (!deps.isEnabled()) return;

  const pageTokens = new Map<string, Promise<string>>();
  const fetchedTokens: string[] = [];
  const tickDeps: PublisherDeps = {
    ...deps,
    meta: {
      ...deps.meta,
      pageToken: (pageId) => {
        let t = pageTokens.get(pageId);
        if (!t) {
          t = deps.meta.pageToken(pageId);
          t.then(token => fetchedTokens.push(token), () => {});
          pageTokens.set(pageId, t);
        }
        return t;
      },
    },
  };

  for (let i = 0; i < MAX_PER_TICK; i++) {
    const post = await claimNext(tickDeps);
    if (!post) return;
    try {
      await publishOne(tickDeps, post);
    } catch (err) {
      // Unknown state (DB/process failure mid-publish): a human must check Meta. Stop this tick.
      const error = scrub(messageOf(err), fetchedTokens);
      log.error('Publisher stopped on an unexpected error', { postId: post.id, siteId: post.siteId, errorMessage: error });
      recordFailure('publisher', 'meta', error, { pausable: false });
      try {
        await deps.store.finishPublishing(post, 'needs_review', INTERRUPTED_MESSAGE);
      } catch {
        // Left in 'publishing': recoverInterrupted moves it to needs_review after 10 minutes.
      }
      return;
    }
  }
}

function defaultDeps(): PublisherDeps {
  return {
    now: () => Date.now(),
    store: socialPostsStore,
    meta: {
      write: metaWrite,
      pageToken: getPageAccessToken,
      userToken: () => {
        const token = process.env.META_ACCESS_TOKEN;
        if (!token) throw MCPError.authError('Falta META_ACCESS_TOKEN: configúralo en Credenciales');
        return token;
      },
      igStatus: getIgContainerStatus,
      igQuota: getIgPublishingQuota,
      igPermalink: getIgPermalink,
    },
    audit: (entry) => auditLog.append(entry),
    sitesStore,
    isEnabled: isMetaPublishingEnabled,
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

/** Starts the publisher loop: full recovery first, then a tick every interval (never overlapping). */
export function startSocialPublisher(intervalMs = 30_000): () => Promise<void> {
  const deps = defaultDeps();
  let running = false;
  let stopped = false;
  let startup = true;
  let activeRun: Promise<void> = Promise.resolve();
  const enabled = deps.isEnabled;
  deps.isEnabled = () => !stopped && enabled();
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      if (await tick(deps, { recoverAll: startup })) startup = false;
    } catch (err) {
      log.error('Social publisher tick failed', { errorMessage: scrub(messageOf(err), []) });
    } finally {
      running = false;
    }
  };
  activeRun = run();
  const timer = setInterval(() => { if (!running) activeRun = run(); }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await activeRun;
  };
}
