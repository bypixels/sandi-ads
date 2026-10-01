/**
 * Mandatory tool execution boundary for MCP, HTTP, agents and internal callers.
 * Owns validation, mutation policy, per-action approval and mutation auditing.
 * Transport authentication never substitutes for approval. Existing explicit
 * MUTATIONS_AUTOAPPLY exceptions apply equally to every caller.
 */

import { getTool } from '../../tools/index.js';
import { MCPError, ErrorCode, type MCPErrorDetails } from '../../types/errors.js';
import { getPinnedSiteId } from '../auth.js';
import { assertMutationScope } from './mutation-scope.js';
import { isMutatingTool, isMutationAllowed, isAutoApproved } from './mutations.js';
import * as approvalGate from './approval-gate.js';
import { auditLog, summarizeResult } from './audit-log.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('guarded-execution');

export type GuardedSource =
  | { kind: 'http' | 'mcp' | 'internal'; siteId?: string }
  | { kind: 'agent'; conversationId: string; siteId?: string };

export interface GuardedExecutionContext {
  source: GuardedSource;
}

export interface GuardedExecutionHooks {
  onPolicyBlock?: (reason: string) => void;
  /** Approval ids can also be discovered through the authenticated pending list. */
  onApprovalRequired?: (approvalId: string) => void;
  onUserDenied?: (reason: string) => void;
}

export type GuardedStatus = 'success' | 'blocked' | 'denied' | 'error';

export interface GuardedResult<T = unknown> {
  status: GuardedStatus;
  result?: T;
  error?: string;
  errorDetails?: MCPErrorDetails;
  durationMs: number;
}

const POLICY_BLOCK_REASON =
  'Las escrituras están deshabilitadas. Habilítelas con MUTATIONS_ENABLED=true o la opción del servicio.';

export async function guardedExecute<T = unknown>(
  toolName: string,
  input: unknown,
  context: GuardedExecutionContext,
  hooks: GuardedExecutionHooks = {},
): Promise<GuardedResult<T>> {
  const startedAt = Date.now();
  const mutating = isMutatingTool(toolName);
  const source = { ...context.source };
  const requestedSiteId = source.siteId;
  const configuredSiteId = getPinnedSiteId()?.trim();
  let executionInput: unknown = input;

  const record = async (status: 'success' | 'error' | 'blocked', error?: string, result?: unknown) => {
    if (!mutating) return;
    await auditLog.append({
      timestamp: new Date(startedAt).toISOString(),
      tool: toolName,
      siteId: source.siteId,
      input: executionInput,
      status,
      durationMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
      ...(status === 'success' ? { resultSummary: summarizeResult(result) } : {}),
    });
  };

  const block = async (): Promise<GuardedResult<T>> => {
    await record('blocked', POLICY_BLOCK_REASON);
    hooks.onPolicyBlock?.(POLICY_BLOCK_REASON);
    return { status: 'blocked', error: POLICY_BLOCK_REASON, durationMs: Date.now() - startedAt };
  };

  try {
    const tool = getTool(toolName);
    if (!tool) {
      throw new MCPError({
        code: ErrorCode.NOT_IMPLEMENTED,
        message: `Herramienta no disponible: ${toolName}`,
        retryable: false,
      });
    }
    const parsed = tool.inputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new MCPError({
        code: ErrorCode.INVALID_PARAMS,
        message: `Parámetros inválidos: ${parsed.error.message}`,
        details: { errors: parsed.error.errors },
        retryable: false,
      });
    }
    // Bind approval to a private snapshot, not the caller's mutable object.
    executionInput = structuredClone(parsed.data);

    if (mutating && !isMutationAllowed(toolName)) return await block();

    if (mutating) {
      source.siteId = await assertMutationScope(toolName, executionInput, configuredSiteId, requestedSiteId);
    }

    if (mutating && !isAutoApproved(toolName)) {
      const { id, decision: pendingDecision } = approvalGate.request({
        source,
        action: { tool: toolName, input: structuredClone(executionInput) },
      });
      hooks.onApprovalRequired?.(id);
      const decision = await pendingDecision;
      if (!decision.approve) {
        const reason = decision.reason || 'Acción denegada por el usuario';
        await record('blocked', 'denied: ' + reason);
        hooks.onUserDenied?.(reason);
        return { status: 'denied', error: reason, durationMs: Date.now() - startedAt };
      }
    }

    // A kill switch changed while approval was pending must still stop execution.
    if (mutating && !isMutationAllowed(toolName)) return await block();
    if (mutating) {
      if (getPinnedSiteId()?.trim() !== configuredSiteId) {
        throw new MCPError({ code: ErrorCode.RESOURCE_ACCESS_DENIED,
          message: 'El cliente autorizado cambió mientras la operación estaba pendiente.', retryable: false });
      }
      await assertMutationScope(toolName, executionInput, configuredSiteId, requestedSiteId);
      if (!isMutationAllowed(toolName)) return await block();
    }
    if (getTool(toolName) !== tool) {
      throw new MCPError({
        code: ErrorCode.RESOURCE_ACCESS_DENIED,
        message: 'La herramienta cambió o dejó de estar disponible antes de ejecutarse.',
        retryable: false,
      });
    }
    const result = await tool.handler(executionInput) as T;
    await record('success', undefined, result);
    return { status: 'success', result, durationMs: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const accessDenied = err instanceof MCPError && err.code === ErrorCode.RESOURCE_ACCESS_DENIED;
    await record(accessDenied ? 'blocked' : 'error', message);
    if (accessDenied) hooks.onPolicyBlock?.(message);
    log.debug('guarded tool execution failed', { tool: toolName, error: message });
    return {
      status: accessDenied ? 'blocked' : 'error',
      error: message,
      ...(err instanceof MCPError ? { errorDetails: err.toJSON() } : {}),
      durationMs: Date.now() - startedAt,
    };
  }
}
