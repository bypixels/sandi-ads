/**
 * Google Indexing API tools module
 *
 * Tools for notifying Google about URL updates and deletions.
 */

export {
  indexingPublishTool,
  indexingGetStatusTool,
  indexingBatchPublishTool,
} from './api.js';

import {
  indexingPublishTool,
  indexingGetStatusTool,
  indexingBatchPublishTool,
} from './api.js';
import type { ToolDefinition } from '../../../types/tools.js';

/** All Indexing API tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const indexingTools: ToolDefinition<any, any>[] = [
  indexingPublishTool,
  indexingGetStatusTool,
  indexingBatchPublishTool,
];

