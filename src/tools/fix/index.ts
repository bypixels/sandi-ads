/**
 * Fix module — autonomous remediation for issues other tools surface.
 *
 * Two flavors of fix:
 *   1. Direct mutations via APIs we own credentials for (Indexing API,
 *      GSC sitemap submission). Gate via approval-gate before invoking.
 *   2. Proposals — for things we can't write directly (page HTML, server
 *      configs), emit deployable configs/patches for the caller to apply.
 */

import type { ToolDefinition } from '../../types/tools.js';
import { fixSubmitPagesToIndexTool } from './indexing.js';
import { fixProposeMetaDescriptionsTool } from './meta.js';
import { fixProposeSecurityHeadersTool } from './security-headers.js';
import { fixResubmitSitemapTool, fixCleanSitemapTool } from './sitemap.js';

export {
  fixSubmitPagesToIndexTool,
  fixProposeMetaDescriptionsTool,
  fixProposeSecurityHeadersTool,
  fixResubmitSitemapTool,
  fixCleanSitemapTool,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fixTools: ToolDefinition<any, any>[] = [
  fixSubmitPagesToIndexTool,
  fixProposeMetaDescriptionsTool,
  fixProposeSecurityHeadersTool,
  fixResubmitSitemapTool,
  fixCleanSitemapTool,
];
