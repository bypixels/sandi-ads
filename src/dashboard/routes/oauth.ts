/**
 * Google OAuth + linked-accounts routes.
 *
 *   GET  /api/oauth/google/init                 → redirects user to Google
 *   GET  /api/oauth/google/callback             → exchange + persist + redirect to UI
 *   GET  /api/oauth/google/accounts             → list linked accounts (no tokens)
 *   POST /api/oauth/google/accounts/:id/active  → toggle isActive
 *   DELETE /api/oauth/google/accounts/:id       → revoke + delete
 *   POST /api/oauth/google/discover             → discover + group sites
 *   POST /api/sites/bulk-import                 → create N sites at once
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateRequest } from '../auth.js';
import { buildAuthUrl, exchangeAndSave, revokeRefreshToken } from '../services/google-oauth-flow.js';
import { googleAccountsStore } from '../services/google-accounts-store.js';
import { discoverAllForActiveAccount } from '../services/google-discovery.js';
import { sitesStore, type SiteInput } from '../services/sites-store.js';
import { authManager } from '../../auth/index.js';
import { createServiceLogger } from '../../utils/logger.js';
import { sendJson, parseBody, getParams } from './route-helpers.js';

const log = createServiceLogger('oauth-api');

export async function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  // The /init and /callback endpoints don't require API-key auth — they're
  // browser navigations the user kicked off. Everything else does.
  const isPublicEndpoint = pathname === '/api/oauth/google/callback';
  if (!isPublicEndpoint) {
    const auth = authenticateRequest(req);
    if (!auth.authenticated) {
      sendJson(res, { error: auth.reason || 'Unauthorized' }, 401);
      return true;
    }
  }

  // GET /api/oauth/google/init
  if (pathname === '/api/oauth/google/init' && req.method === 'POST') {
    try {
      const redirectAfter = getParams(req).get('redirect') || undefined;
      const { url, browserNonce } = buildAuthUrl(redirectAfter);
      res.setHeader('Set-Cookie', `ops_oauth_nonce=${browserNonce}; HttpOnly; SameSite=Lax; Path=/api/oauth/google/callback; Max-Age=300${process.env.OAUTH_REDIRECT_URI?.startsWith('https:') ? '; Secure' : ''}`);
      sendJson(res, { url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Init failed';
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>OAuth init falló</h1><pre>${msg.replace(/</g, '&lt;')}</pre>`);
    }
    return true;
  }

  // GET /api/oauth/google/callback
  if (pathname === '/api/oauth/google/callback' && req.method === 'GET') {
    const params = getParams(req);
    const code = params.get('code');
    const state = params.get('state') || '';
    const error = params.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml({ ok: false, message: 'Google rechazó la autorización: ' + error }));
      return true;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml({ ok: false, message: 'Faltó el code en el callback' }));
      return true;
    }

    try {
      const { account } = await exchangeAndSave(code, state,
        req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('ops_oauth_nonce='))?.slice('ops_oauth_nonce='.length));
      res.setHeader('Set-Cookie', 'ops_oauth_nonce=; HttpOnly; SameSite=Lax; Path=/api/oauth/google/callback; Max-Age=0');
      // Re-init the auth manager so subsequent tool calls use the new account
      try { await authManager.reinitialize(); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        callbackHtml({
          ok: true,
          message: `Cuenta vinculada: ${account.email}`,
        }),
      );
    } catch (err) {
      log.error('OAuth callback failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      const msg = err instanceof Error ? err.message : 'Token exchange failed';
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackHtml({ ok: false, message: msg }));
    }
    return true;
  }

  // GET /api/oauth/google/accounts
  if (pathname === '/api/oauth/google/accounts' && req.method === 'GET') {
    const accounts = await googleAccountsStore.list();
    sendJson(res, { accounts });
    return true;
  }

  // POST /api/oauth/google/accounts/:id/active
  const activeMatch = pathname.match(/^\/api\/oauth\/google\/accounts\/([a-zA-Z0-9-]+)\/active$/);
  if (activeMatch && req.method === 'POST') {
    const id = activeMatch[1];
    const body = (await parseBody(req)) as { active?: boolean };
    await googleAccountsStore.setActive(id, !!body.active);
    try { await authManager.reinitialize(); } catch { /* ignore */ }
    sendJson(res, { ok: true });
    return true;
  }

  // DELETE /api/oauth/google/accounts/:id
  const delMatch = pathname.match(/^\/api\/oauth\/google\/accounts\/([a-zA-Z0-9-]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const id = delMatch[1];
    const acct = await googleAccountsStore.getWithToken(id);
    if (!acct) {
      sendJson(res, { error: 'Account not found' }, 404);
      return true;
    }
    await revokeRefreshToken(acct.refreshToken);
    const removed = await googleAccountsStore.remove(id);
    try { await authManager.reinitialize(); } catch { /* ignore */ }
    sendJson(res, { ok: removed });
    return true;
  }

  // POST /api/oauth/google/discover
  if (pathname === '/api/oauth/google/discover' && req.method === 'POST') {
    try {
      const summary = await discoverAllForActiveAccount();
      sendJson(res, summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Discovery failed';
      log.error('Discovery failed', { error: err instanceof Error ? err : new Error(msg) });
      sendJson(res, { error: msg }, 500);
    }
    return true;
  }

  // POST /api/sites/bulk-import
  // Each item can either CREATE a new site or UPDATE an existing one
  // (sets `existingSiteId` to merge new bindings into the existing record).
  if (pathname === '/api/sites/bulk-import' && req.method === 'POST') {
    try {
      const body = (await parseBody(req)) as {
        items?: Array<{
          name: string;
          primaryUrl: string;
          bindings?: Record<string, string>;
          notes?: string;
          existingSiteId?: string;  // when set → update instead of create
        }>;
      };
      const items = body.items || [];
      if (items.length === 0) {
        sendJson(res, { error: 'No hay items para importar' }, 400);
        return true;
      }
      const created = [];
      const updated = [];
      for (const item of items) {
        try {
          if (item.existingSiteId) {
            const updatedSite = await sitesStore.update(item.existingSiteId, {
              bindings: (item.bindings || {}) as SiteInput['bindings'],
            });
            if (updatedSite) updated.push(updatedSite);
          } else {
            const site = await sitesStore.create({
              name: item.name,
              primaryUrl: item.primaryUrl,
              bindings: (item.bindings || {}) as SiteInput['bindings'],
              notes: item.notes,
            });
            created.push(site);
          }
        } catch (err) {
          log.warn('Bulk import — item failed', {
            name: item.name,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
      sendJson(res, { created, updated, requested: items.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Bulk import failed';
      sendJson(res, { error: msg }, 500);
    }
    return true;
  }

  return false;
}

/**
 * HTML for the OAuth callback page. Shows result and auto-closes if opened
 * in a popup, or links back to the dashboard if opened in the main window.
 */
function callbackHtml(opts: { ok: boolean; message: string }): string {
  const color = opts.ok ? '#4ade80' : '#f87171';
  const title = opts.ok ? '✓ Cuenta vinculada' : '✗ Error vinculando cuenta';
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>OAuth — ${title}</title>
<style>
body { background:#0a0c14; color:#eef0f6; font-family:-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; }
.card { background:#12151f; border:1px solid #232838; border-radius:12px; padding:32px 28px; max-width:420px; box-shadow:0 8px 24px rgba(0,0,0,.3); }
h1 { color:${color}; font-size:18px; margin:0 0 12px; font-weight:600; letter-spacing:-.02em; }
p { color:#c8ccdd; font-size:14px; line-height:1.55; margin:0 0 16px; word-break:break-word; }
a { color:#818cf8; text-decoration:none; font-weight:500; }
a:hover { text-decoration:underline; }
</style></head><body>
<div class="card">
<h1>${title}</h1>
<p>${opts.message.replace(/</g, '&lt;')}</p>
<p><a href="/" id="back">Volver al dashboard →</a></p>
</div>
<script>
// Notify opener (popup flow) and auto-close after a moment
if (window.opener && !window.opener.closed) {
  try { window.opener.postMessage({ type: 'google-oauth-result', ok: ${opts.ok} }, '*'); } catch (e) {}
  setTimeout(() => window.close(), 1500);
}
</script>
</body></html>`;
}
