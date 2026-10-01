/**
 * Google Analytics 4 - Reports tools
 */

import { z } from 'zod';
import { getAnalyticsDataClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import type { GA4DateRange, GA4FilterExpression, GA4OrderBy } from '../../../types/google.js';
// Note: GA4Dimension and GA4Metric types are defined locally via zod schemas

const log = createServiceLogger('ga4-reports');

// ============================================
// Shared Schemas
// ============================================

const dateRangeSchema = z.object({
  startDate: z.string().describe('Start date (YYYY-MM-DD, today, yesterday, NdaysAgo)'),
  endDate: z.string().describe('End date (YYYY-MM-DD, today, yesterday, NdaysAgo)'),
  name: z.string().optional().describe('Name for this date range'),
});

const dimensionSchema = z.object({
  name: z.string().describe('Dimension name (e.g., city, deviceCategory, pagePath)'),
});

const metricSchema = z.object({
  name: z.string().describe('Metric name (e.g., activeUsers, sessions, screenPageViews)'),
});

const orderBySchema = z.object({
  dimension: z.object({
    dimensionName: z.string(),
    orderType: z.enum(['ALPHANUMERIC', 'CASE_INSENSITIVE_ALPHANUMERIC', 'NUMERIC']).optional(),
  }).optional(),
  metric: z.object({
    metricName: z.string(),
  }).optional(),
  desc: z.boolean().optional(),
});

// ============================================
// Run Report
// ============================================

const runReportSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  dateRanges: z.array(dateRangeSchema).min(1).max(4).describe('Date ranges to query (1-4)'),
  dimensions: z.array(dimensionSchema).optional().describe('Dimensions to include'),
  metrics: z.array(metricSchema).min(1).describe('Metrics to include'),
  dimensionFilter: z.any().optional().describe('Filter expression for dimensions'),
  metricFilter: z.any().optional().describe('Filter expression for metrics'),
  orderBys: z.array(orderBySchema).optional().describe('Ordering of results'),
  limit: z.number().min(1).max(100000).optional().describe('Maximum rows to return'),
  offset: z.number().min(0).optional().describe('Row offset for pagination'),
  keepEmptyRows: z.boolean().optional().describe('Include rows with all zero metrics'),
});

type RunReportInput = z.infer<typeof runReportSchema>;

interface ReportRow {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
}

interface RunReportOutput {
  dimensionHeaders: { name: string }[];
  metricHeaders: { name: string; type: string }[];
  rows: ReportRow[];
  rowCount: number;
  metadata: {
    currencyCode: string;
    timeZone: string;
  };
}

export const ga4RunReportTool: ToolDefinition<RunReportInput, RunReportOutput> = {
  name: 'ga4_run_report',
  description: 'Runs a custom report query against GA4 data',
  category: ToolCategory.GOOGLE,
  inputSchema: runReportSchema,

  async handler(input: RunReportInput): Promise<RunReportOutput> {
    log.info('Running GA4 report', {
      propertyId: input.propertyId,
      dimensions: input.dimensions?.length,
      metrics: input.metrics.length,
    });

    const analyticsData = await getAnalyticsDataClient();
    const property = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    const response = await analyticsData.properties.runReport({
      property,
      requestBody: {
        dateRanges: input.dateRanges,
        dimensions: input.dimensions,
        metrics: input.metrics,
        dimensionFilter: input.dimensionFilter as GA4FilterExpression,
        metricFilter: input.metricFilter as GA4FilterExpression,
        orderBys: input.orderBys as GA4OrderBy[],
        limit: input.limit ? String(input.limit) : undefined,
        offset: input.offset ? String(input.offset) : undefined,
        keepEmptyRows: input.keepEmptyRows,
      },
    });

    const data = response.data;

    const rows: ReportRow[] = (data.rows || []).map((row) => ({
      dimensionValues: (row.dimensionValues || []).map((d) => ({ value: d.value || '' })),
      metricValues: (row.metricValues || []).map((m) => ({ value: m.value || '' })),
    }));

    log.info('GA4 report completed', { rowCount: rows.length });

    return {
      dimensionHeaders: (data.dimensionHeaders || []).map((h) => ({ name: h.name || '' })),
      metricHeaders: (data.metricHeaders || []).map((h) => ({
        name: h.name || '',
        type: h.type || '',
      })),
      rows,
      rowCount: data.rowCount ? Number(data.rowCount) : rows.length,
      metadata: {
        currencyCode: data.metadata?.currencyCode || '',
        timeZone: data.metadata?.timeZone || '',
      },
    };
  },
};

// ============================================
// Run Realtime Report
// ============================================

const runRealtimeReportSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  dimensions: z.array(dimensionSchema).optional().describe('Dimensions to include'),
  metrics: z.array(metricSchema).min(1).describe('Metrics to include'),
  dimensionFilter: z.any().optional().describe('Filter expression for dimensions'),
  metricFilter: z.any().optional().describe('Filter expression for metrics'),
  limit: z.number().min(1).max(100000).optional().describe('Maximum rows to return'),
});

