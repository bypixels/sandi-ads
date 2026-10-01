# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`sandi-ads` (display name "Sandi Ads", formerly website-ops-mcp/seo-mcp-pro) is an MCP server providing 121 tools across 17 modules for Google marketing, website performance, SEO, security, monitoring, accessibility, and Cloudflare integration. Built with TypeScript (strict mode), runs on Node.js 20+ via stdio transport. Includes an optional HTTP dashboard with credential management UI.

## Build & Development Commands

```bash
pnpm build              # Build ESM bundle with tsup (target: node20) + copy dashboard HTML
pnpm start              # Run production server (node dist/index.js)
pnpm dashboard          # Run with web dashboard enabled (port 3737)
pnpm dev                # Development mode with tsx watch
pnpm test               # Run tests with vitest
pnpm test:coverage      # Tests with coverage
pnpm lint               # ESLint (flat config)
pnpm lint:fix           # ESLint with auto-fix
pnpm typecheck          # tsc --noEmit
pnpm clean              # Remove dist/
```

Note: Build outputs ESM only (not CJS). The `dist/index.js` has a shebang for CLI use. Dashboard module is code-split (lazy-loaded only when `DASHBOARD_ENABLED=true`).

## Architecture

### Entry flow

`src/index.ts` → loads dotenv, calls `startServer()` from `src/server.ts`, registers signal handlers.

`src/server.ts` (~445 lines) creates the MCP server with stdio transport, initializes `AuthManager`, calls `registerAllTools()`, then sets up MCP request handlers for tools, resources, and prompts.

### Tool system

Tools are registered in a global `Map<string, ToolDefinition>` via `src/tools/index.ts`. Each module directory (google/, performance/, security/, etc.) exports a `register*Tools()` function and a tools array.

**9 tool module groups** registered in `registerAllTools()`: monitoring, security, seo-technical, utilities, google (GTM/GA4/GSC/Ads/Business Profile/Indexing), performance (PageSpeed/CrUX/CWV/Lighthouse), reports (site-health/seo-audit/executive-summary/dashboard-overview), accessibility, cloudflare.

**Tool naming**: `{module}_{action}_{target}` — e.g., `gtm_list_containers`, `ga4_run_report`, `security_ssl_analyze`.

**Adding a new tool**: Create handler using `ToolDefinition<TInput, TOutput>` type, add to module's tools array and register function, export from module index. Use `defineTool()` helper from `src/tools/base.ts` which wraps handlers with `logToolExecution()` timing and optional caching via `withCache()`.

### Auth system (`src/auth/`)

`AuthManager` manages three auth methods:
- **OAuth 2.0** (`google-oauth.ts`) — User access with refresh tokens, auto-refresh via `TokenManager` (5min buffer)
- **Service Account** (`service-account.ts`) — JWT with optional domain-wide delegation
- **API Keys** (`api-keys.ts`) — For PageSpeed and Safe Browsing (no OAuth needed)

Google API clients are created inside each tool module by getting auth from `AuthManager`, then calling `google.{service}({ version, auth })`.

### Utilities (`src/utils/`)

- **Cache** (`cache.ts`): In-memory `Map` with TTL per data type (see `CACHE_TTL` in `src/types/config.ts`). Global helpers: `cacheGet()`, `cacheSet()`, `withCache()`, `buildCacheKey()`.
- **Rate limiter** (`rate-limiter.ts`): Bottleneck-based, per-service limits (GTM: 50/min, GA4: 100/min, GSC: 1200/day, Ads: 15000/day, PageSpeed: 400/day, etc.). Use `rateLimiter.execute(service, fn)`.
- **Logger** (`logger.ts`): Winston, all output goes to stderr (not stdout — stdout is reserved for MCP stdio transport). Use `createServiceLogger(service)` for module-specific loggers.
- **Validators** (`validators.ts`): URL/domain/date validation. `schema.ts` converts Zod schemas to JSON Schema for MCP tool definitions.

### HTTP requests

Use `httpClient` from `src/tools/base.ts` (axios instance with 30s timeout, custom User-Agent, `validateStatus: () => true`). Helpers: `fetchUrl()` (raw), `fetchHtml()` (with cheerio parsing).

### Types

- `src/types/tools.ts` — `ToolDefinition`, `ToolOutput`, `successOutput()`, `errorOutput()`
- `src/types/errors.ts` — `MCPError` with `ErrorCode` enum and factory methods (`.authError()`, `.rateLimitError()`, `.validationError()`, etc.)
- `src/types/google.ts` — Google API type definitions and `GOOGLE_SCOPES` mapping
- `src/types/config.ts` — `AuthConfig`, `SiteConfig`, `CACHE_TTL` per data type

### Key conventions

- All input validation uses Zod schemas; these are converted to JSON Schema in `server.ts` for MCP exposure
- Error codes follow pattern: `AUTH_*`, `RATE_LIMIT_*`, `INVALID_*`, `RESOURCE_*`, `EXTERNAL_SERVICE_*`
- TypeScript strict mode with `noUnusedLocals` and `noUnusedParameters` enabled
- ESM-only (`"type": "module"`) — all internal imports use `.js` extensions
- Env vars loaded from `.env` — see `.env.example` for required variables

### Dashboard (`src/dashboard/`)

Optional HTTP dashboard that runs alongside MCP stdio transport (enabled via `DASHBOARD_ENABLED=true`).

- **`http-server.ts`**: `node:http` server with route dispatching, CORS (restrictive in prod, permissive in dev), and security headers.
- **`auth.ts`**: API key middleware — `Bearer` token or `X-API-Key` header; dev mode skips auth.
- **`routes/api.ts`**: REST endpoints for tools, reports, status. Body size limited to 100KB.
- **`routes/settings.ts`**: Credential CRUD — save/load/validate/clear. Body size limited to 50KB.
- **`routes/sse.ts`**: Server-Sent Events for real-time uptime/response-time monitoring.
- **`services/credential-store.ts`**: AES-256-GCM encrypted file storage (`.sandi-ads-credentials.enc`). Schema maps credential keys to env vars. `applyToEnv()` bridges stored creds to `process.env` for auth system.
- **`services/dashboard-data.ts`**: Orchestration layer calling tool handlers via registry.
- **`ui/index.html`**: Self-contained SPA (dark theme, no build step, inline CSS+JS).

Env vars: `SANDI_ADS_SITE_ID` (pinned client site) and `SANDI_ADS_KEY` (license) are the current names; the old `WEBSITE_OPS_SITE_ID` and `SEO_MCP_PRO_KEY` still work as fallbacks. Persisted files were renamed `.website-ops-*` -> `.sandi-ads-*` and migrate automatically on first start.

**Credential flow**: User saves keys via dashboard UI → `credentialStore.set()` → encrypted to disk → `credentialStore.applyToEnv()` → `authManager.reinitialize()` → tools immediately use new credentials (works for both MCP and HTTP).
