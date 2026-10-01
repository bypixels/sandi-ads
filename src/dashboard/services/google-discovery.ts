/**
 * Discover everything an active Google account has access to and group it
 * by domain. Output is the proposed list of Sites for bulk import.
 *
 * Shape:
 *   - Per-source fetchers (`fetchGscSites`, `fetchGa4Properties`, etc.)
 *     each take the bucket map and return their own errors. Each is
 *     testable in isolation by handing it a fresh Map and asserting
 *     what got added.
 *   - GTM is two-phase: `fetchGtmContainers` collects the raw list,
 *     `attachGtmContainers` runs LATER (after GSC/GA4/Ads but BEFORE GBP)
 *     so `bestGuessDomain` can match container names against the GSC+GA4
 *     domain set. The ordering is load-bearing — preserved deliberately.
 *   - The coordinator (`discoverAllForActiveAccount`) handles ordering,
 *     bucket→array conversion, dedup against DB, typo detection, sort.
 *
 * The grouping heuristic is conservative: we extract a hostname for each
 * resource (skipping resources that don't carry one — Ads customers, GTM
 * accounts) and bucket by hostname. Resources without a hostname become
 * orphans the user can attach manually after creation.
 */

import { executeToolByName } from './dashboard-data.js';
import { sitesStore } from './sites-store.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('google-discovery');

// Local alias keeps call sites short. executeToolByName is the single seam;
// no `as Promise<T>` needed now that it's generic.
const call = executeToolByName;

function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('sc-domain:')) return url.slice('sc-domain:'.length).toLowerCase();
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Extract a domain hint from a free-text label (e.g. a GTM container name
 * like "By Pixels Costa Rica / www.bypixelscr.com" or "Infocus / infocuscr").
 *
 * Steps:
 *   1. Look for an explicit `<sub>.<tld>` pattern with a 2-6 char TLD.
 *   2. Fallback to token-matching against known buckets — split the label
 *      into alphanumeric tokens, return the bucket whose first label
 *      matches a token of length >= 4.
 *
 * Returns lowercased apex hostname, or null when nothing useful is found.
 */
function bestGuessDomain(label: string, knownDomains: string[]): string | null {
  if (!label) return null;
  const lower = label.toLowerCase();

  // (1) Explicit domain pattern in the text
  const m = lower.match(/\b([a-z0-9][a-z0-9-]{0,62}\.(?:[a-z]{2,6}\.)?[a-z]{2,6})\b/);
  if (m) {
    const candidate = m[1].replace(/^www\./, '');
    if (knownDomains.includes(candidate)) return candidate;
    // Even if not in knownDomains, return it — caller can decide
    return candidate;
  }

  // (2) Token-based fuzzy match against known buckets
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return null;
  for (const dom of knownDomains) {
    // First label of the bucket (apex without TLD): "infocuscr.com" → "infocuscr"
    const firstLabel = dom.split('.')[0];
    if (firstLabel.length >= 4 && tokens.includes(firstLabel)) return dom;
  }
  return null;
}

export interface DiscoveredBindingSource {
  service: 'gsc' | 'ga4' | 'gtm' | 'gbp';
  resourceType: string;
  resourceId: string;
  resourceLabel: string;
  rawUrl?: string;
}

export interface DiscoveredSite {
  /** Lowercased hostname this site groups around (apex domain — www stripped) */
  domain: string;
  /** Display name we propose (best label across sources) */
  suggestedName: string;
  /** Best primary URL (https://<host>/ — promoted to https) */
  primaryUrl: string;
  /** Bindings ready to paste into Site.bindings */
  bindings: {
    ga4PropertyId?: string;
    gscSiteUrl?: string;
    gtmAccountId?: string;
    gtmContainerId?: string;
    gbpAccountId?: string;
    gbpLocationName?: string;
  };
  /** Per-source records, useful for the UI to show what it's about to create */
  sources: DiscoveredBindingSource[];
  /** Set when this domain already exists as a Site in the DB. UI uses this to
   *  show a "ya existe" badge and unchecks it by default. */
  existingSiteId?: string;
  existingSiteName?: string;
  /** When true, our auto-bindings differ from the existing Site's bindings —
   *  user can choose to upsert. */
  hasNewBindings?: boolean;
  /** Set when our discovered domain doesn't match the existing Site's
   *  canonical primaryUrl hostname. Common cause: a typo in a GA4 stream's
   *  defaultUri or a www-prefixed mismatch. */
  domainMismatch?: { canonical: string; reason: string };
  /** Set on NEW (un-deduped) buckets that look very similar to another
   *  bucket. Surfaced in the UI as a "¿typo?" warning. */
  suspiciousSimilarTo?: string;
}

