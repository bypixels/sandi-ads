/**
 * License manager for Sandi Ads
 *
 * Validates license keys and determines feature tier.
 * Key format: SMCP-XXXX-XXXX-XXXX-XXXX (alphanumeric segments with checksum)
 */

import { createServiceLogger } from '../utils/logger.js';

const log = createServiceLogger('licensing');

export type LicenseTier = 'free' | 'pro';

interface LicenseInfo {
  tier: LicenseTier;
  key: string | null;
  valid: boolean;
}

const KEY_PATTERN = /^SMCP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

let cachedLicense: LicenseInfo | null = null;

/**
 * Simple checksum validation for license key segments.
 * Sums char codes of the 4 data segments; last segment's first char must match sum mod 36.
 */
function validateChecksum(key: string): boolean {
  const segments = key.split('-').slice(1); // remove SMCP prefix
  if (segments.length !== 4) return false;

  const dataChars = segments.slice(0, 3).join('');
  let sum = 0;
  for (const ch of dataChars) {
    sum += ch.charCodeAt(0);
  }

  const expectedChar = (sum % 36).toString(36).toUpperCase();
  return segments[3][0] === expectedChar;
}

/**
 * Validate a license key format and checksum
 */
export function validateKey(key: string): boolean {
  if (!KEY_PATTERN.test(key)) return false;
  return validateChecksum(key);
}

/**
 * Get the current license info (reads from env, caches result)
 */
export function getLicenseInfo(): LicenseInfo {
  if (cachedLicense) return cachedLicense;

  const key = process.env.SANDI_ADS_KEY?.trim() || process.env.SEO_MCP_PRO_KEY?.trim() || null;

  if (!key) {
    cachedLicense = { tier: 'free', key: null, valid: false };
  } else if (validateKey(key)) {
    cachedLicense = { tier: 'pro', key, valid: true };
  } else {
    log.warn('Invalid license key format (SANDI_ADS_KEY) — running in free tier');
    cachedLicense = { tier: 'free', key, valid: false };
  }

  return cachedLicense;
}

/**
 * Check if the current license is Pro tier
 */
export function isPro(): boolean {
  return getLicenseInfo().tier === 'pro';
}

/**
 * Get the current license tier
 */
export function getLicenseTier(): LicenseTier {
  return getLicenseInfo().tier;
}

/**
 * Reset cached license (useful when env changes at runtime)
 */
export function resetLicenseCache(): void {
  cachedLicense = null;
}
