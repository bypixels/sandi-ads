import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { createCipheriv, scryptSync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encryptionPassphrase, initializeSecurity, migrateLegacyFile,
} from '../../src/dashboard/services/security-config.js';
import { encryptString, decryptString } from '../../src/dashboard/services/crypto.js';
import { getPinnedSiteId } from '../../src/dashboard/auth.js';
import { getLicenseInfo, resetLicenseCache } from '../../src/licensing/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandi-rename-'));
  vi.stubEnv('CREDENTIAL_STORE_PATH', dir);
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '');
  vi.stubEnv('CREDENTIAL_LEGACY_ENCRYPTION_KEY', '');
  vi.stubEnv('DASHBOARD_API_KEY', '');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const ino = (name: string) => statSync(join(dir, name)).ino;

describe('migrateLegacyFile', () => {
  it('hard-links new to old keeping bytes and the old name when only old exists', () => {
    writeFileSync(join(dir, 'old'), 'payload');
    migrateLegacyFile(dir, 'new', 'old');
    expect(readFileSync(join(dir, 'new'), 'utf8')).toBe('payload');
    expect(readFileSync(join(dir, 'old'), 'utf8')).toBe('payload');
    expect(ino('new')).toBe(ino('old'));
  });

  it('never overwrites an existing new file', () => {
    writeFileSync(join(dir, 'old'), 'old-data');
    writeFileSync(join(dir, 'new'), 'new-data');
    migrateLegacyFile(dir, 'new', 'old');
    expect(readFileSync(join(dir, 'new'), 'utf8')).toBe('new-data');
    expect(readFileSync(join(dir, 'old'), 'utf8')).toBe('old-data');
    expect(ino('new')).not.toBe(ino('old'));
  });

  it('does nothing when neither exists', () => {
    migrateLegacyFile(dir, 'new', 'old');
    expect(existsSync(join(dir, 'new'))).toBe(false);
    expect(existsSync(join(dir, 'old'))).toBe(false);
  });

  it('is idempotent and race-safe when called twice for the same pair', () => {
    writeFileSync(join(dir, 'old'), 'payload');
    expect(() => { migrateLegacyFile(dir, 'new', 'old'); migrateLegacyFile(dir, 'new', 'old'); }).not.toThrow();
    expect(ino('new')).toBe(ino('old'));
    expect(readFileSync(join(dir, 'new'), 'utf8')).toBe('payload');
  });
});

function legacyEnvelope(plaintext: string, key: string) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(key, 'website-ops-mcp-credential-store', 32), iv);
  const data = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data };
}

describe('security files migration', () => {
  it('links the three legacy key files, keeps old names, and old ciphertext decrypts', () => {
    writeFileSync(join(dir, '.website-ops-encryption.key'), 'enc-secret', { mode: 0o600 });
    writeFileSync(join(dir, '.website-ops-legacy-encryption.key'), 'legacy-secret', { mode: 0o600 });
    writeFileSync(join(dir, '.website-ops-dashboard.key'), 'dash-secret', { mode: 0o600 });
    // Ciphertext produced "before" the rename: derive from the old key value.
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', 'enc-secret');
    const before = encryptString('precious');
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '');

    initializeSecurity();

    expect(readFileSync(join(dir, '.sandi-ads-encryption.key'), 'utf8')).toBe('enc-secret');
    expect(readFileSync(join(dir, '.sandi-ads-legacy-encryption.key'), 'utf8')).toBe('legacy-secret');
    expect(readFileSync(join(dir, '.sandi-ads-dashboard.key'), 'utf8')).toBe('dash-secret');
    for (const name of ['encryption', 'legacy-encryption', 'dashboard']) {
      // Old name kept on purpose: same inode, so a still-running old process reads the same key.
      expect(ino(`.website-ops-${name}.key`)).toBe(ino(`.sandi-ads-${name}.key`));
    }
    expect(encryptionPassphrase()).toBe('enc-secret');
    expect(process.env.DASHBOARD_API_KEY).toBe('dash-secret');
    expect(decryptString(before)).toBe('precious');
  });

  it('simulated old process still reads the same key under the old name after migration', () => {
    writeFileSync(join(dir, '.website-ops-encryption.key'), 'enc-secret', { mode: 0o600 });
    initializeSecurity();
    // HEAD code reads `.website-ops-encryption.key` and only mints when it is missing (ENOENT).
    expect(existsSync(join(dir, '.website-ops-encryption.key'))).toBe(true);
    expect(readFileSync(join(dir, '.website-ops-encryption.key'), 'utf8').trim())
      .toBe(readFileSync(join(dir, '.sandi-ads-encryption.key'), 'utf8').trim());
    // A second new-code start is a no-op and keeps the same key family.
    expect(() => initializeSecurity()).not.toThrow();
    expect(encryptionPassphrase()).toBe('enc-secret');
  });

  it('legacy key file migrates under an explicit CREDENTIAL_ENCRYPTION_KEY and old ciphertext decrypts', () => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', 'explicit-env-key');
    writeFileSync(join(dir, '.website-ops-legacy-encryption.key'), 'legacy-secret', { mode: 0o600 });
    const old = legacyEnvelope('legacy precious', 'legacy-secret');
    expect(decryptString(old)).toBe('legacy precious');
    expect(ino('.sandi-ads-legacy-encryption.key')).toBe(ino('.website-ops-legacy-encryption.key'));
  });

  it('leaves both files untouched when old and new coexist', () => {
    writeFileSync(join(dir, '.website-ops-encryption.key'), 'old-secret');
    writeFileSync(join(dir, '.sandi-ads-encryption.key'), 'new-secret');
    expect(encryptionPassphrase()).toBe('new-secret');
    expect(readFileSync(join(dir, '.website-ops-encryption.key'), 'utf8')).toBe('old-secret');
    expect(readFileSync(join(dir, '.sandi-ads-encryption.key'), 'utf8')).toBe('new-secret');
    expect(ino('.website-ops-encryption.key')).not.toBe(ino('.sandi-ads-encryption.key'));
  });

  it('mints new-named files when nothing exists', () => {
    initializeSecurity();
    expect(existsSync(join(dir, '.sandi-ads-encryption.key'))).toBe(true);
    expect(existsSync(join(dir, '.sandi-ads-dashboard.key'))).toBe(true);
    expect(existsSync(join(dir, '.website-ops-encryption.key'))).toBe(false);
    expect(existsSync(join(dir, '.website-ops-dashboard.key'))).toBe(false);
  });
});

