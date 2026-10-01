/**
 * Dashboard data orchestration layer
 *
 * All tool calls use the shared protected execution boundary.
 */

import { getAllTools } from '../../tools/index.js';
import { MCPError, ErrorCode } from '../../types/errors.js';
import { guardedExecute, type GuardedExecutionContext } from './guarded-execution.js';
import type { DashboardOverviewOutput } from '../../types/dashboard.js';

/**
 * Get unified dashboard data for a URL
 */
export async function getDashboardData(url: string): Promise<DashboardOverviewOutput> {
  return executeToolByName<DashboardOverviewOutput>('dashboard_overview', { url });
}

/**
 * Get a specific report by type
 */
export async function getReportData(
  type: 'site-health' | 'seo-audit' | 'executive-summary',
  params: Record<string, unknown>,
): Promise<unknown> {
  const toolNames: Record<string, string> = {
    'site-health': 'report_site_health',
    'seo-audit': 'report_seo_audit',
    'executive-summary': 'report_executive_summary',
  };

  const toolName = toolNames[type];
  if (!toolName) {
    throw new MCPError({
      code: ErrorCode.INVALID_PARAMS,
      message: `Unknown report type: ${type}`,
      retryable: false,
    });
  }

  return executeToolByName(toolName, params);
}

/**
 * Protected convenience wrapper for background jobs, reports and agent runners.
 * No raw execution API is exposed here: even callers without explicit context
 * must obey the same mutation policy and approval gate.
 */
export async function executeToolByName<T = unknown>(
  name: string,
  input: unknown,
  context: GuardedExecutionContext = { source: { kind: 'internal' } },
): Promise<T> {
  const guarded = await guardedExecute<T>(name, input, context);
  if (guarded.status !== 'success') {
    throw new MCPError(guarded.errorDetails ?? {
      code: guarded.status === 'error' ? ErrorCode.INTERNAL_ERROR : ErrorCode.RESOURCE_ACCESS_DENIED,
      message: guarded.error ?? 'No se pudo ejecutar la herramienta.',
      retryable: false,
    });
  }
  return guarded.result as T;
}

/**
 * List all available tools with metadata
 */
export function listTools(): { name: string; description: string; category: string }[] {
  return getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: tool.category,
  }));
}
