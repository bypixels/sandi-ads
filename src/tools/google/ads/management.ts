/**
 * Google Ads - Campaign Management tools
 *
 * Tools for creating/updating campaigns, managing keywords, and budgets.
 */

import { z } from 'zod';
import { getAdsClient, getRefreshToken, getLoginCustomerId } from './client.js';
import { createServiceLogger } from '../../../utils/logger.js';
import type { ToolDefinition } from '../../../types/tools.js';
import { ToolCategory } from '../../../types/tools.js';
import { enums, resources, ResourceNames } from 'google-ads-api';
import { assertDailyBudget, microsSchema } from './safety.js';

const log = createServiceLogger('ads-management');

// ============================================
// Create Campaign
// ============================================

const createCampaignSchema = z.object({
  customerId: z.string().describe('Google Ads Customer ID'),
  campaign: z.object({
    name: z.string().describe('Campaign name'),
    advertisingChannelType: z.enum(['SEARCH', 'DISPLAY', 'SHOPPING', 'VIDEO', 'PERFORMANCE_MAX'])
      .describe('Campaign type'),
    status: z.enum(['ENABLED', 'PAUSED']).optional().describe('Campaign status'),
    startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
    budgetAmountMicros: microsSchema.describe('Daily budget in micros (1000000 = $1)'),
    budgetDeliveryMethod: z.enum(['STANDARD']).optional().describe('Budget delivery'),
    biddingStrategyType: z.enum(['MANUAL_CPC', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CLICKS', 'TARGET_CPA', 'TARGET_ROAS'])
      .optional().describe('Bidding strategy'),
    targetCpaMicros: z.number().optional().describe('Target CPA in micros (for TARGET_CPA)'),
    targetRoas: z.number().optional().describe('Target ROAS (for TARGET_ROAS, e.g., 3.0 = 300%)'),
  }),
});

type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

interface CreateCampaignOutput {
  campaignResourceName: string;
  campaignId: string;
  budgetResourceName: string;
}

export const adsCreateCampaignTool: ToolDefinition<CreateCampaignInput, CreateCampaignOutput> = {
  name: 'ads_create_campaign',
  description: 'Creates a new Google Ads campaign with budget and bidding strategy',
  category: ToolCategory.GOOGLE,
  inputSchema: createCampaignSchema,

  async handler(input: CreateCampaignInput): Promise<CreateCampaignOutput> {
    assertDailyBudget(input.campaign.budgetAmountMicros);
    createCampaignSchema.parse(input);
    log.info('Creating Ads campaign', { customerId: input.customerId, name: input.campaign.name });

    const client = getAdsClient();
    const refreshToken = getRefreshToken();
    const customerId = input.customerId.replace(/-/g, '');

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: refreshToken,
      login_customer_id: getLoginCustomerId(),
    });

    // First create a budget
    const budgetCreate: Partial<resources.CampaignBudget> = {
      name: `Budget for ${input.campaign.name}`,
      amount_micros: input.campaign.budgetAmountMicros as unknown as number,
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: false,
    };

    const budgetResponse = await customer.campaignBudgets.create([budgetCreate]);
    const budgetResourceName = budgetResponse.results[0].resource_name;

    // Build campaign object
    const campaignCreate: Partial<resources.Campaign> = {
      name: input.campaign.name,
      advertising_channel_type: enums.AdvertisingChannelType[input.campaign.advertisingChannelType as keyof typeof enums.AdvertisingChannelType],
      status: enums.CampaignStatus.PAUSED,
      campaign_budget: budgetResourceName,
    };

    if (input.campaign.startDate) {
      campaignCreate.start_date = input.campaign.startDate.replace(/-/g, '');
    }
    if (input.campaign.endDate) {
      campaignCreate.end_date = input.campaign.endDate.replace(/-/g, '');
    }

    // Set bidding strategy
    switch (input.campaign.biddingStrategyType) {
      case 'MANUAL_CPC':
        (campaignCreate as Record<string, unknown>).manual_cpc = { enhanced_cpc_enabled: false };
        break;
      case 'MAXIMIZE_CONVERSIONS':
        (campaignCreate as Record<string, unknown>).maximize_conversions = {};
        break;
      case 'MAXIMIZE_CLICKS':
        (campaignCreate as Record<string, unknown>).maximize_clicks = {};
        break;
      case 'TARGET_CPA':
        (campaignCreate as Record<string, unknown>).target_cpa = {
          target_cpa_micros: input.campaign.targetCpaMicros,
        };
        break;
      case 'TARGET_ROAS':
        (campaignCreate as Record<string, unknown>).target_roas = {
          target_roas: input.campaign.targetRoas,
        };
        break;
      default:
        (campaignCreate as Record<string, unknown>).maximize_clicks = {};
    }

    // Network settings for search campaigns
    if (input.campaign.advertisingChannelType === 'SEARCH') {
      campaignCreate.network_settings = {
        target_google_search: true,
        target_search_network: true,
        target_content_network: false,
        target_partner_search_network: false,
      };
    }

    const campaignResponse = await customer.campaigns.create([campaignCreate]);
    const campaignResourceName = campaignResponse.results[0]?.resource_name || '';
    const campaignId = campaignResourceName?.split('/').pop() || '';

    log.info('Created Ads campaign', { campaignId, budgetResourceName });

    return {
      campaignResourceName: campaignResourceName || '',
      campaignId: campaignId || '',
      budgetResourceName: budgetResourceName || '',
    };
  },
};

