/**
 * Convert the MCP tool registry into Anthropic tool definitions.
 *
 * In read-only mode (MUTATIONS_ENABLED=false), mutating tools are filtered
 * out so Claude does not even attempt them. Read-only tools always pass.
 */

import { getAllTools } from '../../tools/index.js';
import { zodToJsonSchema } from '../../utils/schema.js';
import { isMutatingTool, isMutationAllowed } from './mutations.js';

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface AgentToolsetOptions {
  /** Include only tools matching these category prefixes (e.g. ['gsc_', 'ga4_']). */
  includePrefixes?: string[];
  /** When true, include mutating tools regardless of MUTATIONS_ENABLED. */
  forceIncludeMutating?: boolean;
}

/**
 * Build the tool definitions array passed to Anthropic's `tools` parameter.
 *
 * Filtering rules:
 *   1. If MUTATIONS_ENABLED=false (and per-service flag for the tool is also off),
 *      the mutating tool is excluded. Claude only sees tools it can actually run.
 *   2. If `includePrefixes` is set, only tools matching any prefix are included.
 *   3. Tools that are blocked by license tier are already excluded by getAllTools.
 */
export function buildAgentToolset(opts: AgentToolsetOptions = {}): AnthropicTool[] {
  const all = getAllTools();
  const result: AnthropicTool[] = [];

  for (const tool of all) {
    if (opts.includePrefixes && !opts.includePrefixes.some((p) => tool.name.startsWith(p))) {
      continue;
    }
    if (!opts.forceIncludeMutating && isMutatingTool(tool.name) && !isMutationAllowed(tool.name)) {
      continue;
    }
    const schema = zodToJsonSchema(tool.inputSchema);
    // Ensure input_schema.type === 'object' for Anthropic SDK typing
    if (schema.type !== 'object') {
      schema.type = 'object';
    }
    result.push({
      name: tool.name,
      description: tool.description,
      input_schema: schema as AnthropicTool['input_schema'],
    });
  }

  return result;
}

/** Sanitize a string to fit within Anthropic's content size limits */
export function truncateForModel(value: unknown, maxChars = 80_000): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n\n…[truncated ${s.length - maxChars} chars]`;
}