describe('credential store file migration', () => {
  it('links the legacy credentials file and its .legacy.bak sibling on load', async () => {
    vi.resetModules();
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', 'k-for-store');
    const crypto = await import('../../src/dashboard/services/crypto.js');
    const raw = JSON.stringify(crypto.encryptString(JSON.stringify({ google_client_id: 'kept' })));
    writeFileSync(join(dir, '.website-ops-credentials.enc'), raw);
    writeFileSync(join(dir, '.website-ops-credentials.enc.legacy.bak'), 'bak');
    const { credentialStore } = await import('../../src/dashboard/services/credential-store.js');
    expect(credentialStore.load().google_client_id).toBe('kept');
    expect(readFileSync(join(dir, '.sandi-ads-credentials.enc'), 'utf8')).toBe(raw);
    expect(readFileSync(join(dir, '.sandi-ads-credentials.enc.legacy.bak'), 'utf8')).toBe('bak');
    expect(ino('.website-ops-credentials.enc')).toBe(ino('.sandi-ads-credentials.enc'));
    expect(ino('.website-ops-credentials.enc.legacy.bak')).toBe(ino('.sandi-ads-credentials.enc.legacy.bak'));
  });

  it('creates the new-named file when neither exists', async () => {
    vi.resetModules();
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', 'k-for-store');
    const { credentialStore } = await import('../../src/dashboard/services/credential-store.js');
    credentialStore.load();
    credentialStore.set({ google_client_id: 'x' });
    expect(existsSync(join(dir, '.sandi-ads-credentials.enc'))).toBe(true);
    expect(existsSync(join(dir, '.website-ops-credentials.enc'))).toBe(false);
  });
});

describe('env fallbacks', () => {
  it('pinned site id: new name wins, old works alone', () => {
    vi.stubEnv('SANDI_ADS_SITE_ID', '');
    vi.stubEnv('WEBSITE_OPS_SITE_ID', '');
    delete process.env.SANDI_ADS_SITE_ID;
    delete process.env.WEBSITE_OPS_SITE_ID;
    expect(getPinnedSiteId()).toBeUndefined();
    vi.stubEnv('WEBSITE_OPS_SITE_ID', 'old-id');
    expect(getPinnedSiteId()).toBe('old-id');
    vi.stubEnv('SANDI_ADS_SITE_ID', 'new-id');
    expect(getPinnedSiteId()).toBe('new-id');
  });

  it('license key: new name wins, old works alone', () => {
    const mk = (body: string) => {
      const sum = [...body.replace(/-/g, '')].reduce((a, c) => a + c.charCodeAt(0), 0);
      return `SMCP-${body}-${(sum % 36).toString(36).toUpperCase()}AAA`;
    };
    const oldKey = mk('AAAA-BBBB-CCCC');
    const newKey = mk('DDDD-EEEE-FFFF');
    vi.stubEnv('SANDI_ADS_KEY', '');
    vi.stubEnv('SEO_MCP_PRO_KEY', oldKey);
    delete process.env.SANDI_ADS_KEY;
    resetLicenseCache();
    expect(getLicenseInfo()).toMatchObject({ tier: 'pro', key: oldKey });
    vi.stubEnv('SANDI_ADS_KEY', newKey);
    resetLicenseCache();
    expect(getLicenseInfo()).toMatchObject({ tier: 'pro', key: newKey });
    vi.stubEnv('SANDI_ADS_KEY', '   ');
    resetLicenseCache();
    expect(getLicenseInfo()).toMatchObject({ tier: 'pro', key: oldKey });
    resetLicenseCache();
  });
});
