/**
 * Coding module — LLM-driven structured fix proposals.
 *
 * Stateless: tools return structured proposals; the dashboard's `coding`
 * agent runner persists as drafts (type `fix_proposal`). Mutations happen
 * only when the human approves and triggers `fix_*` tools through the
 * guarded-execute pipeline.
 */

import type { ToolDefinition } from '../../types/tools.js';
import { codingProposeFixTool } from './propose-fix.js';

export { codingProposeFixTool };
export type { ProposeFixOutput } from './propose-fix.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const codingTools: ToolDefinition<any, any>[] = [
  codingProposeFixTool,
];
