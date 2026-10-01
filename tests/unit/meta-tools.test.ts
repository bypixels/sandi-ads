import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { metaTools } from '../../src/tools/meta/index.js';
import { registerAllTools, toolRegistry } from '../../src/tools/index.js';
import { MUTATING_TOOLS } from '../../src/dashboard/services/mutations.js';
import { rateLimiter } from '../../src/utils/rate-limiter.js';

const EXPECTED = [
  'meta_list_ad_accounts',
  'meta_list_campaigns',
  'meta_get_insights',
  'meta_list_pages',
  'meta_list_page_posts',
  'meta_get_ig_account',
  'meta_list_ig_media',
  'meta_draft_post',
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function tool(name: string) {
  const t = metaTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing ${name}`);
  return t;
}

async function run(name: string, input: unknown) {
  const t = tool(name);
  return t.handler(t.inputSchema.parse(input));
}

describe('meta tools', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    rateLimiter.setEnabled(false);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.META_ACCESS_TOKEN = 'tok';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.META_ACCESS_TOKEN;
    rateLimiter.setEnabled(true);
  });

  const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)![0]));

  it('registers all 8 meta tools in the global registry', () => {
    registerAllTools();
    for (const n of EXPECTED) expect(toolRegistry.has(n)).toBe(true);
    expect(metaTools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
    expect(metaTools.every((t) => t.category === 'meta')).toBe(true);
  });

  it('none of the meta tools is a mutating tool', () => {
    for (const n of EXPECTED) expect(MUTATING_TOOLS.has(n)).toBe(false);
  });

  it('only ever calls fetch with GET', async () => {
    await run('meta_list_ad_accounts', {});
    await run('meta_list_campaigns', { adAccountId: '1' });
    await run('meta_get_insights', { adAccountId: '1' });
    await run('meta_list_pages', {});
    await run('meta_list_page_posts', { pageId: '1' });
    await run('meta_get_ig_account', { pageId: '1' });
    await run('meta_list_ig_media', { igUserId: '1' });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(7);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    }
  });

  it('list_ad_accounts hits /me/adaccounts', async () => {
    await run('meta_list_ad_accounts', {});
    expect(lastUrl().pathname).toBe('/v25.0/me/adaccounts');
  });

  it('list_campaigns normalizes account and filters effective_status', async () => {
    await run('meta_list_campaigns', { adAccountId: '123', status: ['ACTIVE', 'PAUSED'] });
    const u = lastUrl();
    expect(u.pathname).toBe('/v25.0/act_123/campaigns');
    expect(u.searchParams.get('filtering')).toBe(
      JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }]),
    );
  });

  it('get_insights defaults to campaign level and last_30d', async () => {
    await run('meta_get_insights', { adAccountId: 'act_9' });
    const u = lastUrl();
    expect(u.pathname).toBe('/v25.0/act_9/insights');
    expect(u.searchParams.get('level')).toBe('campaign');
    expect(u.searchParams.get('date_preset')).toBe('last_30d');
  });

  it('get_insights since/until override datePreset; one without the other is rejected', async () => {
    await run('meta_get_insights', {
      adAccountId: '9',
      datePreset: 'today',
      since: '2026-01-01',
      until: '2026-01-31',
    });
    const u = lastUrl();
    expect(u.searchParams.has('date_preset')).toBe(false);
    expect(u.searchParams.get('time_range')).toBe(JSON.stringify({ since: '2026-01-01', until: '2026-01-31' }));
    fetchMock.mockClear();
    await expect(run('meta_get_insights', { adAccountId: '9', since: '2026-01-01' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('list_pages strips access_token from the output', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [{ id: '1', name: 'P', access_token: 'PAGE-TOKEN-SECRET', instagram_business_account: { id: '2' } }],
      }),
    );
    const out = await run('meta_list_pages', {});
    expect(JSON.stringify(out)).not.toContain('access_token');
    expect(JSON.stringify(out)).not.toContain('PAGE-TOKEN-SECRET');
    expect(JSON.stringify(out)).toContain('"id":"1"');
  });

  it('page posts and ig media validate ids and cap limit', async () => {
    const posts = tool('meta_list_page_posts').inputSchema;
    expect(() => posts.parse({ pageId: 'abc' })).toThrow();
    expect(() => posts.parse({ pageId: '1', limit: 101 })).toThrow();
    expect(() => tool('meta_list_ig_media').inputSchema.parse({ igUserId: '1/x' })).toThrow();
    await run('meta_list_page_posts', { pageId: '55' });
    expect(lastUrl().pathname).toBe('/v25.0/55/posts');
    expect(lastUrl().searchParams.get('limit')).toBe('25');
    await run('meta_list_ig_media', { igUserId: '77', limit: 10 });
    expect(lastUrl().pathname).toBe('/v25.0/77/media');
    expect(lastUrl().searchParams.get('limit')).toBe('10');
  });

  it('handlers called directly reject injected ids without fetching', async () => {
    const bad = '1?method=post&x=';
    await expect(
      Promise.resolve().then(() => tool('meta_list_page_posts').handler({ pageId: bad } as never)),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() => tool('meta_get_ig_account').handler({ pageId: bad } as never)),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() => tool('meta_list_ig_media').handler({ igUserId: bad } as never)),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limit must be an integer', () => {
    expect(() => tool('meta_list_page_posts').inputSchema.parse({ pageId: '1', limit: 2.5 })).toThrow();
    expect(() => tool('meta_list_campaigns').inputSchema.parse({ adAccountId: '1', limit: 2.5 })).toThrow();
  });

  it('get_ig_account requests instagram_business_account', async () => {
    await run('meta_get_ig_account', { pageId: '55' });
    expect(lastUrl().pathname).toBe('/v25.0/55');
    expect(lastUrl().searchParams.get('fields')).toContain('instagram_business_account');
  });
});
