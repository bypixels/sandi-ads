/**
 * Feature tier definitions for Sandi Ads
 *
 * Defines which tools and features are gated behind the Pro license.
 * All tools not listed here are available in the free tier.
 */

/** Tools that require a Pro license */
export const PRO_TOOLS: string[] = [
  'report_site_health',
  'report_seo_audit',
  'report_executive_summary',
];

/** Features that require a Pro license */
export const PRO_FEATURES: string[] = [
  'dashboard',
  'credential_store',
  'sse_monitoring',
];

/** Check if a tool name requires Pro */
export function isProTool(name: string): boolean {
  return PRO_TOOLS.includes(name);
}
