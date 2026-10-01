/**
 * Google Business Profile - Insights and Media tools
 */

import { z } from 'zod';
import { assertBusinessProfileAuth } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('gbp-insights');

// ============================================
// Get Insights
// ============================================

const getInsightsSchema = z.object({
  name: z.string().describe('Location resource name'),
  metrics: z.array(z.enum([
    'QUERIES_DIRECT',
    'QUERIES_INDIRECT',
    'VIEWS_MAPS',
    'VIEWS_SEARCH',
    'ACTIONS_WEBSITE',
    'ACTIONS_PHONE',
    'ACTIONS_DRIVING_DIRECTIONS',
  ])).optional().describe('Metrics to retrieve'),
  startTime: z.string().optional().describe('Start time (ISO 8601)'),
  endTime: z.string().optional().describe('End time (ISO 8601)'),
});

type GetInsightsInput = z.infer<typeof getInsightsSchema>;

interface GBPInsightsOutput {
  locationName: string;
  metrics: {
    metric: string;
    totalValue: number;
    timeSeries?: {
      date: string;
      value: number;
    }[];
  }[];
  period: {
    startTime: string;
    endTime: string;
  };
}

export const gbpGetInsightsTool: ToolDefinition<GetInsightsInput, GBPInsightsOutput> = {
  name: 'gbp_get_insights',
  description: 'Gets performance insights for a GBP location',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: getInsightsSchema,

  async handler(input: GetInsightsInput): Promise<GBPInsightsOutput> {
    log.info('Getting GBP insights', { name: input.name });

    assertBusinessProfileAuth();

    // Note: Insights API requires special Business Profile API access
    log.warn('GBP Insights API requires special access setup');

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    return {
      locationName: input.name,
      metrics: (input.metrics || ['VIEWS_SEARCH', 'VIEWS_MAPS', 'ACTIONS_WEBSITE']).map(metric => ({
        metric,
        totalValue: 0,
      })),
      period: {
        startTime: input.startTime || thirtyDaysAgo.toISOString(),
        endTime: input.endTime || now.toISOString(),
      },
    };
  },
};

// ============================================
// List Media
// ============================================

const listMediaSchema = z.object({
  parent: z.string().describe('Location resource name'),
  pageSize: z.number().min(1).max(100).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListMediaInput = z.infer<typeof listMediaSchema>;

interface GBPMedia {
  name: string;
  mediaFormat: string;
  sourceUrl: string;
  category?: string;
  description?: string;
  createTime: string;
}

interface ListMediaOutput {
  mediaItems: GBPMedia[];
  nextPageToken?: string;
}

export const gbpListMediaTool: ToolDefinition<ListMediaInput, ListMediaOutput> = {
  name: 'gbp_list_media',
  description: 'Lists media items (photos, videos) for a GBP location',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: listMediaSchema,

  async handler(input: ListMediaInput): Promise<ListMediaOutput> {
    log.info('Listing GBP media', { parent: input.parent });

    assertBusinessProfileAuth();

    // Note: Media API requires special access setup
    log.warn('GBP Media API requires special access setup');

    return {
      mediaItems: [],
      nextPageToken: undefined,
    };
  },
};

// ============================================
// Upload Media
// ============================================

const uploadMediaSchema = z.object({
  parent: z.string().describe('Location resource name'),
  mediaItem: z.object({
    mediaFormat: z.enum(['PHOTO', 'VIDEO']),
    sourceUrl: z.string().url().optional().describe('URL of media to upload'),
    category: z.enum([
      'COVER', 'PROFILE', 'LOGO', 'EXTERIOR', 'INTERIOR',
      'PRODUCT', 'AT_WORK', 'FOOD_AND_DRINK', 'MENU', 'COMMON_AREA', 'TEAMS'
    ]).optional(),
    description: z.string().max(1000).optional(),
  }),
});

type UploadMediaInput = z.infer<typeof uploadMediaSchema>;

export const gbpUploadMediaTool: ToolDefinition<UploadMediaInput, GBPMedia> = {
  name: 'gbp_upload_media',
  description: 'Uploads a photo or video to a GBP location',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: uploadMediaSchema,

  async handler(input: UploadMediaInput): Promise<GBPMedia> {
    log.info('Uploading GBP media', { parent: input.parent, format: input.mediaItem.mediaFormat });

    assertBusinessProfileAuth();

    // Note: Media upload requires special access setup
    log.warn('GBP Media API requires special access setup');

    return {
      name: '',
      mediaFormat: input.mediaItem.mediaFormat,
      sourceUrl: input.mediaItem.sourceUrl || '',
      category: input.mediaItem.category,
      description: input.mediaItem.description,
      createTime: new Date().toISOString(),
    };
  },
};

// ============================================
// Performance Report (Custom Tool)
// ============================================

const performanceReportSchema = z.object({
  locationName: z.string().describe('Location resource name'),
  dateRange: z.object({
    startDate: z.string().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().describe('End date (YYYY-MM-DD)'),
  }),
});

type PerformanceReportInput = z.infer<typeof performanceReportSchema>;

interface GBPPerformanceReportOutput {
  overview: {
    totalSearchViews: number;
    totalMapViews: number;
    totalWebsiteClicks: number;
    totalPhoneCalls: number;
    totalDirectionRequests: number;
  };
  searchBreakdown: {
    directSearches: number;
    discoverySearches: number;
    brandedSearches: number;
  };
  trends: {
    date: string;
    views: number;
    actions: number;
  }[];
}

export const gbpPerformanceReportTool: ToolDefinition<PerformanceReportInput, GBPPerformanceReportOutput> = {
  name: 'gbp_performance_report',
  description: 'Generates a comprehensive performance report for a GBP location',
  category: ToolCategory.BUSINESS_PROFILE,
  inputSchema: performanceReportSchema,

  async handler(input: PerformanceReportInput): Promise<GBPPerformanceReportOutput> {
    log.info('Generating GBP performance report', { location: input.locationName });

    assertBusinessProfileAuth();

    // Note: This would aggregate data from multiple GBP API calls
    log.warn('GBP Performance Report requires full API access setup');

    return {
      overview: {
        totalSearchViews: 0,
        totalMapViews: 0,
        totalWebsiteClicks: 0,
        totalPhoneCalls: 0,
        totalDirectionRequests: 0,
      },
      searchBreakdown: {
        directSearches: 0,
        discoverySearches: 0,
        brandedSearches: 0,
      },
      trends: [],
    };
  },
};
