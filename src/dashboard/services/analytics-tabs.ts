/**
 * Analytics tabs — resolves the Links / Technical / GEO tabs of the
 * Command Center analytics column into structured widget payloads.
 *
 * Cache-only by design: each widget reads `snapshotsRepo.getLatest()`.
 * If a snapshot is missing, the widget renders an empty state with a
 * one-click "Run audit" action that POSTs to `/api/tool/:name` and
 * persists a fresh snapshot. This keeps tab loads instant (no inline
 * 30-second tool runs) and lets the user control which audits run.
 *
 * SEO tab is intentionally NOT here — its data ships in the main
 * `/api/cc/site/:id` payload (Lighthouse + CWV via snapshots) and is
 * rendered by the existing frontend code.
 *
 * Adding a new tab: append to `TabName`, add a resolver, add a case to
 * `resolveTab`. Widget formats are generic enough that no new render
 * code is usually needed on the frontend.
 */

import { snapshotsRepo, type SnapshotKind } from './snapshots.js';
import { sitesStore, type Site } from './sites-store.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('cc-analytics-tabs');

export const TAB_NAMES = ['links', 'technical', 'geo'] as const;
export type TabName = typeof TAB_NAMES[number];

export function isTabName(value: string): value is TabName {
  return (TAB_NAMES as readonly string[]).includes(value);
}

/** What the UI knows how to render. */
export type WidgetFormat = 'status-list' | 'top-list' | 'kv' | 'empty';

export interface WidgetAction {
  label: string;
  tool: string;
  inputHint?: Record<string, unknown>;
}

export interface StatusItem {
  label: string;
  status: 'good' | 'warn' | 'bad' | 'unknown';
  detail?: string;
}

export interface TopItem {
  label: string;
  value: string | number;
  secondary?: string;
}

export interface TabWidget {
  id: string;
  title: string;
  format: WidgetFormat;
  /** For 'status-list', 'top-list', 'kv' — shape matches format. */
  data?: unknown;
  capturedAt?: string;
  isStale?: boolean;
  /** Tools the user can run to populate or refresh this widget. */
  actions?: WidgetAction[];
  /** Shown when data is null/empty. */
  emptyState?: { message: string };
}

export interface TabPayload {
  tabName: TabName;
  widgets: TabWidget[];
}

// ---------------------------------------------------------------------------
// Freshness windows per snapshot kind used by tabs.
// ---------------------------------------------------------------------------

const STALE_AFTER: Partial<Record<SnapshotKind, number>> = {
  gsc_top_queries: 60 * 60 * 6,
  gsc_top_pages: 60 * 60 * 6,
  broken_links: 60 * 60 * 24,
  seo_robots: 60 * 60 * 24,
  seo_sitemap_status: 60 * 60 * 12,
  seo_structured_data: 60 * 60 * 24,
  security_headers: 60 * 60 * 12,
  security_ssl: 60 * 60 * 24,
  llms_txt_probe: 60 * 60 * 24,
  geo_audit: 60 * 60 * 24,
};

function isStale(capturedAt: string, kind: SnapshotKind): boolean {
  const max = STALE_AFTER[kind];
  if (!max) return false;
  return (Date.now() - new Date(capturedAt).getTime()) / 1000 >= max;
}

// ---------------------------------------------------------------------------
// Resolvers — one per tab
// ---------------------------------------------------------------------------

