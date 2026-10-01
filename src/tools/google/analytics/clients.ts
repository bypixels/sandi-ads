/**
 * Google Analytics — shared API client construction.
 *
 * Three flavors used across the module:
 *   - Admin (v1beta) — accounts, properties, data streams, custom dims/metrics
 *   - Admin (v1alpha) — audiences (still alpha as of 2026)
 *   - Data (v1beta) — runReport, runRealtimeReport, runFunnelReport, getMetadata
 *
 * Mirrors the pattern in `business-profile/clients.ts`.
 */

import { google } from 'googleapis';
import { getGoogleAuth } from '../api-wrapper.js';

const SERVICE = 'analytics' as const;

export function getAnalyticsAdminClient() {
  const auth = getGoogleAuth(SERVICE);
  return google.analyticsadmin({ version: 'v1beta', auth });
}

export function getAnalyticsAdminAlphaClient() {
  const auth = getGoogleAuth(SERVICE);
  return google.analyticsadmin({ version: 'v1alpha', auth });
}

export function getAnalyticsDataClient() {
  const auth = getGoogleAuth(SERVICE);
  return google.analyticsdata({ version: 'v1beta', auth });
}
