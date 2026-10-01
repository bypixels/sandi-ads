/**
 * Content module — structured briefs for LLM-driven article generation.
 *
 * Differentiator vs Outrank/Okara: drafts informed by the user's REAL GSC
 * data (their own search demand), not generic corpus generation.
 */

import type { ToolDefinition } from '../../types/tools.js';
import { contentBriefFromKeywordTool, contentOutlineFromUrlTool } from './briefs.js';
import { contentTopicGapsTool, contentRefreshCandidatesTool } from './gaps.js';
import { contentGenerateLlmsTxtTool } from './llms-txt.js';
import { contentWriteArticleTool } from './writer.js';

export {
  contentBriefFromKeywordTool,
  contentOutlineFromUrlTool,
  contentTopicGapsTool,
  contentRefreshCandidatesTool,
  contentGenerateLlmsTxtTool,
  contentWriteArticleTool,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const contentTools: ToolDefinition<any, any>[] = [
  contentBriefFromKeywordTool,
  contentOutlineFromUrlTool,
  contentTopicGapsTool,
  contentRefreshCandidatesTool,
  contentGenerateLlmsTxtTool,
  contentWriteArticleTool,
];
