/**
 * Cloudflare integration tools module
 *
 * Tools for managing Cloudflare zones, DNS, cache, analytics, and firewall.
 */

// Zones & DNS
export {
  cfGetZonesTool,
  cfListDNSRecordsTool,
  cfCreateDNSRecordTool,
} from './zones.js';

// Analytics & Cache
export {
  cfGetAnalyticsTool,
  cfPurgeCacheTool,
} from './analytics.js';

// Firewall
export { cfFirewallEventsTool } from './firewall.js';

import {
  cfGetZonesTool,
  cfListDNSRecordsTool,
  cfCreateDNSRecordTool,
} from './zones.js';
import {
  cfGetAnalyticsTool,
  cfPurgeCacheTool,
} from './analytics.js';
import { cfFirewallEventsTool } from './firewall.js';
import type { ToolDefinition } from '../../../types/tools.js';

/** All Cloudflare tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cloudflareTools: ToolDefinition<any, any>[] = [
  cfGetZonesTool,
  cfListDNSRecordsTool,
  cfCreateDNSRecordTool,
  cfGetAnalyticsTool,
  cfPurgeCacheTool,
  cfFirewallEventsTool,
];
