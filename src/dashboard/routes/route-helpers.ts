/**
 * Shared HTTP route helpers.
 *
 * Six route files used to inline identical copies of these primitives.
 * They live here so:
 *   - request tracing, content-type policy, body-size policy → one edit
 *   - helpers become unit-testable in isolation
 *   - route files shrink to "auth check → dispatch → service call → response"
 *
 * Body size policy:
 *   - `DEFAULT_MAX_BODY_SIZE = 100KB` covers everything except snapshot
 *     persistence (which carries Lighthouse output up to ~800KB and
 *     overrides via `parseBody(req, SNAPSHOT_MAX_BODY_SIZE)`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export const DEFAULT_MAX_BODY_SIZE = 1024 * 100; // 100KB

/** Send a JSON response with status (defaults to 200). */
export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(data));
}

/** Send a JSON error envelope. Convenience over sendJson for the common case. */
export function sendError(res: ServerResponse, message: string, status = 500): void {
  sendJson(res, { error: message }, status);
}

/** Parse the request URL and return its searchParams. */
export function getParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return url.searchParams;
}

/**
 * Read the request body and parse as JSON. Rejects with "Request body too
 * large" once `maxSize` is exceeded (default 100KB). Empty bodies resolve to
 * `{}` for ergonomic optional-body endpoints.
 *
 * Pass a larger `maxSize` for endpoints accepting tool output (e.g. the
 * snapshot persistence endpoint).
 */
export async function parseBody(req: IncomingMessage, maxSize: number = DEFAULT_MAX_BODY_SIZE): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large (max ${Math.round(maxSize / 1024)}KB)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Raw binary uploads (post images). Kept separate from the 100KB JSON default. */
export const MEDIA_MAX_BODY_SIZE = 8 * 1024 * 1024; // 8MB

/**
 * Read the request body as raw bytes, rejecting once `maxSize` is exceeded.
 * On overflow the socket is NOT destroyed right away: the rest of the upload is
 * drained and discarded so the caller's 413 actually reaches the client
 * (destroying mid-upload makes the client see EPIPE/ECONNRESET instead).
 * Draining stops, and the socket is cut, past twice the limit.
 */
export async function parseRawBody(req: IncomingMessage, maxSize: number = MEDIA_MAX_BODY_SIZE): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) {
        if (size > maxSize * 2) req.destroy();
        return;
      }
      if (size > maxSize) {
        tooLarge = true;
        chunks = [];
        reject(new Error(`Request body too large (max ${Math.round(maxSize / 1024)}KB)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