// ============================================
// Update Campaign
// ============================================

const updateCampaignSchema = z.object({
  customerId: z.string().describe('Google Ads Customer ID'),
  campaignId: z.string().describe('Campaign ID to update'),
  updates: z.object({
    name: z.string().optional().describe('New campaign name'),
    status: z.enum(['ENABLED', 'PAUSED']).optional().describe('New status'),
    endDate: z.string().optional().describe('New end date (YYYY-MM-DD)'),
    budgetAmountMicros: microsSchema.optional().describe('New daily budget in micros'),
  }),
});

type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

interface UpdateCampaignOutput {
  success: boolean;
  campaignResourceName: string;
  updatedFields: string[];
}

export const adsUpdateCampaignTool: ToolDefinition<UpdateCampaignInput, UpdateCampaignOutput> = {
  name: 'ads_update_campaign',
  description: 'Updates an existing Google Ads campaign settings',
  category: ToolCategory.GOOGLE,
  inputSchema: updateCampaignSchema,

  async handler(input: UpdateCampaignInput): Promise<UpdateCampaignOutput> {
    updateCampaignSchema.parse(input);
    if (input.updates.status === 'ENABLED' && input.updates.budgetAmountMicros !== undefined) {
      throw new Error('Enable and budget changes require separate approved operations');
    }
    if (input.updates.budgetAmountMicros !== undefined) assertDailyBudget(input.updates.budgetAmountMicros);
    if (!/^\d+$/.test(input.campaignId)) throw new Error('Campaign ID must contain only digits');
    log.info('Updating Ads campaign', { customerId: input.customerId, campaignId: input.campaignId });

    const client = getAdsClient();
    const refreshToken = getRefreshToken();
    const customerId = input.customerId.replace(/-/g, '');

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: refreshToken,
      login_customer_id: getLoginCustomerId(),
    });

    // Resolve and validate the existing budget before any campaign mutation.
    let budgetResourceName: string | undefined;
    if (input.updates.budgetAmountMicros !== undefined || input.updates.status === 'ENABLED') {
      const rows = await customer.query(`
        SELECT campaign.campaign_budget, campaign_budget.amount_micros,
          campaign_budget.explicitly_shared, campaign_budget.reference_count
        FROM campaign WHERE campaign.id = ${input.campaignId} LIMIT 1
      `);
      const row = rows[0];
      const budget = row?.campaign_budget;
      budgetResourceName = row?.campaign?.campaign_budget as string | undefined;
      if (!budgetResourceName || !budget || budget.explicitly_shared !== false || Number(budget.reference_count) !== 1) {
        throw new Error('Cannot modify or enable a campaign with missing or shared budget metadata');
      }
      if (input.updates.status === 'ENABLED') assertDailyBudget(Number(budget.amount_micros));
    }

    const campaignResourceName = ResourceNames.campaign(customerId, input.campaignId);
    const updatedFields: string[] = [];

    // Update campaign fields
    const campaignUpdate: Partial<resources.Campaign> & { resource_name: string } = {
      resource_name: campaignResourceName,
    };

    if (input.updates.name) {
      campaignUpdate.name = input.updates.name;
      updatedFields.push('name');
    }
    if (input.updates.status) {
      campaignUpdate.status = input.updates.status === 'PAUSED'
        ? enums.CampaignStatus.PAUSED
        : enums.CampaignStatus.ENABLED;
      updatedFields.push('status');
    }
    if (input.updates.endDate) {
      campaignUpdate.end_date = input.updates.endDate.replace(/-/g, '');
      updatedFields.push('end_date');
    }

    if (updatedFields.length > 0) {
      await customer.campaigns.update([campaignUpdate], {
        partial_failure: true,
      });
    }

    // Budget metadata has already been checked before any writes.
    if (input.updates.budgetAmountMicros !== undefined && budgetResourceName) {
      await customer.campaignBudgets.update([{
        resource_name: budgetResourceName,
        amount_micros: input.updates.budgetAmountMicros,
      }], { partial_failure: false });
      updatedFields.push('budget_amount_micros');
    }

    log.info('Updated Ads campaign', { campaignId: input.campaignId, fields: updatedFields });

    return {
      success: true,
      campaignResourceName,
      updatedFields,
    };
  },
};

