/**
 * Google Search Console - Performance tools
 */

import { z } from 'zod';
import { getSearchConsoleClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GSCPerformanceRow } from '../../../types/google.js';

const log = createServiceLogger('gsc-performance');

// ============================================
// Query Performance
// ============================================

const queryPerformanceSchema = z.object({
  siteUrl: z.string().describe('Site URL (e.g., https://example.com/ or sc-domain:example.com)'),
  startDate: z.string().describe('Start date in YYYY-MM-DD format'),
  endDate: z.string().describe('End date in YYYY-MM-DD format'),
  dimensions: z.array(z.enum(['query', 'page', 'country', 'device', 'searchAppearance', 'date']))
    .optional()
    .describe('Dimensions to group by'),
  dimensionFilterGroups: z.array(z.object({
    groupType: z.literal('and').optional(),
    filters: z.array(z.object({
      dimension: z.string(),
      operator: z.enum(['equals', 'contains', 'notContains', 'includingRegex', 'excludingRegex']),
      expression: z.string(),
    })),
  })).optional().describe('Filters to apply'),
  aggregationType: z.enum(['auto', 'byProperty', 'byPage']).optional().describe('Aggregation type'),
  rowLimit: z.number().min(1).max(25000).optional().describe('Maximum rows to return (default 1000)'),
  startRow: z.number().min(0).optional().describe('Starting row for pagination'),
  dataState: z.enum(['all', 'final']).optional().describe('Data freshness'),
  type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional()
    .describe('Search type'),
});

type QueryPerformanceInput = z.infer<typeof queryPerformanceSchema>;

interface QueryPerformanceOutput {
  rows: GSCPerformanceRow[];
  responseAggregationType: string;
}

export const gscQueryPerformanceTool: ToolDefinition<QueryPerformanceInput, QueryPerformanceOutput> = {
  name: 'gsc_query_performance',
  description: 'Queries search performance data from Google Search Console',
  category: ToolCategory.GOOGLE,
  inputSchema: queryPerformanceSchema,

  async handler(input: QueryPerformanceInput): Promise<QueryPerformanceOutput> {
    log.info('Querying Search Console performance', {
      siteUrl: input.siteUrl,
      startDate: input.startDate,
      endDate: input.endDate,
      dimensions: input.dimensions,
    });

    const searchConsole = await getSearchConsoleClient();

    const response = await searchConsole.searchanalytics.query({
      siteUrl: input.siteUrl,
      requestBody: {
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: input.dimensions,
        dimensionFilterGroups: input.dimensionFilterGroups,
        aggregationType: input.aggregationType,
        rowLimit: input.rowLimit,
        startRow: input.startRow,
        dataState: input.dataState,
        type: input.type,
      },
    });

    const rows: GSCPerformanceRow[] = (response.data.rows || []).map((row) => ({
      keys: row.keys || [],
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || 0,
      position: row.position || 0,
    }));

    log.info('Search Console query completed', { rowCount: rows.length });

    return {
      rows,
      responseAggregationType: response.data.responseAggregationType || '',
    };
  },
};

// ============================================
// Top Queries (Custom Tool)
// ============================================

const topQueriesSchema = z.object({
  siteUrl: z.string().describe('Site URL'),
  dateRange: z.object({
    startDate: z.string().describe('Start date'),
    endDate: z.string().describe('End date'),
  }),
  limit: z.number().min(1).max(1000).optional().describe('Number of queries to return (default 50)'),
  filters: z.object({
    page: z.string().optional().describe('Filter by page URL'),
    country: z.string().optional().describe('Filter by country code'),
    device: z.enum(['MOBILE', 'DESKTOP', 'TABLET']).optional().describe('Filter by device'),
  }).optional(),
});

type TopQueriesInput = z.infer<typeof topQueriesSchema>;

interface TopQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface TopQueriesOutput {
  queries: TopQuery[];
  summary: {
    totalClicks: number;
    totalImpressions: number;
    avgCtr: number;
    avgPosition: number;
  };
}

