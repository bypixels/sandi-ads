/**
 * Tool registry and exports
 *
 * This file will export all tools organized by category.
 * Each tool module should register its tools here.
 */

import { ToolDefinition, ToolRegistry } from '../types/tools.js';
import { isPro } from '../licensing/index.js';
import { isProTool } from '../licensing/tiers.js';

/** Global tool registry */
export const toolRegistry: ToolRegistry = new Map();

/**
 * Register a tool
 */
export function registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolRegistry.set(tool.name, tool as ToolDefinition<any, any>);
}

/**
 * Get a tool by name (respects license tier)
 */
export function getTool(name: string): ToolDefinition | undefined {
  const tool = toolRegistry.get(name);
  if (!tool) return undefined;

  if (isProTool(name) && !isPro()) {
    return undefined;
  }

  return tool;
}

/**
 * Check if a tool is blocked by license tier.
 * Returns true if the tool exists but requires Pro.
 */
export function isToolProGated(name: string): boolean {
  return toolRegistry.has(name) && isProTool(name) && !isPro();
}

/**
 * Get all tools (filtered by license tier)
 */
export function getAllTools(): ToolDefinition[] {
  const tools = Array.from(toolRegistry.values());
  if (isPro()) return tools;
  return tools.filter((t) => !isProTool(t.name));
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: string): ToolDefinition[] {
  return getAllTools().filter((tool) => tool.category === category);
}

/**
 * Check if a tool exists
 */
export function hasTool(name: string): boolean {
  return toolRegistry.has(name);
}

// Module tool arrays — each module owns its list; this file owns the
// composition. No per-module `register*Tools()` wrapper exists: the
// indirection added zero behaviour and cost an edit-per-module to maintain.
import { monitoringTools } from './monitoring/index.js';
import { securityTools } from './security/index.js';
import { seoTechnicalTools } from './seo-technical/index.js';
import { utilityTools } from './utilities/index.js';
import { googleTools } from './google/index.js';
import { performanceTools } from './performance/index.js';
import { reportsTools } from './reports/index.js';
import { accessibilityTools } from './accessibility/index.js';
import { cloudflareTools } from './integrations/cloudflare/index.js';
import { contentTools } from './content/index.js';
import { geoTools } from './geo/index.js';
import { fixTools } from './fix/index.js';
import { socialTools } from './social/index.js';
import { redditTools } from './reddit/index.js';
import { codingTools } from './coding/index.js';
import { videoTools } from './video/index.js';
import { metaTools } from './meta/index.js';

/**
 * Register every known tool into the global registry. Idempotent —
 * registering twice with the same name overwrites the prior entry, which
 * is benign because the entries are identical (they come from the same
 * module-level constants).
 */
export function registerAllTools(): void {
  const all = [
    ...monitoringTools,
    ...securityTools,
    ...seoTechnicalTools,
    ...utilityTools,
    ...googleTools,
    ...performanceTools,
    ...reportsTools,
    ...accessibilityTools,
    ...cloudflareTools,
    ...contentTools,
    ...geoTools,
    ...fixTools,
    ...socialTools,
    ...redditTools,
    ...codingTools,
    ...videoTools,
    ...metaTools,
  ];
  for (const tool of all) registerTool(tool);
}

// Export tool arrays for direct access
export {
  monitoringTools,
  securityTools,
  seoTechnicalTools,
  utilityTools,
  googleTools,
  performanceTools,
  reportsTools,
  accessibilityTools,
  cloudflareTools,
  contentTools,
  geoTools,
  fixTools,
  socialTools,
  redditTools,
  codingTools,
  videoTools,
  metaTools,
};

// Re-export tool modules
export * from './monitoring/index.js';
export * from './security/index.js';
export * from './seo-technical/index.js';
export * from './utilities/index.js';
export * from './google/index.js';
export * from './performance/index.js';
export * from './reports/index.js';
export * from './accessibility/index.js';
export * from './integrations/cloudflare/index.js';
export * from './content/index.js';
export * from './geo/index.js';
export * from './fix/index.js';
export * from './social/index.js';
export * from './reddit/index.js';
export * from './coding/index.js';
export * from './video/index.js';
export * from './meta/index.js';
