/**
 * Google tools aggregator — exposes `googleTools` as the flat array of every
 * Google sub-module's tools. The top-level `src/tools/index.ts` iterates it
 * once at boot; no per-sub-module `register*Tools()` wrapper exists.
 */

// Re-export individual sub-module APIs (tools, arrays) for direct consumers
export * from './gtm/index.js';
export * from './analytics/index.js';
export * from './search-console/index.js';
export * from './ads/index.js';
export * from './indexing/index.js';
export * from './business-profile/index.js';

import { gtmTools } from './gtm/index.js';
import { ga4Tools } from './analytics/index.js';
import { gscTools } from './search-console/index.js';
import { adsTools } from './ads/index.js';
import { indexingTools } from './indexing/index.js';
import { gbpTools } from './business-profile/index.js';
import type { ToolDefinition } from '../../types/tools.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const googleTools: ToolDefinition<any, any>[] = [
  ...gtmTools,
  ...ga4Tools,
  ...gscTools,
  ...adsTools,
  ...indexingTools,
  ...gbpTools,
];
