/**
 * Tests for the encrypted credential store
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Set env BEFORE importing the module (the constructor reads CREDENTIAL_STORE_PATH)
const TEST_DIR = join(import.meta.dirname, '..');
const TEST_STORE_PATH = join(TEST_DIR, '.sandi-ads-credentials.enc');

vi.stubEnv('CREDENTIAL_STORE_PATH', TEST_DIR);
vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', 'test-encryption-key-for-unit-tests');

const { credentialStore, CREDENTIAL_SCHEMA, CREDENTIAL_GROUPS } = await import(
  '../../src/dashboard/services/credential-store.js'
);

describe('CREDENTIAL_SCHEMA', () => {
  it('should define all expected credential keys', () => {
    const keys = Object.keys(CREDENTIAL_SCHEMA);
    expect(keys).toContain('google_client_id');
    expect(keys).toContain('google_client_secret');
    expect(keys).toContain('google_pagespeed_api_key');
    expect(keys).toContain('cloudflare_api_token');
    expect(keys.length).toBeGreaterThanOrEqual(13);
  });

  it('should have envVar, label, and secret for each key', () => {
    for (const [key, schema] of Object.entries(CREDENTIAL_SCHEMA)) {
      expect(schema).toHaveProperty('envVar');
      expect(schema).toHaveProperty('label');
      expect(schema).toHaveProperty('secret');
      expect(typeof schema.envVar).toBe('string');
      expect(typeof schema.label).toBe('string');
      expect(typeof schema.secret).toBe('boolean');
    }
  });

  it('should mark sensitive fields as secret', () => {
    expect(CREDENTIAL_SCHEMA.google_client_secret.secret).toBe(true);
    expect(CREDENTIAL_SCHEMA.google_refresh_token.secret).toBe(true);
    expect(CREDENTIAL_SCHEMA.cloudflare_api_token.secret).toBe(true);
  });

  it('should mark non-sensitive fields as not secret', () => {
    expect(CREDENTIAL_SCHEMA.google_client_id.secret).toBe(false);
    expect(CREDENTIAL_SCHEMA.google_redirect_uri.secret).toBe(false);
    expect(CREDENTIAL_SCHEMA.cloudflare_email.secret).toBe(false);
  });
});

describe('CREDENTIAL_GROUPS', () => {
  it('should define groups for all credential categories', () => {
    const groupIds = CREDENTIAL_GROUPS.map((g: { id: string }) => g.id);
    expect(groupIds).toContain('google_oauth');
    expect(groupIds).toContain('google_service_account');
    expect(groupIds).toContain('google_api_keys');
    expect(groupIds).toContain('google_ads');
    expect(groupIds).toContain('cloudflare');
  });

  it('should reference only valid schema keys', () => {
    const validKeys = Object.keys(CREDENTIAL_SCHEMA);
    for (const group of CREDENTIAL_GROUPS) {
      for (const key of group.keys) {
        expect(validKeys).toContain(key);
      }
    }
  });
});

describe('CredentialStore', () => {
  beforeEach(() => {
    // Clean up any existing test file
    if (existsSync(TEST_STORE_PATH)) {
      unlinkSync(TEST_STORE_PATH);
    }
    credentialStore.clear();
  });

  afterEach(() => {
    if (existsSync(TEST_STORE_PATH)) {
      unlinkSync(TEST_STORE_PATH);
    }
  });

  it('should start with empty credentials', () => {
    const all = credentialStore.getAll();
    expect(Object.keys(all).length).toBe(0);
  });

  it('should set and get credentials', () => {
    credentialStore.set({ google_client_id: 'test-id-123' });
    expect(credentialStore.get('google_client_id')).toBe('test-id-123');
  });

  it('should persist and reload credentials from encrypted file', () => {
    credentialStore.set({ google_client_id: 'persist-test', cloudflare_email: 'x@y.com' });

    // Reload from disk to verify persistence
    const loaded = credentialStore.load();
    expect(loaded.google_client_id).toBe('persist-test');
    expect(loaded.cloudflare_email).toBe('x@y.com');
  });

  it('should load credentials from encrypted file', () => {
    credentialStore.set({ google_client_id: 'load-test', cloudflare_email: 'test@example.com' });

    // Load fresh (simulates restart)
    const loaded = credentialStore.load();
    expect(loaded.google_client_id).toBe('load-test');
    expect(loaded.cloudflare_email).toBe('test@example.com');
  });

  it('migrates a pre-rename .website-ops-credentials.enc on load', () => {
    credentialStore.set({ google_client_id: 'pre-rename' });
    const legacyPath = join(TEST_DIR, '.website-ops-credentials.enc');
    renameSync(TEST_STORE_PATH, legacyPath);

    const loaded = credentialStore.load();
    expect(loaded.google_client_id).toBe('pre-rename');
    expect(existsSync(TEST_STORE_PATH)).toBe(true);
    // Old name kept as a hard link for still-running old processes.
    expect(statSync(legacyPath).ino).toBe(statSync(TEST_STORE_PATH).ino);
    unlinkSync(legacyPath);
  });

  it('should remove credentials with empty values', () => {
    credentialStore.set({ google_client_id: 'to-remove' });
    expect(credentialStore.get('google_client_id')).toBe('to-remove');

    credentialStore.set({ google_client_id: '' });
    expect(credentialStore.get('google_client_id')).toBeUndefined();
  });

  it('should remove a single credential', () => {
    credentialStore.set({ google_client_id: 'x', cloudflare_email: 'y' });
    credentialStore.remove('google_client_id');

    expect(credentialStore.get('google_client_id')).toBeUndefined();
    expect(credentialStore.get('cloudflare_email')).toBe('y');
  });

  it('should clear all credentials', () => {
    credentialStore.set({ google_client_id: 'a', cloudflare_email: 'b' });
    credentialStore.clear();

    const all = credentialStore.getAll();
    expect(Object.keys(all).length).toBe(0);
  });

  it('should trim whitespace from values', () => {
    credentialStore.set({ google_client_id: '  trimmed  ' });
    expect(credentialStore.get('google_client_id')).toBe('trimmed');
  });

  it('should return correct status', () => {
    credentialStore.set({ google_client_id: 'yes', google_pagespeed_api_key: 'key' });
    const status = credentialStore.getStatus();

    expect(status.google_client_id).toBe(true);
    expect(status.google_pagespeed_api_key).toBe(true);
    expect(status.google_client_secret).toBe(false);
    expect(status.cloudflare_api_token).toBe(false);
  });

  it('should apply credentials to process.env', () => {
    // Clear any existing env
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_PAGESPEED_API_KEY;

    credentialStore.set({ google_client_id: 'env-test', google_pagespeed_api_key: 'psi-key' });
    credentialStore.applyToEnv();

    expect(process.env.GOOGLE_CLIENT_ID).toBe('env-test');
    expect(process.env.GOOGLE_PAGESPEED_API_KEY).toBe('psi-key');

    // Clean up
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_PAGESPEED_API_KEY;
  });

  it('should handle multiple set calls correctly', () => {
    credentialStore.set({ google_client_id: 'first' });
    credentialStore.set({ google_client_secret: 'second' });

    expect(credentialStore.get('google_client_id')).toBe('first');
    expect(credentialStore.get('google_client_secret')).toBe('second');
  });

  it('should handle loading when no file exists', () => {
    if (existsSync(TEST_STORE_PATH)) {
      unlinkSync(TEST_STORE_PATH);
    }

    const loaded = credentialStore.load();
    expect(Object.keys(loaded).length).toBe(0);
  });
});
