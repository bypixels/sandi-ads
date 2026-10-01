/**
 * Google Analytics 4 tools module
 *
 * Tools for GA4 accounts, properties, reports, real-time data, and configuration.
 */

// Accounts & Properties
export {
  ga4ListAccountsTool,
  ga4GetAccountTool,
  ga4ListPropertiesTool,
  ga4GetPropertyTool,
} from './accounts.js';

// Reports
export {
  ga4RunReportTool,
  ga4RunRealtimeReportTool,
  ga4TrafficOverviewTool,
} from './reports.js';

// Metadata & Configuration
export {
  ga4GetMetadataTool,
  ga4ListCustomDimensionsTool,
  ga4ListCustomMetricsTool,
  ga4ListConversionEventsTool,
  ga4ListDataStreamsTool,
} from './metadata.js';

// Audiences & Funnels
export {
  ga4ListAudiencesTool,
  ga4RunFunnelReportTool,
} from './audiences.js';

import {
  ga4ListAccountsTool,
  ga4GetAccountTool,
  ga4ListPropertiesTool,
  ga4GetPropertyTool,
} from './accounts.js';
import {
  ga4RunReportTool,
  ga4RunRealtimeReportTool,
  ga4TrafficOverviewTool,
} from './reports.js';
import {
  ga4GetMetadataTool,
  ga4ListCustomDimensionsTool,
  ga4ListCustomMetricsTool,
  ga4ListConversionEventsTool,
  ga4ListDataStreamsTool,
} from './metadata.js';
import {
  ga4ListAudiencesTool,
  ga4RunFunnelReportTool,
} from './audiences.js';
import type { ToolDefinition } from '../../../types/tools.js';

/** All GA4 tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ga4Tools: ToolDefinition<any, any>[] = [
  // Accounts & Properties
  ga4ListAccountsTool,
  ga4GetAccountTool,
  ga4ListPropertiesTool,
  ga4GetPropertyTool,
  // Reports
  ga4RunReportTool,
  ga4RunRealtimeReportTool,
  ga4TrafficOverviewTool,
  // Metadata & Configuration
  ga4GetMetadataTool,
  ga4ListCustomDimensionsTool,
  ga4ListCustomMetricsTool,
  ga4ListConversionEventsTool,
  ga4ListDataStreamsTool,
  // Audiences & Funnels
  ga4ListAudiencesTool,
  ga4RunFunnelReportTool,
];

