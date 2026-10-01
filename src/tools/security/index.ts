/**
 * Security tools module
 *
 * Tools for SSL analysis, security headers, Safe Browsing, and comprehensive security audits.
 */

export { sslAnalyzeTool } from './ssl.js';
export { headersCheckTool } from './headers.js';
export { securityAuditTool } from './audit.js';
export { safeBrowsingTool } from './safe-browsing.js';

import { sslAnalyzeTool } from './ssl.js';
import { headersCheckTool } from './headers.js';
import { securityAuditTool } from './audit.js';
import { safeBrowsingTool } from './safe-browsing.js';
import type { ToolDefinition } from '../../types/tools.js';

/** All security tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const securityTools: ToolDefinition<any, any>[] = [
  sslAnalyzeTool,
  headersCheckTool,
  securityAuditTool,
  safeBrowsingTool,
];
