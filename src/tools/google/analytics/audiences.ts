/**
 * Google Analytics 4 - Audiences and Funnel tools
 */

import { z } from 'zod';
import { getAnalyticsAdminAlphaClient, getAnalyticsDataClient } from './clients.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';

const log = createServiceLogger('ga4-audiences');

// ============================================
// List Audiences
// ============================================

const listAudiencesSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  pageSize: z.number().min(1).max(200).optional().describe('Maximum results per page'),
  pageToken: z.string().optional().describe('Page token for pagination'),
});

type ListAudiencesInput = z.infer<typeof listAudiencesSchema>;

interface GA4Audience {
  name: string;
  displayName: string;
  description: string;
  membershipDurationDays: number;
  adsPersonalizationEnabled: boolean;
  createTime: string;
}

interface ListAudiencesOutput {
  audiences: GA4Audience[];
  nextPageToken?: string;
}

export const ga4ListAudiencesTool: ToolDefinition<ListAudiencesInput, ListAudiencesOutput> = {
  name: 'ga4_list_audiences',
  description: 'Lists configured audiences for a GA4 property',
  category: ToolCategory.GOOGLE,
  inputSchema: listAudiencesSchema,

  async handler(input: ListAudiencesInput): Promise<ListAudiencesOutput> {
    log.info('Listing GA4 audiences', { propertyId: input.propertyId });

    const parent = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    // Audiences only exist in v1alpha. Cast through unknown because the
    // googleapis types for v1alpha may not surface every field we use.
    const alphaClient = (getAnalyticsAdminAlphaClient() as unknown) as {
      properties: {
        audiences: {
          list: (params: { parent: string; pageSize?: number; pageToken?: string }) => Promise<{
            data: { audiences?: Array<Record<string, unknown>>; nextPageToken?: string };
          }>;
        };
      };
    };

    if (!alphaClient.properties?.audiences?.list) {
      throw new Error(
        'GA4 audiences API not available — googleapis v1alpha may have moved. ' +
        'Update the analyticsadmin client version or use the GA4 admin UI for audiences.',
      );
    }

    const response = await alphaClient.properties.audiences.list({
      parent,
      pageSize: input.pageSize || 50,
      pageToken: input.pageToken,
    });

    const data = response.data;
    const audiences: GA4Audience[] = (data.audiences || []).map((aud: Record<string, unknown>) => ({
      name: String(aud.name || ''),
      displayName: String(aud.displayName || ''),
      description: String(aud.description || ''),
      membershipDurationDays: Number(aud.membershipDurationDays || 0),
      adsPersonalizationEnabled: Boolean(aud.adsPersonalizationEnabled),
      createTime: String(aud.createTime || ''),
    }));

    log.info('Listed GA4 audiences', { count: audiences.length });

    return {
      audiences,
      nextPageToken: data.nextPageToken || undefined,
    };
  },
};

// ============================================
// Run Funnel Report
// ============================================

const funnelStepSchema = z.object({
  name: z.string().describe('Step name'),
  filterExpression: z.any().describe('Filter expression for this step'),
  isDirectlyFollowedBy: z.boolean().optional().describe('Step must directly follow previous'),
  withinDurationFromPriorStep: z.string().optional().describe('Duration limit from prior step'),
});

const runFunnelReportSchema = z.object({
  propertyId: z.string().describe('GA4 Property ID'),
  dateRanges: z.array(z.object({
    startDate: z.string().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().describe('End date (YYYY-MM-DD)'),
  })).min(1).max(2).describe('Date ranges'),
  funnel: z.object({
    isOpenFunnel: z.boolean().optional().describe('Whether funnel is open (users can enter at any step)'),
    steps: z.array(funnelStepSchema).min(2).describe('Funnel steps (minimum 2)'),
  }),
  funnelBreakdown: z.object({
    breakdownDimension: z.object({
      name: z.string().describe('Dimension name to break down by'),
    }),
  }).optional().describe('Optional breakdown dimension'),
  limit: z.number().min(1).max(10000).optional().describe('Maximum rows to return'),
});

type RunFunnelReportInput = z.infer<typeof runFunnelReportSchema>;

interface FunnelStepResult {
  stepName: string;
  activeUsers: number;
  completionRate: number;
  abandonmentRate: number;
  abandonments: number;
}

interface FunnelReportOutput {
  funnelSteps: FunnelStepResult[];
  funnelVisualization: {
    stepName: string;
    users: number;
    percentage: number;
  }[];
  breakdown?: {
    dimension: string;
    values: {
      dimensionValue: string;
      stepMetrics: { stepName: string; users: number }[];
    }[];
  };
  metadata: {
    dateRange: { startDate: string; endDate: string };
    isOpenFunnel: boolean;
    totalSteps: number;
  };
}

