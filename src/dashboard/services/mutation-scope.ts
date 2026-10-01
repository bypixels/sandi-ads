/**
 * Write scope pinned by server configuration, never by tool input or headers.
 * One process owns one Site; Sites/bindings remain the operator's trusted
 * configuration. This is a write fence, not a multi-user/RBAC implementation.
 */
import { MCPError, ErrorCode } from '../../types/errors.js';
import { sitesStore, type Site } from './sites-store.js';

function deny(message = 'El recurso no pertenece al cliente autorizado para este proceso.'): never {
  throw new MCPError({ code: ErrorCode.RESOURCE_ACCESS_DENIED, message, retryable: false });
}
function equal(actual: unknown, expected: string | undefined): void {
  if (!expected || typeof actual !== 'string' || actual !== expected) deny();
}
function numericId(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) deny();
  return value;
}
function adsId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(value)) deny();
  return value.replace(/-/g, '');
}
function ownUrl(value: unknown, site: Site): void {
  if (typeof value !== 'string') deny();
  try {
    const url = new URL(value);
    const base = new URL(site.primaryUrl);
    const prefix = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.origin !== base.origin || (url.pathname !== base.pathname && !url.pathname.startsWith(prefix))) deny();
    // Reject encoded separators/dot segments rather than interpreting them
    // differently from Google or a downstream server.
    if (/%(?:2e|2f|5c)/i.test(url.pathname)) deny();
  } catch { deny(); }
}
function location(value: unknown): { account?: string; id: string } {
  if (typeof value !== 'string') deny();
  const match = value.match(/^(?:accounts\/(\d+)\/)?locations\/(\d+)$/);
  if (!match) deny();
  return { account: match[1], id: match[2] };
}
function ownLocation(value: unknown, site: Site, review = false): void {
  const bound = location(site.bindings.gbpLocationName);
  let target = value;
  if (review) {
    if (typeof value !== 'string') deny();
    const match = value.match(/^(accounts\/\d+\/locations\/\d+)\/reviews\/[A-Za-z0-9_-]+$/);
    if (!match) deny();
    target = match[1];
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    target = 'locations/' + value;
  }
  const requested = location(target);
  if (requested.id !== bound.id) deny();
  if (requested.account) {
    const account = site.bindings.gbpAccountId?.replace(/^accounts\//, '') ?? bound.account;
    equal(requested.account, account);
  }
}

export async function assertMutationScope(
  toolName: string,
  input: unknown,
  configuredSiteId: string | undefined,
  requestedSiteId?: string,
): Promise<string> {
  if (!configuredSiteId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(configuredSiteId)) {
    deny('Las escrituras requieren SANDI_ADS_SITE_ID con el UUID del cliente autorizado.');
  }
  if (requestedSiteId !== undefined && requestedSiteId !== configuredSiteId) deny();
  let site: Site | undefined;
  try { site = await sitesStore.get(configuredSiteId); }
  catch { deny('No se pudo verificar el cliente autorizado. No se ejecutó la escritura.'); }
  if (!site || site.id !== configuredSiteId) deny('El cliente autorizado no existe.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) deny();
  const data = input as Record<string, unknown>;
  const b = site.bindings;

  if (toolName.startsWith('ads_')) {
    equal(adsId(data.customerId), adsId(b.adsCustomerId));
    if (data.campaignId !== undefined) numericId(data.campaignId);
    if (data.adGroupId !== undefined) numericId(data.adGroupId);
  } else if (toolName.startsWith('gtm_')) {
    equal(numericId(data.accountId), b.gtmAccountId);
    equal(numericId(data.containerId), b.gtmContainerId);
    for (const key of ['workspaceId', 'tagId', 'triggerId', 'variableId', 'containerVersionId']) {
      if (data[key] !== undefined) numericId(data[key]);
    }
  } else if (toolName.startsWith('gsc_') || toolName === 'fix_resubmit_sitemap') {
    equal(data.siteUrl, b.gscSiteUrl);
  } else if (toolName.startsWith('cf_')) {
    if (typeof data.zoneId !== 'string' || !/^[0-9a-f]{32}$/i.test(data.zoneId)) deny();
    equal(data.zoneId, b.cloudflareZoneId);
  } else if (toolName.startsWith('gbp_')) {
    ownLocation(data.name ?? data.parent, site, toolName === 'gbp_reply_review' || toolName === 'gbp_delete_review_reply');
  } else if (toolName === 'indexing_publish') {
    ownUrl(data.url, site);
  } else if (toolName === 'indexing_batch_publish') {
    if (!Array.isArray(data.notifications) || data.notifications.length === 0) deny();
    for (const notification of data.notifications) {
      if (!notification || typeof notification !== 'object') deny();
      ownUrl((notification as Record<string, unknown>).url, site);
    }
  } else if (toolName === 'fix_submit_pages_to_index') {
    equal(data.siteUrl, b.gscSiteUrl);
    // Discovery occurs inside the handler, after approval. Until discovered
    // URLs can be verified there, protected writes require explicit URLs.
    if (!Array.isArray(data.urls) || data.urls.length === 0) {
      deny('Esta escritura requiere URLs explícitas del cliente; la autodetección no está habilitada.');
    }
    for (const url of data.urls) ownUrl(url, site);
  } else {
    deny('La herramienta no tiene una política de alcance de escritura.');
  }
  return site.id;
}
