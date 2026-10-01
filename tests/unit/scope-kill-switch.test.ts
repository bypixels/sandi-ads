import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
const mocks = vi.hoisted(() => ({ tools: new Map(), sites: new Map(), provider: vi.fn() }));
vi.mock('../../src/dashboard/services/approval-storage.js', async () => {
  const { createTestApprovalStorage } = await import('../helpers/approval-storage.js');
  return { approvalStorage: createTestApprovalStorage() };
});
vi.mock('../../src/tools/index.js', () => ({
  getTool: (name: string) => mocks.tools.get(name), getAllTools: () => [...mocks.tools.values()],
  registerAllTools: vi.fn(), isToolProGated: () => false,
}));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({
  sitesStore: { get: async (id: string) => structuredClone(mocks.sites.get(id)) },
}));
vi.mock('../../src/dashboard/services/audit-log.js', () => ({
  auditLog: { append: vi.fn().mockResolvedValue(undefined) }, summarizeResult: () => '',
}));
vi.mock('../../src/auth/index.js', () => ({ authManager: { initialize: vi.fn() } }));
vi.mock('../../src/licensing/index.js', () => ({ isPro: () => false }));
vi.mock('../../src/dashboard/services/dashboard-suggest.js', () => ({ isSuggestConfigured: () => false }));
import { createServer } from '../../src/server.js';
import { handleApiRoute } from '../../src/dashboard/routes/api.js';
import { guardedExecute } from '../../src/dashboard/services/guarded-execution.js';
import * as approvals from '../../src/dashboard/services/approval-gate.js';

const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
beforeEach(() => {
  vi.stubEnv('SANDI_ADS_SITE_ID', siteA);
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  vi.stubEnv('MUTATIONS_ADS', '');
  vi.stubEnv('MUTATIONS_AUTOAPPLY', 'ads_create_campaign');
  vi.stubEnv('DASHBOARD_API_KEY', 'test-secret');
  mocks.sites.clear();
  for (const [id, customerId] of [[siteA, '1111111111'], [siteB, '2222222222']]) {
    mocks.sites.set(id, { id, primaryUrl: 'https://client.test/', bindings: { adsCustomerId: customerId } });
  }
  // Same simulated identity can access both accounts: a Google permission
  // error must NOT be what makes the cross-client test pass.
  mocks.provider.mockReset().mockImplementation(async (input: { customerId: string }) => {
    if (!['1111111111', '2222222222'].includes(input.customerId)) throw new Error('Unknown account');
    return { campaignId: 'created', customerId: input.customerId };
  });
  mocks.tools.clear();
  mocks.tools.set('ads_create_campaign', { name: 'ads_create_campaign', category: 'google', description: 'test',
    inputSchema: z.object({ customerId: z.string() }), handler: mocks.provider });
});
afterEach(async () => {
  for (const pending of await approvals.list()) await approvals.resolve(pending.id, false, undefined, pending.source.siteId);
  vi.unstubAllEnvs();
});
it('actual MCP transport rejects B before invoking a provider authorized for A and B', async () => {
  await expect(mocks.provider({ customerId: '2222222222' })).resolves.toMatchObject({ customerId: '2222222222' });
  mocks.provider.mockClear();
  const server = await createServer();
  const client = new Client({ name: 'scope-kill-switch', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const denied = await client.callTool({ name: 'ads_create_campaign', arguments: { customerId: '2222222222' } });
    expect(denied.isError).toBe(true);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(await approvals.list()).toEqual([]);
    const own = await client.callTool({ name: 'ads_create_campaign', arguments: { customerId: '1111111111' } });
    expect(own.isError).not.toBe(true);
    expect(mocks.provider).toHaveBeenCalledTimes(1);
  } finally { await client.close(); await server.close(); }
});
it.each([siteA, siteB])('authenticated HTTP cannot use header %s to write B', async (header) => {
  const req = Object.assign(Readable.from([Buffer.from('{"customerId":"2222222222"}')]), {
    method: 'POST', url: '/api/tool/ads_create_campaign', headers: { authorization: 'Bearer test-secret', 'x-site-id': header },
  }) as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await handleApiRoute(req, res as unknown as ServerResponse, '/api/tool/ads_create_campaign');
  expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
  expect(mocks.provider).not.toHaveBeenCalled();
});
it.each(['rebind', 'delete'])('changing trusted site bindings during approval stops the write: %s', async (change) => {
  vi.stubEnv('MUTATIONS_AUTOAPPLY', '');
  const running = guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source: { kind: 'mcp' } });
  await vi.waitFor(async () => expect(await approvals.list()).toHaveLength(1));
  const pending = (await approvals.list())[0];
  if (change === 'delete') mocks.sites.delete(siteA);
  else mocks.sites.get(siteA).bindings.adsCustomerId = '2222222222';
  await approvals.resolve(pending.id, true, undefined, pending.source.siteId);
  expect((await running).status).toBe('blocked');
  expect(mocks.provider).not.toHaveBeenCalled();
});
