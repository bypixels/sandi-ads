/**
 * Agent runners — one per draft-producing agent. Each runner takes the
 * pre-resolved site + profile + request body, calls the underlying
 * stateless tool, and persists the result as a draft.
 *
 * Dispatched from `routes/drafts.ts` by agentId. To add a new draft-producing
 * agent (Phase 4: reddit; Phase 5: coding):
 *   1. Implement the stateless tool in src/tools/<area>/.
 *   2. Add a runner here.
 *   3. Append to AGENT_RUNNERS.
 *   4. Add the agent to agent-catalog.ts with primaryAction: '<agentId>.run'.
 *
 * The route dispatcher uses the agentId to pick a runner and never needs to
 * know what each agent does internally.
 */

import { sitesStore, type Site } from './sites-store.js';
import { siteProfileRepo, type SiteProfile } from './site-profile.js';
import { draftsRepo, type Draft } from './drafts-store.js';
import { executeToolByName } from './dashboard-data.js';
import type { WriteArticleOutput } from '../../tools/content/writer.js';
import type { XDraftOutput, LinkedInOutput, HNOutput } from '../../tools/social/index.js';
import type { RedditDraftOutput } from '../../tools/reddit/index.js';
import type { ProposeFixOutput } from '../../tools/coding/index.js';
import type { VideoBriefOutput } from '../../tools/video/index.js';
import { signalsRepo } from './gsc-signals.js';
import { snapshotsRepo, isKnownSnapshotKind, type SnapshotKind } from './snapshots.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('agent-runners');

export interface AgentRunContext {
  /** Pre-resolved site row. */
  site: Site;
  /** Pre-resolved profile (may be the default if the site never edited it). */
  profile: SiteProfile | null;
  /** Raw parsed JSON body from the route — runner validates its shape. */
  body: unknown;
}

export interface AgentRunResult {
  draft: Draft;
  /** Small KV the route returns next to `draft` for the UI's success log. */
  summary: Record<string, unknown>;
}

export type AgentRunner = (ctx: AgentRunContext) => Promise<AgentRunResult>;

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

/**
 * Resolve site + profile from a siteId. Returns null when the site doesn't
 * exist (the route turns that into a 404).
 */
export async function resolveSiteContext(siteId: string): Promise<{ site: Site; profile: SiteProfile | null } | null> {
  const site = await sitesStore.get(siteId);
  if (!site) return null;
  const profile = await siteProfileRepo.get(siteId);
  return { site, profile };
}

/**
 * When a runner is given an `articleDraftId`, hydrate it into the
 * tool-friendly `{ title, summary, bodyMarkdown, slug }` shape used by the
 * social drafters. Returns null when the id is missing/invalid — callers
 * decide whether that's an error.
 */
async function loadArticleSource(articleDraftId: string): Promise<{
  title: string;
  summary?: string;
  bodyMarkdown: string;
  slug?: string;
} | null> {
  const draft = await draftsRepo.get(articleDraftId);
  if (!draft || draft.draftType !== 'article') return null;
  const c = (draft.content ?? {}) as {
    title?: string;
    metaDescription?: string;
    bodyMarkdown?: string;
    suggestedSlug?: string;
  };
  if (!c.bodyMarkdown) return null;
  return {
    title: c.title ?? draft.title,
    summary: c.metaDescription,
    bodyMarkdown: c.bodyMarkdown,
    slug: c.suggestedSlug,
  };
}

// ---------------------------------------------------------------------------
// Runner: writer
// ---------------------------------------------------------------------------

interface WriterBody {
  keyword?: string;
  brief?: unknown;
  targetWordCount?: number;
  language?: 'es' | 'en' | 'pt';
  additionalContext?: string;
}

