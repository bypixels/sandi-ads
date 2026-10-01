/** Shared durable approval inbox. Only the original live caller executes an approved action. */
import { randomUUID } from 'node:crypto';
import { approvalStorage, type ApprovalStorage } from './approval-storage.js';

export type ApprovalSource =
  | { kind: 'agent'; conversationId: string; siteId?: string }
  | { kind: 'monitor'; signalId: string; siteId?: string }
  | { kind: 'http' | 'mcp' | 'internal'; siteId?: string };
export interface ApprovalAction { tool: string; input: unknown }
export interface ApprovalDecision { approve: boolean; reason?: string }
export interface PendingApproval {
  id: string; source: ApprovalSource; action: ApprovalAction; createdAt: number;
}

export function createApprovalGate(storage: ApprovalStorage, options: { timeoutMs?: number; pollMs?: number } = {}) {
  const ownerId = randomUUID();
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollMs = options.pollMs ?? 250;
  function request(args: { source: ApprovalSource; action: ApprovalAction }): { id: string; decision: Promise<ApprovalDecision> } {
    const id = randomUUID();
    const snapshot = structuredClone(args);
    const createdAt = Date.now();
    const decision = (async (): Promise<ApprovalDecision> => {
      if (!snapshot.source.siteId) return { approve: false, reason: 'La aprobación requiere un sitio autorizado' };
      try {
        await storage.insert({ id, ...snapshot, siteId: snapshot.source.siteId, ownerId, createdAt, expiresAt: createdAt + timeoutMs });
        while (Date.now() < createdAt + timeoutMs) {
          const resolved = await storage.consume(id, ownerId);
          if (resolved) return resolved;
          await new Promise<void>(resolve => setTimeout(resolve, pollMs));
        }
        return { approve: false, reason: 'Tiempo de aprobación excedido' };
      } catch {
        return { approve: false, reason: 'No se pudo verificar la aprobación compartida' };
      }
    })();
    return { id, decision };
  }
  async function list(filter?: { conversationId?: string; signalId?: string; siteId?: string }): Promise<PendingApproval[]> {
    const entries = await storage.list();
    return structuredClone(entries.filter(e =>
      (filter?.siteId === undefined || e.source.siteId === filter.siteId) &&
      (filter?.conversationId === undefined || (e.source.kind === 'agent' && e.source.conversationId === filter.conversationId)) &&
      (filter?.signalId === undefined || (e.source.kind === 'monitor' && e.source.signalId === filter.signalId))));
  }
  async function resolve(id: string, approve: boolean, reason?: string, siteId?: string): Promise<boolean> {
    if (typeof approve !== 'boolean') return false;
    return storage.decide(id, approve, reason, siteId);
  }
  return { request, list, resolve };
}
const gate = createApprovalGate(approvalStorage);
export const request = gate.request;
export const list = gate.list;
export const resolve = gate.resolve;
