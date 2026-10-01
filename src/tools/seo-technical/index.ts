/**
 * SEO Technical tools module
 *
 * Tools for robots.txt, sitemaps, meta tags, structured data, redirects, canonicals, and headings.
 */

export { robotsAnalyzeTool, robotsTestTool } from './robots.js';
export { sitemapAnalyzeTool } from './sitemap.js';
export { metaAnalyzeTool } from './meta.js';
export { structuredDataTool } from './structured-data.js';
export { redirectCheckTool, canonicalCheckTool } from './redirects.js';
export { headingAnalysisTool } from './headings.js';

import { robotsAnalyzeTool, robotsTestTool } from './robots.js';
import { sitemapAnalyzeTool } from './sitemap.js';
import { metaAnalyzeTool } from './meta.js';
import { structuredDataTool } from './structured-data.js';
import { redirectCheckTool, canonicalCheckTool } from './redirects.js';
import { headingAnalysisTool } from './headings.js';
import type { ToolDefinition } from '../../types/tools.js';

/** All SEO technical tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const seoTechnicalTools: ToolDefinition<any, any>[] = [
  robotsAnalyzeTool,
  robotsTestTool,
  sitemapAnalyzeTool,
  metaAnalyzeTool,
  structuredDataTool,
  redirectCheckTool,
  canonicalCheckTool,
  headingAnalysisTool,
];
