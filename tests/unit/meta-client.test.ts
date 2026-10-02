import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  META_GRAPH_BASE,
  normalizeAdAccountId,
  appSecretProof,
  metaGet,
  metaGetAll,
} from '../../src/tools/meta/client.js';
import { rateLimiter } from '../../src/utils/rate-limiter.js';
import * as client from '../../src/tools/meta/client.js';

const TOKEN = 'EAAB-super-secret-token-123';
const SECRET = 'app-secret-xyz';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('meta client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    rateLimiter.setEnabled(false);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.META_ACCESS_TOKEN = TOKEN;
    process.env.META_APP_SECRET = SECRET;
    vi.stubEnv('MUTATIONS_META', 'true');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_APP_SECRET;
    rateLimiter.setEnabled(true);
  });

  it('uses the v25.0 base and GET only, with token and proof', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await metaGet('/me/adaccounts', { fields: 'id,name', limit: 5, skip: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(META_GRAPH_BASE).toBe('https://graph.facebook.com/v25.0');
    expect(String(url).startsWith('https://graph.facebook.com/v25.0/me/adaccounts?')).toBe(true);
    const u = new URL(String(url));
    expect(u.searchParams.get('access_token')).toBe(TOKEN);
    expect(u.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', SECRET).update(TOKEN).digest('hex'),
    );
    expect(u.searchParams.get('fields')).toBe('id,name');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.has('skip')).toBe(false);
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('omits appsecret_proof when no app secret is set', async () => {
    delete process.env.META_APP_SECRET;
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    await metaGet('/me');
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.has('appsecret_proof')).toBe(false);
  });

  it('appSecretProof is HMAC-SHA256 hex', () => {
    expect(appSecretProof('t', 's')).toBe(createHmac('sha256', 's').update('t').digest('hex'));
  });

  it('fails without a token and never calls fetch', async () => {
    delete process.env.META_ACCESS_TOKEN;
    await expect(metaGet('/me')).rejects.toThrow('Falta META_ACCESS_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('error body surfaces Meta details but never the token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { message: 'Invalid OAuth access token', code: 190, fbtrace_id: 'TRACE123' } },
        400,
      ),
    );
    const err = await metaGet('/me').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('Invalid OAuth access token');
    expect(msg).toContain('190');
    expect(msg).toContain('TRACE123');
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain(SECRET);
  });

  it('redacts token and secret echoed inside a Graph error message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: `bad token ${TOKEN} for app ${SECRET}`, code: 190 } }, 400),
    );
    const msg = ((await metaGet('/me').catch((e: Error) => e)) as Error).message;
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain(SECRET);
  });

  it('redacts token and secret echoed inside a network error', async () => {
    fetchMock.mockRejectedValue(new Error(`connect failed ?access_token=${TOKEN}&s=${SECRET}`));
    const msg = ((await metaGet('/me').catch((e: Error) => e)) as Error).message;
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain(SECRET);
  });

  it('error inside a 200 body is also an error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom', code: 1 } }, 200));
    await expect(metaGet('/me')).rejects.toThrow('boom');
  });

  it('rejects paths that are not relative or contain ://', async () => {
    await expect(metaGet('https://evil.com/x')).rejects.toThrow();
    await expect(metaGet('/me?next=http://evil.com')).rejects.toThrow();
    await expect(metaGet('me')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects paths with query, fragment, ampersand or odd segments', async () => {
    for (const p of ['/123?method=delete', '/123#x', '/123&method=post', '/a/../b', '/a//b', '/a/']) {
      await expect(metaGet(p)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects forbidden params (method, access_token, appsecret_proof)', async () => {
    await expect(metaGet('/123', { method: 'POST' })).rejects.toThrow();
    await expect(metaGet('/123', { METHOD: 'delete' })).rejects.toThrow();
    await expect(metaGet('/123', { access_token: 'x' })).rejects.toThrow();
    await expect(metaGet('/123', { Appsecret_Proof: 'x' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('metaGetAll throws on paging.next carrying method, without a 2nd request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 1 }], paging: { next: `${META_GRAPH_BASE}/me/x?method=delete&after=A` } }),
    );
    await expect(metaGetAll('/me/x')).rejects.toThrow('forbidden parameter');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('metaGetAll preserves benign paging.next params', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 1 }],
          paging: {
            next: `${META_GRAPH_BASE}/act_1/insights?after=A&limit=50&fields=id&level=ad&date_preset=last_7d&access_token=${TOKEN}`,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    await metaGetAll('/act_1/insights');
    const u = new URL(String(fetchMock.mock.calls[1][0]));
    for (const [k, v] of [['after', 'A'], ['limit', '50'], ['fields', 'id'], ['level', 'ad'], ['date_preset', 'last_7d']]) {
      expect(u.searchParams.get(k)).toBe(v);
    }
    expect(u.searchParams.get('access_token')).toBe(TOKEN);
  });

  it('assertNumericId', () => {
    expect(client.assertNumericId('123', 'pageId')).toBe('123');
    expect(() => client.assertNumericId('1?method=post&x=', 'pageId')).toThrow();
  });

  it('normalizeAdAccountId', () => {
    expect(normalizeAdAccountId('123')).toBe('act_123');
    expect(normalizeAdAccountId('act_123')).toBe('act_123');
    expect(() => normalizeAdAccountId('abc')).toThrow();
    expect(() => normalizeAdAccountId('act_')).toThrow();
    expect(() => normalizeAdAccountId('123/../x')).toThrow();
  });

  it('metaGetAll follows paging.next and concatenates', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 1 }], paging: { next: `${META_GRAPH_BASE}/me/x?after=A&access_token=${TOKEN}` } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 2 }] }));
    const out = await metaGetAll<{ id: number }>('/me/x');
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = new URL(String(fetchMock.mock.calls[1][0]));
    expect(second.pathname).toBe('/v25.0/me/x');
    expect(second.searchParams.get('after')).toBe('A');
  });

  it('metaGetAll stops at maxPages', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ data: [{ id: 1 }], paging: { next: `${META_GRAPH_BASE}/me/x?after=B` } }),
    );
    const out = await metaGetAll('/me/x', {}, 3);
    expect(out).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('exposes no write helpers', () => {
    const names = Object.keys(client);
    expect(names.filter((n) => /post|delete|put|patch/i.test(n))).toEqual([]);
  });
});

