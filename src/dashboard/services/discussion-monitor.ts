/**
 * Discussion Monitor — periodically searches Reddit and HN for threads
 * matching the site's niche + known competitors. Emits `reddit_thread_opportunity`
 * and `hn_discussion_match` signals so the Reddit + HN agents in the Command
 * Center surface them as drafting opportunities.
 *
 * Owned signal kinds:
 *   - reddit_thread_opportunity → 'reddit' agent
 *   - hn_discussion_match       → 'social-hn' agent
 *
 * Default cadence: every 6h. Override with DISCUSSION_MONITOR_INTERVAL_MIN.
 *
 * Skips sites with no niche or competitors (no good query basis). Filters
 * out low-signal threads (score < N, comments < N) so the inbox stays useful.
 */

import { sitesStore, type Site } from './sites-store.js';
import { siteProfileRepo } from './site-profile.js';
import { signalsRepo, type SignalSeverity } from './gsc-signals.js';
import type { SignalKind } from './agent-catalog.js';
import { executeToolByName } from './dashboard-data.js';
import type { RedditSearchOutput, RedditThread } from '../../tools/reddit/index.js';
import type { HnSearchOutput, HnHit } from '../../tools/social/index.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('discussion-monitor');

// Tunables
const REDDIT_MIN_SCORE = parseInt(process.env.DISCUSSION_REDDIT_MIN_SCORE || '5', 10);
const REDDIT_MIN_COMMENTS = parseInt(process.env.DISCUSSION_REDDIT_MIN_COMMENTS || '3', 10);
const HN_MIN_POINTS = parseInt(process.env.DISCUSSION_HN_MIN_POINTS || '5', 10);
const MAX_OPPORTUNITIES_PER_PLATFORM = parseInt(process.env.DISCUSSION_MAX_PER_PLATFORM || '5', 10);



export interface DiscussionMonitorRunResult {
  siteId: string;
  siteName: string;
  ok: boolean;
  redditCount: number;
  hnCount: number;
  emittedTypes: string[];
  resolvedCount: number;
  error?: string;
  checkedTypes?: string[];
  errors?: string[];
}

/**
 * Build search queries from a site's niche + competitors. Niche becomes the
 * primary query; each competitor name adds one more query (capped). Returns
 * unique trimmed strings.
 */
function buildQueries(niche: string | undefined, competitors: Array<{ name: string }>): string[] {
  const queries = new Set<string>();
  if (niche && niche.trim().length >= 3) queries.add(niche.trim());
  for (const c of competitors.slice(0, 4)) {
    if (c.name && c.name.trim().length >= 2) queries.add(c.name.trim());
  }
  return [...queries];
}

function redditSeverity(thread: RedditThread): SignalSeverity {
  if (thread.score >= 50 && thread.numComments >= 20) return 'warn';
  if (thread.score >= 20 || thread.numComments >= 10) return 'low';
  return 'info';
}

function hnSeverity(hit: HnHit): SignalSeverity {
  const pts = hit.points ?? 0;
  const cmts = hit.numComments ?? 0;
  if (pts >= 50 || cmts >= 20) return 'warn';
  if (pts >= 20 || cmts >= 10) return 'low';
  return 'info';
}

