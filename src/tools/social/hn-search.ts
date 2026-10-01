/**
 * hn_search_discussions — searches Hacker News (stories + comments) via the
 * Algolia HN Search API. No auth, generous rate limits.
 *
 * Stateless. Pair with `social_draft_hn` (drafter) — search finds the thread,
 * drafter writes the reply.
 *
 * Algolia HN docs: https://hn.algolia.com/api
 */

import { z } from 'zod';
import { httpClient } from '../base.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';
import { MCPError } from '../../types/errors.js';

const log = createServiceLogger('hn-search');

const hnSearchSchema = z.object({
  query: z.string().min(2).max(200).describe('Search query (full-text against title + URL + author + story_text + comment_text)'),
  /** What types of items to return. */
  tags: z.enum(['story', 'comment', 'story,comment', 'show_hn', 'ask_hn']).optional().default('story,comment'),
  /** Sort by relevance (Algolia default) or by date (newest first). */
  sortBy: z.enum(['relevance', 'date']).optional().default('relevance'),
  /** Restrict to results created after this Unix timestamp (seconds). */
  createdAfter: z.number().int().optional().describe('Unix epoch in seconds; matches Algolia\'s numericFilters.'),
  hitsPerPage: z.number().int().min(1).max(100).optional().default(25),
});

type HnSearchInput = z.infer<typeof hnSearchSchema>;

export interface HnHit {
  objectId: string;
  type: 'story' | 'comment' | 'unknown';
  title: string | null;
  url: string | null;
  /** HN item URL (always present; the "url" above is the external link). */
  hnUrl: string;
  author: string | null;
  points: number | null;
  numComments: number | null;
  createdAt: string;
  createdAtUnix: number;
  storyTitle: string | null;
  /** Comment body for comments, story_text for self-stories, otherwise null. */
  text: string | null;
}

export interface HnSearchOutput {
  query: string;
  tags: string;
  sortBy: string;
  count: number;
  hits: HnHit[];
}

interface AlgoliaHit {
  objectID?: string;
  _tags?: string[];
  title?: string | null;
  url?: string | null;
  author?: string;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string;
  created_at_i?: number;
  story_title?: string | null;
  story_id?: number;
  comment_text?: string | null;
  story_text?: string | null;
}

interface AlgoliaResponse {
  hits?: AlgoliaHit[];
  nbHits?: number;
  message?: string;
}

function classify(tags: string[] | undefined): HnHit['type'] {
  if (!tags) return 'unknown';
  if (tags.includes('story')) return 'story';
  if (tags.includes('comment')) return 'comment';
  return 'unknown';
}

export const hnSearchDiscussionsTool: ToolDefinition<HnSearchInput, HnSearchOutput> = {
  name: 'hn_search_discussions',
  description:
    'Searches Hacker News (stories + comments) via Algolia HN Search (no auth). Returns title, URL, points, num_comments, author and the HN item URL. Read-only.',
  category: ToolCategory.SEO,
  inputSchema: hnSearchSchema,

  async handler(input: HnSearchInput): Promise<HnSearchOutput> {
    const endpoint = input.sortBy === 'date'
      ? 'https://hn.algolia.com/api/v1/search_by_date'
      : 'https://hn.algolia.com/api/v1/search';
    const params = new URLSearchParams({
      query: input.query,
      tags: input.tags,
      hitsPerPage: String(input.hitsPerPage),
    });
    if (input.createdAfter) {
      params.set('numericFilters', `created_at_i>${input.createdAfter}`);
    }
    const url = `${endpoint}?${params.toString()}`;

    log.info('Searching HN', { query: input.query, tags: input.tags, sortBy: input.sortBy });

    const response = await httpClient.get(url, { responseType: 'json' });

    if (response.status >= 400) {
      throw MCPError.externalServiceError(
        'hn-algolia',
        `HN Algolia returned ${response.status}: ${typeof response.data === 'string' ? response.data.slice(0, 200) : JSON.stringify(response.data).slice(0, 200)}`,
      );
    }

    const data = response.data as AlgoliaResponse;

    const hits: HnHit[] = (data.hits ?? []).map((h) => {
      const type = classify(h._tags);
      const objectId = h.objectID ?? '';
      const hnUrl = `https://news.ycombinator.com/item?id=${objectId}`;
      const text = type === 'comment' ? h.comment_text ?? null : h.story_text ?? null;
      return {
        objectId,
        type,
        title: h.title ?? h.story_title ?? null,
        url: h.url ?? null,
        hnUrl,
        author: h.author ?? null,
        points: h.points ?? null,
        numComments: h.num_comments ?? null,
        createdAt: h.created_at ?? '',
        createdAtUnix: h.created_at_i ?? 0,
        storyTitle: h.story_title ?? null,
        text: text ? text.replace(/<[^>]+>/g, '').slice(0, 1500) : null,
      };
    });

    return {
      query: input.query,
      tags: input.tags,
      sortBy: input.sortBy,
      count: hits.length,
      hits,
    };
  },
};
