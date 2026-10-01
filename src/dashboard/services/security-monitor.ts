/**
 * Security Monitor — periodically inspects each site for security regressions
 * and emits the Security Agent signals.
 *
 * Detectors:
 *   - security_header_missing  → from security_headers_check.missingHeaders
 *   - ssl_expiring             → from monitor_certificate.daysUntilExpiry
 *   - safe_browsing_flag       → from security_safe_browsing.matches
 *
 * Default cadence: every 12h (slower than GSC monitor because cert/headers
 * change rarely). Override with SECURITY_MONITOR_INTERVAL_MIN.
 *
 * Skips Safe Browsing without resolving its previous alerts when GOOGLE_SAFE_BROWSING_API_KEY is absent —
 * the rest of the security checks still emit.
 */

import { sitesStore, type Site } from './sites-store.js';
import { signalsRepo, type SignalSeverity } from './gsc-signals.js';
import type { SignalKind } from './agent-catalog.js';
import { executeToolByName } from './dashboard-data.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('security-monitor');

// Tunables
const SSL_DAYS_CRITICAL = parseInt(process.env.SECURITY_SSL_DAYS_CRITICAL || '7', 10);
const SSL_DAYS_WARN = parseInt(process.env.SECURITY_SSL_DAYS_WARN || '30', 10);
// Critical headers — if any is missing, emit. Others (e.g. Referrer-Policy)
// are recommendations, not red flags.
const CRITICAL_HEADERS = new Set(['Strict-Transport-Security', 'Content-Security-Policy', 'X-Frame-Options']);

interface HeadersCheckOutput {
  url?: string;
  grade?: string;
  score?: number;
  missingHeaders?: string[];
  recommendations?: string[];
}

interface CertificateOutput {
  hostname?: string;
  valid?: boolean;
  daysUntilExpiry?: number;
  validTo?: string;
  issues?: string[];
}

interface SafeBrowsingOutput {
  safe?: boolean;
  matches?: Array<{ threatType?: string; url?: string }>;
}



export interface SecurityMonitorRunResult {
  siteId: string;
  siteName: string;
  ok: boolean;
  emittedTypes: string[];
  resolvedCount: number;
  error?: string;
  checkedTypes?: string[];
  errors?: string[];
}

/**
 * Runs every detector for one site. Errors per-detector are swallowed and
 * logged so a single failure doesn't suppress the others.
 */
