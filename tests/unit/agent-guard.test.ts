import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  tools: new Map(), stream: vi.fn(), save: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { stream: mocks.stream }; },
}));
vi.mock('../../src/dashboard/services/approval-storage.js', async () => {
  const { createTestApprovalStorage } = await import('../helpers/approval-storage.js');
  return { approvalStorage: createTestApprovalStorage() };
});
vi.mock('../../src/tools/index.js', () => ({
  getTool: (name: string) => mocks.tools.get(name),
  getAllTools: () => [...mocks.tools.values()],
}));
vi.mock('../../src/dashboard/services/audit-log.js', () => ({
  auditLog: { append: vi.fn().mockResolvedValue(undefined) }, summarizeResult: () => 'executed',
}));
vi.mock('../../src/dashboard/services/agent-conversations.js', () => ({
  conversationStore: {
    create: async () => ({ id: 'conversation-a', siteId: null, title: 'test', messages: [],
      createdAt: '', updatedAt: '', totalInputTokens: 0, totalOutputTokens: 0,
      totalCacheReadTokens: 0, totalCacheCreationTokens: 0 }),
    save: mocks.save,
  },
}));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: { get: async (id: string) => ({ id, primaryUrl: 'https://client-a.test/', bindings: { adsCustomerId: '1111111111' } }) } }));
vi.mock('../../src/dashboard/services/gsc-signals.js', () => ({ signalsRepo: {} }));
vi.mock('../../src/dashboard/services/agent-catalog.js', () => ({ formatSignalsForPrompt: () => '' }));

import { runAgentTurn, type AgentEvent } from '../../src/dashboard/services/agent.js';
import * as approvals from '../../src/dashboard/services/approval-gate.js';

let handler: ReturnType<typeof vi.fn>;
function modelStream(withTool: boolean) {
  return {
    async *[Symbol.asyncIterator]() {
      if (!withTool) return;
      yield { type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'tool-use-a', name: 'ads_create_campaign' } };
      yield { type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"customerId":"1111111111"}' } };
      yield { type: 'content_block_stop', index: 0 };
    },
    finalMessage: async () => ({ stop_reason: withTool ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 } }),
  };
}
beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-real-key');
  vi.stubEnv('SANDI_ADS_SITE_ID', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  vi.stubEnv('MUTATIONS_ENABLED', 'true');
  vi.stubEnv('MUTATIONS_ADS', '');
  vi.stubEnv('MUTATIONS_AUTOAPPLY', '');
  mocks.stream.mockReset();
  mocks.stream.mockReturnValueOnce(modelStream(true)).mockReturnValueOnce(modelStream(false));
  mocks.save.mockClear();
  mocks.tools.clear();
  handler = vi.fn().mockResolvedValue({ campaignId: 'new-campaign' });
  mocks.tools.set('ads_create_campaign', { name: 'ads_create_campaign', description: 'test',
    category: 'google', inputSchema: z.object({ customerId: z.string() }), handler });
});
afterEach(async () => {
  for (const pending of await approvals.list()) await approvals.resolve(pending.id, false, undefined, pending.source.siteId);
  vi.unstubAllEnvs();
});

it.each([true, false])('real agent loop preserves approval and result events: approve=%s', async (approve) => {
  const events: AgentEvent[] = [];
  const result = await runAgentTurn({ conversationId: null, siteId: null, userMessage: 'Crear campaña' }, (event) => {
    events.push(event);
    if (event.type === 'approval_required') {
      expect(handler).not.toHaveBeenCalled();
      void approvals.list().then(entries => expect(entries[0].source).toMatchObject({ kind: 'agent', conversationId: 'conversation-a' }));
      void vi.waitFor(async () => expect(await approvals.list()).toHaveLength(1)).then(async () => {
        expect(await approvals.resolve(event.id, approve, undefined, process.env.SANDI_ADS_SITE_ID)).toBe(true);
      });
    }
  });
  expect(events).toContainEqual(expect.objectContaining({ type: 'approval_required', name: 'ads_create_campaign' }));
  expect(events.at(-1)).toMatchObject({ type: 'done', conversationId: 'conversation-a' });
  expect(handler).toHaveBeenCalledTimes(approve ? 1 : 0);
  if (approve) {
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', toolUseId: 'tool-use-a', isError: false }));
  } else {
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use_denied', id: 'tool-use-a' }));
    expect(result.conversation.messages.flatMap((message) => message.content))
      .toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'tool-use-a', is_error: true }));
  }
  expect(mocks.save).toHaveBeenCalled();
});
it('real agent loop blocks writes even when the model requests a filtered-out tool', async () => {
  vi.stubEnv('MUTATIONS_ENABLED', 'false');
  const events: AgentEvent[] = [];
  await runAgentTurn({ conversationId: null, siteId: null, userMessage: 'Crear campaña' }, (event) => events.push(event));
  expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use_blocked', id: 'tool-use-a' }));
  expect(events.some((event) => event.type === 'approval_required')).toBe(false);
  expect(handler).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({ type: 'done' });
});
