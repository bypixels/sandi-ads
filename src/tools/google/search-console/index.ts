/**
 * Google Search Console tools module
 *
 * Tools for Search Console sites, performance queries, sitemaps, and URL inspection.
 */

// Sites
export {
  gscListSitesTool,
  gscGetSiteTool,
} from './sites.js';

// Performance
export {
  gscQueryPerformanceTool,
  gscTopQueriesTool,
  gscTopPagesTool,
} from './performance.js';

// Sitemaps
export {
  gscListSitemapsTool,
  gscGetSitemapTool,
  gscSubmitSitemapTool,
  gscDeleteSitemapTool,
} from './sitemaps.js';

// URL Inspection
export {
  gscInspectUrlTool,
} from './inspection.js';

// Coverage
export {
  gscCoverageReportTool,
} from './coverage.js';

import {
  gscListSitesTool,
  gscGetSiteTool,
} from './sites.js';
import {
  gscQueryPerformanceTool,
  gscTopQueriesTool,
  gscTopPagesTool,
} from './performance.js';
import {
  gscListSitemapsTool,
  gscGetSitemapTool,
  gscSubmitSitemapTool,
  gscDeleteSitemapTool,
} from './sitemaps.js';
import {
  gscInspectUrlTool,
} from './inspection.js';
import {
  gscCoverageReportTool,
} from './coverage.js';
import type { ToolDefinition } from '../../../types/tools.js';

/** All Search Console tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const gscTools: ToolDefinition<any, any>[] = [
  // Sites
  gscListSitesTool,
  gscGetSiteTool,
  // Performance
  gscQueryPerformanceTool,
  gscTopQueriesTool,
  gscTopPagesTool,
  // Sitemaps
  gscListSitemapsTool,
  gscGetSitemapTool,
  gscSubmitSitemapTool,
  gscDeleteSitemapTool,
  // URL Inspection
  gscInspectUrlTool,
  // Coverage
  gscCoverageReportTool,
];

