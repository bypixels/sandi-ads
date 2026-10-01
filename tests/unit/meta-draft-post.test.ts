import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const m = vi.hoisted(() => ({ createDraft: vi.fn() }));
vi.mock('../../src/dashboard/services/social-posts-store.js', async (orig) => ({
  ...(await orig<typeof import('../../src/dashboard/services/social-posts-store.js')>()),
  socialPostsStore: { createDraft: m.createDraft },
}));

const { metaDraftPostTool } = await import('../../src/tools/meta/posts.js');
const { metaTools } = await import('../../src/tools/meta/index.js');
const { registerAllTools, toolRegistry } = await import('../../src/tools/index.js');
const { isMutatingTool } = await import('../../src/dashboard/services/mutations.js');
const { SocialPostValidationError } = await import('../../src/dashboard/services/social-posts-store.js');
const { guardedExecute } = await import('../../src/dashboard/services/guarded-execution.js');

const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fetchMock = vi.fn();
const run = (input: unknown) => metaDraftPostTool.handler(metaDraftPostTool.inputSchema.parse(input));

beforeEach(() => {
  m.createDraft.mockReset().mockImplementation(async (d: Record<string, unknown>) => ({ id: 'p1', status: 'draft', ...d }));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('SANDI_ADS_SITE_ID', '');
  vi.stubEnv('WEBSITE_OPS_SITE_ID', '');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('meta_draft_post', () => {
  it('is registered with the meta tools and is NOT a mutating tool', () => {
    registerAllTools();
    expect(toolRegistry.has('meta_draft_post')).toBe(true);
    expect(metaTools).toContain(metaDraftPostTool);
    expect(isMutatingTool('meta_draft_post')).toBe(false);
  });
  it('no registered meta_ tool can approve', () => {
    registerAllTools();
    expect([...toolRegistry.keys()].filter(n => n.startsWith('meta_') && n.includes('approve'))).toEqual([]);
  });
  it('module source cannot reach Meta: no fetch, no Graph client, only the posts store', () => {
    const src = readFileSync(resolve('src/tools/meta/posts.ts'), 'utf-8');
    const imports = [...new Set([...src.matchAll(/from\s+'([^']+)'/g)].map(x => x[1]))].sort();
    expect(imports).toEqual(['../../dashboard/auth.js', '../../dashboard/services/social-posts-store.js', '../../types/errors.js', '../../types/tools.js', 'zod'].sort());
    expect(src).not.toMatch(/\bfetch\s*\(|axios|httpClient|method\s*:/);
    const store = readFileSync(resolve('src/dashboard/services/social-posts-store.ts'), 'utf-8');
    expect(store).not.toMatch(/\bfetch\s*\(|axios|httpClient|meta\/client|graph\.facebook/);
  });
  it('creates a DRAFT only (createdBy mcp) and never calls fetch', async () => {
    const out = await run({ siteId: siteA, platforms: ['facebook'], message: 'Hola', scheduledAt: '2026-12-01T15:00:00-06:00' });
    expect(m.createDraft).toHaveBeenCalledWith({
      siteId: siteA, platforms: ['facebook'], message: 'Hola', imageUrl: null,
      scheduledAt: Date.parse('2026-12-01T21:00:00Z'), createdBy: 'mcp',
    });
    expect(out.note).toBe('Borrador creado; requiere aprobación en el dashboard');
    expect(out.draft).toMatchObject({ status: 'draft' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a pinned site forbids drafting for another site', async () => {
    vi.stubEnv('SANDI_ADS_SITE_ID', siteA);
    await expect(run({ siteId: siteB, platforms: ['facebook'], message: 'x' })).rejects.toThrow(/sitio/);
    expect(m.createDraft).not.toHaveBeenCalled();
    await run({ siteId: siteA, platforms: ['facebook'], message: 'x' });
    expect(m.createDraft).toHaveBeenCalledTimes(1);
  });
  it('surfaces validation details as an INVALID_INPUT error', async () => {
    m.createDraft.mockRejectedValueOnce(new SocialPostValidationError(['Instagram requiere una imagen.']));
    await expect(run({ siteId: siteA, platforms: ['instagram'], message: 'x' })).rejects.toMatchObject({
      code: 'INVALID_INPUT', details: { details: ['Instagram requiere una imagen.'] },
    });
  });
});
describe('meta_draft_post through guardedExecute', () => {
  const input = (siteId: string) => ({ siteId, platforms: ['facebook'], message: 'Hola' });
  beforeEach(() => registerAllTools());
  it('an agent session for site A cannot draft for site B', async () => {
    const r = await guardedExecute('meta_draft_post', input(siteB), { source: { kind: 'agent', conversationId: 'c1', siteId: siteA } });
    expect(r.status).toBe('denied');
    expect(r.error).toMatch(/otro cliente/);
    expect(m.createDraft).not.toHaveBeenCalled();
  });
  it.each([
    [{ kind: 'agent', conversationId: 'c1', siteId: siteA }, 'agent'],
    [{ kind: 'mcp' }, 'mcp'],
    [{ kind: 'http', siteId: siteA }, 'dashboard'],
  ] as const)('createdBy reflects the real origin (%o → %s)', async (source, createdBy) => {
    const r = await guardedExecute('meta_draft_post', input(siteA), { source });
    expect(r.status).toBe('success');
    expect(m.createDraft).toHaveBeenCalledWith(expect.objectContaining({ siteId: siteA, createdBy }));
  });
});
