/**
 * Content briefs — structured input for an LLM to write articles.
 *
 * These tools do NOT generate text. They pull real GSC data (queries,
 * positions, impressions) and return a structured brief. The LLM consumer
 * (Claude over MCP) does the actual drafting. This is the differentiator vs
 * Outrank/Okara: drafts informed by *the user's own search data*, not a
 * generic corpus.
 */

import { z } from 'zod';
import { executeGoogleApi } from '../google/api-wrapper.js';
import { getSearchConsoleClient } from '../google/search-console/clients.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

const log = createServiceLogger('content-briefs');

function defaultRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// ============================================
// content_brief_from_keyword
// ============================================

const briefFromKeywordSchema = z.object({
  siteUrl: z.string().describe('GSC site URL (sc-domain:example.com or https://example.com/)'),
  keyword: z.string().min(2).describe('Target keyword/phrase to build a brief around'),
  startDate: z.string().optional().describe('YYYY-MM-DD (default: 90 days ago)'),
  endDate: z.string().optional().describe('YYYY-MM-DD (default: today)'),
  country: z.string().length(3).optional().describe('ISO 3-letter country code filter (e.g. USA, CRI)'),
});

type BriefFromKeywordInput = z.infer<typeof briefFromKeywordSchema>;

interface RelatedQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface RankingPage {
  page: string;
  clicks: number;
  impressions: number;
  avgPosition: number;
  matchedQueries: number;
}

interface BriefFromKeywordOutput {
  targetKeyword: string;
  dateRange: { startDate: string; endDate: string };
  ownsRankingPage: boolean;
  semanticCluster: RelatedQuery[];
  currentlyRankingPages: RankingPage[];
  recommendation: {
    action: 'create_new' | 'refresh_existing' | 'low_priority';
    reason: string;
    suggestedMinWords: number;
    targetH2Count: number;
  };
}

export const contentBriefFromKeywordTool: ToolDefinition<BriefFromKeywordInput, BriefFromKeywordOutput> = {
  name: 'content_brief_from_keyword',
  description:
    'Builds a structured content brief for a keyword using real GSC data: related query cluster, currently-ranking pages, and refresh-vs-create recommendation. Feed the output to an LLM to draft the article.',
  category: ToolCategory.SEO,
  inputSchema: briefFromKeywordSchema,

  async handler(input): Promise<BriefFromKeywordOutput> {
    const range = {
      startDate: input.startDate ?? defaultRange().startDate,
      endDate: input.endDate ?? defaultRange().endDate,
    };

    log.info('Building brief from keyword', { siteUrl: input.siteUrl, keyword: input.keyword });

    const sc = getSearchConsoleClient();

    const baseFilters: { dimension: string; operator: 'contains' | 'equals'; expression: string }[] = [
      { dimension: 'query', operator: 'contains', expression: input.keyword },
    ];
    if (input.country) {
      baseFilters.push({ dimension: 'country', operator: 'equals', expression: input.country.toLowerCase() });
    }

    const [queryResp, pageResp] = await Promise.all([
      executeGoogleApi('searchConsole', () =>
        sc.searchanalytics.query({
          siteUrl: input.siteUrl,
          requestBody: {
            startDate: range.startDate,
            endDate: range.endDate,
            dimensions: ['query'],
            dimensionFilterGroups: [{ groupType: 'and', filters: baseFilters }],
            rowLimit: 100,
          },
        })
      ),
      executeGoogleApi('searchConsole', () =>
        sc.searchanalytics.query({
          siteUrl: input.siteUrl,
          requestBody: {
            startDate: range.startDate,
            endDate: range.endDate,
            dimensions: ['page', 'query'],
            dimensionFilterGroups: [{ groupType: 'and', filters: baseFilters }],
            rowLimit: 500,
          },
        })
      ),
    ]);

    const semanticCluster: RelatedQuery[] = (queryResp.data.rows ?? []).map((r) => ({
      query: r.keys?.[0] ?? '',
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));

    const pageMap = new Map<string, { clicks: number; impressions: number; positions: number[]; queries: Set<string> }>();
    for (const row of pageResp.data.rows ?? []) {
      const page = row.keys?.[0] ?? '';
      const query = row.keys?.[1] ?? '';
      if (!page) continue;
      const entry = pageMap.get(page) ?? { clicks: 0, impressions: 0, positions: [], queries: new Set<string>() };
      entry.clicks += row.clicks ?? 0;
      entry.impressions += row.impressions ?? 0;
      if (row.position) entry.positions.push(row.position);
      if (query) entry.queries.add(query);
      pageMap.set(page, entry);
    }

    const currentlyRankingPages: RankingPage[] = [...pageMap.entries()]
      .map(([page, e]) => ({
        page,
        clicks: e.clicks,
        impressions: e.impressions,
        avgPosition: e.positions.length ? e.positions.reduce((a, b) => a + b, 0) / e.positions.length : 0,
        matchedQueries: e.queries.size,
      }))
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 15);

    const ownsRankingPage = currentlyRankingPages.some((p) => p.avgPosition > 0 && p.avgPosition <= 20);

    const totalImpressions = semanticCluster.reduce((s, q) => s + q.impressions, 0);
    const avgPosition = semanticCluster.length
      ? semanticCluster.reduce((s, q) => s + q.position, 0) / semanticCluster.length
      : 99;

    let action: BriefFromKeywordOutput['recommendation']['action'];
    let reason: string;
    if (ownsRankingPage && avgPosition <= 20) {
      action = 'refresh_existing';
      reason = `Ya rankeás en posición ${avgPosition.toFixed(1)} promedio — refrescar la página existente es 5-10x más eficiente que crear nueva.`;
    } else if (totalImpressions >= 100) {
      action = 'create_new';
      reason = `${totalImpressions} impresiones acumuladas en cluster — demanda demostrada, vale crear contenido nuevo.`;
    } else {
      action = 'low_priority';
      reason = `Solo ${totalImpressions} impresiones en cluster — demanda baja, priorizá otros keywords primero.`;
    }

    const suggestedMinWords = Math.max(800, Math.min(2500, 600 + semanticCluster.length * 30));
    const targetH2Count = Math.max(3, Math.min(10, Math.ceil(semanticCluster.length / 6)));

    return {
      targetKeyword: input.keyword,
      dateRange: range,
      ownsRankingPage,
      semanticCluster,
      currentlyRankingPages,
      recommendation: { action, reason, suggestedMinWords, targetH2Count },
    };
  },
};

