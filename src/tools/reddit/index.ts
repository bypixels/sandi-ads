/**
 * Reddit module — search for relevant threads + draft replies.
 *
 * Search (`reddit_search_threads`) hits the public JSON API; drafter
 * (`reddit_draft_reply`) uses the Anthropic SDK. The discussion-monitor
 * scheduler consumes search; the dashboard exposes both for ad-hoc use.
 */

import type { ToolDefinition } from '../../types/tools.js';
import { redditSearchThreadsTool } from './search.js';
import { redditDraftReplyTool } from './draft.js';

export { redditSearchThreadsTool, redditDraftReplyTool };
export type { RedditThread, RedditSearchOutput } from './search.js';
export type { RedditDraftOutput } from './draft.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const redditTools: ToolDefinition<any, any>[] = [
  redditSearchThreadsTool,
  redditDraftReplyTool,
];
