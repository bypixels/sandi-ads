/**
 * GSC Monitor — polls the GSC API for each active site and emits signals
 * for conditions that mirror the alerts Google sends by email.
 *
 * Detectors implemented:
 *  - coverage_high_excluded   ratio of excluded pages over total > threshold
 *  - coverage_errors          coverage report reports any errors
 *  - sitemap_errors           any sitemap with errors > 0 or warnings > 0
 *  - sitemap_zero_indexed     sitemap submitted N URLs but indexed = 0
 *  - traffic_drop             clicks last 7d dropped > threshold vs prior 7d
 *
 * Each detector either calls upsertOpen() (with an idempotent signalType)
 * or omits the call when the condition does not hold. After running all
 * detectors for a site, the watcher calls resolveStale() to close any
 * previously-open signals that no longer match.
 */

import { sitesStore, type Site } from './sites-store.js';
import { signalsRepo, type SignalSeverity } from './gsc-signals.js';
import { type SignalKind } from './agent-catalog.js';
import { executeToolByName } from './dashboard-data.js';
import { recordFailure, recordSuccess } from './monitor-health.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('gsc-monitor');

// Tunables — overridable via env. Defaults are conservative.
const COVERAGE_EXCLUDED_RATIO_HIGH = parseFloat(process.env.GSC_COVERAGE_EXCLUDED_RATIO_HIGH || '0.5');
const COVERAGE_EXCLUDED_RATIO_WARN = parseFloat(process.env.GSC_COVERAGE_EXCLUDED_RATIO_WARN || '0.3');
const TRAFFIC_DROP_PCT_HIGH = parseFloat(process.env.GSC_TRAFFIC_DROP_PCT_HIGH || '0.30');
const TRAFFIC_DROP_PCT_WARN = parseFloat(process.env.GSC_TRAFFIC_DROP_PCT_WARN || '0.15');
const TRAFFIC_DROP_MIN_BASELINE = parseInt(process.env.GSC_TRAFFIC_DROP_MIN_BASELINE || '20', 10);

interface CoverageReport {
  summary?: { valid?: number; validWithWarnings?: number; error?: number; excluded?: number; total?: number };
  issues?: Array<{ type: string; severity: string; description: string; count: number }>;
  recommendations?: string[];
}

interface SitemapsList {
  sitemaps?: Array<{
    path?: string;
    url?: string;
    errors?: number;
    warnings?: number;
    contents?: Array<{ type?: string; submitted?: number; indexed?: number }>;
    lastSubmitted?: string;
    lastDownloaded?: string;
  }>;
}

interface TopPagesResult {
  pages?: Array<{ page?: string; clicks?: number; impressions?: number }>;
  rows?: Array<{ page?: string; clicks?: number; impressions?: number }>;
  totals?: { clicks?: number; impressions?: number };
}