export interface DiscoverySummary {
  byDomain: DiscoveredSite[];
  /** Resources that have no associated hostname (Ads customers, GTM accounts without a website) */
  unmatched: {
    adsCustomers?: Array<{ id: string; descriptiveName: string }>;
    gtmAccounts?: Array<{ accountId: string; name: string }>;
  };
  errors: Array<{ source: string; message: string }>;
}

interface BucketRow {
  bindings: DiscoveredSite['bindings'];
  sources: DiscoveredBindingSource[];
  bestName?: string;
  bestNamePriority: number; // higher = better
}

/** Higher-priority sources contribute the display name */
const NAME_PRIORITY: Record<string, number> = {
  gbp_location: 5,
  ga4_property: 4,
  gtm_container: 3,
  gsc_site: 2,
};

function ensureBucket(map: Map<string, BucketRow>, domain: string): BucketRow {
  let b = map.get(domain);
  if (!b) {
    b = { bindings: {}, sources: [], bestName: undefined, bestNamePriority: -1 };
    map.set(domain, b);
  }
  return b;
}

function maybeName(b: BucketRow, name: string | undefined, sourceType: string): void {
  if (!name) return;
  const priority = NAME_PRIORITY[sourceType] ?? 0;
  if (priority > b.bestNamePriority) {
    b.bestName = name;
    b.bestNamePriority = priority;
  }
}

/**
 * Match a discovered domain against existing Sites. Hits when:
 *   - existing site's primaryUrl hostname matches the domain
 *   - any binding overlaps (gscSiteUrl / ga4PropertyId / gtmContainerId / gbpLocationName)
 *
 * Returns the matched site so the caller can compare bindings.
 */
type MatchableSite = { id: string; name: string; primaryUrl: string; bindings: Record<string, string | undefined> | unknown };

function findExistingMatch<T extends MatchableSite>(
  dom: DiscoveredSite,
  existing: T[],
): T | null {
  // Hostname match (highest priority)
  for (const s of existing) {
    const existingHost = hostFromUrl(s.primaryUrl);
    if (existingHost === dom.domain) return s;
  }
  // Binding overlap (lower priority)
  for (const s of existing) {
    const b = (s.bindings || {}) as Record<string, string | undefined>;
    if (
      (dom.bindings.gscSiteUrl && b.gscSiteUrl === dom.bindings.gscSiteUrl) ||
      (dom.bindings.ga4PropertyId && b.ga4PropertyId === dom.bindings.ga4PropertyId) ||
      (dom.bindings.gtmContainerId && b.gtmContainerId === dom.bindings.gtmContainerId) ||
      (dom.bindings.gbpLocationName && b.gbpLocationName === dom.bindings.gbpLocationName)
    ) {
      return s;
    }
  }
  return null;
}

/** Classic Levenshtein edit distance. Used to detect domain typos. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** Compare two apex domains for "looks like a typo" likeness. */
function looksLikeTypo(a: string, b: string): boolean {
  if (a === b) return false;
  // Same TLD only — comparing arinconadacr.com vs example.net is noise.
  const aTld = a.split('.').slice(1).join('.');
  const bTld = b.split('.').slice(1).join('.');
  if (aTld !== bTld) return false;
  const aLabel = a.split('.')[0];
  const bLabel = b.split('.')[0];
  // Substring containment with small length diff (catches missing prefix/suffix)
  if (aLabel.length >= 5 && bLabel.length >= 5) {
    if (aLabel.includes(bLabel) || bLabel.includes(aLabel)) {
      if (Math.abs(aLabel.length - bLabel.length) <= 2) return true;
    }
  }
  // Edit distance ≤ 2 on the first label
  return levenshtein(aLabel, bLabel) <= 2;
}