export const ga4RunFunnelReportTool: ToolDefinition<RunFunnelReportInput, FunnelReportOutput> = {
  name: 'ga4_run_funnel_report',
  description: 'Runs a funnel analysis report to understand user flow through defined steps',
  category: ToolCategory.GOOGLE,
  inputSchema: runFunnelReportSchema,

  async handler(input: RunFunnelReportInput): Promise<FunnelReportOutput> {
    log.info('Running GA4 funnel report', {
      propertyId: input.propertyId,
      steps: input.funnel.steps.length,
    });

    const analyticsData = await getAnalyticsDataClient();
    const property = input.propertyId.startsWith('properties/')
      ? input.propertyId
      : `properties/${input.propertyId}`;

    // Build funnel request
    const funnelSteps = input.funnel.steps.map((step) => ({
      name: step.name,
      filterExpression: step.filterExpression,
      isDirectlyFollowedBy: step.isDirectlyFollowedBy,
      withinDurationFromPriorStep: step.withinDurationFromPriorStep,
    }));

    const requestBody: Record<string, unknown> = {
      dateRanges: input.dateRanges,
      funnel: {
        isOpenFunnel: input.funnel.isOpenFunnel || false,
        steps: funnelSteps,
      },
      limit: input.limit ? String(input.limit) : '10000',
    };

    if (input.funnelBreakdown) {
      requestBody.funnelBreakdown = input.funnelBreakdown;
    }

    // Note: runFunnelReport requires analyticsdata v1alpha version
    const dataClient = analyticsData as unknown as {
      properties: {
        runFunnelReport: (params: { property: string; requestBody: Record<string, unknown> }) => Promise<{
          data: {
            funnelTable?: {
              rows?: Array<{
                dimensionValues?: Array<{ value?: string }>;
                metricValues?: Array<{ value?: string }>;
              }>;
            };
            funnelVisualization?: {
              rows?: Array<{
                dimensionValues?: Array<{ value?: string }>;
                metricValues?: Array<{ value?: string }>;
              }>;
            };
          };
        }>;
      };
    };

    const response = await dataClient.properties.runFunnelReport({
      property,
      requestBody,
    });

    const data = response.data;
    const funnelTable = data.funnelTable;

    // Process funnel steps
    const steps: FunnelStepResult[] = [];
    const visualization: { stepName: string; users: number; percentage: number }[] = [];
    let firstStepUsers = 0;

    if (funnelTable?.rows) {
      for (let i = 0; i < input.funnel.steps.length; i++) {
        const stepName = input.funnel.steps[i].name;
        const row = funnelTable.rows.find((r: { dimensionValues?: Array<{ value?: string }> }) =>
          r.dimensionValues?.[0]?.value === String(i)
        );

        const activeUsers = Number(row?.metricValues?.[0]?.value || 0);
        const completionRate = Number(row?.metricValues?.[1]?.value || 0);
        const abandonmentRate = Number(row?.metricValues?.[2]?.value || 0);
        const abandonments = Number(row?.metricValues?.[3]?.value || 0);

        if (i === 0) firstStepUsers = activeUsers;

        steps.push({
          stepName,
          activeUsers,
          completionRate: completionRate * 100,
          abandonmentRate: abandonmentRate * 100,
          abandonments,
        });

        visualization.push({
          stepName,
          users: activeUsers,
          percentage: firstStepUsers > 0 ? (activeUsers / firstStepUsers) * 100 : 0,
        });
      }
    }

    // Process breakdown if present
    let breakdown: FunnelReportOutput['breakdown'];
    if (input.funnelBreakdown && data.funnelVisualization) {
      const breakdownData = data.funnelVisualization;
      breakdown = {
        dimension: input.funnelBreakdown.breakdownDimension.name,
        values: [],
      };

      // Group by dimension value
      const groupedByDimension = new Map<string, { stepName: string; users: number }[]>();

      for (const row of breakdownData.rows || []) {
        const dimValue = row.dimensionValues?.[1]?.value || 'unknown';
        const stepIndex = Number(row.dimensionValues?.[0]?.value || 0);
        const users = Number(row.metricValues?.[0]?.value || 0);
        const stepName = input.funnel.steps[stepIndex]?.name || `Step ${stepIndex}`;

        if (!groupedByDimension.has(dimValue)) {
          groupedByDimension.set(dimValue, []);
        }
        groupedByDimension.get(dimValue)!.push({ stepName, users });
      }

      breakdown.values = Array.from(groupedByDimension.entries()).map(([dimValue, stepMetrics]) => ({
        dimensionValue: dimValue,
        stepMetrics,
      }));
    }

    log.info('GA4 funnel report completed', { steps: steps.length });

    return {
      funnelSteps: steps,
      funnelVisualization: visualization,
      breakdown,
      metadata: {
        dateRange: input.dateRanges[0],
        isOpenFunnel: input.funnel.isOpenFunnel || false,
        totalSteps: input.funnel.steps.length,
      },
    };
  },
};
