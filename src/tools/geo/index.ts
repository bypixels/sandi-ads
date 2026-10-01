/**
 * GEO (Generative Engine Optimization) module — AI search visibility,
 * brand citations, llms.txt, AI-extractability auditing.
 */

import type { ToolDefinition } from '../../types/tools.js';
import { geoQueryAiSearchTool } from './query.js';
import { geoCheckBrandVisibilityTool, geoCompetitorShareOfVoiceTool } from './visibility.js';
import { geoValidateLlmsTxtTool } from './llms-txt-validate.js';
import { geoAiSearchAuditTool } from './audit.js';

export {
  geoQueryAiSearchTool,
  geoCheckBrandVisibilityTool,
  geoCompetitorShareOfVoiceTool,
  geoValidateLlmsTxtTool,
  geoAiSearchAuditTool,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const geoTools: ToolDefinition<any, any>[] = [
  geoQueryAiSearchTool,
  geoCheckBrandVisibilityTool,
  geoCompetitorShareOfVoiceTool,
  geoValidateLlmsTxtTool,
  geoAiSearchAuditTool,
];
