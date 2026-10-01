import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  tools: new Map(),
  audit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/dashboard/services/approval-storage.js', async () => {
  const { createTestApprovalStorage } = await import('../helpers/approval-storage.js');
  return { approvalStorage: createTestApprovalStorage() };
});
vi.mock('../../src/tools/index.js', () => ({
  getTool: (name: string) => mocks.tools.get(name),
  getAllTools: () => [...mocks.tools.values()],
  registerAllTools: vi.fn(),
  isToolProGated: () => false,
}));
vi.mock('../../src/dashboard/services/audit-log.js', () => ({
  auditLog: { append: mocks.audit },
  summarizeResult: () => 'executed',
}));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: {
  get: async (id: string) => ({ id, primaryUrl: 'https://client-a.test/', bindings: { adsCustomerId: '1111111111' } }),
} }));
vi.mock('../../src/auth/index.js', () => ({ authManager: { initialize: vi.fn() } }));
vi.mock('../../src/licensing/index.js', () => ({ isPro: () => false }));
vi.mock('../../src/dashboard/services/dashboard-suggest.js', () => ({
  streamSuggestions: vi.fn(), isSuggestConfigured: () => false,
}));
vi.mock('../../src/dashboard/services/agent.js', () => ({
  runAgentTurn: vi.fn(), isAgentConfigured: () => false,
}));
vi.mock('../../src/dashboard/services/agent-conversations.js', () => ({ conversationStore: {} }));

import { guardedExecute, type GuardedSource } from '../../src/dashboard/services/guarded-execution.js';
import * as approvals from '../../src/dashboard/services/approval-gate.js';
import { executeToolByName } from '../../src/dashboard/services/dashboard-data.js';
import { isMutationAllowed, isMutatingTool } from '../../src/dashboard/services/mutations.js';
import { handleApiRoute } from '../../src/dashboard/routes/api.js';
import { handleAgentRoute } from '../../src/dashboard/routes/agent.js';
import { createServer } from '../../src/server.js';

const sources: GuardedSource[] = [
  { kind: 'mcp' }, { kind: 'http' },
  { kind: 'agent', conversationId: 'conversation-a' }, { kind: 'internal' },
];
let handler: ReturnType<typeof vi.fn>;

function httpRequest(path: string, body: unknown, authenticated = true): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, {
    method: 'POST', url: path,
    headers: authenticated ? { authorization: 'Bearer test-secret' } : {},
  }) as IncomingMessage;
}
function httpResponse() {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  return { res: res as unknown as ServerResponse, spies: res };
}
async function waitForApproval() {
  await vi.waitFor(async () => expect(await approvals.list()).toHaveLength(1));
  return (await approvals.list())[0];
}

beforeEach(() => {
  vi.stubEnv('SANDI_ADS_SITE_ID', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  vi.stubEnv('MUTATIONS_ENABLED', 'false');
  vi.stubEnv('MUTATIONS_ADS', '');
  vi.stubEnv('MUTATIONS_GSC', '');
  vi.stubEnv('MUTATIONS_INDEXING', '');
  vi.stubEnv('MUTATIONS_AUTOAPPLY', '');
  vi.stubEnv('DASHBOARD_API_KEY', 'test-secret');
  mocks.tools.clear();
  mocks.audit.mockClear();
  handler = vi.fn().mockResolvedValue({ success: true });
  for (const name of ['ads_create_campaign', 'gsc_submit_sitemap', 'gsc_list_sites',
    'fix_resubmit_sitemap', 'fix_submit_pages_to_index']) {
    mocks.tools.set(name, { name, description: name, category: 'google',
      inputSchema: z.object({ customerId: z.string(), amount: z.number().default(10) }), handler });
  }
});
afterEach(async () => {
  for (const pending of await approvals.list()) await approvals.resolve(pending.id, false, undefined, pending.source.siteId);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.each(sources)('shared guard: $kind', (source) => {
  it('blocks writes by default before calling the handler', async () => {
    const result = await guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source });
    expect(result.status).toBe('blocked');
    expect(handler).not.toHaveBeenCalled();
    expect(await approvals.list()).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }));
  });
  it('permits validated reads without approval', async () => {
    expect((await guardedExecute('gsc_list_sites', { customerId: '1111111111' }, { source })).status).toBe('success');
    expect(handler).toHaveBeenCalledWith({ customerId: '1111111111', amount: 10 }, expect.objectContaining({ sourceKind: source.kind }));
    expect(await approvals.list()).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('waits for explicit approval and executes exactly once', async () => {
    vi.stubEnv('MUTATIONS_ENABLED', 'true');
    const running = guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source });
    const pending = await waitForApproval();
    expect(pending.source.kind).toBe(source.kind);
    expect(handler).not.toHaveBeenCalled();
    expect(await approvals.resolve(pending.id, true, undefined, pending.source.siteId)).toBe(true);
    expect(await approvals.resolve(pending.id, true, undefined, pending.source.siteId)).toBe(false);
    expect((await running).status).toBe('success');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
  });
  it('never executes a denied request', async () => {
    vi.stubEnv('MUTATIONS_ENABLED', 'true');
    const running = guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source });
    await approvals.resolve((await waitForApproval()).id, false, 'No autorizado', process.env.SANDI_ADS_SITE_ID);
    expect((await running).status).toBe('denied');
    expect(handler).not.toHaveBeenCalled();
  });
  it('rechecks the kill switch after approval', async () => {
    vi.stubEnv('MUTATIONS_ENABLED', 'true');
    const running = guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source });
    const pending = await waitForApproval();
    vi.stubEnv('MUTATIONS_ADS', 'false');
    await approvals.resolve(pending.id, true, undefined, pending.source.siteId);
    expect((await running).status).toBe('blocked');
    expect(handler).not.toHaveBeenCalled();
  });
});

