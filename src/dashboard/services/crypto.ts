/**
 * App-layer crypto — AES-256-GCM with scrypt-derived key.
 *
 * Owns: cipher choice, envelope shape ({ iv, tag, data } hex), passphrase
 * resolution. Stores consume `encryptString` / `decryptString` without
 * knowing the envelope.
 *
 * Why this module exists:
 *   - credential-store originally owned the cipher AND was a store. Other
 *     stores (google-accounts) imported the encrypt helpers and rebuilt the
 *     envelope at their call sites — leaky seam, two stores coupled to one
 *     store's internals.
 *   - Now: any store needing at-rest encryption imports from here. An audit
 *     of "how do we encrypt data at rest?" reads one file.
 *
 * Passphrase resolution order:
 *   1. CREDENTIAL_ENCRYPTION_KEY env var (explicit; recommended for prod)
 *   2. Independent persistent random key (owner-only permissions).
 * Legacy envelopes retain their original key for authenticated recovery.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { encryptionPassphrase, legacyPassphrases } from './security-config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
// KDF constant, not branding: changing it makes every stored ciphertext undecryptable. Never change.
const SALT = 'website-ops-mcp-credential-store';

/**
 * The wire format used everywhere encryption results are persisted.
 * All three fields are hex-encoded so the envelope can sit cleanly inside
 * JSON columns / files without escaping headaches.
 */
export interface CryptoEnvelope {
  iv: string;
  tag: string;
  data: string;
  version?: 2;
}

function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, SALT, KEY_LENGTH);
}

/**
 * Encrypt a UTF-8 string. The returned envelope is the only shape callers
 * should persist — the algorithm, salt, and IV length are private to this
 * module.
 */
export function encryptString(plaintext: string): CryptoEnvelope {
  const key = deriveKey(encryptionPassphrase());
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return {
    version: 2,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted,
  };
}

/**
 * Decrypt an envelope produced by `encryptString`. Throws on tag mismatch
 * (tampered ciphertext) or incorrect passphrase.
 */
export function decryptString(envelope: CryptoEnvelope): string {
  const primary = encryptionPassphrase();
  const candidates = envelope.version === 2 ? [primary] : [primary, ...legacyPassphrases()];
  for (const passphrase of new Set(candidates)) {
    try {
      const decipher = createDecipheriv(ALGORITHM, deriveKey(passphrase), Buffer.from(envelope.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      return decipher.update(envelope.data, 'hex', 'utf8') + decipher.final('utf8');
    } catch { /* authenticated decryption must succeed before returning any plaintext */ }
  }
  throw new Error('No se pudieron descifrar las credenciales. No se modificaron los datos; verificá la llave de cifrado.');
}