export async function runSecurityMonitorForSite(site: Site): Promise<SecurityMonitorRunResult> {
  const result: SecurityMonitorRunResult = {
    siteId: site.id,
    siteName: site.name,
    ok: true,
    emittedTypes: [],
    resolvedCount: 0,
  };

  const url = site.primaryUrl;
  if (!url) {
    result.ok = false;
    result.error = 'no primaryUrl on site';
    return result;
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    result.ok = false;
    result.error = `cannot parse primaryUrl: ${url}`;
    return result;
  }

  log.info('Running security monitor for site', { siteId: site.id, url, hostname });

  const checkedTypes: SignalKind[] = [];
  const errors: string[] = [];
  const failed = (type: string, error: unknown): void => { errors.push(type + ': ' + String(error)); };
  const safeBrowsingKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY;
  const [headersRes, certRes, sbRes] = await Promise.allSettled([
    executeToolByName<HeadersCheckOutput>('security_headers_check', { url }).then((out) => {
      if (!Array.isArray(out.missingHeaders)) throw new Error('invalid headers response');
      return out;
    }),
    executeToolByName<CertificateOutput>('monitor_certificate', { hostname, port: 443 }).then((out) => {
      if (typeof out.daysUntilExpiry !== 'number' || !Number.isFinite(out.daysUntilExpiry)) {
        throw new Error('invalid certificate response');
      }
      return out;
    }),
    safeBrowsingKey
      ? executeToolByName<SafeBrowsingOutput>('security_safe_browsing', { urls: [url] }).then((out) => {
        if (typeof out.safe !== 'boolean' || !Array.isArray(out.matches) ||
            (!out.safe && out.matches.length === 0)) throw new Error('invalid Safe Browsing response');
        return out;
      })
      : Promise.resolve<SafeBrowsingOutput | null>(null),
  ]);

  // ── security_header_missing ─────────────────────────────────────────
  if (headersRes.status === 'fulfilled') {
    checkedTypes.push('security_header_missing');
    const out = headersRes.value;
    const missing = (out.missingHeaders ?? []).filter((h) => CRITICAL_HEADERS.has(h));
    if (missing.length > 0) {
      const severity: SignalSeverity = missing.length >= 2 ? 'warn' : 'low';
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'security_header_missing' satisfies SignalKind,
        severity,
        title: `${missing.length} security header(s) crítico(s) ausente(s): ${missing.join(', ')}`,
        detail: {
          missing,
          grade: out.grade ?? null,
          score: out.score ?? null,
          recommendations: out.recommendations ?? [],
          checkedUrl: url,
        },
      });
      result.emittedTypes.push('security_header_missing');
    }
  } else {
    failed('security_header_missing', headersRes.reason);
    log.warn('security_headers_check failed', { siteId: site.id, error: String(headersRes.reason) });
  }

  // ── ssl_expiring ────────────────────────────────────────────────────
  if (certRes.status === 'fulfilled') {
    checkedTypes.push('ssl_expiring');
    const out = certRes.value;
    const days = out.daysUntilExpiry;
    if (typeof days === 'number') {
      if (days <= 0) {
        await signalsRepo.upsertOpen({
          siteId: site.id,
          signalType: 'ssl_expiring' satisfies SignalKind,
          severity: 'critical',
          title: `Certificado SSL EXPIRADO (${Math.abs(days)} días)`,
          detail: { daysUntilExpiry: days, validTo: out.validTo, hostname, issues: out.issues ?? [] },
        });
        result.emittedTypes.push('ssl_expiring');
      } else if (days <= SSL_DAYS_CRITICAL) {
        await signalsRepo.upsertOpen({
          siteId: site.id,
          signalType: 'ssl_expiring' satisfies SignalKind,
          severity: 'high',
          title: `Certificado SSL expira en ${days} día(s) — crítico`,
          detail: { daysUntilExpiry: days, validTo: out.validTo, hostname, issues: out.issues ?? [] },
        });
        result.emittedTypes.push('ssl_expiring');
      } else if (days <= SSL_DAYS_WARN) {
        await signalsRepo.upsertOpen({
          siteId: site.id,
          signalType: 'ssl_expiring' satisfies SignalKind,
          severity: 'warn',
          title: `Certificado SSL expira en ${days} día(s)`,
          detail: { daysUntilExpiry: days, validTo: out.validTo, hostname, issues: out.issues ?? [] },
        });
        result.emittedTypes.push('ssl_expiring');
      }
    }
  } else {
    failed('ssl_expiring', certRes.reason);
    log.warn('monitor_certificate failed', { siteId: site.id, hostname, error: String(certRes.reason) });
  }

  // ── safe_browsing_flag ──────────────────────────────────────────────
  if (sbRes.status === 'fulfilled' && sbRes.value) {
    checkedTypes.push('safe_browsing_flag');
    const out = sbRes.value;
    if (out.safe === false && (out.matches?.length ?? 0) > 0) {
      const threats = (out.matches ?? []).map((m) => m.threatType ?? 'unknown');
      await signalsRepo.upsertOpen({
        siteId: site.id,
        signalType: 'safe_browsing_flag' satisfies SignalKind,
        severity: 'critical',
        title: `Google Safe Browsing detectó ${out.matches?.length ?? 0} threat(s): ${threats.join(', ')}`,
        detail: { matches: out.matches ?? [], checkedUrl: url },
      });
      result.emittedTypes.push('safe_browsing_flag');
    }
  } else if (sbRes.status === 'rejected') {
    failed('safe_browsing_flag', sbRes.reason);
    log.warn('safe_browsing failed', { siteId: site.id, error: String(sbRes.reason) });
  }

  if (!safeBrowsingKey) failed('safe_browsing_flag', 'skipped: API key not configured');
  result.checkedTypes = checkedTypes;
  result.errors = errors;
  result.ok = errors.length === 0;
  if (errors.length) result.error = errors.join('; ');
  // Only successful detectors can establish that their previous alert resolved.
  if (checkedTypes.length) {
    result.resolvedCount = await signalsRepo.resolveByTypes(site.id, checkedTypes, result.emittedTypes);
  }

  log.info('Security monitor done for site', {
    siteId: site.id,
    emitted: result.emittedTypes,
    resolved: result.resolvedCount,
  });
  return result;
}

export async function runSecurityMonitorAll(): Promise<SecurityMonitorRunResult[]> {
  const all = await sitesStore.list();
  const eligible = all.filter((s) => !!s.primaryUrl);
  if (eligible.length === 0) {
    log.info('No sites with primaryUrl — skipping security monitor run');
    return [];
  }
  log.info('Running security monitor for all sites', { count: eligible.length });
  const results: SecurityMonitorRunResult[] = [];
  for (const site of eligible) {
    try {
      results.push(await runSecurityMonitorForSite(site));
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

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let initialHandle: ReturnType<typeof setTimeout> | null = null;
let scheduledRunActive = false;

async function runScheduledMonitor(): Promise<void> {
  if (scheduledRunActive) return;
  scheduledRunActive = true;
  try {
    await runSecurityMonitorAll();
  } catch (err) {
    log.error('Scheduled security monitor run failed', { error: err instanceof Error ? err : new Error(String(err)) });
  } finally {
    scheduledRunActive = false;
  }
}

export function startSecurityMonitorScheduler(): void {
  if (process.env.SECURITY_MONITOR_DISABLED === 'true') {
    log.info('Security monitor disabled via env');
    return;
  }
  if (intervalHandle) return;

  const intervalMin = parseInt(process.env.SECURITY_MONITOR_INTERVAL_MIN || '720', 10); // 12h default
  const initialDelayMs = parseInt(process.env.SECURITY_MONITOR_INITIAL_DELAY_MS || '20000', 10); // 20s after boot

  log.info('Security monitor scheduler started', { intervalMin, initialDelayMs });

  initialHandle = setTimeout(() => {
    initialHandle = null;
    void runScheduledMonitor();
  }, initialDelayMs);

  intervalHandle = setInterval(() => {
    void runScheduledMonitor();
  }, intervalMin * 60 * 1000);
}

export function stopSecurityMonitorScheduler(): void {
  if (initialHandle) {
    clearTimeout(initialHandle);
    initialHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('Security monitor scheduler stopped');
  }
}
