import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDashboardServer } from '../../src/dashboard/http-server.js';

beforeEach(() => { vi.stubEnv('DASHBOARD_AUTH_REQUIRED', 'true'); vi.stubEnv('DASHBOARD_API_KEY', 'k'); });
afterEach(() => vi.unstubAllEnvs());
async function get(url: string) {
  let status = 0; let headers: Record<string, string> = {}; let body = '';
  const res = {
    setHeader: vi.fn(), writeHead: vi.fn((c: number, h?: Record<string, string>) => { status = c; headers = h ?? {}; }),
    end: vi.fn((b?: string) => { body = b ?? ''; }),
  } as unknown as ServerResponse;
  const req = { method: 'GET', url, headers: { host: 'localhost:3737' } } as IncomingMessage;
  await (createDashboardServer().listeners('request')[0] as (a: IncomingMessage, b: ServerResponse) => Promise<void>)(req, res);
  return { status, headers, body };
}
const nonceOf = (csp: string) => /script-src 'nonce-([^']+)'/.exec(csp)?.[1];

it('serves the SPA with a CSP whose nonce matches the script tag', async () => {
  const r = await get('/');
  const csp = r.headers['Content-Security-Policy'];
  const nonce = nonceOf(csp);
  expect(nonce).toBeTruthy();
  expect(r.body).toContain(`<script nonce="${nonce}">`);
  expect(r.body.match(/<script\b/g)).toHaveLength(1);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(r.headers['X-Frame-Options']).toBe('DENY');
  expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
  expect(r.headers['Referrer-Policy']).toBe('no-referrer');
});
it('uses a fresh nonce per request', async () => {
  const a = nonceOf((await get('/')).headers['Content-Security-Policy']);
  const b = nonceOf((await get('/index.html')).headers['Content-Security-Policy']);
  expect(a).not.toBe(b);
});
it('leaves no inline event handlers in the shell', async () => {
  expect((await get('/')).body).not.toMatch(/\son(click|change|submit|load|error|input)\s*=/i);
});
it('requires auth for the monitor health route', async () => {
  expect((await get('/api/monitors/health')).status).toBe(401);
});
