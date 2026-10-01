/**
 * Site auto-discovery
 *
 * Given a primary URL, attempts to find the matching resource in each
 * external service the user has access to. Returns suggestions only —
 * the caller decides which to persist.
 */

import { executeToolByName } from './dashboard-data.js';
import { createServiceLogger } from '../../utils/logger.js';
import type { SiteBindings } from './sites-store.js';

const log = createServiceLogger('sites-discover');

export interface DiscoveryMatch<T = unknown> {
  status: 'matched' | 'none' | 'error' | 'unauthorized';
  message?: string;
  binding?: string;            // suggested value for SiteBindings.<field>
  candidates?: T[];            // additional options if multiple plausible matches
}

export interface DiscoveryResult {
  primaryUrl: string;
  hostname: string;
  ga4: DiscoveryMatch;
  gsc: DiscoveryMatch;
  gtm: DiscoveryMatch;
  ads: DiscoveryMatch;
  gbp: DiscoveryMatch;
  cloudflare: DiscoveryMatch;
  suggestedBindings: SiteBindings;
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

function asMatched<T>(binding: string, message?: string, candidates?: T[]): DiscoveryMatch<T> {
  return { status: 'matched', binding, message, candidates };
}

function asNone<T = unknown>(message = 'No se encontró coincidencia'): DiscoveryMatch<T> {
  return { status: 'none', message };
}

function asError<T = unknown>(err: unknown): DiscoveryMatch<T> {
  const m = String(err instanceof Error ? err.message : err);
  if (/AUTH|credentials|not configured|not authenticated|invalid_grant|developer token/i.test(m)) {
    return { status: 'unauthorized', message: m };
  }
  return { status: 'error', message: m };
}

// Tool calls go through the dashboard's single seam (executeToolByName) so
// validation, error-mapping, and future telemetry concerns apply uniformly.
const callTool = executeToolByName;

interface GSCSite { siteUrl: string; permissionLevel: string }
interface GA4Property { name: string; displayName: string }
interface GA4DataStream {
  name: string;
  type?: string;
  webStreamData?: { defaultUri?: string };
}
interface AdsCustomer { id: string; descriptiveName: string }
interface CFZone { id: string; name: string }
interface GBPLocation { name: string; title: string; websiteUri?: string }
interface GBPAccount { name: string }

/**
 * Match a GSC site URL against a hostname. Both prefixed (https://example.com/)
 * and domain (sc-domain:example.com) properties match.
 */
function gscMatches(siteUrl: string, hostname: string): boolean {
  const s = siteUrl.toLowerCase();
  const h = hostname.toLowerCase();
  if (s.startsWith('sc-domain:')) return s.slice('sc-domain:'.length) === h;
  try {
    return new URL(siteUrl).hostname.replace(/^www\./, '') === h;
  } catch {
    return false;
  }
}

async function discoverGSC(hostname: string): Promise<DiscoveryMatch<GSCSite>> {
  try {
    const data = await callTool<{ sites: GSCSite[] }>('gsc_list_sites', {});
    const sites = data.sites || [];
    const matches = sites.filter((s) => gscMatches(s.siteUrl, hostname));
    if (matches.length === 0) return asNone();
    // Prefer domain-level property if available, else the first prefix match
    const domain = matches.find((s) => s.siteUrl.startsWith('sc-domain:'));
    const chosen = domain || matches[0];
    return asMatched(chosen.siteUrl, `${matches.length} coincidencia(s)`, matches);
  } catch (err) {
    return asError(err);
  }
}

async function discoverGA4(hostname: string): Promise<DiscoveryMatch<GA4Property>> {
  try {
    // GA4 Admin API requires a parent filter — list accounts then iterate
    const accounts = await callTool<{ accounts: { name: string }[] }>('ga4_list_accounts', {});
    const properties: GA4Property[] = [];
    for (const acc of accounts.accounts || []) {
      const accountId = acc.name.replace('accounts/', '');
      try {
        const data = await callTool<{ properties: GA4Property[] }>('ga4_list_properties', { accountId });
        properties.push(...(data.properties || []));
      } catch {
        // skip account if not authorized
      }
    }

    const matches: GA4Property[] = [];
    for (const prop of properties) {
      const propId = prop.name.replace('properties/', '');
      try {
        const streamsData = await callTool<{ dataStreams?: GA4DataStream[]; streams?: GA4DataStream[] }>(
          'ga4_list_data_streams',
          { propertyId: propId },
        );
        const streams = streamsData.dataStreams || streamsData.streams || [];
        const hit = streams.some((s) => {
          const uri = s.webStreamData?.defaultUri;
          if (!uri) return false;
          try {
            return new URL(uri).hostname.replace(/^www\./, '') === hostname;
          } catch {
            return false;
          }
        });
        if (hit) matches.push(prop);
      } catch {
        // skip property on stream error
      }
    }
    if (matches.length === 0) return asNone();
    return asMatched(
      matches[0].name.replace('properties/', ''),
      `${matches.length} property(ies) con stream para ${hostname}`,
      matches,
    );
  } catch (err) {
    return asError(err);
  }
}

async function discoverCloudflare(hostname: string): Promise<DiscoveryMatch<CFZone>> {
  try {
    const data = await callTool<{ zones: CFZone[] }>('cf_get_zones', { name: hostname });
    const zones = data.zones || [];
    if (zones.length === 0) {
      // Try without filter, fallback search
      const all = await callTool<{ zones: CFZone[] }>('cf_get_zones', { perPage: 50 });
      const matches = (all.zones || []).filter((z) => z.name === hostname);
      if (matches.length === 0) return asNone();
      return asMatched(matches[0].id, `Zona: ${matches[0].name}`);
    }
    return asMatched(zones[0].id, `Zona: ${zones[0].name}`);
  } catch (err) {
    return asError(err);
  }
}

async function discoverGBP(hostname: string): Promise<DiscoveryMatch<GBPLocation>> {
  try {
    const accounts = await callTool<{ accounts: GBPAccount[] }>('gbp_list_accounts', {});
    const list = accounts.accounts || [];
    for (const acc of list) {
      const accountId = acc.name.replace('accounts/', '');
      try {
        const locs = await callTool<{ locations: GBPLocation[] }>('gbp_list_locations', { accountId });
        const matches = (locs.locations || []).filter((l) => {
          if (!l.websiteUri) return false;
          try {
            return new URL(l.websiteUri).hostname.replace(/^www\./, '') === hostname;
          } catch {
            return false;
          }
        });
        if (matches.length > 0) {
          return asMatched(matches[0].name, `Cuenta: ${acc.name}`, matches);
        }
      } catch {
        // skip
      }
    }
    return asNone();
  } catch (err) {
    return asError(err);
  }
}

async function discoverAds(): Promise<DiscoveryMatch<AdsCustomer>> {
  // Ads has no URL → customer mapping in metadata. Just return list of accessible
  // customers as candidates so the user picks one.
  try {
    const data = await callTool<{ customers: AdsCustomer[] }>('ads_list_customers', {});
    const customers = (data.customers || []).filter((c) => c.id);
    if (customers.length === 0) return asNone('Sin cuentas accesibles');
    if (customers.length === 1) {
      return asMatched(customers[0].id, `Única cuenta: ${customers[0].descriptiveName || customers[0].id}`);
    }
    return { status: 'none', message: `${customers.length} cuentas — elegí manualmente`, candidates: customers };
  } catch (err) {
    return asError(err);
  }
}

async function discoverGTM(): Promise<DiscoveryMatch> {
  // GTM containers don't expose the served URL via API. Just check that GTM
  // is reachable so the user knows whether to fill these manually.
  try {
    await callTool<unknown>('gtm_list_accounts', {});
    return { status: 'none', message: 'GTM accesible — elegí container manualmente' };
  } catch (err) {
    return asError(err);
  }
}

export async function discoverSiteBindings(primaryUrl: string): Promise<DiscoveryResult> {
  const hostname = extractHostname(primaryUrl);
  log.info('Discovering bindings', { primaryUrl, hostname });

  const [gsc, ga4, cf, gbp, ads, gtm] = await Promise.all([
    discoverGSC(hostname),
    discoverGA4(hostname),
    discoverCloudflare(hostname),
    discoverGBP(hostname),
    discoverAds(),
    discoverGTM(),
  ]);

  const suggested: SiteBindings = {};
  if (gsc.binding) suggested.gscSiteUrl = gsc.binding;
  if (ga4.binding) suggested.ga4PropertyId = ga4.binding;
  if (cf.binding) suggested.cloudflareZoneId = cf.binding;
  if (gbp.binding) {
    suggested.gbpLocationName = gbp.binding;
    const acc = gbp.binding.match(/^accounts\/([^/]+)/);
    if (acc) suggested.gbpAccountId = acc[1];
  }
  if (ads.binding) suggested.adsCustomerId = ads.binding;

  return {
    primaryUrl,
    hostname,
    ga4,
    gsc,
    gtm,
    ads,
    gbp,
    cloudflare: cf,
    suggestedBindings: suggested,
  };
}
