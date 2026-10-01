/**
 * Social module — drafters for X / LinkedIn / Hacker News.
 *
 * All three are stateless: they call the Anthropic SDK with platform-specific
 * prompts and return structured drafts. Persistence + state machine live in
 * `src/dashboard/services/drafts-store.ts`; the dashboard orchestrator
 * (`agent-runners.ts`) is the seam that calls these tools.
 */

import type { ToolDefinition } from '../../types/tools.js';
import { socialDraftXTool } from './x.js';
import { socialDraftLinkedInTool } from './linkedin.js';
import { socialDraftHnTool } from './hn.js';
import { hnSearchDiscussionsTool } from './hn-search.js';

export { socialDraftXTool, socialDraftLinkedInTool, socialDraftHnTool, hnSearchDiscussionsTool };
export type { XDraftOutput } from './x.js';
export type { LinkedInOutput } from './linkedin.js';
export type { HNOutput } from './hn.js';
export type { HnHit, HnSearchOutput } from './hn-search.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const socialTools: ToolDefinition<any, any>[] = [
  socialDraftXTool,
  socialDraftLinkedInTool,
  socialDraftHnTool,
  hnSearchDiscussionsTool,
];
