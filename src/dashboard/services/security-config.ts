import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, linkSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

export function securityFile(name: string): string {
  return join(process.env.CREDENTIAL_STORE_PATH || process.cwd(), name);
}

/** Atomic first-writer-wins secrets: concurrent MCP/HTTP processes share keys. */
export function persistentSecret(name: string, initial?: string): string {
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
  persistentSecret('.website-ops-legacy-encryption.key',
    process.env.DASHBOARD_API_KEY || `website-ops-${process.env.USER || 'default'}-${hostname()}`);
  return persistentSecret('.website-ops-encryption.key');
}

export function legacyPassphrases(): string[] {
  const candidates = [process.env.CREDENTIAL_LEGACY_ENCRYPTION_KEY];
  try { candidates.push(readFileSync(securityFile('.website-ops-legacy-encryption.key'), 'utf8').trim()); }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  return candidates.filter((value): value is string => !!value);
}

export function initializeSecurity(): void {
  encryptionPassphrase();
  if (!process.env.DASHBOARD_API_KEY) {
    process.env.DASHBOARD_API_KEY = persistentSecret('.website-ops-dashboard.key');
  }
}
