/**
 * Utilities tools module
 *
 * Tools for technology detection, broken links checking, WHOIS lookup, headers analysis, and screenshots.
 */

export { techDetectionTool } from './tech-detection.js';
export { brokenLinksTool } from './broken-links.js';
export { whoisLookupTool } from './whois.js';
export { headersAnalysisTool } from './headers.js';
export { screenshotTool } from './screenshot.js';

import { techDetectionTool } from './tech-detection.js';
import { brokenLinksTool } from './broken-links.js';
import { whoisLookupTool } from './whois.js';
import { headersAnalysisTool } from './headers.js';
import { screenshotTool } from './screenshot.js';
import type { ToolDefinition } from '../../types/tools.js';

/** All utility tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const utilityTools: ToolDefinition<any, any>[] = [
  techDetectionTool,
  brokenLinksTool,
  whoisLookupTool,
  headersAnalysisTool,
  screenshotTool,
];