const writerRunner: AgentRunner = async ({ site, profile, body: raw }) => {
  const body = (raw ?? {}) as WriterBody;
  if (!body.keyword && !body.brief) {
    throw new Error('Either `keyword` or `brief` is required.');
  }

  const article = await executeToolByName<WriteArticleOutput>('content_write_article', {
    siteUrl: site.primaryUrl,
    keyword: body.keyword,
    brief: body.brief,
    brandVoice: profile?.brandVoice || undefined,
    niche: profile?.niche || undefined,
    competitors: profile?.competitors,
    targetWordCount: body.targetWordCount,
    language: body.language,
    additionalContext: body.additionalContext,
  });

  const draft = await draftsRepo.create({
    siteId: site.id,
    agentId: 'writer',
    draftType: 'article',
    title: article.title,
    content: {
      title: article.title,
      metaDescription: article.metaDescription,
      suggestedSlug: article.suggestedSlug,
      bodyMarkdown: article.bodyMarkdown,
      outline: article.outline,
      language: article.language,
    },
    sourceRef: body.brief ? { brief: body.brief } : { keyword: body.keyword },
    metadata: {
      wordCount: article.wordCount,
      model: article.model,
      tokensInput: article.tokensInput,
      tokensOutput: article.tokensOutput,
    },
  });

  return {
    draft,
    summary: { wordCount: article.wordCount, model: article.model },
  };
};

// ---------------------------------------------------------------------------
// Runner: social-x
// ---------------------------------------------------------------------------

interface SocialBody {
  topic?: string;
  sourceUrl?: string;
  articleDraftId?: string;
  language?: 'es' | 'en' | 'pt';
  additionalContext?: string;
  /** Platform-specific extras passed through (format / angle / threadContext). */
  format?: 'single' | 'thread' | 'auto';
  angle?: 'story' | 'insight' | 'announcement' | 'how-to';
  threadContext?: string;
}

const socialXRunner: AgentRunner = async ({ site, profile, body: raw }) => {
  const body = (raw ?? {}) as SocialBody;
  const article = body.articleDraftId ? await loadArticleSource(body.articleDraftId) : null;
  if (!body.topic && !body.sourceUrl && !article) {
    throw new Error('Provide one of: `topic`, `sourceUrl`, or `articleDraftId`.');
  }

  const out = await executeToolByName<XDraftOutput>('social_draft_x', {
    siteUrl: site.primaryUrl,
    topic: body.topic,
    sourceUrl: body.sourceUrl,
    article: article ?? undefined,
    format: body.format,
    brandVoice: profile?.brandVoice || undefined,
    niche: profile?.niche || undefined,
    competitors: profile?.competitors,
    language: body.language,
    additionalContext: body.additionalContext,
  });

  const draftType = out.kind === 'thread' ? 'thread' : 'tweet';
  const titlePreview = out.tweets[0]?.slice(0, 80) ?? 'X draft';
  const draft = await draftsRepo.create({
    siteId: site.id,
    agentId: 'social-x',
    draftType,
    title: titlePreview + (out.tweets[0]?.length > 80 ? '…' : ''),
    content: {
      kind: out.kind,
      tweets: out.tweets,
      totalChars: out.totalChars,
      language: out.language,
    },
    sourceRef: article
      ? { articleDraftId: body.articleDraftId }
      : { topic: body.topic, sourceUrl: body.sourceUrl },
    metadata: {
      tweetCount: out.tweets.length,
      totalChars: out.totalChars,
      model: out.model,
      tokensInput: out.tokensInput,
      tokensOutput: out.tokensOutput,
    },
  });

  return {
    draft,
    summary: { kind: out.kind, tweetCount: out.tweets.length, model: out.model },
  };
};

// ---------------------------------------------------------------------------
// Runner: social-linkedin
// ---------------------------------------------------------------------------

