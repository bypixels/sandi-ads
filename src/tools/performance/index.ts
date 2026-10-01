/**
 * Performance tools module
 *
 * Tools for PageSpeed Insights, Chrome UX Report, Core Web Vitals, and Lighthouse analysis.
 */

// PageSpeed Insights
export { psiAnalyzeTool } from './pagespeed.js';

// Chrome UX Report
export { cruxQueryTool, cruxHistoryTool } from './crux.js';

// Core Web Vitals
export { cwvReportTool } from './core-web-vitals.js';

// Lighthouse
export { lighthouseAuditTool } from './lighthouse.js';

import { psiAnalyzeTool } from './pagespeed.js';
import { cruxQueryTool, cruxHistoryTool } from './crux.js';
import { cwvReportTool } from './core-web-vitals.js';
import { lighthouseAuditTool } from './lighthouse.js';
import type { ToolDefinition } from '../../types/tools.js';

/** All Performance tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const performanceTools: ToolDefinition<any, any>[] = [
  psiAnalyzeTool,
  cruxQueryTool,
  cruxHistoryTool,
  cwvReportTool,
  lighthouseAuditTool,
];
