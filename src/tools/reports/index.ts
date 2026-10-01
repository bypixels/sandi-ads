/**
 * Reports tools module
 *
 * Tools for generating comprehensive reports: site health, SEO audit, executive summary, and dashboard overview.
 */

export { reportSiteHealthTool } from './site-health.js';
export { reportSeoAuditTool } from './seo-audit.js';
export { reportExecutiveSummaryTool } from './executive-summary.js';
export { dashboardOverviewTool } from './dashboard-overview.js';

import { reportSiteHealthTool } from './site-health.js';
import { reportSeoAuditTool } from './seo-audit.js';
import { reportExecutiveSummaryTool } from './executive-summary.js';
import { dashboardOverviewTool } from './dashboard-overview.js';
import type { ToolDefinition } from '../../types/tools.js';

/** All Reports tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reportsTools: ToolDefinition<any, any>[] = [
  reportSiteHealthTool,
  reportSeoAuditTool,
  reportExecutiveSummaryTool,
  dashboardOverviewTool,
];