// ============================================
// Add Keywords
// ============================================

const addKeywordsSchema = z.object({
  customerId: z.string().describe('Google Ads Customer ID'),
  adGroupId: z.string().describe('Ad Group ID'),
  keywords: z.array(z.object({
    text: z.string().describe('Keyword text'),
    matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']).describe('Match type'),
    status: z.enum(['ENABLED', 'PAUSED']).optional().describe('Keyword status'),
    cpcBidMicros: z.number().optional().describe('CPC bid in micros'),
    finalUrl: z.string().optional().describe('Final URL for this keyword'),
  })).min(1).describe('Keywords to add'),
});

type AddKeywordsInput = z.infer<typeof addKeywordsSchema>;

interface AddKeywordsOutput {
  results: {
    keywordText: string;
    resourceName: string;
    criterionId: string;
  }[];
  summary: {
    total: number;
    added: number;
    failed: number;
  };
}

export const adsAddKeywordsTool: ToolDefinition<AddKeywordsInput, AddKeywordsOutput> = {
  name: 'ads_add_keywords',
  description: 'Adds keywords to an ad group',
  category: ToolCategory.GOOGLE,
  inputSchema: addKeywordsSchema,

  async handler(input: AddKeywordsInput): Promise<AddKeywordsOutput> {
    log.info('Adding keywords to ad group', {
      customerId: input.customerId,
      adGroupId: input.adGroupId,
      count: input.keywords.length,
    });

    const client = getAdsClient();
    const refreshToken = getRefreshToken();
    const customerId = input.customerId.replace(/-/g, '');

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: refreshToken,
      login_customer_id: getLoginCustomerId(),
    });

    const adGroupResourceName = ResourceNames.adGroup(customerId, input.adGroupId);

    // Build keyword operations
    const operations: Partial<resources.AdGroupCriterion>[] = input.keywords.map((kw) => {
      const criterion: Partial<resources.AdGroupCriterion> = {
        ad_group: adGroupResourceName,
        status: kw.status === 'PAUSED'
          ? enums.AdGroupCriterionStatus.PAUSED
          : enums.AdGroupCriterionStatus.ENABLED,
        keyword: {
          text: kw.text,
          match_type: enums.KeywordMatchType[kw.matchType as keyof typeof enums.KeywordMatchType],
        },
      };

      if (kw.cpcBidMicros) {
        criterion.cpc_bid_micros = kw.cpcBidMicros as unknown as number;
      }
      if (kw.finalUrl) {
        criterion.final_urls = [kw.finalUrl];
      }

      return criterion;
    });

    const response = await customer.adGroupCriteria.create(operations);

    const results = response.results.map((r, i) => ({
      keywordText: input.keywords[i].text,
      resourceName: r.resource_name || '',
      criterionId: r.resource_name?.split('~').pop() || '',
    }));

    log.info('Added keywords', { added: results.length });

    return {
      results,
      summary: {
        total: input.keywords.length,
        added: results.length,
        failed: input.keywords.length - results.length,
      },
    };
  },
};