type RunRealtimeReportInput = z.infer<typeof runRealtimeReportSchema>;

export const ga4RunRealtimeReportTool: ToolDefinition<RunRealtimeReportInput, RunReportOutput> = {
  name: 'ga4_run_realtime_report',
  description: 'Gets real-time data from GA4 (last 30 minutes)',
  category: ToolCategory.GOOGLE,
  inputSchema: runRealtimeReportSchema,

  async handler(input: RunRealtimeReportInput): Promise<RunReportOutput> {
    log.info('Running GA4 realtime report', { propertyId: input.propertyId });

    const analyticsData = await getAnalyticsDataClient();
    const property = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    const response = await analyticsData.properties.runRealtimeReport({
      property,
      requestBody: {
        dimensions: input.dimensions,
        metrics: input.metrics,
        dimensionFilter: input.dimensionFilter as GA4FilterExpression,
        metricFilter: input.metricFilter as GA4FilterExpression,
        limit: input.limit ? String(input.limit) : undefined,
      },
    });

    const data = response.data;

    const rows: ReportRow[] = (data.rows || []).map((row) => ({
      dimensionValues: (row.dimensionValues || []).map((d) => ({ value: d.value || '' })),
      metricValues: (row.metricValues || []).map((m) => ({ value: m.value || '' })),
    }));

    log.info('GA4 realtime report completed', { rowCount: rows.length });

    return {
      dimensionHeaders: (data.dimensionHeaders || []).map((h) => ({ name: h.name || '' })),
      metricHeaders: (data.metricHeaders || []).map((h) => ({
        name: h.name || '',
        type: h.type || '',
      })),
      rows,
      rowCount: data.rowCount ? Number(data.rowCount) : rows.length,
      metadata: {
        currencyCode: '',
        timeZone: '',
      },
    };
  },
};

// ============================================
// Traffic Overview (Custom Tool)
// ============================================

const trafficOverviewSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  dateRange: z.object({
    startDate: z.string().describe('Start date'),
    endDate: z.string().describe('End date'),
  }),
  compareTo: z.enum(['previousPeriod', 'previousYear']).optional().describe('Comparison period'),
});

type TrafficOverviewInput = z.infer<typeof trafficOverviewSchema>;

interface TrafficOverviewOutput {
  summary: {
    users: number;
    newUsers: number;
    sessions: number;
    bounceRate: number;
    avgSessionDuration: number;
    pageviews: number;
  };
  comparison?: {
    usersChange: number;
    newUsersChange: number;
    sessionsChange: number;
    bounceRateChange: number;
    avgSessionDurationChange: number;
    pageviewsChange: number;
  };
  topSources: { source: string; users: number; sessions: number }[];
  topPages: { page: string; views: number; avgTimeOnPage: number }[];
  deviceBreakdown: { device: string; users: number; percentage: number }[];
  geoBreakdown: { country: string; users: number; percentage: number }[];
}