const socialLinkedInRunner: AgentRunner = async ({ site, profile, body: raw }) => {
  const body = (raw ?? {}) as SocialBody;
  const article = body.articleDraftId ? await loadArticleSource(body.articleDraftId) : null;
  if (!body.topic && !body.sourceUrl && !article) {
    throw new Error('Provide one of: `topic`, `sourceUrl`, or `articleDraftId`.');
  }

  const out = await executeToolByName<LinkedInOutput>('social_draft_linkedin', {
    siteUrl: site.primaryUrl,
    topic: body.topic,
    sourceUrl: body.sourceUrl,
    article: article ?? undefined,
    angle: body.angle,
    brandVoice: profile?.brandVoice || undefined,
    niche: profile?.niche || undefined,
    competitors: profile?.competitors,
    language: body.language,
    additionalContext: body.additionalContext,
  });

  const titlePreview = out.body.split('\n', 1)[0]?.slice(0, 100) ?? 'LinkedIn draft';
  const draft = await draftsRepo.create({
    siteId: site.id,
    agentId: 'social-linkedin',
    draftType: 'linkedin_post',
    title: titlePreview + (out.body.length > 100 ? '…' : ''),
    content: {
      body: out.body,
      hashtags: out.hashtags,
      charCount: out.charCount,
      language: out.language,
    },
    sourceRef: article
      ? { articleDraftId: body.articleDraftId }
      : { topic: body.topic, sourceUrl: body.sourceUrl },
    metadata: {
      charCount: out.charCount,
      hashtagCount: out.hashtags.length,
      model: out.model,
      tokensInput: out.tokensInput,
      tokensOutput: out.tokensOutput,
    },
  });

  return {
    draft,
    summary: { charCount: out.charCount, hashtags: out.hashtags.length, model: out.model },
  };
};

// ---------------------------------------------------------------------------
// Runner: social-hn
// ---------------------------------------------------------------------------

const socialHnRunner: AgentRunner = async ({ site, profile, body: raw }) => {
  const body = (raw ?? {}) as SocialBody;
  const article = body.articleDraftId ? await loadArticleSource(body.articleDraftId) : null;
  if (!body.topic && !body.sourceUrl && !article && !body.threadContext) {
    throw new Error('Provide one of: `topic`, `sourceUrl`, `articleDraftId`, or `threadContext`.');
  }

  const out = await executeToolByName<HNOutput>('social_draft_hn', {
    siteUrl: site.primaryUrl,
    topic: body.topic,
    sourceUrl: body.sourceUrl,
    threadContext: body.threadContext,
    article: article ?? undefined,
    brandVoice: profile?.brandVoice || undefined,
    niche: profile?.niche || undefined,
    competitors: profile?.competitors,
    language: body.language === 'es' ? 'es' : 'en',
    additionalContext: body.additionalContext,
  });

  const titlePreview = out.body.split('\n', 1)[0]?.slice(0, 100) ?? 'HN comment draft';
  const draft = await draftsRepo.create({
    siteId: site.id,
    agentId: 'social-hn',
    draftType: 'hn_comment',
    title: titlePreview + (out.body.length > 100 ? '…' : ''),
    content: {
      body: out.body,
      charCount: out.charCount,
      language: out.language,
      sensitivityNote: out.sensitivityNote,
    },
    sourceRef: article
      ? { articleDraftId: body.articleDraftId }
      : { topic: body.topic, sourceUrl: body.sourceUrl, threadContext: body.threadContext },
    metadata: {
      charCount: out.charCount,
      model: out.model,
      tokensInput: out.tokensInput,
      tokensOutput: out.tokensOutput,
    },
  });

  return {
    draft,
    summary: { charCount: out.charCount, model: out.model },
  };
};

// ---------------------------------------------------------------------------
// Runner: reddit
// ---------------------------------------------------------------------------

interface RedditBody {
  topic?: string;
  sourceUrl?: string;
  articleDraftId?: string;
  subreddit?: string;
  threadUrl?: string;
  threadContext?: string;
  language?: 'es' | 'en';
  additionalContext?: string;
}

