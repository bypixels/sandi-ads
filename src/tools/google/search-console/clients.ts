/**
 * Google Search Console — shared API client construction.
 *
 * Centralizes auth wiring so tool files just import the constructed client.
 * Mirrors the pattern in `business-profile/clients.ts`.
 */

import { google } from 'googleapis';
import { getGoogleAuth } from '../api-wrapper.js';

const SERVICE = 'searchConsole' as const;

export function getSearchConsoleClient() {
  const auth = getGoogleAuth(SERVICE);
  return google.searchconsole({ version: 'v1', auth });
}