// ============================================
// Get Keyword Ideas
// ============================================

const getKeywordIdeasSchema = z.object({
  customerId: z.string().describe('Google Ads Customer ID'),
  language: z.string().describe('Language criterion ID (e.g., 1000 for English)'),
  geoTargetConstants: z.array(z.string()).describe('Location criterion IDs'),
  keywordSeed: z.object({
    keywords: z.array(z.string()).describe('Seed keywords'),
  }).optional().describe('Keywords to base suggestions on'),
  urlSeed: z.object({
    url: z.string().describe('URL to analyze for keyword ideas'),
  }).optional().describe('URL to base suggestions on'),
  pageSize: z.number().min(1).max(500).optional().describe('Maximum ideas to return'),
});

type GetKeywordIdeasInput = z.infer<typeof getKeywordIdeasSchema>;

interface KeywordIdea {
  text: string;
  avgMonthlySearches: number;
  competition: string;
  competitionIndex: number;
  lowTopOfPageBidMicros: number;
  highTopOfPageBidMicros: number;
}

interface GetKeywordIdeasOutput {
  ideas: KeywordIdea[];
  totalCount: number;
}

export const adsGetKeywordIdeasTool: ToolDefinition<GetKeywordIdeasInput, GetKeywordIdeasOutput> = {
  name: 'ads_get_keyword_ideas',
  description: 'Gets keyword suggestions based on seed keywords or URL',
  category: ToolCategory.GOOGLE,
  inputSchema: getKeywordIdeasSchema,

  async handler(input: GetKeywordIdeasInput): Promise<GetKeywordIdeasOutput> {
    log.info('Getting keyword ideas', { customerId: input.customerId });

    const client = getAdsClient();
    const refreshToken = getRefreshToken();
    const customerId = input.customerId.replace(/-/g, '');

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: refreshToken,
      login_customer_id: getLoginCustomerId(),
    });

    // Build geo targets
    const geoTargetConstants = input.geoTargetConstants.map(
      (id) => `geoTargetConstants/${id}`
    );

    // Build request
    const requestBody: Record<string, unknown> = {
      customer_id: customerId,
      language: `languageConstants/${input.language}`,
      geo_target_constants: geoTargetConstants,
      keyword_plan_network: enums.KeywordPlanNetwork.GOOGLE_SEARCH,
      page_size: input.pageSize || 100,
      include_adult_keywords: false,
      page_token: '',
      keyword_annotation: [],
    };

    if (input.keywordSeed) {
      requestBody.keyword_seed = { keywords: input.keywordSeed.keywords };
    }
    if (input.urlSeed) {
      requestBody.url_seed = { url: input.urlSeed.url };
    }

    const response = await customer.keywordPlanIdeas.generateKeywordIdeas(requestBody as never);

    const ideas: KeywordIdea[] = (response.results || []).map((idea) => {
      const metrics = idea.keyword_idea_metrics;
      return {
        text: idea.text || '',
        avgMonthlySearches: Number(metrics?.avg_monthly_searches || 0),
        competition: String(metrics?.competition || 'UNKNOWN'),
        competitionIndex: Number(metrics?.competition_index || 0),
        lowTopOfPageBidMicros: Number(metrics?.low_top_of_page_bid_micros || 0),
        highTopOfPageBidMicros: Number(metrics?.high_top_of_page_bid_micros || 0),
      };
    });

    log.info('Got keyword ideas', { count: ideas.length });

    return {
      ideas,
      totalCount: ideas.length,
    };
  },
};

// ============================================
// List Budgets
// ============================================

const listBudgetsSchema = z.object({
  customerId: z.string().describe('Google Ads Customer ID'),
  limit: z.number().min(1).max(1000).optional().describe('Maximum results'),
});

type ListBudgetsInput = z.infer<typeof listBudgetsSchema>;

interface AdsBudget {
  resourceName: string;
  id: string;
  name: string;
  amountMicros: number;
  deliveryMethod: string;
  status: string;
  totalAmountMicros?: number;
  explicitlyShared: boolean;
  referenceCount: number;
}

