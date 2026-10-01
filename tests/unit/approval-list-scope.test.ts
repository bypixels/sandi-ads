import { expect, it, vi } from 'vitest';
import { createApprovalGate } from '../../src/dashboard/services/approval-gate.js';
import { createTestApprovalStorage } from '../helpers/approval-storage.js';
const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const mk = (siteId: string) => ({ source: { kind: 'mcp' as const, siteId }, action: { tool: 'test_write', input: {} } });

it('lists approvals of every client with siteId and expiresAt, and filters by siteId on demand', async () => {
  const gate = createApprovalGate(createTestApprovalStorage(), { pollMs: 1 });
  const a = gate.request(mk(siteA));
  const b = gate.request(mk(siteB));
  await vi.waitFor(async () => expect(await gate.list()).toHaveLength(2));
  const all = await gate.list();
  for (const item of all) {
    expect([siteA, siteB]).toContain(item.siteId);
    expect(item.expiresAt).toBeGreaterThan(Date.now());
  }
  expect(await gate.list({ siteId: siteB })).toHaveLength(1);
  // Approving client B's item uses B's own siteId regardless of any "active" site
  expect(await gate.resolve(b.id, true, undefined, siteA)).toBe(false);
  expect(await gate.resolve(b.id, true, undefined, siteB)).toBe(true);
  await gate.resolve(a.id, false, undefined, siteA);
  await Promise.all([a.decision, b.decision]);
});

it('postgres list() selects siteId and expiresAt as numbers', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ id: 'x', source: { kind: 'mcp', siteId: siteB }, action: { tool: 't', input: {} }, siteId: siteB, createdAt: '1000', expiresAt: '301000' }] });
  vi.resetModules();
  vi.doMock('../../src/db/index.js', () => ({ getPool: () => ({ query }) }));
  const { approvalStorage } = await import('../../src/dashboard/services/approval-storage.js');
  const rows = await approvalStorage.list();
  expect(String(query.mock.calls[0][0])).toMatch(/site_id AS "siteId"/);
  expect(String(query.mock.calls[0][0])).toMatch(/expires_at\) \* 1000 AS "expiresAt"/);
  expect(rows[0]).toMatchObject({ siteId: siteB, createdAt: 1000, expiresAt: 301000 });
  vi.doUnmock('../../src/db/index.js');
});
