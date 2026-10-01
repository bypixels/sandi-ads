import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, linkSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('security-config');

/** New persisted file name -> name used before the sandi-ads rename. */
const LEGACY_FILE_NAMES: Record<string, string> = {
  '.sandi-ads-encryption.key': '.website-ops-encryption.key',
  '.sandi-ads-legacy-encryption.key': '.website-ops-legacy-encryption.key',
  '.sandi-ads-dashboard.key': '.website-ops-dashboard.key',
};

/**
 * Publish a pre-rebrand file under its new name as a HARD LINK (same inode).
 * Not a rename: processes built from older code may still be running and
 * re-read the old name on every use; if it vanished they would mint a new
 * random key and orphan data. The old name is kept on purpose. linkSync is the
 * atomic existence test: EEXIST (new already there) or ENOENT (no old file)
 * means nothing to do, so it never overwrites and concurrent callers are safe.
 */
export function migrateLegacyFile(dir: string, newName: string, oldName: string): void {
  try {
    linkSync(join(dir, oldName), join(dir, newName));
    log.info('Linked legacy file under new name', { from: oldName, to: newName });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
  }
}

export function securityFile(name: string): string {
  return join(process.env.CREDENTIAL_STORE_PATH || process.cwd(), name);
}

/** Atomic first-writer-wins secrets: concurrent MCP/HTTP processes share keys. */
export function persistentSecret(name: string, initial?: string): string {
  const legacyName = LEGACY_FILE_NAMES[name];
  if (legacyName) migrateLegacyFile(process.env.CREDENTIAL_STORE_PATH || process.cwd(), name, legacyName);
  const path = securityFile(name);
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (!value) throw new Error('El archivo de llave está vacío; no se reemplazó.');
    chmodSync(path, 0o600);
    return value;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  mkdirSync(process.env.CREDENTIAL_STORE_PATH || process.cwd(), { recursive: true });
  const temp = path + '.' + randomBytes(12).toString('hex');
  writeFileSync(temp, initial || randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  try { linkSync(temp, path); }
  catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error; }
  finally { unlinkSync(temp); }
  return readFileSync(path, 'utf8').trim();
}

export function encryptionPassphrase(): string {
  if (process.env.CREDENTIAL_ENCRYPTION_KEY) return process.env.CREDENTIAL_ENCRYPTION_KEY;
  // Preserve the old effective key before bootstrap creates the new API key.
  // The `website-ops-` seed is a KDF/legacy-key constant, not branding: it reproduces
  // the pre-rename key and must never change.
  persistentSecret('.sandi-ads-legacy-encryption.key',
    process.env.DASHBOARD_API_KEY || `website-ops-${process.env.USER || 'default'}-${hostname()}`);
  return persistentSecret('.sandi-ads-encryption.key');
}

export function legacyPassphrases(): string[] {
  const candidates = [process.env.CREDENTIAL_LEGACY_ENCRYPTION_KEY];
  migrateLegacyFile(process.env.CREDENTIAL_STORE_PATH || process.cwd(),
    '.sandi-ads-legacy-encryption.key', '.website-ops-legacy-encryption.key');
  try { candidates.push(readFileSync(securityFile('.sandi-ads-legacy-encryption.key'), 'utf8').trim()); }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  return candidates.filter((value): value is string => !!value);
}

export function initializeSecurity(): void {
  encryptionPassphrase();
  if (!process.env.DASHBOARD_API_KEY) {
    process.env.DASHBOARD_API_KEY = persistentSecret('.sandi-ads-dashboard.key');
  }
}