const redditRunner: AgentRunner = async ({ site, profile, body: raw }) => {
  const body = (raw ?? {}) as RedditBody;
  const article = body.articleDraftId ? await loadArticleSource(body.articleDraftId) : null;
  if (!body.topic && !body.sourceUrl && !article && !body.threadContext && !body.threadUrl) {
    throw new Error('Provide one of: `topic`, `sourceUrl`, `articleDraftId`, `threadUrl`, or `threadContext`.');
  }

  const out = await executeToolByName<RedditDraftOutput>('reddit_draft_reply', {
    siteUrl: site.primaryUrl,
    subreddit: body.subreddit,
    threadUrl: body.threadUrl,
    threadContext: body.threadContext,
    topic: body.topic,
    sourceUrl: body.sourceUrl,
    article: article ?? undefined,
    brandVoice: profile?.brandVoice || undefined,
    niche: profile?.niche || undefined,
    competitors: profile?.competitors,
    language: body.language === 'es' ? 'es' : 'en',
    additionalContext: body.additionalContext,
  });

  const titlePreview = out.body.split('\n', 1)[0]?.slice(0, 100) ?? 'Reddit reply draft';
  const draft = await draftsRepo.create({
    siteId: site.id,
    agentId: 'reddit',
    draftType: 'reddit_reply',
    title: titlePreview + (out.body.length > 100 ? '…' : ''),
    content: {
      body: out.body,
      subreddit: out.subreddit,
      threadUrl: out.threadUrl,
      charCount: out.charCount,
      language: out.language,
      sensitivityNote: out.sensitivityNote,
    },
    sourceRef: article
      ? { articleDraftId: body.articleDraftId }
      : {
          topic: body.topic,
          sourceUrl: body.sourceUrl,
          threadUrl: body.threadUrl,
          threadContext: body.threadContext,
          subreddit: body.subreddit,
        },
    metadata: {
      charCount: out.charCount,
      model: out.model,
      tokensInput: out.tokensInput,
      tokensOutput: out.tokensOutput,
    },
  });

  return {
    draft,
    summary: { charCount: out.charCount, model: out.model, subreddit: out.subreddit ?? null },
  };
};

// ---------------------------------------------------------------------------
// Runner: coding
// ---------------------------------------------------------------------------

interface CodingBody {
  /** Free-form description of what's wrong. */
  problem?: string;
  /** Optional: pull signal context by id. Numeric id from gsc_signals. */
  signalId?: number;
  /** Optional: pull snapshot context by kind. Latest of that kind for the site. */
  snapshotKind?: string;
  language?: 'es' | 'en';
  additionalContext?: string;
}

const codingRunner: AgentRunner = async ({ site, profile, body: raw }) => {
  const body = (raw ?? {}) as CodingBody;
  if (!body.problem || body.problem.trim().length < 10) {
    throw new Error('`problem` is required (at least 10 chars).');
  }

  let signalContext: { signalType: string; severity: string; title: string; detail: unknown } | undefined;
  if (typeof body.signalId === 'number') {
    const sig = await signalsRepo.getById(body.signalId);
    if (sig) {
      signalContext = {
        signalType: sig.signalType,
        severity: sig.severity,
        title: sig.title,
        detail: sig.detail,
      };
    }
  }

  let snapshotContext: { kind: string; capturedAt: string; data: unknown } | undefined;
  if (body.snapshotKind && isKnownSnapshotKind(body.snapshotKind)) {
    const snap = await snapshotsRepo.getLatest(site.id, body.snapshotKind as SnapshotKind);
    if (snap) {
      snapshotContext = {
        kind: snap.kind,
        capturedAt: snap.capturedAt,
        data: snap.data,
      };
    }
  }

  const out = await executeToolByName<ProposeFixOutput>('coding_propose_fix', {
    siteUrl: site.primaryUrl,
    problem: body.problem,
    signal: signalContext,
    snapshot: snapshotContext,
    brandVoice: profile?.brandVoice || undefined,
    niche: profile?.niche || undefined,
    language: body.language === 'en' ? 'en' : 'es',
    additionalContext: body.additionalContext,
  });

  const draft = await draftsRepo.create({
    siteId: site.id,
    agentId: 'coding',
    draftType: 'fix_proposal',
    title: out.title,
    content: {
      title: out.title,
      diagnosis: out.diagnosis,
      rootCause: out.rootCause,
      steps: out.steps,
      toolsToInvoke: out.toolsToInvoke,
      riskAssessment: out.riskAssessment,
      verificationSteps: out.verificationSteps,
      escalationCriteria: out.escalationCriteria,
      language: out.language,
    },
    sourceRef: {
      problem: body.problem,
      signalId: body.signalId,
      snapshotKind: body.snapshotKind,
    },
    metadata: {
      stepCount: out.steps.length,
      toolCount: out.toolsToInvoke.length,
      model: out.model,
      tokensInput: out.tokensInput,
      tokensOutput: out.tokensOutput,
    },
  });

  return {
    draft,
    summary: { stepCount: out.steps.length, toolCount: out.toolsToInvoke.length, model: out.model },
  };
};

