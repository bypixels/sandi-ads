/**
 * Google Indexing API — shared API client construction.
 *
 * Centralizes auth wiring so tool files just import the constructed client.
 * Mirrors the pattern in `business-profile/clients.ts`.
 */

import { google } from 'googleapis';
import { getGoogleAuth } from '../api-wrapper.js';

const SERVICE = 'indexing' as const;

export function getIndexingClient() {
  const auth = getGoogleAuth(SERVICE);
  return google.indexing({ version: 'v3', auth });
}
