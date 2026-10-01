#!/usr/bin/env node

/**
 * Sandi Ads — License Key Generator
 *
 * Usage:
 *   node scripts/generate-keys.js          # Generate 1 key
 *   node scripts/generate-keys.js 10       # Generate 10 keys
 *   node scripts/generate-keys.js 50 --csv # Generate 50 keys in CSV format
 *
 * Key format: SMCP-XXXX-XXXX-XXXX-XXXX
 * Checksum: first char of segment 4 = (sum of char codes of segments 1-3) mod 36
 */

import { randomBytes } from 'node:crypto';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomSegment(length) {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARSET[bytes[i] % CHARSET.length];
  }
  return result;
}

function generateKey() {
  const seg1 = randomSegment(4);
  const seg2 = randomSegment(4);
  const seg3 = randomSegment(4);

  // Checksum: sum char codes of first 3 segments, mod 36
  const dataChars = seg1 + seg2 + seg3;
  let sum = 0;
  for (const ch of dataChars) {
    sum += ch.charCodeAt(0);
  }
  const checksumChar = (sum % 36).toString(36).toUpperCase();
  const seg4 = checksumChar + randomSegment(3);

  return `SMCP-${seg1}-${seg2}-${seg3}-${seg4}`;
}

// --- CLI ---
const args = process.argv.slice(2);
const count = Math.max(1, parseInt(args.find((a) => !a.startsWith('--')) || '1', 10));
const csv = args.includes('--csv');

if (csv) {
  console.log('key,created_at');
  const now = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    console.log(`${generateKey()},${now}`);
  }
} else {
  for (let i = 0; i < count; i++) {
    console.log(generateKey());
  }
}
