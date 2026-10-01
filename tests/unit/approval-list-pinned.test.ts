import { afterEach, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const gate = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn() }));
vi.mock('../../src/dashboard/auth.js', async (orig) => ({
  ...(await orig<typeof import('../../src/dashboard/auth.js')>()),
  authenticateRequest: () => ({ authenticated: true, role: 'admin' }),
}));
vi.mock('../../src/dashboard/services/approval-gate.js', () => gate);

const { handleAgentRoute } = await import('../../src/dashboard/routes/agent.js');
const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function list(query = '') {
  gate.list.mockResolvedValue([]);
  const req = { method: 'GET', url: '/api/agent/pending-approvals' + query, headers: { host: 'localhost' } } as IncomingMessage;
  const res = { writeHead: () => {}, setHeader: () => {}, end: () => {} } as unknown as ServerResponse;
  await handleAgentRoute(req, res, '/api/agent/pending-approvals');
  return gate.list.mock.calls.at(-1)?.[0];
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('admin on a pinned instance is filtered to the pinned site even without or against ?siteId', async () => {
  vi.stubEnv('SANDI_ADS_SITE_ID', siteA);
  expect((await list()).siteId).toBe(siteA);
  expect((await list(`?siteId=${siteB}`)).siteId).toBe(siteA);
});

it('admin without a pin keeps using the query siteId', async () => {
  vi.stubEnv('SANDI_ADS_SITE_ID', '');
  vi.stubEnv('WEBSITE_OPS_SITE_ID', '');
  expect((await list(`?siteId=${siteB}`)).siteId).toBe(siteB);
  expect((await list()).siteId).toBeUndefined();
});
