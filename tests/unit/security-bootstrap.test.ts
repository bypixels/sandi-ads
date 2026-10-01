import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, scryptSync, randomBytes } from 'node:crypto';
import { encryptionPassphrase, initializeSecurity, securityFile } from '../../src/dashboard/services/security-config.js';
import { encryptString, decryptString } from '../../src/dashboard/services/crypto.js';
import { authenticateRequest, authorizeEndpoint } from '../../src/dashboard/auth.js';
import type { IncomingMessage } from 'node:http';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ops-security-'));
  vi.stubEnv('CREDENTIAL_STORE_PATH', dir);
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', '');
  vi.stubEnv('CREDENTIAL_LEGACY_ENCRYPTION_KEY', '');
  vi.stubEnv('DASHBOARD_API_KEY', '');
  vi.stubEnv('DASHBOARD_REVIEWER_API_KEY', '');
  vi.stubEnv('DASHBOARD_AUTH_REQUIRED', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function legacy(plaintext: string, key: string) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(key, 'website-ops-mcp-credential-store', 32), iv);
  const data = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data };
}

it('bootstraps independent persistent owner-only keys without exposing them', () => {
  initializeSecurity();
  const encryptionKey = encryptionPassphrase();
  const accessKey = process.env.DASHBOARD_API_KEY;
  expect(encryptionKey).not.toBe(accessKey);
  expect(statSync(securityFile('.sandi-ads-encryption.key')).mode & 0o777).toBe(0o600);
  expect(statSync(securityFile('.sandi-ads-dashboard.key')).mode & 0o777).toBe(0o600);
  vi.stubEnv('DASHBOARD_API_KEY', '');
  initializeSecurity();
  expect(process.env.DASHBOARD_API_KEY).toBe(accessKey);
});

it.each(['machine', 'api'])('recovers %s legacy ciphertext after bootstrap and API rotation', mode => {
  const old = mode === 'api' ? 'previous-api-secret' : `website-ops-${process.env.USER || 'default'}-${hostname()}`;
  if (mode === 'api') vi.stubEnv('DASHBOARD_API_KEY', old);
  const encrypted = legacy('preserved credentials', old);
  initializeSecurity();
  vi.stubEnv('DASHBOARD_API_KEY', 'new-access-secret');
  expect(decryptString(encrypted)).toBe('preserved credentials');
  const current = encryptString('new ciphertext');
  vi.stubEnv('DASHBOARD_API_KEY', 'another-access-secret');
  expect(decryptString(current)).toBe('new ciphertext');
});

it('rejects tampering and refuses legacy fallback on new ciphertext', () => {
  const encrypted = encryptString('sensitive');
  expect(() => decryptString({ ...encrypted, tag: '00'.repeat(16) })).toThrow();
  const old = legacy('legacy', readFileSync(securityFile('.sandi-ads-legacy-encryption.key'), 'utf8'));
  expect(() => decryptString({ ...old, version: 2 })).toThrow();
});

it('backs up and migrates readable credentials but preserves unreadable files', async () => {
  vi.resetModules();
  const { credentialStore } = await import('../../src/dashboard/services/credential-store.js');
  const path = securityFile('.sandi-ads-credentials.enc');
  const old = `website-ops-${process.env.USER || 'default'}-${hostname()}`;
  const raw = JSON.stringify(legacy(JSON.stringify({ google_client_id: 'preserved' }), old));
  writeFileSync(path, raw);
  initializeSecurity();
  expect(credentialStore.load().google_client_id).toBe('preserved');
  expect(readFileSync(path + '.legacy.bak', 'utf8')).toBe(raw);
  expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2);
  writeFileSync(path, 'corrupt ciphertext');
  expect(() => credentialStore.load()).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('corrupt ciphertext');
});

it('reviewer can approve but cannot change configuration or execute tools', () => {
  vi.stubEnv('DASHBOARD_API_KEY', 'admin-key');
  vi.stubEnv('DASHBOARD_REVIEWER_API_KEY', 'review-key');
  vi.stubEnv('SANDI_ADS_SITE_ID', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const reviewer = authenticateRequest({ headers: { authorization: 'Bearer review-key' } } as IncomingMessage);
  expect(reviewer.role).toBe('reviewer');
  expect(authorizeEndpoint(reviewer, 'POST', '/api/agent/approve')).toBe(true);
  for (const path of ['/api/settings/credentials', '/api/sites/id', '/api/tool/ads_create_campaign', '/api/oauth/google/init']) {
    expect(authorizeEndpoint(reviewer, 'POST', path)).toBe(false);
  }
  expect(authorizeEndpoint(reviewer, 'GET', '/api/audit')).toBe(false);
  const admin = authenticateRequest({ headers: { authorization: 'Bearer admin-key' } } as IncomingMessage);
  expect(authorizeEndpoint(admin, 'PUT', '/api/sites/id')).toBe(true);
});
