/**
 * Google Business Profile tools module
 *
 * Tools for managing Google Business Profile accounts, locations, reviews, posts, and insights.
 */

// Accounts & Locations
export {
  gbpListAccountsTool,
  gbpListLocationsTool,
  gbpGetLocationTool,
  gbpUpdateLocationTool,
} from './accounts.js';

// Reviews
export {
  gbpListReviewsTool,
  gbpReplyReviewTool,
  gbpDeleteReviewReplyTool,
} from './reviews.js';

// Posts
export {
  gbpListPostsTool,
  gbpCreatePostTool,
} from './posts.js';

// Insights & Media
export {
  gbpGetInsightsTool,
  gbpListMediaTool,
  gbpUploadMediaTool,
  gbpPerformanceReportTool,
} from './insights.js';

import {
  gbpListAccountsTool,
  gbpListLocationsTool,
  gbpGetLocationTool,
  gbpUpdateLocationTool,
} from './accounts.js';
import {
  gbpListReviewsTool,
  gbpReplyReviewTool,
  gbpDeleteReviewReplyTool,
} from './reviews.js';
import {
  gbpListPostsTool,
  gbpCreatePostTool,
} from './posts.js';
import {
  gbpGetInsightsTool,
  gbpListMediaTool,
  gbpUploadMediaTool,
  gbpPerformanceReportTool,
} from './insights.js';
import type { ToolDefinition } from '../../../types/tools.js';

/** All Google Business Profile tools */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const gbpTools: ToolDefinition<any, any>[] = [
  // Accounts & Locations
  gbpListAccountsTool,
  gbpListLocationsTool,
  gbpGetLocationTool,
  gbpUpdateLocationTool,
  // Reviews
  gbpListReviewsTool,
  gbpReplyReviewTool,
  gbpDeleteReviewReplyTool,
  // Posts
  gbpListPostsTool,
  gbpCreatePostTool,
  // Insights & Media
  gbpGetInsightsTool,
  gbpListMediaTool,
  gbpUploadMediaTool,
  gbpPerformanceReportTool,
];