interface TopQueriesResult {
  queries?: Array<{ query?: string; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
}

/**
 * Signal kinds this monitor owns and reconciles. Any signal NOT in this set
 * (e.g. llms_txt_*, cwv_*, security_*) is left untouched — that's owned by
 * other producers (snapshot-signals, security-monitor).
 */
const GSC_MONITOR_OWNED: SignalKind[] = [
  'coverage_errors',
  'coverage_high_excluded',
  'sitemap_errors',
  'sitemap_zero_indexed',
  'traffic_drop',
  'content_gap',
  'gsc_query_near_miss',
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Last N days range, ending 3 days ago to compensate for GSC's 72h data lag. */
function trailingRange(days: number, offsetDaysFromToday = 3): { startDate: string; endDate: string } {
  const end = new Date();
  end.setDate(end.getDate() - offsetDaysFromToday);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

// Local alias keeps call sites short — executeToolByName is now generic so
// no per-call `as Promise<T>` cast is needed.
const callTool = executeToolByName;

function totalClicks(data: TopPagesResult | undefined): number {
  if (!data) return 0;
  if (data.totals?.clicks != null) return data.totals.clicks;
  const list = data.pages || data.rows || [];
  return list.reduce((s, r) => s + (r.clicks || 0), 0);
}

export interface MonitorRunResult {
  siteId: string;
  siteName: string;
  ok: boolean;
  emittedTypes: string[];
  resolvedCount: number;
  error?: string;
}

/**
 * Runs every detector for one site and reconciles the open-signals state.
 * Never throws — errors are captured into the result.
 */
export async function runMonitorForSite(site: Site): Promise<MonitorRunResult> {
  const result: MonitorRunResult = {
    siteId: site.id,
    siteName: site.name,
    ok: true,
    emittedTypes: [],
    resolvedCount: 0,
  };

  const siteUrl = site.bindings?.gscSiteUrl;
  if (!siteUrl) {
    result.ok = false;
    result.error = 'no gscSiteUrl binding';
    return result;
  }

  log.info('Running GSC monitor for site', { siteId: site.id, siteUrl });
  const gscFailures: string[] = [];

  // Run detectors in parallel — they're independent
  const [coverageRes, sitemapsRes, currentRes, priorRes, queriesRes] = await Promise.allSettled([
    callTool<CoverageReport>('gsc_coverage_report', { siteUrl }),
    callTool<SitemapsList>('gsc_list_sitemaps', { siteUrl }),
    callTool<TopPagesResult>('gsc_top_pages', { siteUrl, dateRange: trailingRange(7, 3), limit: 50 }),
    callTool<TopPagesResult>('gsc_top_pages', { siteUrl, dateRange: trailingRange(7, 10), limit: 50 }),
    callTool<TopQueriesResult>('gsc_top_queries', { siteUrl, dateRange: trailingRange(28, 3), limit: 200 }),
  ]);

  // ── coverage detectors ──────────────────────────────────────────────
  if (coverageRes.status === 'fulfilled') {
    const cov = coverageRes.value;
    const total = cov.summary?.total || 0;
    const excluded = cov.summary?.excluded || 0;
    const errors = cov.summary?.error || 0;

    if (errors > 0) {
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'coverage_errors' satisfies SignalKind,
        severity: 'high',
        title: `${errors} página(s) con error de coverage en GSC`,
        detail: { total, excluded, errors, issues: cov.issues || [], recommendations: cov.recommendations || [] },
      });
      result.emittedTypes.push('coverage_errors');
    }

    if (total > 0 && excluded / total >= COVERAGE_EXCLUDED_RATIO_HIGH) {
      const sev: SignalSeverity = excluded / total >= 0.7 ? 'high' : 'warn';
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'coverage_high_excluded' satisfies SignalKind,
        severity: sev,
        title: `${excluded} de ${total} páginas excluidas (${Math.round((excluded / total) * 100)}%)`,
        detail: {
          total,
          excluded,
          ratio: excluded / total,
          issues: cov.issues || [],
          recommendations: cov.recommendations || [],
        },
      });
      result.emittedTypes.push('coverage_high_excluded');
    } else if (total > 0 && excluded / total >= COVERAGE_EXCLUDED_RATIO_WARN) {
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'coverage_high_excluded' satisfies SignalKind,
        severity: 'low',
        title: `${excluded} de ${total} páginas excluidas (${Math.round((excluded / total) * 100)}%) — revisar`,
        detail: { total, excluded, ratio: excluded / total, issues: cov.issues || [] },
      });
      result.emittedTypes.push('coverage_high_excluded');
    }
  } else {
    log.warn('coverage_report failed', { siteId: site.id, error: String(coverageRes.reason) });
    gscFailures.push('coverage_report: ' + String(coverageRes.reason));
  }

  // ── sitemap detectors ───────────────────────────────────────────────
  if (sitemapsRes.status === 'fulfilled') {
    const sitemaps = sitemapsRes.value.sitemaps || [];
    const errored = sitemaps.filter((s) => (s.errors || 0) > 0 || (s.warnings || 0) > 0);
    if (errored.length > 0) {
      const totalErrors = errored.reduce((sum, s) => sum + (s.errors || 0), 0);
      const totalWarnings = errored.reduce((sum, s) => sum + (s.warnings || 0), 0);
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'sitemap_errors' satisfies SignalKind,
        severity: totalErrors > 0 ? 'warn' : 'low',
        title: `${errored.length} sitemap(s) con problemas: ${totalErrors} errores, ${totalWarnings} warnings`,
        detail: {
          totalErrors,
          totalWarnings,
          sitemaps: errored.map((s) => ({
            path: s.path || s.url,
            errors: s.errors || 0,
            warnings: s.warnings || 0,
          })),
        },
      });
      result.emittedTypes.push('sitemap_errors');
    }

    const submittedNotIndexed = sitemaps.filter((s) => {
      const submitted = (s.contents || []).reduce((sum, c) => sum + (c.submitted || 0), 0);
      const indexed = (s.contents || []).reduce((sum, c) => sum + (c.indexed || 0), 0);
      return submitted >= 5 && indexed === 0;
    });
    if (submittedNotIndexed.length > 0) {
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'sitemap_zero_indexed' satisfies SignalKind,
        severity: 'high',
        title: `Sitemap con URLs enviadas pero 0 indexadas`,
        detail: {
          sitemaps: submittedNotIndexed.map((s) => ({
            path: s.path || s.url,
            lastSubmitted: s.lastSubmitted,
            lastDownloaded: s.lastDownloaded,
            submitted: (s.contents || []).reduce((sum, c) => sum + (c.submitted || 0), 0),
            indexed: 0,
          })),
          recommendation:
            'Probable causa: thin content, canonical apuntando a otra URL, duplicate, o low quality signal. Revisar URL inspection en una muestra para diagnosticar.',
        },
      });
      result.emittedTypes.push('sitemap_zero_indexed');
    }
  } else {
    log.warn('list_sitemaps failed', { siteId: site.id, error: String(sitemapsRes.reason) });
    gscFailures.push('list_sitemaps: ' + String(sitemapsRes.reason));
  }

  // ── traffic-drop detector ──────────────────────────────────────────
  if (currentRes.status === 'fulfilled' && priorRes.status === 'fulfilled') {
    const current = totalClicks(currentRes.value);
    const prior = totalClicks(priorRes.value);
    if (prior >= TRAFFIC_DROP_MIN_BASELINE) {
      const dropPct = (prior - current) / prior;
      if (dropPct >= TRAFFIC_DROP_PCT_HIGH) {
        await signalsRepo.upsertOpen({
          siteId: site.id,
          signalType: 'traffic_drop' satisfies SignalKind,
          severity: 'high',
          title: `Clicks orgánicos cayeron ${Math.round(dropPct * 100)}% vs semana previa`,
          detail: { currentClicks: current, priorClicks: prior, dropPct, window: '7d' },
        });
        result.emittedTypes.push('traffic_drop');
      } else if (dropPct >= TRAFFIC_DROP_PCT_WARN) {
        await signalsRepo.upsertOpen({
          siteId: site.id,
          signalType: 'traffic_drop' satisfies SignalKind,
          severity: 'warn',
          title: `Clicks orgánicos cayeron ${Math.round(dropPct * 100)}% vs semana previa`,
          detail: { currentClicks: current, priorClicks: prior, dropPct, window: '7d' },
        });
        result.emittedTypes.push('traffic_drop');
      }
    }
  } else {
    log.warn('top_pages compare failed', { siteId: site.id });
  }

  // ── content detectors (content_gap + gsc_query_near_miss) ───────────
  if (queriesRes.status === 'fulfilled') {
    const queries = queriesRes.value.queries ?? [];

    // content_gap: high impressions, low CTR, past page 2 — opportunity but
    // ranking too low to convert. Capped to top 10 worst offenders.
    const gaps = queries
      .filter((q) => (q.impressions ?? 0) >= 100 && (q.ctr ?? 0) < 0.01 && (q.position ?? 0) > 20)
      .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
      .slice(0, 10);
    if (gaps.length > 0) {
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'content_gap' satisfies SignalKind,
        severity: 'low',
        title: `${gaps.length} query(s) con muchas impressions pero baja conversión (oportunidad de contenido)`,
        detail: {
          queries: gaps.map((q) => ({
            query: q.query,
            impressions: q.impressions,
            ctr: q.ctr,
            position: q.position,
          })),
          recommendation: 'Considerar contenido dedicado a estas queries — alta demanda, baja captura.',
        },
      });
      result.emittedTypes.push('content_gap');
    }

    // gsc_query_near_miss: position 11-20 with meaningful impressions —
    // a small bump in rank could move them to page 1.
    const nearMisses = queries
      .filter((q) => {
        const p = q.position ?? 0;
        return p >= 11 && p <= 20 && (q.impressions ?? 0) >= 50;
      })
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
      .slice(0, 10);
    if (nearMisses.length > 0) {
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'gsc_query_near_miss' satisfies SignalKind,
        severity: 'info',
        title: `${nearMisses.length} query(s) en posición 11-20 — easy wins para empujar a página 1`,
        detail: {
          queries: nearMisses.map((q) => ({
            query: q.query,
            impressions: q.impressions,
            ctr: q.ctr,
            position: q.position,
          })),
          recommendation: 'Refrescar el contenido que rankea para estas queries; un pequeño boost mueve a top 10.',
        },
      });
      result.emittedTypes.push('gsc_query_near_miss');
    }
  } else {
    log.warn('gsc_top_queries failed', { siteId: site.id, error: String(queriesRes.reason) });
    gscFailures.push('gsc_top_queries: ' + String(queriesRes.reason));
  }

  // Resolve only the kinds this monitor OWNS that didn't trigger this run.
  // Signals owned by snapshot-signals / security-monitor stay untouched.
  if (gscFailures.length) recordFailure('gsc', 'gsc-monitor', gscFailures.join('; '), { pausable: false });
  else recordSuccess('gsc', 'gsc-monitor');

  result.resolvedCount = await signalsRepo.resolveByTypes(site.id, GSC_MONITOR_OWNED, result.emittedTypes);

  log.info('GSC monitor done for site', {
    siteId: site.id,
    emitted: result.emittedTypes,
    resolved: result.resolvedCount,
  });
  return result;
}

