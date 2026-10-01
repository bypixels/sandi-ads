/**
 * Google Business Profile — shared client construction.
 *
 * Centralizes:
 *   - Account Management API client (for `accounts.list`)
 *   - Business Information API client (for `accounts.locations.list`)
 *   - The top-level `locations` resource (for `get` and `patch`) — the
 *     googleapis types don't expose this, so the unsafe cast lives here
 *     in a single reviewed place instead of duplicated at every call site.
 *   - `normalizeLocationName` — list responses give `accounts/X/locations/Y`,
 *     but get/patch want bare `locations/Y`.
 *   - `assertBusinessProfileAuth` — explicit guard for stub handlers that
 *     don't actually call Google but need to surface AUTH_NOT_CONFIGURED
 *     consistently.
 */

import { google } from 'googleapis';
import { getGoogleAuth } from '../api-wrapper.js';

const SERVICE = 'businessProfile' as const;

export function getAccountManagementClient() {
  const auth = getGoogleAuth(SERVICE);
  return google.mybusinessaccountmanagement({ version: 'v1', auth });
}

export function getBusinessInformationClient() {
  const auth = getGoogleAuth(SERVICE);
  return google.mybusinessbusinessinformation({ version: 'v1', auth });
}

/**
 * Surface of the top-level `locations` resource we actually use. Add
 * methods here when a call site needs them — keep YAGNI, don't pre-declare
 * `delete` etc. just because they exist.
 */
export interface LocationsClient {
  get(params: { name: string; readMask: string }): Promise<{ data: Record<string, unknown> }>;
  patch(params: { name: string; updateMask: string; requestBody: unknown }): Promise<{ data: Record<string, unknown> }>;
}

/**
 * Get the top-level `locations` resource. The googleapis types only expose
 * `accounts.locations` (list/create) but get/patch actually live on the
 * bare `locations` resource. The unsafe cast is encapsulated here.
 */
export function getLocationsClient(): LocationsClient {
  const client = getBusinessInformationClient();
  return (client as unknown as { locations: LocationsClient }).locations;
}

/**
 * Normalize a location resource name to `locations/{id}` (the form expected
 * by `locations.{get,patch}`). Lists return the legacy form
 * `accounts/{accountId}/locations/{id}`; bare ids are also accepted.
 */
export function normalizeLocationName(name: string): string {
  if (name.startsWith('locations/')) return name;
  const idx = name.indexOf('/locations/');
  if (idx >= 0) return 'locations/' + name.slice(idx + '/locations/'.length);
  return 'locations/' + name;
}

/**
 * Throw AUTH_NOT_CONFIGURED if Business Profile auth isn't wired up.
 * Used by handlers that return stub data (Posts, Media, Insights — APIs
 * that require special GBP access) so they fail with the same auth error
 * shape as handlers that actually call Google.
 */
export function assertBusinessProfileAuth(): void {
  getGoogleAuth(SERVICE);
}
