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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
