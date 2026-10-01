import { getPool } from '../../db/index.js';
import type { ApprovalDecision, PendingApproval } from './approval-gate.js';

export interface StoredApproval extends PendingApproval { siteId: string; ownerId: string; expiresAt: number }
export interface ApprovalStorage {
  insert(entry: StoredApproval): Promise<void>;
  list(): Promise<PendingApproval[]>;
  decide(id: string, approve: boolean, reason?: string, siteId?: string): Promise<boolean>;
  consume(id: string, ownerId: string): Promise<ApprovalDecision | null>;
}

export const approvalStorage: ApprovalStorage = {
  async insert(e) {
    await getPool().query(`INSERT INTO pending_approvals
      (id, site_id, owner_id, source, action, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,to_timestamp($6 / 1000.0),to_timestamp($7 / 1000.0))`,
    [e.id, e.siteId, e.ownerId, JSON.stringify(e.source), JSON.stringify(e.action), e.createdAt, e.expiresAt]);
  },
  async list() {
    const result = await getPool().query(`SELECT id, source, action,
      site_id AS "siteId", extract(epoch FROM created_at) * 1000 AS "createdAt",
      extract(epoch FROM expires_at) * 1000 AS "expiresAt" FROM pending_approvals
      WHERE status = 'pending' AND expires_at > now() ORDER BY created_at`);
    return result.rows.map(r => ({ ...r, createdAt: Number(r.createdAt), expiresAt: Number(r.expiresAt) })) as PendingApproval[];
  },
  async decide(id, approve, reason, siteId) {
    if (!siteId) return false;
    const result = await getPool().query(`UPDATE pending_approvals SET status='decided', decision=$2
      WHERE id=$1 AND site_id=$3 AND status='pending' AND expires_at > now() RETURNING id`,
    [id, JSON.stringify({ approve, reason }), siteId]);
    return result.rowCount === 1;
  },
  async consume(id, ownerId) {
    const result = await getPool().query(`UPDATE pending_approvals SET status='consumed'
      WHERE id=$1 AND owner_id=$2 AND status='decided' AND expires_at > now() RETURNING decision`, [id, ownerId]);
    return (result.rows[0]?.decision as ApprovalDecision | undefined) ?? null;
  },
};
