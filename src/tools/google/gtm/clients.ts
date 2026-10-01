/**
 * GTM — shared API client construction.
 *
 * Centralizes auth wiring so tool files just import the constructed client.
 * Mirrors the pattern in `business-profile/clients.ts`.
 */

import { google } from 'googleapis';
import { getGoogleAuth } from '../api-wrapper.js';

const SERVICE = 'gtm' as const;

export function getGTMClient() {
  const auth = getGoogleAuth(SERVICE);
  return google.tagmanager({ version: 'v2', auth });
}