interface ListBudgetsOutput {
  budgets: AdsBudget[];
}

export const adsListBudgetsTool: ToolDefinition<ListBudgetsInput, ListBudgetsOutput> = {
  name: 'ads_list_budgets',
  description: 'Lists campaign budgets in a Google Ads account',
  category: ToolCategory.GOOGLE,
  inputSchema: listBudgetsSchema,

  async handler(input: ListBudgetsInput): Promise<ListBudgetsOutput> {
    log.info('Listing Ads budgets', { customerId: input.customerId });

    const client = getAdsClient();
    const refreshToken = getRefreshToken();
    const customerId = input.customerId.replace(/-/g, '');

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: refreshToken,
      login_customer_id: getLoginCustomerId(),
    });

    const limitClause = input.limit ? `LIMIT ${input.limit}` : 'LIMIT 500';

    const result = await customer.query(`
      SELECT
        campaign_budget.resource_name,
        campaign_budget.id,
        campaign_budget.name,
        campaign_budget.amount_micros,
        campaign_budget.delivery_method,
        campaign_budget.status,
        campaign_budget.total_amount_micros,
        campaign_budget.explicitly_shared,
        campaign_budget.reference_count
      FROM campaign_budget
      ORDER BY campaign_budget.name
      ${limitClause}
    `);

    const budgets: AdsBudget[] = result.map((row) => {
      const b = row.campaign_budget;
      return {
        resourceName: b?.resource_name || '',
        id: String(b?.id || ''),
        name: b?.name || '',
        amountMicros: Number(b?.amount_micros || 0),
        deliveryMethod: String(b?.delivery_method || ''),
        status: String(b?.status || ''),
        totalAmountMicros: b?.total_amount_micros ? Number(b.total_amount_micros) : undefined,
        explicitlyShared: b?.explicitly_shared || false,
        referenceCount: Number(b?.reference_count || 0),
      };
    });

    log.info('Listed Ads budgets', { count: budgets.length });

    return { budgets };
  },
};

// ============================================
// Create Budget
// ============================================

const createBudgetSchema = z.object({
  customerId: z.string().describe('Google Ads Customer ID'),
  budget: z.object({
    name: z.string().describe('Budget name'),
    amountMicros: microsSchema.describe('Daily amount in micros (1000000 = $1)'),
    deliveryMethod: z.enum(['STANDARD']).optional().describe('Delivery method'),
    explicitlyShared: z.boolean().optional().describe('Whether budget can be shared across campaigns'),
  }),
});

type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

interface CreateBudgetOutput {
  resourceName: string;
  budgetId: string;
}

export const adsCreateBudgetTool: ToolDefinition<CreateBudgetInput, CreateBudgetOutput> = {
  name: 'ads_create_budget',
  description: 'Creates a campaign budget that can be assigned to campaigns',
  category: ToolCategory.GOOGLE,
  inputSchema: createBudgetSchema,

  async handler(input: CreateBudgetInput): Promise<CreateBudgetOutput> {
    createBudgetSchema.parse(input);
    assertDailyBudget(input.budget.amountMicros);
    if (input.budget.explicitlyShared) throw new Error('Shared budgets are not supported by the per-campaign safety policy');
    log.info('Creating Ads budget', { customerId: input.customerId, name: input.budget.name });

    const client = getAdsClient();
    const refreshToken = getRefreshToken();
    const customerId = input.customerId.replace(/-/g, '');

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: refreshToken,
      login_customer_id: getLoginCustomerId(),
    });

    const budgetCreateObj: Partial<resources.CampaignBudget> = {
      name: input.budget.name,
      amount_micros: input.budget.amountMicros as unknown as number,
      delivery_method: enums.BudgetDeliveryMethod.STANDARD,
      explicitly_shared: input.budget.explicitlyShared ?? false,
    };

    const response = await customer.campaignBudgets.create([budgetCreateObj]);
    const resourceName = response.results[0].resource_name || '';
    const budgetId = resourceName.split('/').pop() || '';

    log.info('Created Ads budget', { budgetId });

    return {
      resourceName,
      budgetId,
    };
  },
};
