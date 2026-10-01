/**
 * Google Ads tools module
 *
 * Tools for managing Google Ads accounts, campaigns, ad groups, keywords, and reports.
 */

// Client
export { getAdsClient, initializeAdsClient } from './client.js';

// Customers
export {
  adsListCustomersTool,
  adsGetCustomerTool,
} from './customers.js';

// Campaigns
export {
  adsListCampaignsTool,
  adsGetCampaignTool,
  adsListAdGroupsTool,
  adsListKeywordsTool,
} from './campaigns.js';

// Reports
export {
  adsCampaignPerformanceTool,
  adsSearchTermReportTool,
  adsAccountSummaryTool,
} from './reports.js';

// Management (create, update, keywords, budgets)
export {
  adsCreateCampaignTool,
  adsUpdateCampaignTool,
  adsAddKeywordsTool,
  adsGetKeywordIdeasTool,
  adsListBudgetsTool,
  adsCreateBudgetTool,
} from './management.js';

import {
  adsListCustomersTool,
  adsGetCustomerTool,
} from './customers.js';
import {
  adsListCampaignsTool,
  adsGetCampaignTool,
  adsListAdGroupsTool,
  adsListKeywordsTool,
} from './campaigns.js';
import {
  adsCampaignPerformanceTool,
  adsSearchTermReportTool,
  adsAccountSummaryTool,
} from './reports.js';
import {
  adsCreateCampaignTool,
  adsUpdateCampaignTool,
  adsAddKeywordsTool,
  adsGetKeywordIdeasTool,
  adsListBudgetsTool,
  adsCreateBudgetTool,
} from './management.js';
import type { ToolDefinition } from '../../../types/tools.js';

/** All Google Ads tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adsTools: ToolDefinition<any, any>[] = [
  // Customers
  adsListCustomersTool,
  adsGetCustomerTool,
  // Campaigns
  adsListCampaignsTool,
  adsGetCampaignTool,
  adsListAdGroupsTool,
  adsListKeywordsTool,
  // Reports
  adsCampaignPerformanceTool,
  adsSearchTermReportTool,
  adsAccountSummaryTool,
  // Management
  adsCreateCampaignTool,
  adsUpdateCampaignTool,
  adsAddKeywordsTool,
  adsGetKeywordIdeasTool,
  adsListBudgetsTool,
  adsCreateBudgetTool,
];