export async function runDiscussionMonitorForSite(site: Site): Promise<DiscussionMonitorRunResult> {
  const result: DiscussionMonitorRunResult = {
    siteId: site.id,
    siteName: site.name,
    ok: true,
    redditCount: 0,
    hnCount: 0,
    emittedTypes: [],
    resolvedCount: 0,
  };

  const profile = await siteProfileRepo.get(site.id);
  const queries = buildQueries(profile?.niche, profile?.competitors ?? []);
  if (queries.length === 0) {
    result.ok = false;
    result.error = 'no niche or competitors in site profile — nothing to search';
    return result;
  }

  log.info('Running discussion monitor for site', { siteId: site.id, queries });

  const errors: string[] = [];
  let redditComplete = true;
  let hnComplete = true;

  const redditCandidates: Array<{ q: string; thread: RedditThread }> = [];
  const hnCandidates: Array<{ q: string; hit: HnHit }> = [];

  // Run all queries in parallel across both platforms
  const searches = queries.flatMap((q) => [
    executeToolByName<RedditSearchOutput>('reddit_search_threads', {
      query: q, sort: 'relevance', timeFilter: 'week', limit: 15,
    }).then((out) => {
      if (!Array.isArray(out.threads)) throw new Error('invalid Reddit search response');
      for (const t of out.threads) {
        if (t.isLocked) continue;
        if (t.score < REDDIT_MIN_SCORE && t.numComments < REDDIT_MIN_COMMENTS) continue;
        redditCandidates.push({ q, thread: t });
      }
    }).catch((err) => {
      redditComplete = false;
      errors.push('reddit: ' + String(err));
      log.warn('Reddit search failed for query', { siteId: site.id, q, error: String(err) });
    }),

    executeToolByName<HnSearchOutput>('hn_search_discussions', {
      query: q, tags: 'story,comment', sortBy: 'date',
      createdAfter: Math.floor(Date.now() / 1000) - 7 * 24 * 3600, hitsPerPage: 15,
    }).then((out) => {
      if (!Array.isArray(out.hits)) throw new Error('invalid HN search response');
      for (const h of out.hits) {
        const pts = h.points ?? 0;
        if (pts < HN_MIN_POINTS && (h.numComments ?? 0) < 3) continue;
        hnCandidates.push({ q, hit: h });
      }
    }).catch((err) => {
      hnComplete = false;
      errors.push('hn: ' + String(err));
      log.warn('HN search failed for query', { siteId: site.id, q, error: String(err) });
    }),
  ]);
  await Promise.allSettled(searches);

  // De-dupe by Reddit thread id + HN objectId. Keep the highest-scoring sample per id.
  const seenReddit = new Map<string, { q: string; thread: RedditThread }>();
  for (const c of redditCandidates) {
    const prior = seenReddit.get(c.thread.id);
    if (!prior || c.thread.score > prior.thread.score) seenReddit.set(c.thread.id, c);
  }
  const seenHn = new Map<string, { q: string; hit: HnHit }>();
  for (const c of hnCandidates) {
    const prior = seenHn.get(c.hit.objectId);
    if (!prior || (c.hit.points ?? 0) > (prior.hit.points ?? 0)) seenHn.set(c.hit.objectId, c);
  }

  // Cap to the top N per platform — sort by activity (score + comments).
  const topReddit = [...seenReddit.values()]
    .sort((a, b) => (b.thread.score + b.thread.numComments) - (a.thread.score + a.thread.numComments))
    .slice(0, MAX_OPPORTUNITIES_PER_PLATFORM);
  const topHn = [...seenHn.values()]
    .sort((a, b) => ((b.hit.points ?? 0) + (b.hit.numComments ?? 0)) - ((a.hit.points ?? 0) + (a.hit.numComments ?? 0)))
    .slice(0, MAX_OPPORTUNITIES_PER_PLATFORM);

  result.redditCount = topReddit.length;
  result.hnCount = topHn.length;

  // Emit one summary signal per platform per site — the detail array holds
  // the individual threads. This keeps the inbox sane (1 signal per agent,
  // not 5+). The UI's drill-down enumerates the threads.
  if (topReddit.length > 0) {
    const worstSev = topReddit.reduce<SignalSeverity>(
      (acc, { thread }) => {
        const s = redditSeverity(thread);
        return rank(s) > rank(acc) ? s : acc;
      },
      'info',
    );
    await signalsRepo.upsertOpen({
      siteId: site.id,
      signalType: 'reddit_thread_opportunity' satisfies SignalKind,
      severity: worstSev,
      title: `${topReddit.length} thread(s) en Reddit con discusión activa de tu nicho`,
      detail: {
        threads: topReddit.map(({ q, thread }) => ({
          matchedQuery: q,
          id: thread.id,
          title: thread.title,
          subreddit: thread.subreddit,
          author: thread.author,
          permalink: thread.permalink,
          score: thread.score,
          numComments: thread.numComments,
          createdUtc: thread.createdUtc,
          selftext: thread.selftext.slice(0, 800),
        })),
      },
    });
    result.emittedTypes.push('reddit_thread_opportunity');
  }

  if (topHn.length > 0) {
    const worstSev = topHn.reduce<SignalSeverity>(
      (acc, { hit }) => {
        const s = hnSeverity(hit);
        return rank(s) > rank(acc) ? s : acc;
      },
      'info',
    );
    await signalsRepo.upsertOpen({
      siteId: site.id,
      signalType: 'hn_discussion_match' satisfies SignalKind,
      severity: worstSev,
      title: `${topHn.length} discusión(es) en Hacker News mencionando tu nicho`,
      detail: {
        hits: topHn.map(({ q, hit }) => ({
          matchedQuery: q,
          objectId: hit.objectId,
          type: hit.type,
          title: hit.title,
          url: hit.url,
          hnUrl: hit.hnUrl,
          author: hit.author,
          points: hit.points,
          numComments: hit.numComments,
          createdAt: hit.createdAt,
          storyTitle: hit.storyTitle,
          text: hit.text?.slice(0, 800) ?? null,
        })),
      },
    });
    result.emittedTypes.push('hn_discussion_match');
  }

  const checkedTypes: SignalKind[] = [];
  if (redditComplete) checkedTypes.push('reddit_thread_opportunity');
  if (hnComplete) checkedTypes.push('hn_discussion_match');
  result.checkedTypes = checkedTypes;
  result.errors = errors;
  result.ok = errors.length === 0;
  if (errors.length) result.error = errors.join('; ');
  // An incomplete search is unknown, not evidence that an old opportunity vanished.
  if (checkedTypes.length) {
    result.resolvedCount = await signalsRepo.resolveByTypes(site.id, checkedTypes, result.emittedTypes);
  }

  log.info('Discussion monitor done for site', {
    siteId: site.id,
    reddit: result.redditCount,
    hn: result.hnCount,
    emitted: result.emittedTypes,
    resolved: result.resolvedCount,
  });
  return result;
}