// ============================================
// content_outline_from_url
// ============================================

const outlineFromUrlSchema = z.object({
  siteUrl: z.string().describe('GSC site URL'),
  pageUrl: z.string().url().describe('Specific page URL to analyze'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

type OutlineFromUrlInput = z.infer<typeof outlineFromUrlSchema>;

interface OutlineSection {
  h2: string;
  rationale: string;
  targetQueries: string[];
  combinedImpressions: number;
}

interface OutlineFromUrlOutput {
  pageUrl: string;
  dateRange: { startDate: string; endDate: string };
  totalQueriesFound: number;
  suggestedOutline: {
    suggestedH1: string;
    sections: OutlineSection[];
  };
  underservedQueries: { query: string; impressions: number; position: number }[];
}

export const contentOutlineFromUrlTool: ToolDefinition<OutlineFromUrlInput, OutlineFromUrlOutput> = {
  name: 'content_outline_from_url',
  description:
    'Analyzes which queries an existing or planned page should target (from GSC) and proposes an H1 + H2 outline grouped by query topic. Feed to an LLM to draft sections.',
  category: ToolCategory.SEO,
  inputSchema: outlineFromUrlSchema,

  async handler(input): Promise<OutlineFromUrlOutput> {
    const range = {
      startDate: input.startDate ?? defaultRange().startDate,
      endDate: input.endDate ?? defaultRange().endDate,
    };

    log.info('Building outline from URL', { pageUrl: input.pageUrl });

    const sc = getSearchConsoleClient();
    const resp = await executeGoogleApi('searchConsole', () =>
      sc.searchanalytics.query({
        siteUrl: input.siteUrl,
        requestBody: {
          startDate: range.startDate,
          endDate: range.endDate,
          dimensions: ['query'],
          dimensionFilterGroups: [
            { groupType: 'and', filters: [{ dimension: 'page', operator: 'equals', expression: input.pageUrl }] },
          ],
          rowLimit: 500,
        },
      })
    );

    const queries = (resp.data.rows ?? []).map((r) => ({
      query: r.keys?.[0] ?? '',
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      position: r.position ?? 0,
    }));

    const topQueries = [...queries].sort((a, b) => b.impressions - a.impressions);
    const suggestedH1 = topQueries[0]?.query ?? 'Untitled';

    const groups = new Map<string, { queries: typeof queries; impressions: number }>();
    for (const q of queries) {
      const head = q.query.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
      const g = groups.get(head) ?? { queries: [], impressions: 0 };
      g.queries.push(q);
      g.impressions += q.impressions;
      groups.set(head, g);
    }

    const sections: OutlineSection[] = [...groups.entries()]
      .sort((a, b) => b[1].impressions - a[1].impressions)
      .slice(0, 8)
      .map(([head, g]) => ({
        h2: head.charAt(0).toUpperCase() + head.slice(1),
        rationale: `${g.queries.length} queries en cluster, ${g.impressions} impresiones combinadas`,
        targetQueries: g.queries.slice(0, 5).map((q) => q.query),
        combinedImpressions: g.impressions,
      }));

    const underservedQueries = queries
      .filter((q) => q.impressions >= 10 && q.position > 10 && q.position <= 30)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 20);

    return {
      pageUrl: input.pageUrl,
      dateRange: range,
      totalQueriesFound: queries.length,
      suggestedOutline: { suggestedH1, sections },
      underservedQueries,
    };
  },
};