describe('meta write client (publisher only)', () => {
  const fetchMock = vi.fn();
  const PAGE_TOKEN = 'EAAB-page-token-456';

  beforeEach(() => {
    rateLimiter.setEnabled(false);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.META_ACCESS_TOKEN = TOKEN;
    process.env.META_APP_SECRET = SECRET;
    vi.stubEnv('MUTATIONS_META', 'true');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_APP_SECRET;
    rateLimiter.setEnabled(true);
  });

  const sent = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
    return { url: new URL(String(url)), init, body: new URLSearchParams(String(init.body)) };
  };

  it('does not send a queued write after Meta is disabled', async () => {
    let queued!: () => Promise<unknown>;
    vi.spyOn(rateLimiter, 'execute').mockImplementation((_service, callback) => {
      return new Promise((resolve, reject) => {
        queued = async () => callback().then(resolve, reject);
      });
    });
    const request = client.metaWrite({ kind: 'page_feed', pageId: '111', message: 'Hola' }, PAGE_TOKEN);
    const result = request.catch(err => err);
    vi.stubEnv('MUTATIONS_META', 'false');
    await queued();
    expect(await result).toBeInstanceOf(client.MetaWriteCancelledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechecks the switch after an asynchronous claim check', async () => {
    const beforeSend = vi.fn(async () => { vi.stubEnv('MUTATIONS_META', 'false'); });
    await expect(client.metaWrite({ kind: 'page_feed', pageId: '111', message: 'Hola' }, PAGE_TOKEN, beforeSend))
      .rejects.toBeInstanceOf(client.MetaWriteCancelledError);
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'body'] as const)('bounds a stalled GET %s to 20 seconds', async phase => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    fetchMock.mockImplementation(() => phase === 'fetch' ? never : Promise.resolve({ ok: true, json: () => never }));
    const result = client.getPageAccessToken('111').catch(err => err);
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await result).message).toContain('tiempo máximo');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('a GET deadline includes the limiter queue and expired callbacks never fetch', async () => {
    vi.useFakeTimers();
    let queued!: () => Promise<unknown>;
    vi.spyOn(rateLimiter, 'execute').mockImplementation((_service, callback) => new Promise((resolve, reject) => {
      queued = async () => callback().then(resolve, reject);
    }));
    const result = client.getPageAccessToken('111').catch(err => err);
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await result).message).toContain('tiempo máximo');
    await queued();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an expired queued write never sends later and is not ambiguous', async () => {
    vi.useFakeTimers();
    let queued!: () => Promise<unknown>;
    vi.spyOn(rateLimiter, 'execute').mockImplementation((_service, callback) => new Promise((resolve, reject) => {
      queued = async () => callback().then(resolve, reject);
    }));
    const result = client.metaWrite({ kind: 'page_feed', pageId: '111', message: 'Hola' }, PAGE_TOKEN).catch(err => err);
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await result).details?.uncertain).toBeFalsy();
    await queued();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a stalled write body is ambiguous, never silently retried', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const result = client.metaWrite({ kind: 'page_feed', pageId: '111', message: 'Hola' }, PAGE_TOKEN).catch(err => err);
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await result).details?.uncertain).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'page_photo', pageId: '111', url: 'https://media.example.com/a.jpg', caption: 'Hola' }, '/v25.0/111/photos', { url: 'https://media.example.com/a.jpg', caption: 'Hola' }],
    [{ kind: 'page_feed', pageId: '111', message: 'Hola' }, '/v25.0/111/feed', { message: 'Hola' }],
    [{ kind: 'ig_container', igUserId: '222', imageUrl: 'https://media.example.com/a.jpg', caption: 'Hola' }, '/v25.0/222/media', { image_url: 'https://media.example.com/a.jpg', caption: 'Hola' }],
    [{ kind: 'ig_publish', igUserId: '222', creationId: '333' }, '/v25.0/222/media_publish', { creation_id: '333' }],
  ] as const)('POSTs %o form-encoded to a path built from the op, token + proof in the body only', async (op, path, fields) => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '999' }));
    expect(await client.metaWrite(op, PAGE_TOKEN)).toEqual({ id: '999' });
    const { url, init, body } = sent();
    expect(init.method).toBe('POST');
    expect(String((init.headers as Record<string, string>)['content-type'])).toBe('application/x-www-form-urlencoded');
    expect(url.origin + url.pathname).toBe(`https://graph.facebook.com${path}`);
    expect(url.search).toBe('');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(PAGE_TOKEN);
    for (const [k, v] of Object.entries(fields)) expect(body.get(k)).toBe(v);
    expect(body.get('access_token')).toBe(PAGE_TOKEN);
    expect(body.get('appsecret_proof')).toBe(createHmac('sha256', SECRET).update(PAGE_TOKEN).digest('hex'));
  });

  it('returns the post id of a page photo', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '5', post_id: '111_7' }));
    expect(await client.metaWrite({ kind: 'page_photo', pageId: '111', url: 'https://x/a.jpg', caption: '' }, PAGE_TOKEN)).toEqual({ id: '5', postId: '111_7' });
  });

  it.each([
    { kind: 'page_feed', pageId: '1/../2', message: 'x' },
    { kind: 'page_photo', pageId: 'me', url: 'https://x/a.jpg', caption: '' },
    { kind: 'ig_container', igUserId: '22?method=delete', imageUrl: 'https://x/a.jpg', caption: '' },
    { kind: 'ig_publish', igUserId: '222', creationId: '33&x=1' },
    { kind: 'page_delete', pageId: '1' },
  ])('refuses non-numeric ids or unknown ops without any request: %o', async (op) => {
    await expect(client.metaWrite(op as never, PAGE_TOKEN)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an empty token without any request', async () => {
    await expect(client.metaWrite({ kind: 'page_feed', pageId: '1', message: 'x' }, '')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a Meta 4xx error is definitive and scrubbed of page token, system token and app secret', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: `bad ${PAGE_TOKEN} ${TOKEN} ${SECRET}`, code: 100 } }, 400));
    const err = (await client.metaWrite({ kind: 'page_feed', pageId: '1', message: 'x' }, PAGE_TOKEN).catch((e: unknown) => e)) as MCPErrorLike;
    expect(err.message).not.toContain(PAGE_TOKEN);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(SECRET);
    expect(err.details?.uncertain).toBeFalsy();
    expect(err.retryable).toBe(false);
  });

  it.each([
    ['network failure', () => fetchMock.mockRejectedValue(new Error(`socket hang up access_token=${PAGE_TOKEN}`))],
    ['5xx', () => fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'oops', code: 2 } }, 500))],
    ['200 without id', () => fetchMock.mockResolvedValue(jsonResponse({}))],
  ])('%s is flagged uncertain (Meta may have published) and never retryable', async (_n, arrange) => {
    arrange();
    const err = (await client.metaWrite({ kind: 'page_feed', pageId: '1', message: 'x' }, PAGE_TOKEN).catch((e: unknown) => e)) as MCPErrorLike;
    expect(err.details?.uncertain).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain(PAGE_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getPageAccessToken asks the page for its token with the system-user token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: PAGE_TOKEN, id: '111' }));
    expect(await client.getPageAccessToken('111')).toBe(PAGE_TOKEN);
    const u = new URL(String(fetchMock.mock.calls[0][0]));
    expect(u.pathname).toBe('/v25.0/111');
    expect(u.searchParams.get('fields')).toBe('access_token');
    expect(u.searchParams.get('access_token')).toBe(TOKEN);
    await expect(client.getPageAccessToken('abc')).rejects.toThrow();
  });

  it('getPageAccessToken fails in Spanish when the system user cannot manage the page', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '111' }));
    await expect(client.getPageAccessToken('111')).rejects.toThrow(/página/);
  });

  it('getIgContainerStatus, getIgPublishingQuota and getIgPermalink are plain GETs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status_code: 'FINISHED', id: '333' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ quota_usage: 7, config: { quota_total: 100, quota_duration: 86400 } }] }))
      .mockResolvedValueOnce(jsonResponse({ permalink: 'https://www.instagram.com/p/abc/', id: '444' }));
    expect(await client.getIgContainerStatus('333')).toBe('FINISHED');
    expect(await client.getIgPublishingQuota('222')).toEqual({ usage: 7, total: 100 });
    expect(await client.getIgPermalink('444')).toBe('https://www.instagram.com/p/abc/');
    const urls = fetchMock.mock.calls.map(c => new URL(String(c[0])));
    expect(urls.map(u => `${u.pathname}?fields=${u.searchParams.get('fields')}`)).toEqual([
      '/v25.0/333?fields=status_code', '/v25.0/222/content_publishing_limit?fields=quota_usage,config', '/v25.0/444?fields=permalink',
    ]);
    expect(fetchMock.mock.calls.every(c => ((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true);
  });
});

interface MCPErrorLike { message: string; retryable?: boolean; details?: Record<string, unknown> }
