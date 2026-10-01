# Sandi Ads

[![npm version](https://img.shields.io/npm/v/sandi-ads.svg)](https://www.npmjs.com/package/sandi-ads)
[![CI](https://github.com/bypixels/sandi-ads/actions/workflows/ci.yml/badge.svg)](https://github.com/bypixels/sandi-ads/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that provides Claude with **121 tools** for website operations, Google Marketing, SEO, performance analysis, security auditing, monitoring, accessibility testing, and more.

---

## Table of Contents

- [Overview](#overview)
- [Free vs Pro](#free-vs-pro)
- [Quick Start](#quick-start)
- [Tool Modules](#tool-modules)
- [Configuration](#configuration)
- [Claude Desktop Integration](#claude-desktop-integration)
- [Web Dashboard (Pro)](#web-dashboard-pro)
- [Dashboard REST API](#dashboard-rest-api)
- [Architecture](#architecture)
- [Commands](#commands)
- [OAuth Token Helper](#oauth-token-helper)
- [License](#license)

---

## Overview

`sandi-ads` is a comprehensive MCP server built with TypeScript in strict mode. It connects Claude to the full spectrum of website management tasks -- from Google Analytics reporting and Tag Manager configuration to SSL analysis, Core Web Vitals monitoring, and WCAG accessibility audits.

- **121 tools** across 17 modules
- Zero external runtime frameworks -- uses `node:http` for the optional dashboard
- Built-in credential management with **AES-256-GCM** encryption (Pro)
- Per-service rate limiting and in-memory caching

---

## Free vs Pro

Sandi Ads follows a hybrid open source model. The core MCP tools are **free and open source**. Advanced reporting, the web dashboard, and credential management require a **Pro license**.

| Feature | Free | Pro |
|---|:---:|:---:|
| Google Analytics 4 (GA4) tools | Yes | Yes |
| Google Tag Manager (GTM) tools | Yes | Yes |
| Google Search Console (GSC) tools | Yes | Yes |
| Google Ads tools | Yes | Yes |
| Google Business Profile tools | Yes | Yes |
| Indexing API tools | Yes | Yes |
| PageSpeed Insights / Lighthouse | Yes | Yes |
| Core Web Vitals / CrUX | Yes | Yes |
| Security auditing (SSL, headers, Safe Browsing) | Yes | Yes |
| SEO technical (robots, sitemaps, canonicals, etc.) | Yes | Yes |
| Monitoring (uptime, DNS, certificates) | Yes | Yes |
| Accessibility (WCAG, contrast, images) | Yes | Yes |
| Cloudflare integration | Yes | Yes |
| Utilities (tech detection, broken links, WHOIS) | Yes | Yes |
| Dashboard overview tool | Yes | Yes |
| **Site Health Report** (`report_site_health`) | -- | Yes |
| **SEO Audit Report** (`report_seo_audit`) | -- | Yes |
| **Executive Summary** (`report_executive_summary`) | -- | Yes |
| **Web Dashboard** (browser UI on port 3737) | -- | Yes |
| **Encrypted Credential Store** (AES-256-GCM) | -- | Yes |
| **SSE Real-time Monitoring** | -- | Yes |

### Activating Pro

Set your license key as an environment variable:

```bash
SANDI_ADS_KEY=SMCP-XXXX-XXXX-XXXX-XXXX
```

Or add it to your `.env` file. The server logs the active tier on startup.

---

## Quick Start

### Install from npm

```bash
# Run directly with npx (no install needed)
npx sandi-ads

# Or install globally
npm install -g sandi-ads
sandi-ads
```

### Install from source

```bash
git clone https://github.com/bypixels/sandi-ads.git
cd sandi-ads
pnpm install
pnpm build
pnpm start
```

### Development

```bash
pnpm dev         # Development mode with hot reload
```

---

## Tool Modules

The server organizes its tools into 17 modules spanning 14 core categories:

| Module | Description | Example Tools |
|---|---|---|
| **Google Tag Manager** | Accounts, containers, workspaces, tags, triggers, variables, versions | `gtm_list_containers`, `gtm_create_tag`, `gtm_publish_version` |
| **Google Analytics 4** | Accounts, properties, reports, realtime, funnels, custom dimensions/metrics, audiences, data streams, conversion events | `ga4_run_report`, `ga4_run_realtime_report`, `ga4_run_funnel_report` |
| **Google Search Console** | Sites, performance queries, top queries/pages, sitemaps, URL inspection, coverage | `gsc_query_performance`, `gsc_top_queries`, `gsc_inspect_url` |
| **Google Ads** | Customers, campaigns, ad groups, keywords, budgets, performance, search terms, keyword ideas | `ads_list_campaigns`, `ads_create_campaign`, `ads_get_keyword_ideas` |
| **Google Business Profile** | Accounts, locations, reviews, posts, insights, media | `gbp_list_locations`, `gbp_reply_review`, `gbp_create_post` |
| **Indexing API** | Submit URLs for indexing, check status, batch operations | `indexing_publish`, `indexing_get_status`, `indexing_batch_publish` |
| **PageSpeed Insights** | Page performance analysis via PSI API | `psi_analyze` |
| **CrUX** | Chrome UX Report data queries and historical trends | `crux_query`, `crux_history` |
| **Core Web Vitals** | LCP, INP, CLS aggregate reports | `cwv_report` |
| **Lighthouse** | Full Lighthouse audits via PSI API | `lighthouse_audit` |
| **Security** | SSL analysis, security headers, Safe Browsing, comprehensive audits | `security_ssl_analyze`, `security_headers_check`, `security_audit` |
| **SEO Technical** | Robots.txt, sitemaps, canonicals, redirects, structured data, headings, meta tags | `seo_robots_analyze`, `seo_sitemap_analyze`, `seo_structured_data` |
| **Monitoring** | Uptime, response time, DNS lookup/propagation, certificate checks | `monitor_check_uptime`, `monitor_dns_lookup`, `monitor_certificate` |
| **Accessibility** | WCAG audits, contrast checking, image alt text validation | `a11y_audit`, `a11y_check_contrast`, `a11y_check_images` |
| **Utilities** | Tech stack detection, broken link scanning, WHOIS, headers, screenshots | `util_tech_detection`, `util_broken_links`, `util_whois_lookup` |
| **Cloudflare** | Zones, DNS records, analytics, cache purge, firewall events | `cf_get_zones`, `cf_create_dns_record`, `cf_purge_cache` |
| **Reports** | Aggregated site health, SEO audit, executive summary | `report_site_health`, `report_seo_audit`, `report_executive_summary` |

---

## Configuration

All configuration is handled through environment variables. Create a `.env` file in the project root:

### Sandi Ads License

| Variable | Description |
|---|---|
| `SANDI_ADS_KEY` | Pro license key (`SMCP-XXXX-XXXX-XXXX-XXXX`) (the old `SEO_MCP_PRO_KEY` still works as a fallback) |

### Google OAuth 2.0

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | OAuth redirect URI |
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token |

### Google Service Account

| Variable | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Path to service account JSON key file |
| `GOOGLE_SERVICE_ACCOUNT_IMPERSONATE` | Email address for domain-wide delegation |

### API Keys

| Variable | Description |
|---|---|
| `GOOGLE_PAGESPEED_API_KEY` | PageSpeed Insights API key |
| `GOOGLE_SAFE_BROWSING_API_KEY` | Safe Browsing API key |

### Google Ads

| Variable | Description |
|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API developer token |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Manager account customer ID |

### Cloudflare

| Variable | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token (preferred) |
| `CLOUDFLARE_EMAIL` | Cloudflare account email (legacy auth) |
| `CLOUDFLARE_API_KEY` | Cloudflare global API key (legacy auth) |

### Dashboard (Pro)

| Variable | Description | Default |
|---|---|---|
| `DASHBOARD_ENABLED` | Enable the web dashboard | `false` |
| `DASHBOARD_PORT` | Dashboard HTTP port | `3737` |
| `DASHBOARD_API_KEY` | API key for dashboard access | -- |
| `DASHBOARD_AUTH_REQUIRED` | Require authentication for dashboard | `false` |

---

## Claude Desktop Integration

Add the server to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sandi-ads": {
      "command": "npx",
      "args": ["-y", "sandi-ads"],
      "env": {
        "GOOGLE_PAGESPEED_API_KEY": "your-api-key",
        "SANDI_ADS_KEY": "SMCP-XXXX-XXXX-XXXX-XXXX"
      }
    }
  }
}
```

Or if installed from source:

```json
{
  "mcpServers": {
    "sandi-ads": {
      "command": "node",
      "args": ["/path/to/sandi-ads/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret",
        "GOOGLE_REFRESH_TOKEN": "your-refresh-token",
        "GOOGLE_PAGESPEED_API_KEY": "your-api-key"
      }
    }
  }
}
```

Once configured, Claude will have access to all available tools. Ask Claude to analyze your website's performance, check SEO issues, audit security headers, or manage your Google Marketing stack -- all through natural language.

---

## Web Dashboard (Pro)

The server includes an optional self-contained web dashboard for browser-based access to all tools and reports. **Requires a Pro license.**

```bash
SANDI_ADS_KEY=SMCP-... pnpm dashboard
```

Or set `DASHBOARD_ENABLED=true` and `SANDI_ADS_KEY` in your `.env` file and run `pnpm start`.

The dashboard is available at `http://localhost:3737` and provides:

- **Tool browser** -- Browse and execute all available tools
- **Site reports** -- Site health, SEO audit, and executive summary reports
- **Real-time monitoring** -- Server-Sent Events for live status updates
- **Credential management** -- Save and manage API keys through the UI (AES-256-GCM encrypted at rest)
- **Status overview** -- Authentication state, cache statistics, rate limit status

---

## Dashboard REST API

When the dashboard is enabled (Pro), the following HTTP endpoints are available:

### Health and Status

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Server health check |
| `GET` | `/api/status/auth` | Authentication status |
| `GET` | `/api/status/cache` | Cache statistics |
| `GET` | `/api/status/rate-limits` | Rate limit status per service |

### Tools and Reports

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/tools` | List all available tools |
| `POST` | `/api/tool/:name` | Execute a tool (JSON body = tool input) |
| `GET` | `/api/dashboard?url=X` | Dashboard overview for a URL |
| `GET` | `/api/report/site-health?url=X` | Site health report |
| `GET` | `/api/report/seo-audit?url=X` | SEO audit report |

### Settings and Credentials

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/settings/schema` | Configuration schema |
| `GET` | `/api/settings/credentials` | Retrieve saved credentials |
| `POST` | `/api/settings/credentials` | Save credentials |
| `POST` | `/api/settings/credentials/validate` | Validate credentials |

### Monitoring

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/sse?url=X` | Server-Sent Events stream for real-time monitoring |

---

## Architecture

```
src/
├── index.ts                  # Entry point
├── server.ts                 # MCP server setup and tool registration
├── licensing/                # License management (free vs pro)
│   ├── index.ts              # Key validation, isPro(), getLicenseTier()
│   └── tiers.ts              # Pro tool and feature definitions
├── auth/                     # Authentication layer
│   ├── oauth.ts              # Google OAuth 2.0 flow
│   ├── service-account.ts    # Service account authentication
│   └── token-manager.ts      # Automatic token refresh
├── tools/                    # 14 tool modules
│   ├── google/               # GTM, GA4, GSC, Ads, Business Profile, PageSpeed, Indexing
│   ├── performance/          # Core Web Vitals, CrUX, Lighthouse
│   ├── security/             # SSL, headers, Safe Browsing
│   ├── seo-technical/        # Structured data, robots, sitemaps, canonicals
│   ├── accessibility/        # WCAG audits, contrast checking
│   ├── monitoring/           # Uptime, DNS, certificates
│   ├── integrations/         # Cloudflare
│   ├── utilities/            # Screenshots, tech detection, broken links
│   └── reports/              # Site health, SEO audit, executive summary
├── dashboard/                # Optional HTTP dashboard (Pro)
│   ├── http-server.ts        # node:http server (zero frameworks)
│   ├── routes/               # API, SSE, and settings route handlers
│   ├── services/             # Credential store (AES-256-GCM), data orchestration
│   └── ui/                   # Self-contained HTML dashboard
├── utils/                    # Shared utilities
│   ├── rate-limiter.ts       # Per-service rate limiting (bottleneck)
│   ├── cache.ts              # In-memory + file cache
│   └── logger.ts             # Structured JSON logging (winston)
├── config/                   # Google API scopes, default values
└── types/                    # TypeScript type definitions
```

### Design Principles

- **Zod validation** on all tool inputs and outputs
- **Per-service rate limiting** via bottleneck (e.g., GTM: 50 req/min, GA4: 100 req/min, GSC: 1200 req/day)
- **In-memory caching** with 5-minute TTL (1000-item limit) and file cache fallback (1-hour TTL)
- **Structured logging** with Winston in JSON format
- **Automatic token refresh** for all Google API interactions
- **stdio transport** for Claude Desktop; optional HTTP transport for the dashboard

---

## Commands

| Command | Description |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm build` | Build with tsup (ESM) |
| `pnpm start` | Run the MCP server (stdio transport) |
| `pnpm dashboard` | Run with web dashboard enabled (Pro) |
| `pnpm dev` | Development mode with hot reload |
| `pnpm test` | Run tests with vitest |
| `pnpm lint` | Lint with ESLint |
| `pnpm typecheck` | TypeScript type checking |

---

## OAuth Token Helper

To obtain a Google OAuth refresh token for local development:

```bash
node get-token.cjs
```

This interactive script reads `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from your `.env` file, opens a browser for the OAuth consent flow, and writes the resulting refresh token back to `.env`.

---

## License

[MIT](LICENSE)