// ---------------------------------------------------------------------------
// Runner: video
// ---------------------------------------------------------------------------

interface VideoBody {
  topic?: string;
  format?: 'reel' | 'short' | 'square' | 'horizontal';
  durationSec?: number;
  style?: 'conversational' | 'energetic' | 'educational' | 'narrative' | 'product_demo';
  language?: 'es' | 'en' | 'pt';
  additionalContext?: string;
}

const videoRunner: AgentRunner = async ({ site, profile, body: raw }) => {
  const body = (raw ?? {}) as VideoBody;
  if (!body.topic || body.topic.trim().length < 2) {
    throw new Error('`topic` is required.');
  }

  const out = await executeToolByName<VideoBriefOutput>('video_draft_brief', {
    siteUrl: site.primaryUrl,
    topic: body.topic,
    format: body.format,
    durationSec: body.durationSec,
    style: body.style,
    brandVoice: profile?.brandVoice || undefined,
    niche: profile?.niche || undefined,
    competitors: profile?.competitors,
    language: body.language,
    additionalContext: body.additionalContext,
  });

  const draft = await draftsRepo.create({
    siteId: site.id,
    agentId: 'video',
    draftType: 'video_brief',
    title: out.title,
    content: {
      title: out.title,
      topic: out.topic,
      format: out.format,
      aspectRatio: out.aspectRatio,
      durationSec: out.durationSec,
      hookScript: out.hookScript,
      mainScript: out.mainScript,
      ctaScript: out.ctaScript,
      shotList: out.shotList,
      onScreenText: out.onScreenText,
      voiceoverInstructions: out.voiceoverInstructions,
      moodAndStyle: out.moodAndStyle,
      thumbnailIdeas: out.thumbnailIdeas,
      hashtagsForCaption: out.hashtagsForCaption,
      language: out.language,
      // Render state populated post-approval by /api/drafts/:id/render
      render: null,
    },
    sourceRef: {
      topic: body.topic,
      style: body.style,
    },
    metadata: {
      shotCount: out.shotList.length,
      durationSec: out.durationSec,
      format: out.format,
      model: out.model,
      tokensInput: out.tokensInput,
      tokensOutput: out.tokensOutput,
    },
  });

  return {
    draft,
    summary: { shotCount: out.shotList.length, format: out.format, durationSec: out.durationSec, model: out.model },
  };
};

// ---------------------------------------------------------------------------
// Dispatch table — the route reads this and never edits inline.
// ---------------------------------------------------------------------------

export const AGENT_RUNNERS: Record<string, AgentRunner> = {
  writer: writerRunner,
  'social-x': socialXRunner,
  'social-linkedin': socialLinkedInRunner,
  'social-hn': socialHnRunner,
  reddit: redditRunner,
  coding: codingRunner,
  video: videoRunner,
};

/**
 * Run an agent end-to-end. Resolves site + profile, dispatches to the
 * registered runner, and returns the result. Throws if the agentId is
 * unknown or the site doesn't exist.
 */
export async function runAgent(agentId: string, siteId: string, body: unknown): Promise<AgentRunResult> {
  const runner = AGENT_RUNNERS[agentId];
  if (!runner) {
    const err = new Error(`Unknown agent: ${agentId}`);
    (err as Error & { code?: string }).code = 'UNKNOWN_AGENT';
    throw err;
  }
  const ctx = await resolveSiteContext(siteId);
  if (!ctx) {
    const err = new Error('Site not found');
    (err as Error & { code?: string }).code = 'SITE_NOT_FOUND';
    throw err;
  }
  log.info('Running agent', { agentId, siteId });
  return runner({ site: ctx.site, profile: ctx.profile, body });
}
