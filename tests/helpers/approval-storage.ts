import type { ApprovalStorage, StoredApproval } from '../../src/dashboard/services/approval-storage.js';
import type { ApprovalDecision } from '../../src/dashboard/services/approval-gate.js';

/** Shared fake database, not a gate mock: independent requesters still poll the storage. */
export function createTestApprovalStorage(): ApprovalStorage {
  const rows = new Map<string, StoredApproval & { decision?: ApprovalDecision; consumed?: boolean }>();
  return {
    async insert(row) { rows.set(row.id, structuredClone(row)); },
    async list() { return structuredClone([...rows.values()].filter(r => !r.decision && r.expiresAt > Date.now())); },
    async decide(id, approve, reason, siteId) {
      const row = rows.get(id);
      if (!row || row.siteId !== siteId || row.decision || row.expiresAt <= Date.now()) return false;
      row.decision = { approve, reason }; return true;
    },
    async consume(id, ownerId) {
      const row = rows.get(id);
      if (!row || row.ownerId !== ownerId || row.consumed || row.expiresAt <= Date.now() || !row.decision) return null;
      row.consumed = true; return structuredClone(row.decision);
    },
  };
}