/** Run the monitor for every site that has a gscSiteUrl binding. */
export async function runMonitorAll(): Promise<MonitorRunResult[]> {
  const allSites = await sitesStore.list();
  const eligible = allSites.filter((s) => !!s.bindings?.gscSiteUrl);
  if (eligible.length === 0) {
    log.info('No sites with gscSiteUrl binding — skipping monitor run');
    return [];
  }
  log.info('Running GSC monitor for all sites', { count: eligible.length });
  const results: MonitorRunResult[] = [];
  for (const site of eligible) {
    try {
      results.push(await runMonitorForSite(site));
    } catch (err) {
      results.push({
        siteId: site.id,
        siteName: site.name,
        ok: false,
        emittedTypes: [],
        resolvedCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ── Scheduler ─────────────────────────────────────────────────────────────

let intervalHandle: NodeJS.Timeout | null = null;

export function startMonitorScheduler(): void {
  if (process.env.GSC_MONITOR_DISABLED === 'true') {
    log.info('GSC monitor disabled via env');
    return;
  }
  if (intervalHandle) return;

  const intervalMin = parseInt(process.env.GSC_MONITOR_INTERVAL_MIN || '360', 10); // 6h default
  const initialDelayMs = parseInt(process.env.GSC_MONITOR_INITIAL_DELAY_MS || '15000', 10); // 15s after boot

  log.info('GSC monitor scheduler started', { intervalMin, initialDelayMs });

  // First run, after a short delay so OAuth/etc has time to settle
  setTimeout(() => {
    void runMonitorAll().catch((err) =>
      log.error('Initial monitor run failed', { error: err instanceof Error ? err : new Error(String(err)) }),
    );
  }, initialDelayMs);

  intervalHandle = setInterval(() => {
    void runMonitorAll().catch((err) =>
      log.error('Scheduled monitor run failed', { error: err instanceof Error ? err : new Error(String(err)) }),
    );
  }, intervalMin * 60 * 1000);
}

export function stopMonitorScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('GSC monitor scheduler stopped');
  }
}
