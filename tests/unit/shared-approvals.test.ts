import { expect, it, vi } from 'vitest';
import { createApprovalGate } from '../../src/dashboard/services/approval-gate.js';
import { createTestApprovalStorage } from '../helpers/approval-storage.js';
const siteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const args = { source: { kind: 'mcp' as const, siteId }, action: { tool: 'test_write', input: { x: 1 } } };
it('separate gates share pending approvals and only original live requester consumes decision once', async () => {
  const storage = createTestApprovalStorage();
  const mcp = createApprovalGate(storage, { pollMs: 1 });
  const dashboard = createApprovalGate(storage);
  const request = mcp.request(args);
  await vi.waitFor(async () => expect(await dashboard.list({ siteId })).toHaveLength(1));
  expect(await dashboard.resolve(request.id, true, undefined, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false);
  expect(await dashboard.resolve(request.id, true, undefined, siteId)).toBe(true);
  expect(await dashboard.resolve(request.id, false, undefined, siteId)).toBe(false);
  expect(await request.decision).toEqual({ approve: true, reason: undefined });
  expect(await dashboard.list()).toEqual([]);
  expect(await createApprovalGate(storage).list()).toEqual([]);
});
it('expires unattended and rejects subsequent decisions', async () => {
  const gate = createApprovalGate(createTestApprovalStorage(), { timeoutMs: 10, pollMs: 1 });
  const r = gate.request(args);
  expect(await r.decision).toMatchObject({ approve: false });
  expect(await gate.resolve(r.id, true, undefined, siteId)).toBe(false);
  expect(await gate.list()).toEqual([]);
});
it('fails closed if persistence is unavailable or site scope is missing', async () => {
  const storage = createTestApprovalStorage();
  storage.insert = async () => { throw new Error('offline'); };
  const gate = createApprovalGate(storage);
  expect(await gate.request(args).decision).toMatchObject({ approve: false });
  expect(await gate.request({ ...args, source: { kind: 'mcp' } }).decision).toMatchObject({ approve: false });
});
it('snapshots request inputs and only exposes independent pending copies', async () => {
  const gate = createApprovalGate(createTestApprovalStorage(), { pollMs: 1 });
  const input = structuredClone(args);
  const r = gate.request(input);
  input.action.input.x = 99;
  await vi.waitFor(async () => expect(await gate.list()).toHaveLength(1));
  const listed = await gate.list();
  (listed[0].action.input as { x: number }).x = 2;
  expect((await gate.list())[0].action.input).toEqual({ x: 1 });
  await gate.resolve(r.id, false, undefined, siteId);
  await r.decision;
});