/**
 * Merge buckets that resolve to the same existing Site. Happens when a
 * GA4 stream's defaultUri has a typo so we end up with two buckets
 * (correct domain + typo domain) that both `findExistingMatch` against
 * the same Site in the DB.
 *
 * The canonical bucket is the one whose domain matches the existing
 * Site's primaryUrl hostname (or the first one if none match).
 */
function mergeBucketsByExistingSite(items: DiscoveredSite[]): DiscoveredSite[] {
  const groups = new Map<string, DiscoveredSite[]>();
  const out: DiscoveredSite[] = [];
  for (const it of items) {
    if (!it.existingSiteId) {
      out.push(it);
      continue;
    }
    const arr = groups.get(it.existingSiteId) || [];
    arr.push(it);
    groups.set(it.existingSiteId, arr);
  }
  for (const [, arr] of groups) {
    if (arr.length === 1) {
      out.push(arr[0]);
      continue;
    }
    // Pick the canonical bucket: prefers matching hostname of existing site,
    // then most sources.
    const canonicalHost = arr[0].domainMismatch?.canonical || null;
    arr.sort((a, b) => {
      const aMatch = canonicalHost && a.domain === canonicalHost ? 1 : 0;
      const bMatch = canonicalHost && b.domain === canonicalHost ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return b.sources.length - a.sources.length;
    });
    const head = arr[0];
    for (let i = 1; i < arr.length; i++) {
      const tail = arr[i];
      // Merge bindings (keep head's first, fill gaps from tail)
      for (const [k, v] of Object.entries(tail.bindings) as Array<[
        keyof DiscoveredSite['bindings'],
        string | undefined,
      ]>) {
        if (v && !head.bindings[k]) {
          (head.bindings as Record<string, string | undefined>)[k] = v;
        }
      }
      head.sources.push(...tail.sources);
    }
    out.push(head);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Per-source fetchers
// ────────────────────────────────────────────────────────────────────

type SourceErrors = Array<{ source: string; message: string }>;

/** Walk GSC sites, bucketing each by hostname. Prefer sc-domain entries. */
async function fetchGscSites(buckets: Map<string, BucketRow>): Promise<SourceErrors> {
  const errors: SourceErrors = [];
  try {
    const gsc = await call<{ sites: Array<{ siteUrl: string; permissionLevel: string }> }>('gsc_list_sites', {});
    for (const s of gsc.sites || []) {
      const host = hostFromUrl(s.siteUrl);
      if (!host) continue;
      const b = ensureBucket(buckets, host);
      if (!b.bindings.gscSiteUrl || s.siteUrl.startsWith('sc-domain:')) {
        b.bindings.gscSiteUrl = s.siteUrl;
      }
      b.sources.push({
        service: 'gsc',
        resourceType: 'gsc_site',
        resourceId: s.siteUrl,
        resourceLabel: s.siteUrl + ' (' + s.permissionLevel + ')',
        rawUrl: s.siteUrl,
      });
      maybeName(b, host, 'gsc_site');
    }
  } catch (err) {
    errors.push({ source: 'gsc_list_sites', message: err instanceof Error ? err.message : String(err) });
  }
  return errors;
}

/**
 * Walk GA4 accounts → properties → data streams. Each stream's defaultUri
 * is bucketed by hostname (this is where typos surface — a misspelled
 * defaultUri creates a phantom bucket).
 */
async function fetchGa4Properties(buckets: Map<string, BucketRow>): Promise<SourceErrors> {
  const errors: SourceErrors = [];
  try {
    const accounts = await call<{ accounts: Array<{ name: string; displayName: string }> }>('ga4_list_accounts', {});
    for (const acc of accounts.accounts || []) {
      const accountId = acc.name.replace('accounts/', '');
      try {
        const props = await call<{ properties: Array<{ name: string; displayName: string }> }>('ga4_list_properties', { accountId });
        for (const prop of props.properties || []) {
          const propId = prop.name.replace('properties/', '');
          try {
            const streamsRes = await call<{ dataStreams?: Array<{ webStreamData?: { defaultUri?: string } }> }>(
              'ga4_list_data_streams',
              { propertyId: propId },
            );
            const streams = streamsRes.dataStreams || [];
            const hosts = streams
              .map((s) => hostFromUrl(s.webStreamData?.defaultUri))
              .filter((h): h is string => !!h);
            for (const host of hosts) {
              const b = ensureBucket(buckets, host);
              if (!b.bindings.ga4PropertyId) b.bindings.ga4PropertyId = propId;
              b.sources.push({
                service: 'ga4',
                resourceType: 'ga4_property',
                resourceId: propId,
                resourceLabel: `${prop.displayName} (${propId})`,
              });
              maybeName(b, prop.displayName, 'ga4_property');
            }
          } catch {
            /* skip property */
          }
        }
      } catch {
        /* skip account */
      }
    }
  } catch (err) {
    errors.push({ source: 'ga4_list_accounts', message: err instanceof Error ? err.message : String(err) });
  }
  return errors;
}

interface GtmContainer {
  accountId: string;
  containerId: string;
  name: string;
  publicId: string;
  accountName: string;
}

/**
 * Phase 1 of GTM: collect raw containers across all accounts. We don't
 * attach to buckets yet because GTM's API doesn't report the install
 * domain — we have to infer from container/account labels which need the
 * full set of known domains to match against.
 */
async function fetchGtmContainers(): Promise<{ containers: GtmContainer[]; errors: SourceErrors }> {
  const containers: GtmContainer[] = [];
  const errors: SourceErrors = [];
  try {
    const gtmAccounts = await call<{ accounts: Array<{ accountId: string; name: string }> }>('gtm_list_accounts', {});
    for (const acc of gtmAccounts.accounts || []) {
      try {
        const containersRes = await call<{
          containers: Array<{ accountId: string; containerId: string; name: string; publicId: string; usageContext: string[] }>;
        }>('gtm_list_containers', { accountId: acc.accountId });
        for (const c of containersRes.containers || []) {
          containers.push({
            accountId: c.accountId,
            containerId: c.containerId,
            name: c.name,
            publicId: c.publicId,
            accountName: acc.name,
          });
        }
      } catch {
        /* skip account */
      }
    }
  } catch (err) {
    errors.push({ source: 'gtm_list_accounts', message: err instanceof Error ? err.message : String(err) });
  }
  return { containers, errors };
}

/**
 * Phase 2 of GTM: try to attach each container to a bucket.
 *   1. If the label has an explicit domain that matches a known bucket → attach.
 *   2. If the label has an explicit domain not yet bucketed → create a new bucket.
 *   3. Otherwise → push to orphan list.
 *
 * IMPORTANT: callers must invoke this AFTER the GSC/GA4 fetchers have
 * populated the buckets but BEFORE GBP runs. GBP-only domains intentionally
 * don't participate in GTM matching (matches the prior behavior).
 */
function attachGtmContainers(
  buckets: Map<string, BucketRow>,
  containers: GtmContainer[],
): { unmatchedGtm: Array<{ accountId: string; name: string }> } {
  const unmatchedGtm: Array<{ accountId: string; name: string }> = [];
  const knownDomains = Array.from(buckets.keys());
  for (const c of containers) {
    const labelForGuess = `${c.name} ${c.accountName}`;
    const guessed = bestGuessDomain(labelForGuess, knownDomains);

    if (guessed && buckets.has(guessed)) {
      const b = buckets.get(guessed)!;
      if (!b.bindings.gtmAccountId) b.bindings.gtmAccountId = c.accountId;
      if (!b.bindings.gtmContainerId) b.bindings.gtmContainerId = c.containerId;
      b.sources.push({
        service: 'gtm',
        resourceType: 'gtm_container',
        resourceId: c.containerId,
        resourceLabel: `${c.name} (${c.publicId})`,
      });
      maybeName(b, c.name, 'gtm_container');
    } else if (guessed) {
      // Container name carries an explicit domain not yet bucketed (e.g.
      // GTM-only setup with no GA4/GSC). Spawn a new bucket so the user
      // can still create the Site.
      const b = ensureBucket(buckets, guessed);
      if (!b.bindings.gtmAccountId) b.bindings.gtmAccountId = c.accountId;
      if (!b.bindings.gtmContainerId) b.bindings.gtmContainerId = c.containerId;
      b.sources.push({
        service: 'gtm',
        resourceType: 'gtm_container',
        resourceId: c.containerId,
        resourceLabel: `${c.name} (${c.publicId})`,
      });
      maybeName(b, c.name, 'gtm_container');
    } else {
      unmatchedGtm.push({ accountId: c.accountId, name: `${c.accountName} / ${c.name}` });
    }
  }
  return { unmatchedGtm };
}

/** Ads customers carry no domain — all are orphans by design. */
async function fetchAdsCustomers(): Promise<{
  unmatchedAds: Array<{ id: string; descriptiveName: string }>;
  errors: SourceErrors;
}> {
  const errors: SourceErrors = [];
  let unmatchedAds: Array<{ id: string; descriptiveName: string }> = [];
  try {
    const adsRes = await call<{ customers: Array<{ id: string; descriptiveName: string }> }>('ads_list_customers', {});
    unmatchedAds = (adsRes.customers || []).filter((c) => c.id);
  } catch (err) {
    errors.push({ source: 'ads_list_customers', message: err instanceof Error ? err.message : String(err) });
  }
  return { unmatchedAds, errors };
}

/** Walk GBP accounts → locations, bucketing each by `websiteUri` host. */
async function fetchGbpLocations(buckets: Map<string, BucketRow>): Promise<SourceErrors> {
  const errors: SourceErrors = [];
  try {
    const gbpAccounts = await call<{ accounts: Array<{ name: string; accountName: string }> }>('gbp_list_accounts', {});
    for (const acc of gbpAccounts.accounts || []) {
      const accountId = acc.name.replace('accounts/', '');
      try {
        const locsRes = await call<{ locations: Array<{ name: string; title: string; websiteUri?: string }> }>(
          'gbp_list_locations',
          { accountId },
        );
        for (const loc of locsRes.locations || []) {
          const host = hostFromUrl(loc.websiteUri);
          if (!host) continue;
          const b = ensureBucket(buckets, host);
          if (!b.bindings.gbpAccountId) b.bindings.gbpAccountId = accountId;
          if (!b.bindings.gbpLocationName) b.bindings.gbpLocationName = loc.name;
          b.sources.push({
            service: 'gbp',
            resourceType: 'gbp_location',
            resourceId: loc.name,
            resourceLabel: loc.title || loc.name,
          });
          maybeName(b, loc.title, 'gbp_location');
        }
      } catch {
        /* skip account */
      }
    }
  } catch (err) {
    errors.push({ source: 'gbp_list_accounts', message: err instanceof Error ? err.message : String(err) });
  }
  return errors;
}

// ────────────────────────────────────────────────────────────────────
// Coordinator
// ────────────────────────────────────────────────────────────────────

export async function discoverAllForActiveAccount(): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = { byDomain: [], unmatched: {}, errors: [] };
  const buckets = new Map<string, BucketRow>();

  // ─── Fetch sources (GSC, GA4, GTM phase 1) ──────────────────────────
  summary.errors.push(...(await fetchGscSites(buckets)));
  summary.errors.push(...(await fetchGa4Properties(buckets)));

  const gtm = await fetchGtmContainers();
  summary.errors.push(...gtm.errors);

  const ads = await fetchAdsCustomers();
  summary.errors.push(...ads.errors);
  if (ads.unmatchedAds.length > 0) summary.unmatched.adsCustomers = ads.unmatchedAds;

  // GTM phase 2: attach using GSC+GA4 domain set (NOT GBP — preserved
  // ordering keeps GTM matching scoped to the canonical web properties).
  const gtmAttach = attachGtmContainers(buckets, gtm.containers);
  if (gtmAttach.unmatchedGtm.length > 0) summary.unmatched.gtmAccounts = gtmAttach.unmatchedGtm;

  summary.errors.push(...(await fetchGbpLocations(buckets)));

  // ─── Convert buckets to ordered array ──────────────────────────────
  for (const [domain, b] of buckets) {
    summary.byDomain.push({
      domain,
      suggestedName: b.bestName || domain,
      primaryUrl: 'https://' + domain + '/',
      bindings: b.bindings,
      sources: b.sources,
    });
  }

  // ─── Dedup against existing Sites in the DB ────────────────────────
  try {
    const existingSites = await sitesStore.list();
    for (const dom of summary.byDomain) {
      const matched = findExistingMatch(dom, existingSites);
      if (matched) {
        dom.existingSiteId = matched.id;
        dom.existingSiteName = matched.name;
        const existingBindings = (matched.bindings || {}) as Record<string, string | undefined>;
        const hasNew = Object.entries(dom.bindings).some(
          ([k, v]) => v && !existingBindings[k],
        );
        dom.hasNewBindings = hasNew;
        // Flag domain mismatch when our bucket's host ≠ existing Site's
        // canonical primaryUrl host. The bucket was matched by binding
        // overlap (a GA4/GSC binding pointed back to the existing Site),
        // so the divergent hostname is almost certainly a typo upstream.
        const canonicalHost = hostFromUrl(matched.primaryUrl);
        if (canonicalHost && canonicalHost !== dom.domain) {
          dom.domainMismatch = {
            canonical: canonicalHost,
            reason: looksLikeTypo(dom.domain, canonicalHost)
              ? 'Posible typo de ' + canonicalHost
              : 'Distinto de ' + canonicalHost,
          };
        }
      }
    }
    // Merge buckets that resolve to the same existing Site (typo + canonical
    // both pointing back at one DB row). Drops the typo as a standalone bucket.
    summary.byDomain = mergeBucketsByExistingSite(summary.byDomain);
  } catch (err) {
    log.warn('Dedup pass against existing sites failed', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  // ─── Detect typos between buckets ─────────────────────────────────
  // Catches both: (a) two NEW buckets where one is a typo, and (b) two
  // EXISTING Sites already in the DB that look like typos of each other
  // (often happens when the same property got imported twice).
  for (const a of summary.byDomain) {
    for (const b of summary.byDomain) {
      if (a === b) continue;
      if (a.suspiciousSimilarTo) continue;
      if (looksLikeTypo(a.domain, b.domain)) {
        // The "more authoritative" partner has more sources, or — if equal
        // — is the longer string (typos are usually missing a character).
        const bIsAuthoritative =
          b.sources.length > a.sources.length ||
          (b.sources.length === a.sources.length && b.domain.length > a.domain.length);
        if (bIsAuthoritative) {
          a.suspiciousSimilarTo = b.domain;
        }
      }
    }
  }

  summary.byDomain.sort((a, b) => {
    // New (no existing match) first; among new, more sources first
    if (!!a.existingSiteId !== !!b.existingSiteId) return a.existingSiteId ? 1 : -1;
    return b.sources.length - a.sources.length || a.domain.localeCompare(b.domain);
  });

  log.info('Discovery complete', {
    domains: summary.byDomain.length,
    unmatchedAds: summary.unmatched.adsCustomers?.length ?? 0,
    unmatchedGtm: summary.unmatched.gtmAccounts?.length ?? 0,
    errors: summary.errors.length,
  });
  return summary;
}