export const ga4TrafficOverviewTool: ToolDefinition<TrafficOverviewInput, TrafficOverviewOutput> = {
  name: 'ga4_traffic_overview',
  description: 'Gets a comprehensive traffic overview including sources, pages, devices, and geography',
  category: ToolCategory.GOOGLE,
  inputSchema: trafficOverviewSchema,

  async handler(input: TrafficOverviewInput): Promise<TrafficOverviewOutput> {
    log.info('Getting GA4 traffic overview', { propertyId: input.propertyId });

    const analyticsData = await getAnalyticsDataClient();
    const property = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    // Build date ranges
    const dateRanges: GA4DateRange[] = [input.dateRange];

    if (input.compareTo) {
      // Calculate comparison date range
      const start = new Date(input.dateRange.startDate);
      const end = new Date(input.dateRange.endDate);
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

      let comparisonStart: Date;
      let comparisonEnd: Date;

      if (input.compareTo === 'previousPeriod') {
        comparisonEnd = new Date(start);
        comparisonEnd.setDate(comparisonEnd.getDate() - 1);
        comparisonStart = new Date(comparisonEnd);
        comparisonStart.setDate(comparisonStart.getDate() - daysDiff);
      } else {
        comparisonStart = new Date(start);
        comparisonStart.setFullYear(comparisonStart.getFullYear() - 1);
        comparisonEnd = new Date(end);
        comparisonEnd.setFullYear(comparisonEnd.getFullYear() - 1);
      }

      dateRanges.push({
        startDate: comparisonStart.toISOString().split('T')[0],
        endDate: comparisonEnd.toISOString().split('T')[0],
        name: 'comparison',
      });
    }

    // Run multiple reports in parallel
    const [summaryReport, sourcesReport, pagesReport, devicesReport, geoReport] = await Promise.all([
      // Summary metrics
      analyticsData.properties.runReport({
        property,
        requestBody: {
          dateRanges,
          metrics: [
            { name: 'totalUsers' },
            { name: 'newUsers' },
            { name: 'sessions' },
            { name: 'bounceRate' },
            { name: 'averageSessionDuration' },
            { name: 'screenPageViews' },
          ],
        },
      }),
      // Top sources
      analyticsData.properties.runReport({
        property,
        requestBody: {
          dateRanges: [input.dateRange],
          dimensions: [{ name: 'sessionSource' }],
          metrics: [{ name: 'totalUsers' }, { name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
          limit: '10',
        },
      }),
      // Top pages
      analyticsData.properties.runReport({
        property,
        requestBody: {
          dateRanges: [input.dateRange],
          dimensions: [{ name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }, { name: 'averageSessionDuration' }],
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: '10',
        },
      }),
      // Device breakdown
      analyticsData.properties.runReport({
        property,
        requestBody: {
          dateRanges: [input.dateRange],
          dimensions: [{ name: 'deviceCategory' }],
          metrics: [{ name: 'totalUsers' }],
        },
      }),
      // Geographic breakdown
      analyticsData.properties.runReport({
        property,
        requestBody: {
          dateRanges: [input.dateRange],
          dimensions: [{ name: 'country' }],
          metrics: [{ name: 'totalUsers' }],
          orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }],
          limit: '10',
        },
      }),
    ]);

    // Parse summary
    const summaryRow = summaryReport.data.rows?.[0];
    const summaryMetrics = summaryRow?.metricValues || [];
    const summary = {
      users: Number(summaryMetrics[0]?.value || 0),
      newUsers: Number(summaryMetrics[1]?.value || 0),
      sessions: Number(summaryMetrics[2]?.value || 0),
      bounceRate: Number(summaryMetrics[3]?.value || 0),
      avgSessionDuration: Number(summaryMetrics[4]?.value || 0),
      pageviews: Number(summaryMetrics[5]?.value || 0),
    };

    // Parse comparison if available
    let comparison: TrafficOverviewOutput['comparison'];
    if (summaryReport.data.rows && summaryReport.data.rows.length > 1) {
      const compRow = summaryReport.data.rows[1];
      const compMetrics = compRow?.metricValues || [];

      const calcChange = (current: number, previous: number) =>
        previous === 0 ? 0 : ((current - previous) / previous) * 100;

      comparison = {
        usersChange: calcChange(summary.users, Number(compMetrics[0]?.value || 0)),
        newUsersChange: calcChange(summary.newUsers, Number(compMetrics[1]?.value || 0)),
        sessionsChange: calcChange(summary.sessions, Number(compMetrics[2]?.value || 0)),
        bounceRateChange: calcChange(summary.bounceRate, Number(compMetrics[3]?.value || 0)),
        avgSessionDurationChange: calcChange(summary.avgSessionDuration, Number(compMetrics[4]?.value || 0)),
        pageviewsChange: calcChange(summary.pageviews, Number(compMetrics[5]?.value || 0)),
      };
    }

    // Parse top sources
    const topSources = (sourcesReport.data.rows || []).map((row) => ({
      source: row.dimensionValues?.[0]?.value || '',
      users: Number(row.metricValues?.[0]?.value || 0),
      sessions: Number(row.metricValues?.[1]?.value || 0),
    }));

    // Parse top pages
    const topPages = (pagesReport.data.rows || []).map((row) => ({
      page: row.dimensionValues?.[0]?.value || '',
      views: Number(row.metricValues?.[0]?.value || 0),
      avgTimeOnPage: Number(row.metricValues?.[1]?.value || 0),
    }));

    // Parse device breakdown
    const totalDeviceUsers = (devicesReport.data.rows || []).reduce(
      (sum, row) => sum + Number(row.metricValues?.[0]?.value || 0),
      0
    );
    const deviceBreakdown = (devicesReport.data.rows || []).map((row) => {
      const users = Number(row.metricValues?.[0]?.value || 0);
      return {
        device: row.dimensionValues?.[0]?.value || '',
        users,
        percentage: totalDeviceUsers > 0 ? (users / totalDeviceUsers) * 100 : 0,
      };
    });

    // Parse geo breakdown
    const totalGeoUsers = (geoReport.data.rows || []).reduce(
      (sum, row) => sum + Number(row.metricValues?.[0]?.value || 0),
      0
    );
    const geoBreakdown = (geoReport.data.rows || []).map((row) => {
      const users = Number(row.metricValues?.[0]?.value || 0);
      return {
        country: row.dimensionValues?.[0]?.value || '',
        users,
        percentage: totalGeoUsers > 0 ? (users / totalGeoUsers) * 100 : 0,
      };
    });

    log.info('GA4 traffic overview completed');

    return {
      summary,
      comparison,
      topSources,
      topPages,
      deviceBreakdown,
      geoBreakdown,
    };
  },
};
