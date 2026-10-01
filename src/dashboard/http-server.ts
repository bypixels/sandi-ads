/**
 * Dashboard HTTP server using node:http
 *
 * Runs alongside the MCP stdio transport to serve the web dashboard and REST API.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServiceLogger } from '../utils/logger.js';
import { handleApiRoute } from './routes/api.js';
import { handleSseRoute } from './routes/sse.js';
import { handleSettingsRoute } from './routes/settings.js';
import { handleSitesRoute } from './routes/sites.js';
import { handleAgentRoute } from './routes/agent.js';
import { handleSignalsRoute } from './routes/signals.js';
import { handleDraftsRoute } from './routes/drafts.js';
import { handlePostsRoute } from './routes/posts.js';
import { handleCommandCenterRoute } from './routes/command-center.js';
import { handleOAuthRoute } from './routes/oauth.js';
import { authenticateRequest, authorizeEndpoint } from './auth.js';
import { getDashboardHtml } from './ui/assets.js';

const log = createServiceLogger('dashboard-http');

/** Get allowed CORS origin based on configuration */
function getCorsOrigin(req: IncomingMessage): string {
  // In dev mode (no auth required), allow any origin for convenience
  if (process.env.DASHBOARD_AUTH_REQUIRED === 'false' && !process.env.DASHBOARD_API_KEY) {
    return '*';
  }
  // In production, restrict to same-origin (the request's own origin or none)
  const origin = req.headers.origin;
  if (origin) {
    // Allow localhost origins (dashboard is accessed locally)
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return origin;
      }
    } catch {
      // Invalid origin
    }
  }
  // No CORS header = same-origin only
  return '';
}

/**
 * Create the dashboard HTTP server
 */
export function createDashboardServer(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // CORS headers
    const corsOrigin = getCorsOrigin(req);
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      if (corsOrigin !== '*') {
        res.setHeader('Vary', 'Origin');
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Site-ID');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    log.debug(`${req.method} ${pathname}`);

    try {
      // Public callback still verifies a browser-bound, one-use OAuth state.
      if (pathname.startsWith('/api/') && pathname !== '/api/oauth/google/callback') {
        const auth = authenticateRequest(req);
        if (!auth.authenticated || !authorizeEndpoint(auth, req.method || 'GET', pathname)) {
          res.writeHead(auth.authenticated ? 403 : 401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: auth.reason || 'Permisos insuficientes.' }));
          return;
        }
      }
      // SSE route (before other API routes since it's long-lived)
      if (pathname === '/api/sse') {
        const handled = handleSseRoute(req, res, pathname);
        if (handled) return;
      }

      // Settings routes
      if (pathname.startsWith('/api/settings/')) {
        const handled = await handleSettingsRoute(req, res, pathname);
        if (handled) return;
      }

      // Sites routes
      if (pathname === '/api/sites' || pathname.startsWith('/api/sites/')) {
        const handled = await handleSitesRoute(req, res, pathname);
        if (handled) return;
      }

      // Agent routes (chat, conversations, status)
      if (pathname.startsWith('/api/agent/')) {
        const handled = await handleAgentRoute(req, res, pathname);
        if (handled) return;
      }

      // Signals routes (alerts list, autopilot, manual scan)
      if (pathname === '/api/signals' || pathname.startsWith('/api/signals/')) {
        const handled = await handleSignalsRoute(req, res, pathname);
        if (handled) return;
      }

      // Drafts routes (agent inbox: list / edit / approve / publish)
      if (pathname === '/api/drafts' || pathname.startsWith('/api/drafts/')) {
        const handled = await handleDraftsRoute(req, res, pathname);
        if (handled) return;
      }

      // Social posts (FB/IG drafts + approval) and post image uploads
      if (pathname === '/api/posts' || pathname.startsWith('/api/posts/') || pathname === '/api/media') {
        const handled = await handlePostsRoute(req, res, pathname);
        if (handled) return;
      }

      // Command Center routes (/api/cc/*) — site payload, profile, agents, refresh
      if (pathname.startsWith('/api/cc/')) {
        const handled = await handleCommandCenterRoute(req, res, pathname);
        if (handled) return;
      }

      // OAuth + Google account linking + bulk site import
      if (pathname.startsWith('/api/oauth/') || pathname === '/api/sites/bulk-import') {
        const handled = await handleOAuthRoute(req, res, pathname);
        if (handled) return;
      }

      // API routes
      if (pathname.startsWith('/api/')) {
        const handled = await handleApiRoute(req, res, pathname);
        if (handled) return;
      }

      // Dashboard HTML (no auth for the shell)
      if (pathname === '/' || pathname === '/index.html') {
        // Fresh nonce per request: only the shell's single inline script may run.
        const nonce = randomBytes(16).toString('base64');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': [
            "default-src 'self'",
            `script-src 'nonce-${nonce}'`,
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: https:",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "object-src 'none'",
          ].join('; '),
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(getDashboardHtml().replace('<script>', `<script nonce="${nonce}">`));
        return;
      }

      // Favicon (prevent 404 noise)
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      log.error('Request error', { error: error instanceof Error ? error : new Error(String(error)) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return server;
}
