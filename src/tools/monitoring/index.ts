/**
 * Monitoring tools module
 *
 * Tools for uptime, DNS, and certificate monitoring.
 */

export { checkUptimeTool, responseTimeTool } from './uptime.js';
export { dnsLookupTool, dnsPropagationTool } from './dns.js';
export { certificateTool } from './certificates.js';

import { checkUptimeTool, responseTimeTool } from './uptime.js';
import { dnsLookupTool, dnsPropagationTool } from './dns.js';
import { certificateTool } from './certificates.js';
import type { ToolDefinition } from '../../types/tools.js';

/** All monitoring tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const monitoringTools: ToolDefinition<any, any>[] = [
  checkUptimeTool,
  responseTimeTool,
  dnsLookupTool,
  dnsPropagationTool,
  certificateTool,
];
