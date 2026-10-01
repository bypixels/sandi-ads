/**
 * Meta Ads tools (read-only)
 */

import { z } from 'zod';
import { metaGet, metaGetAll, normalizeAdAccountId } from './client.js';
import { MCPError } from '../../types/errors.js';
import type { ToolDefinition } from '../../types/tools.js';
import { ToolCategory } from '../../types/tools.js';

// ============================================
// List Ad Accounts
// ============================================

const listAdAccountsSchema = z.object({});
type ListAdAccountsInput = z.infer<typeof listAdAccountsSchema>;

export const metaListAdAccountsTool: ToolDefinition<ListAdAccountsInput, { adAccounts: unknown[] }> = {
  name: 'meta_list_ad_accounts',
  description: 'Lists Meta (Facebook) ad accounts accessible to the configured access token',
  category: ToolCategory.META,
  inputSchema: listAdAccountsSchema,
  async handler() {
    const adAccounts = await metaGetAll('/me/adaccounts', {
      fields: 'id,name,account_status,currency,timezone_name,business',
      limit: 100,
    });
    return { adAccounts };
  },
};

// ============================================
// List Campaigns
// ============================================

const listCampaignsSchema = z.object({
  adAccountId: z.string().describe('Ad account ID, with or without the "act_" prefix'),
  status: z.array(z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED'])).optional().describe('Filter by effective status'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 25)'),
});
type ListCampaignsInput = z.infer<typeof listCampaignsSchema>;

export const metaListCampaignsTool: ToolDefinition<ListCampaignsInput, { campaigns: unknown[] }> = {
  name: 'meta_list_campaigns',
  description: 'Lists campaigns in a Meta ad account',
  category: ToolCategory.META,
  inputSchema: listCampaignsSchema,
  async handler(input) {
    const act = normalizeAdAccountId(input.adAccountId);
    const data = await metaGet<{ data?: unknown[] }>(`/${act}/campaigns`, {
      fields:
        'id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time',
      limit: input.limit ?? 25,
      filtering: input.status?.length
        ? JSON.stringify([{ field: 'effective_status', operator: 'IN', value: input.status }])
        : undefined,
    });
    return { campaigns: data.data ?? [] };
  },
};

// ============================================
// Insights
// ============================================

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const insightsSchema = z.object({
  adAccountId: z.string().describe('Ad account ID, with or without the "act_" prefix'),
  level: z.enum(['account', 'campaign', 'adset', 'ad']).default('campaign').describe('Aggregation level'),
  datePreset: z
    .enum(['today', 'yesterday', 'last_7d', 'last_30d', 'this_month', 'last_month'])
    .default('last_30d')
    .describe('Date preset (ignored when since/until are given)'),
  since: z.string().regex(DATE).optional().describe('Start date YYYY-MM-DD (requires until)'),
  until: z.string().regex(DATE).optional().describe('End date YYYY-MM-DD (requires since)'),
});
type InsightsInput = z.infer<typeof insightsSchema>;

export const metaGetInsightsTool: ToolDefinition<InsightsInput, { insights: unknown[] }> = {
  name: 'meta_get_insights',
  description: 'Gets performance insights (impressions, reach, clicks, spend, CTR, CPC, CPM, actions) for a Meta ad account',
  category: ToolCategory.META,
  inputSchema: insightsSchema,
  async handler(input) {
    if ((input.since === undefined) !== (input.until === undefined)) {
      throw MCPError.validationError('since and until must be provided together');
    }
    const act = normalizeAdAccountId(input.adAccountId);
    const useRange = input.since !== undefined && input.until !== undefined;
    const insights = await metaGetAll(`/${act}/insights`, {
      fields: 'campaign_id,campaign_name,impressions,reach,clicks,spend,ctr,cpc,cpm,actions',
      level: input.level ?? 'campaign',
      date_preset: useRange ? undefined : (input.datePreset ?? 'last_30d'),
      time_range: useRange ? JSON.stringify({ since: input.since, until: input.until }) : undefined,
      limit: 100,
    });
    return { insights };
  },
};