const SEV_RANK: Record<SignalSeverity, number> = { info: 1, low: 2, warn: 3, high: 4, critical: 5 };
function rank(s: SignalSeverity): number { return SEV_RANK[s]; }

export async function runDiscussionMonitorAll(): Promise<DiscussionMonitorRunResult[]> {
  const all = await sitesStore.list();
  // Eligibility: site has either niche or competitors in profile. Without
  // those, search queries would be too noisy to be useful.
  const eligible: Site[] = [];
  for (const s of all) {
    const profile = await siteProfileRepo.get(s.id);
    const hasNiche = !!(profile?.niche && profile.niche.trim().length >= 3);
    const hasCompetitors = !!(profile?.competitors && profile.competitors.length > 0);
    if (hasNiche || hasCompetitors) eligible.push(s);
  }
  if (eligible.length === 0) {
    log.info('No sites with niche or competitors — skipping discussion monitor run');
    return [];
  }
  log.info('Running discussion monitor for all eligible sites', { count: eligible.length });
  const results: DiscussionMonitorRunResult[] = [];
  for (const site of eligible) {
    try {
      results.push(await runDiscussionMonitorForSite(site));
    } catch (err) {
      results.push({
        siteId: site.id,
        siteName: site.name,
        ok: false,
        redditCount: 0,
        hnCount: 0,
        emittedTypes: [],
        resolvedCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ── Scheduler ─────────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let initialHandle: ReturnType<typeof setTimeout> | null = null;
let scheduledRunActive = false;

async function runScheduledMonitor(): Promise<void> {
  if (scheduledRunActive) return;
  scheduledRunActive = true;
  try {
    await runDiscussionMonitorAll();
  } catch (err) {
    log.error('Scheduled discussion monitor run failed', { error: err instanceof Error ? err : new Error(String(err)) });
  } finally {
    scheduledRunActive = false;
  }
}

export function startDiscussionMonitorScheduler(): void {
  if (process.env.DISCUSSION_MONITOR_DISABLED === 'true') {
    log.info('Discussion monitor disabled via env');
    return;
  }
  if (intervalHandle) return;

  const intervalMin = parseInt(process.env.DISCUSSION_MONITOR_INTERVAL_MIN || '360', 10); // 6h
  const initialDelayMs = parseInt(process.env.DISCUSSION_MONITOR_INITIAL_DELAY_MS || '25000', 10); // 25s

  log.info('Discussion monitor scheduler started', { intervalMin, initialDelayMs });

  initialHandle = setTimeout(() => {
    initialHandle = null;
    void runScheduledMonitor();
  }, initialDelayMs);

  intervalHandle = setInterval(() => {
    void runScheduledMonitor();
  }, intervalMin * 60 * 1000);
}

export function stopDiscussionMonitorScheduler(): void {
  if (initialHandle) {
    clearTimeout(initialHandle);
    initialHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('Discussion monitor scheduler stopped');
  }
}
