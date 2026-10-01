/**
 * reddit_search_threads — searches Reddit's public JSON API for threads
 * matching a query. No OAuth needed for read-only search.
 *
 * Stateless: the discussion-monitor calls this with niche + competitor names;
 * the dashboard exposes the same tool so the user can search ad-hoc.
 *
 * Reddit politely asks for a custom User-Agent — httpClient sends one, but
 * we also add a `Reddit-Search-Tool` suffix so abuse is traceable to our app.
 */

import { z } from 'zod';
import { httpClient } from '../base.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';
import { MCPError } from '../../types/errors.js';

const log = createServiceLogger('reddit-search');

const redditSearchSchema = z.object({
  query: z.string().min(2).max(200).describe('Search query (matched against title + selftext)'),
  subreddit: z.string().max(80).optional().describe('Scope to a subreddit (without r/). Omit for all of Reddit.'),
  sort: z.enum(['new', 'relevance', 'top', 'hot', 'comments']).optional().default('relevance'),
  timeFilter: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).optional().default('week'),
  limit: z.number().int().min(1).max(100).optional().default(25),
});

type RedditSearchInput = z.infer<typeof redditSearchSchema>;

export interface RedditThread {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  url: string;
  permalink: string;
  score: number;
  numComments: number;
  createdUtc: number;
  selftext: string;
  /** True when the post is a self-post (text), false when it's a link. */
  isSelf: boolean;
  /** True when the post is locked / archived (you can't reply). */
  isLocked: boolean;
}

export interface RedditSearchOutput {
  query: string;
  subreddit: string | null;
  sort: string;
  timeFilter: string;
  count: number;
  threads: RedditThread[];
}

interface RedditApiChild {
  data?: {
    id?: string;
    title?: string;
    subreddit?: string;
    author?: string;
    url?: string;
    permalink?: string;
    score?: number;
    num_comments?: number;
    created_utc?: number;
    selftext?: string;
    is_self?: boolean;
    locked?: boolean;
    archived?: boolean;
  };
}

interface RedditApiResponse {
  data?: { children?: RedditApiChild[] };
  error?: number;
  message?: string;
}

export const redditSearchThreadsTool: ToolDefinition<RedditSearchInput, RedditSearchOutput> = {
  name: 'reddit_search_threads',
  description:
    'Searches Reddit for threads matching a query (no OAuth). Returns title, subreddit, score, num_comments, created_utc, selftext, and the permalink to reply on. Read-only.',
  category: ToolCategory.SEO,
  inputSchema: redditSearchSchema,

  async handler(input: RedditSearchInput): Promise<RedditSearchOutput> {
    const sub = input.subreddit?.replace(/^r\//, '').trim();
    const base = sub
      ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json`
      : 'https://www.reddit.com/search.json';
    const params = new URLSearchParams({
      q: input.query,
      sort: input.sort,
      t: input.timeFilter,
      limit: String(input.limit),
      restrict_sr: sub ? 'true' : 'false',
    });
    const url = `${base}?${params.toString()}`;

    log.info('Searching Reddit', { query: input.query, subreddit: sub ?? null, sort: input.sort });

    const response = await httpClient.get(url, {
      headers: {
        // Reddit asks for a descriptive UA; spoofing a browser gets you 429s.
        'User-Agent': 'website-ops-mcp/0.1 (https://github.com/bypixels) discussion-finder',
      },
      responseType: 'json',
    });

    if (response.status === 429) {
      throw MCPError.rateLimitError('reddit', 60);
    }
    if (response.status >= 400) {
      throw MCPError.externalServiceError(
        'reddit',
        `Reddit search returned ${response.status}: ${typeof response.data === 'string' ? response.data.slice(0, 200) : JSON.stringify(response.data).slice(0, 200)}`,
      );
    }

    const data = response.data as RedditApiResponse;
    if (data.error) {
      throw MCPError.externalServiceError('reddit', `Reddit error ${data.error}: ${data.message ?? 'unknown'}`);
    }

    const threads: RedditThread[] = (data.data?.children ?? []).map((child) => {
      const d = child.data ?? {};
      return {
        id: d.id ?? '',
        title: d.title ?? '',
        subreddit: d.subreddit ?? '',
        author: d.author ?? '',
        url: d.url ?? '',
        permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
        score: d.score ?? 0,
        numComments: d.num_comments ?? 0,
        createdUtc: d.created_utc ?? 0,
        selftext: (d.selftext ?? '').slice(0, 2000),
        isSelf: d.is_self === true,
        isLocked: d.locked === true || d.archived === true,
      };
    });

    return {
      query: input.query,
      subreddit: sub ?? null,
      sort: input.sort,
      timeFilter: input.timeFilter,
      count: threads.length,
      threads,
    };
  },
};
