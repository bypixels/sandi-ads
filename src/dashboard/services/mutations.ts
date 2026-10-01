/**
 * Mutations gate
 *
 * Write/destructive tools are blocked by the shared execution layer for
 * every transport unless mutations are explicitly enabled via env vars.
 */

/** Tools that mutate external state */
export const MUTATING_TOOLS = new Set<string>([
  // GTM
  'gtm_create_tag', 'gtm_create_trigger', 'gtm_create_variable', 'gtm_create_version',
  'gtm_update_tag', 'gtm_update_trigger', 'gtm_update_variable',
  'gtm_delete_tag', 'gtm_delete_trigger', 'gtm_delete_variable',
  'gtm_publish_version',
  // GBP
  'gbp_create_post', 'gbp_update_location', 'gbp_upload_media',
  'gbp_reply_review', 'gbp_delete_review_reply',
  // Cloudflare
  'cf_create_dns_record', 'cf_purge_cache',
  // Ads
  'ads_create_campaign', 'ads_update_campaign', 'ads_create_budget', 'ads_add_keywords',
  // Search Console
  'gsc_submit_sitemap', 'gsc_delete_sitemap',
  // Indexing API
  'indexing_publish', 'indexing_batch_publish',
  // Remediation aliases perform real external writes too.
  'fix_resubmit_sitemap', 'fix_submit_pages_to_index',
]);

/** Service category for a mutating tool name (used for granular env overrides) */
function categoryFor(toolName: string): string {
  if (toolName.startsWith('gtm_')) return 'gtm';
  if (toolName.startsWith('gbp_')) return 'gbp';
  if (toolName.startsWith('cf_')) return 'cloudflare';
  if (toolName.startsWith('ads_')) return 'ads';
  if (toolName === 'fix_resubmit_sitemap' || toolName.startsWith('gsc_')) return 'gsc';
  if (toolName === 'fix_submit_pages_to_index' || toolName.startsWith('indexing_')) return 'indexing';
  return 'other';
}

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/**
 * Returns true if the tool is allowed to mutate.
 *
 * Resolution order:
 * 1. Per-service flag MUTATIONS_<CATEGORY>=true|false (overrides global)
 * 2. Global flag MUTATIONS_ENABLED=true|false (default false)
 */
export function isMutationAllowed(toolName: string): boolean {
  if (!isMutatingTool(toolName)) return true; // read-only tools are always allowed
  const category = categoryFor(toolName).toUpperCase();
  const perService = process.env[`MUTATIONS_${category}`];
  if (perService === 'true') return true;
  if (perService === 'false') return false;
  return process.env.MUTATIONS_ENABLED === 'true';
}

/** Status snapshot for the UI banner */
export function getMutationsStatus(): {
  globalEnabled: boolean;
  perService: Record<string, boolean | null>;
  autoApprove: string[];
} {
  const globalEnabled = process.env.MUTATIONS_ENABLED === 'true';
  const services = ['gtm', 'gbp', 'cloudflare', 'ads', 'gsc', 'indexing'];
  const perService: Record<string, boolean | null> = {};
  for (const s of services) {
    const v = process.env[`MUTATIONS_${s.toUpperCase()}`];
    perService[s] = v === 'true' ? true : v === 'false' ? false : null;
  }
  return { globalEnabled, perService, autoApprove: getAutoApproveList() };
}

/**
 * Explicit exceptions that can mutate WITHOUT approval on any transport.
 * Configured via MUTATIONS_AUTOAPPLY env var (comma-separated tool names).
 * Default: empty — every mutation requires per-action approval from the human.
 * Campaign activation/budget changes and live GTM publication are never exempt.
 */
export function getAutoApproveList(): string[] {
  const raw = process.env.MUTATIONS_AUTOAPPLY || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && MUTATING_TOOLS.has(s)
      && s !== 'ads_update_campaign' && s !== 'gtm_publish_version');
}

/** Returns true if the tool can be auto-applied without per-action approval */
export function isAutoApproved(toolName: string): boolean {
  if (!isMutationAllowed(toolName)) return false;
  return getAutoApproveList().includes(toolName);
}