export const gscTopQueriesTool: ToolDefinition<TopQueriesInput, TopQueriesOutput> = {
  name: 'gsc_top_queries',
  description: 'Gets top search queries for a site with summary statistics',
  category: ToolCategory.GOOGLE,
  inputSchema: topQueriesSchema,

  async handler(input: TopQueriesInput): Promise<TopQueriesOutput> {
    log.info('Getting top queries', { siteUrl: input.siteUrl });

    const searchConsole = await getSearchConsoleClient();

    // Build filters
    const dimensionFilterGroups: Array<{
      groupType?: 'and';
      filters: Array<{
        dimension: string;
        operator: 'equals' | 'contains';
        expression: string;
      }>;
    }> = [];

    if (input.filters) {
      const filters: Array<{
        dimension: string;
        operator: 'equals' | 'contains';
        expression: string;
      }> = [];

      if (input.filters.page) {
        filters.push({
          dimension: 'page',
          operator: 'contains',
          expression: input.filters.page,
        });
      }
      if (input.filters.country) {
        filters.push({
          dimension: 'country',
          operator: 'equals',
          expression: input.filters.country,
        });
      }
      if (input.filters.device) {
        filters.push({
          dimension: 'device',
          operator: 'equals',
          expression: input.filters.device,
        });
      }

      if (filters.length > 0) {
        dimensionFilterGroups.push({ groupType: 'and', filters });
      }
    }

    const response = await searchConsole.searchanalytics.query({
      siteUrl: input.siteUrl,
      requestBody: {
        startDate: input.dateRange.startDate,
        endDate: input.dateRange.endDate,
        dimensions: ['query'],
        dimensionFilterGroups: dimensionFilterGroups.length > 0 ? dimensionFilterGroups : undefined,
        rowLimit: input.limit || 50,
      },
    });

    const queries: TopQuery[] = (response.data.rows || []).map((row) => ({
      query: row.keys?.[0] || '',
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || 0,
      position: row.position || 0,
    }));

    // Calculate summary
    const totalClicks = queries.reduce((sum, q) => sum + q.clicks, 0);
    const totalImpressions = queries.reduce((sum, q) => sum + q.impressions, 0);
    const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    const avgPosition = queries.length > 0
      ? queries.reduce((sum, q) => sum + q.position, 0) / queries.length
      : 0;

    log.info('Top queries retrieved', { count: queries.length });

    return {
      queries,
      summary: {
        totalClicks,
        totalImpressions,
        avgCtr,
        avgPosition,
      },
    };
  },
};

// ============================================
// Top Pages (Custom Tool)
// ============================================

const topPagesSchema = z.object({
  siteUrl: z.string().describe('Site URL'),
  dateRange: z.object({
    startDate: z.string().describe('Start date'),
    endDate: z.string().describe('End date'),
  }),
  limit: z.number().min(1).max(1000).optional().describe('Number of pages to return (default 50)'),
});

type TopPagesInput = z.infer<typeof topPagesSchema>;

interface TopPage {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface TopPagesOutput {
  pages: TopPage[];
}

export const gscTopPagesTool: ToolDefinition<TopPagesInput, TopPagesOutput> = {
  name: 'gsc_top_pages',
  description: 'Gets top performing pages for a site',
  category: ToolCategory.GOOGLE,
  inputSchema: topPagesSchema,

  async handler(input: TopPagesInput): Promise<TopPagesOutput> {
    log.info('Getting top pages', { siteUrl: input.siteUrl });

    const searchConsole = await getSearchConsoleClient();

    const response = await searchConsole.searchanalytics.query({
      siteUrl: input.siteUrl,
      requestBody: {
        startDate: input.dateRange.startDate,
        endDate: input.dateRange.endDate,
        dimensions: ['page'],
        rowLimit: input.limit || 50,
      },
    });

    const pages: TopPage[] = (response.data.rows || []).map((row) => ({
      page: row.keys?.[0] || '',
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || 0,
      position: row.position || 0,
    }));

    log.info('Top pages retrieved', { count: pages.length });

    return { pages };
  },
};