async function resolveLinksTab(site: Site): Promise<TabPayload> {
  const gscSiteUrl = site.bindings.gscSiteUrl ?? '';
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const dateRange = { startDate: daysAgo(30), endDate: today };

  const [topQueries, topPages, brokenLinks] = await Promise.all([
    snapshotsRepo.getLatest<{ queries?: Array<{ query: string; clicks: number; impressions: number; position: number }> }>(site.id, 'gsc_top_queries'),
    snapshotsRepo.getLatest<{ pages?: Array<{ page: string; clicks: number; impressions: number }> }>(site.id, 'gsc_top_pages'),
    snapshotsRepo.getLatest<{ totalLinks?: number; brokenCount?: number; broken?: Array<{ url: string; status: number }> }>(site.id, 'broken_links'),
  ]);

  const widgets: TabWidget[] = [];

  // Top queries
  widgets.push(
    topQueries
      ? {
          id: 'top_queries',
          title: 'Top queries (últimos 30 días)',
          format: 'top-list',
          capturedAt: topQueries.capturedAt,
          isStale: isStale(topQueries.capturedAt, 'gsc_top_queries'),
          data: {
            items: (topQueries.data.queries ?? []).slice(0, 10).map((q) => ({
              label: q.query,
              value: q.clicks,
              secondary: `${q.impressions} impr · pos ${q.position.toFixed(1)}`,
            })),
          },
          actions: [{ label: 'Re-cargar', tool: 'gsc_top_queries', inputHint: { siteUrl: gscSiteUrl, dateRange, limit: 50 } }],
        }
      : {
          id: 'top_queries',
          title: 'Top queries (últimos 30 días)',
          format: 'empty',
          emptyState: { message: 'Sin datos cargados.' },
          actions: [{ label: 'Cargar desde GSC', tool: 'gsc_top_queries', inputHint: { siteUrl: gscSiteUrl, dateRange, limit: 50 } }],
        },
  );

  // Top pages
  widgets.push(
    topPages
      ? {
          id: 'top_pages',
          title: 'Top páginas (últimos 30 días)',
          format: 'top-list',
          capturedAt: topPages.capturedAt,
          isStale: isStale(topPages.capturedAt, 'gsc_top_pages'),
          data: {
            items: (topPages.data.pages ?? []).slice(0, 10).map((p) => ({
              label: p.page.replace(site.primaryUrl ?? '', '/').replace(/^\/\//, '/'),
              value: p.clicks,
              secondary: `${p.impressions} impr`,
            })),
          },
          actions: [{ label: 'Re-cargar', tool: 'gsc_top_pages', inputHint: { siteUrl: gscSiteUrl, dateRange, limit: 50 } }],
        }
      : {
          id: 'top_pages',
          title: 'Top páginas (últimos 30 días)',
          format: 'empty',
          emptyState: { message: 'Sin datos cargados.' },
          actions: [{ label: 'Cargar desde GSC', tool: 'gsc_top_pages', inputHint: { siteUrl: gscSiteUrl, dateRange, limit: 50 } }],
        },
  );

  // Broken links health
  widgets.push(
    brokenLinks
      ? {
          id: 'broken_links',
          title: 'Salud de links internos',
          format: 'kv',
          capturedAt: brokenLinks.capturedAt,
          isStale: isStale(brokenLinks.capturedAt, 'broken_links'),
          data: {
            'Total links': brokenLinks.data.totalLinks ?? 0,
            'Links rotos': brokenLinks.data.brokenCount ?? 0,
            'Primeros 5 rotos': (brokenLinks.data.broken ?? []).slice(0, 5).map((b) => `${b.status} · ${b.url}`).join(' · ') || 'ninguno',
          },
          actions: [{ label: 'Re-crawlear', tool: 'util_broken_links', inputHint: { url: site.primaryUrl } }],
        }
      : {
          id: 'broken_links',
          title: 'Salud de links internos',
          format: 'empty',
          emptyState: { message: 'No corriste el broken-links crawler todavía.' },
          actions: [{ label: 'Crawlear links', tool: 'util_broken_links', inputHint: { url: site.primaryUrl } }],
        },
  );

  return { tabName: 'links', widgets };
}

async function resolveTechnicalTab(site: Site): Promise<TabPayload> {
  const url = site.primaryUrl;

  const [robots, sitemapStatus, structuredData, headers, ssl] = await Promise.all([
    snapshotsRepo.getLatest<{ allowed?: boolean; disallowed?: string[]; sitemaps?: string[] }>(site.id, 'seo_robots'),
    snapshotsRepo.getLatest<{ valid?: number; errors?: number; warnings?: number; sitemapsCount?: number }>(site.id, 'seo_sitemap_status'),
    snapshotsRepo.getLatest<{ schemas?: string[]; total?: number; valid?: boolean }>(site.id, 'seo_structured_data'),
    snapshotsRepo.getLatest<{ score?: number; grade?: string; missing?: string[] }>(site.id, 'security_headers'),
    snapshotsRepo.getLatest<{ grade?: string; valid?: boolean; daysToExpiry?: number }>(site.id, 'security_ssl'),
  ]);

  const items: StatusItem[] = [];
  const actions: WidgetAction[] = [];

  // robots
  if (robots) {
    items.push({
      label: 'robots.txt',
      status: robots.data.allowed !== false ? 'good' : 'warn',
      detail: `${(robots.data.disallowed ?? []).length} disallow rule(s) · ${(robots.data.sitemaps ?? []).length} sitemap ref(s)`,
    });
  } else {
    items.push({ label: 'robots.txt', status: 'unknown', detail: 'no analizado' });
    actions.push({ label: 'Analizar robots.txt', tool: 'seo_robots_analyze', inputHint: { url } });
  }

  // sitemap
  if (sitemapStatus) {
    const errs = sitemapStatus.data.errors ?? 0;
    items.push({
      label: 'Sitemap (GSC)',
      status: errs > 0 ? 'bad' : (sitemapStatus.data.warnings ?? 0) > 0 ? 'warn' : 'good',
      detail: `${sitemapStatus.data.sitemapsCount ?? 0} sitemap(s) · ${errs} errores · ${sitemapStatus.data.warnings ?? 0} warnings`,
    });
  } else {
    items.push({ label: 'Sitemap (GSC)', status: 'unknown', detail: 'no analizado' });
    actions.push({ label: 'Listar sitemaps', tool: 'gsc_list_sitemaps', inputHint: { siteUrl: site.bindings.gscSiteUrl } });
  }

  // structured data
  if (structuredData) {
    items.push({
      label: 'Structured data',
      status: (structuredData.data.total ?? 0) > 0 ? 'good' : 'warn',
      detail: `${structuredData.data.total ?? 0} schema(s) · ${(structuredData.data.schemas ?? []).join(', ') || 'ninguno'}`,
    });
  } else {
    items.push({ label: 'Structured data', status: 'unknown', detail: 'no analizado' });
    actions.push({ label: 'Escanear schema', tool: 'seo_structured_data', inputHint: { url } });
  }

  // security headers
  if (headers) {
    const s = headers.data.score ?? 0;
    items.push({
      label: 'Security headers',
      status: s >= 80 ? 'good' : s >= 50 ? 'warn' : 'bad',
      detail: `Score ${s}/100 · grade ${headers.data.grade ?? '—'} · ${(headers.data.missing ?? []).length} faltantes`,
    });
  } else {
    items.push({ label: 'Security headers', status: 'unknown', detail: 'no analizado' });
    actions.push({ label: 'Chequear headers', tool: 'security_headers_check', inputHint: { url } });
  }

  // SSL
  if (ssl) {
    const days = ssl.data.daysToExpiry ?? 0;
    items.push({
      label: 'SSL',
      status: days < 14 ? 'bad' : days < 30 ? 'warn' : 'good',
      detail: `Grade ${ssl.data.grade ?? '—'} · expira en ${days} día(s)`,
    });
  } else {
    items.push({ label: 'SSL', status: 'unknown', detail: 'no analizado' });
    actions.push({ label: 'Analizar SSL', tool: 'security_ssl_analyze', inputHint: { url } });
  }

  return {
    tabName: 'technical',
    widgets: [
      {
        id: 'technical_status',
        title: 'Estado técnico',
        format: 'status-list',
        data: { items },
        actions: actions.length > 0 ? actions : undefined,
        emptyState: items.every((i) => i.status === 'unknown')
          ? { message: 'Ningún chequeo corrido todavía. Usá los botones de abajo para empezar.' }
          : undefined,
      },
    ],
  };
}

async function resolveGeoTab(site: Site): Promise<TabPayload> {
  const url = site.primaryUrl;
  const baseUrl = url ? new URL(url).origin : '';

  interface LlmsTxtProbe {
    llmsTxt?: { exists?: boolean; status?: number; valid?: boolean; parsed?: { totalLinks?: number; sections?: unknown[] } };
    llmsFullTxt?: { exists?: boolean; status?: number };
    recommendations?: string[];
  }
  const [llmsTxt, geoAudit] = await Promise.all([
    snapshotsRepo.getLatest<LlmsTxtProbe>(site.id, 'llms_txt_probe'),
    snapshotsRepo.getLatest<{ score?: number; grade?: string; checks?: Array<{ label: string; passed: boolean }> }>(site.id, 'geo_audit'),
  ]);

  const items: StatusItem[] = [];
  const actions: WidgetAction[] = [];

  // llms.txt
  const llms = llmsTxt?.data?.llmsTxt;
  if (llms) {
    items.push({
      label: '/llms.txt',
      status: llms.exists && llms.valid ? 'good' : llms.exists ? 'warn' : 'bad',
      detail: llms.exists
        ? `${llms.parsed?.totalLinks ?? 0} links · ${(llms.parsed?.sections ?? []).length} sections${llms.valid ? '' : ' · estructura inválida'}`
        : `HTTP ${llms.status ?? '—'}`,
    });
  } else {
    items.push({ label: '/llms.txt', status: 'unknown', detail: 'no probado' });
    actions.push({ label: 'Validar llms.txt', tool: 'geo_validate_llms_txt', inputHint: { baseUrl } });
  }

  // llms-full.txt
  const llmsFull = llmsTxt?.data?.llmsFullTxt;
  if (llmsFull) {
    items.push({
      label: '/llms-full.txt',
      status: llmsFull.exists ? 'good' : 'warn',
      detail: llmsFull.exists ? `HTTP ${llmsFull.status}` : 'no publicado (opcional)',
    });
  }

  // GEO audit
  if (geoAudit) {
    const s = geoAudit.data.score ?? 0;
    const passed = (geoAudit.data.checks ?? []).filter((c) => c.passed).length;
    const total = (geoAudit.data.checks ?? []).length;
    items.push({
      label: 'AI-friendliness',
      status: s >= 75 ? 'good' : s >= 50 ? 'warn' : 'bad',
      detail: `Score ${s}/100 · grade ${geoAudit.data.grade ?? '—'} · ${passed}/${total} checks`,
    });
  } else {
    items.push({ label: 'AI-friendliness', status: 'unknown', detail: 'no auditado' });
    actions.push({ label: 'Auditar página', tool: 'geo_ai_search_friendly_audit', inputHint: { url } });
  }

  return {
    tabName: 'geo',
    widgets: [
      {
        id: 'geo_status',
        title: 'Visibilidad en AI search',
        format: 'status-list',
        data: { items },
        capturedAt: llmsTxt?.capturedAt,
        isStale: llmsTxt ? isStale(llmsTxt.capturedAt, 'llms_txt_probe') : undefined,
        actions: actions.length > 0 ? actions : undefined,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

export async function resolveTab(siteId: string, tabName: TabName): Promise<TabPayload> {
  const site = await sitesStore.get(siteId);
  if (!site) throw new Error(`Site ${siteId} not found`);

  log.debug('Resolving analytics tab', { siteId, tabName });

  switch (tabName) {
    case 'links':     return resolveLinksTab(site);
    case 'technical': return resolveTechnicalTab(site);
    case 'geo':       return resolveGeoTab(site);
  }
}

// Side-effect import keep to ensure SnapshotKind union stays in sync if other
// modules add kinds we depend on.
void STALE_AFTER;