it('validates before requesting approval and preserves structured errors', async () => {
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  const result = await guardedExecute('ads_create_campaign', {}, { source: sources[0] });
  expect(result.errorDetails?.code).toBe('INVALID_PARAMS');
  expect(handler).not.toHaveBeenCalled();
  expect(await approvals.list()).toEqual([]);
  await expect(executeToolByName('gsc_list_sites', {})).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});
it('protects the generic helper and returns handler failures', async () => {
  await expect(executeToolByName('ads_create_campaign', { customerId: '1111111111' }))
    .rejects.toMatchObject({ code: 'RESOURCE_ACCESS_DENIED' });
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  vi.stubEnv('MUTATIONS_AUTOAPPLY', 'ads_create_campaign');
  handler.mockRejectedValueOnce(new Error('provider failed'));
  expect(await guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source: sources[0] }))
    .toMatchObject({ status: 'error', error: 'provider failed' });
  expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
});
it('applies explicit auto-approval equally but never overrides disabled writes', async () => {
  vi.stubEnv('MUTATIONS_AUTOAPPLY', 'ads_create_campaign');
  for (const source of sources) {
    expect((await guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source })).status).toBe('blocked');
  }
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  for (const source of sources) {
    expect((await guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source })).status).toBe('success');
  }
  expect(await approvals.list()).toEqual([]);
});
it('binds approval to immutable snapshots of the validated input', async () => {
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  const input = { customerId: '1111111111', amount: 10 };
  const running = guardedExecute('ads_create_campaign', input, { source: sources[0] });
  const pending = await waitForApproval();
  input.customerId = '2222222222';
  (pending.action.input as typeof input).amount = 1_000_000;
  expect((await approvals.list())[0].action.input).toEqual({ customerId: '1111111111', amount: 10 });
  await approvals.resolve(pending.id, true, undefined, pending.source.siteId);
  await running;
  expect(handler).toHaveBeenCalledWith({ customerId: '1111111111', amount: 10 }, expect.anything());
});
it('denies unattended requests after five minutes', async () => {
  vi.useFakeTimers();
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  const running = guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source: sources[0] });
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect((await running).status).toBe('denied');
  expect(handler).not.toHaveBeenCalled();
  expect(await approvals.list()).toEqual([]);
});
it('classifies remediation aliases as writes with their underlying service policies', async () => {
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  vi.stubEnv('MUTATIONS_GSC', 'false');
  vi.stubEnv('MUTATIONS_INDEXING', 'false');
  for (const name of ['fix_resubmit_sitemap', 'fix_submit_pages_to_index']) {
    expect(isMutatingTool(name)).toBe(true);
    expect(isMutationAllowed(name)).toBe(false);
    await expect(executeToolByName(name, { customerId: '1111111111' })).rejects.toMatchObject({ code: 'RESOURCE_ACCESS_DENIED' });
  }
  expect(handler).not.toHaveBeenCalled();
});
it('rejects unavailable tools without executing or requesting approval', async () => {
  expect(await guardedExecute('unknown_tool', {}, { source: sources[0] }))
    .toMatchObject({ status: 'error', errorDetails: { code: 'NOT_IMPLEMENTED' } });
  expect(handler).not.toHaveBeenCalled();
});
it('MCP transport cannot bypass the guard and supports dashboard approval', async () => {
  const server = await createServer();
  const client = new Client({ name: 'guard-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const blocked = await client.callTool({ name: 'ads_create_campaign', arguments: { customerId: '1111111111' } });
    expect(blocked.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    vi.stubEnv('MUTATIONS_ENABLED', 'true');
    const running = client.callTool({ name: 'ads_create_campaign', arguments: { customerId: '1111111111' } });
    const pending = await waitForApproval();
    expect(pending.source.kind).toBe('mcp');
    expect(handler).not.toHaveBeenCalled();
    await approvals.resolve(pending.id, true, undefined, pending.source.siteId);
    expect((await running).isError).not.toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});
it('authenticated HTTP waits for approval; non-boolean approvals cannot authorize it', async () => {
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  const response = httpResponse();
  const running = handleApiRoute(httpRequest('/api/tool/ads_create_campaign', { customerId: '1111111111' }),
    response.res, '/api/tool/ads_create_campaign');
  const pending = await waitForApproval();
  expect(handler).not.toHaveBeenCalled();
  const bad = httpResponse();
  await handleAgentRoute(httpRequest('/api/agent/approve', { toolUseId: pending.id, approve: 'false' }), bad.res, '/api/agent/approve');
  expect(bad.spies.writeHead).toHaveBeenCalledWith(400, expect.anything());
  expect(await approvals.list()).toHaveLength(1);
  const accepted = httpResponse();
  await handleAgentRoute(httpRequest('/api/agent/approve', { toolUseId: pending.id, approve: true }), accepted.res, '/api/agent/approve');
  await running;
  expect(response.spies.writeHead).toHaveBeenCalledWith(200, expect.anything());
  expect(handler).toHaveBeenCalledTimes(1);
});
it('HTTP denial returns 403, not a successful empty result', async () => {
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  const response = httpResponse();
  const running = handleApiRoute(httpRequest('/api/tool/ads_create_campaign', { customerId: '1111111111' }), response.res, '/api/tool/ads_create_campaign');
  await approvals.resolve((await waitForApproval()).id, false, undefined, process.env.SANDI_ADS_SITE_ID);
  await running;
  expect(response.spies.writeHead).toHaveBeenCalledWith(403, expect.anything());
  expect(handler).not.toHaveBeenCalled();
});
it('HTTP still rejects unauthenticated callers before creating approvals', async () => {
  const response = httpResponse();
  await handleApiRoute(httpRequest('/api/tool/ads_create_campaign', { customerId: '1111111111' }, false), response.res, '/api/tool/ads_create_campaign');
  expect(response.spies.writeHead).toHaveBeenCalledWith(401, expect.anything());
  expect(await approvals.list()).toEqual([]);
  expect(handler).not.toHaveBeenCalled();
});

it.each(sources)('client-A session cannot write client B even with auto-approval: $kind', async (source) => {
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  vi.stubEnv('MUTATIONS_AUTOAPPLY', 'ads_create_campaign');
  const result = await guardedExecute('ads_create_campaign', { customerId: '2222222222' }, { source });
  expect(result).toMatchObject({ status: 'blocked', errorDetails: { code: 'RESOURCE_ACCESS_DENIED' } });
  expect(handler).not.toHaveBeenCalled();
  expect(await approvals.list()).toEqual([]);
});
it('configured client is required even when the caller supplies a site', async () => {
  vi.stubEnv('SANDI_ADS_SITE_ID', '');
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  const result = await guardedExecute('ads_create_campaign', { customerId: '1111111111' },
    { source: { kind: 'http', siteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  expect(result.status).toBe('blocked');
  expect(handler).not.toHaveBeenCalled();
});
it('HTTP x-site-id cannot switch the server-pinned client', async () => {
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  const req = httpRequest('/api/tool/ads_create_campaign', { customerId: '2222222222' });
  req.headers['x-site-id'] = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const response = httpResponse();
  await handleApiRoute(req, response.res, '/api/tool/ads_create_campaign');
  expect(response.spies.writeHead).toHaveBeenCalledWith(403, expect.anything());
  expect(handler).not.toHaveBeenCalled();
  expect(await approvals.list()).toEqual([]);
});
it('changing the pinned client during approval prevents execution', async () => {
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  const running = guardedExecute('ads_create_campaign', { customerId: '1111111111' }, { source: sources[0] });
  const pending = await waitForApproval();
  vi.stubEnv('SANDI_ADS_SITE_ID', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await approvals.resolve(pending.id, true, undefined, pending.source.siteId);
  expect((await running).status).toBe('blocked');
  expect(handler).not.toHaveBeenCalled();
});
describe('input siteId must match the session client', () => {
  const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  beforeEach(() => {
    mocks.tools.set('site_read', { name: 'site_read', description: 'r', category: 'google',
      inputSchema: z.object({ siteId: z.string() }), handler });
  });
  it.each([
    { kind: 'agent', conversationId: 'conversation-a', siteId: siteA },
    { kind: 'http', siteId: siteA },
  ] as GuardedSource[])('$kind session for A cannot run a (read) tool targeting B', async (source) => {
    const r = await guardedExecute('site_read', { siteId: siteB }, { source });
    expect(r.status).toBe('denied');
    expect(r.error).toBe('La herramienta apunta a otro cliente distinto al de esta sesión.');
    expect(handler).not.toHaveBeenCalled();
  });
  it('same client runs and the handler receives the source context', async () => {
    const r = await guardedExecute('site_read', { siteId: siteA },
      { source: { kind: 'agent', conversationId: 'conversation-a', siteId: siteA } });
    expect(r.status).toBe('success');
    expect(handler).toHaveBeenCalledWith({ siteId: siteA }, { sourceKind: 'agent', siteId: siteA });
  });
  it('a source without a client keeps the tool-level checks only', async () => {
    expect((await guardedExecute('site_read', { siteId: siteB }, { source: { kind: 'mcp' } })).status).toBe('success');
  });
});
