/**
 * Meta (Facebook / Instagram Graph API) tools module — read-only.
 */

import {
  metaListAdAccountsTool,
  metaListCampaignsTool,
  metaGetInsightsTool,
} from './ads.js';
import {
  metaListPagesTool,
  metaListPagePostsTool,
  metaGetIgAccountTool,
  metaListIgMediaTool,
} from './pages.js';
import type { ToolDefinition } from '../../types/tools.js';

/** All Meta tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const metaTools: ToolDefinition<any, any>[] = [
  metaListAdAccountsTool,
  metaListCampaignsTool,
  metaGetInsightsTool,
  metaListPagesTool,
  metaListPagePostsTool,
  metaGetIgAccountTool,
  metaListIgMediaTool,
];
