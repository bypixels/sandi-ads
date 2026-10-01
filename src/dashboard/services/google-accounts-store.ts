/**
 * Google accounts repository.
 *
 * Stores OAuth-linked Google identities. Refresh tokens are encrypted at
 * the application layer (AES-256-GCM, same passphrase as credential-store)
 * before they hit the database.
 */

import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { googleAccounts } from '../../db/schema.js';
import { encryptString, decryptString } from './crypto.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('google-accounts');

export interface GoogleAccountSummary {
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  scopes: string[];
  isActive: boolean;
  lastValidatedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoogleAccountWithToken extends GoogleAccountSummary {
  refreshToken: string;
}

export interface SaveGoogleAccountInput {
  email: string;
  name?: string | null;
  pictureUrl?: string | null;
  refreshToken: string;
  scopes: string[];
}

class GoogleAccountsStore {
  /** All accounts (no tokens). Most-recently-used first. */
  async list(): Promise<GoogleAccountSummary[]> {
    const rows = await getDb()
      .select()
      .from(googleAccounts)
      .orderBy(desc(googleAccounts.lastUsedAt), desc(googleAccounts.createdAt));
    return rows.map(rowToSummary);
  }

  async listActive(): Promise<GoogleAccountSummary[]> {
    const rows = await getDb()
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.isActive, true))
      .orderBy(desc(googleAccounts.lastUsedAt), desc(googleAccounts.createdAt));
    return rows.map(rowToSummary);
  }

  async getById(id: string): Promise<GoogleAccountSummary | null> {
    const rows = await getDb().select().from(googleAccounts).where(eq(googleAccounts.id, id)).limit(1);
    return rows[0] ? rowToSummary(rows[0]) : null;
  }

  async getByEmail(email: string): Promise<GoogleAccountSummary | null> {
    const rows = await getDb().select().from(googleAccounts).where(eq(googleAccounts.email, email)).limit(1);
    return rows[0] ? rowToSummary(rows[0]) : null;
  }

  /** Read account with decrypted refresh token. Used by AuthManager only. */
  async getWithToken(id: string): Promise<GoogleAccountWithToken | null> {
    const rows = await getDb().select().from(googleAccounts).where(eq(googleAccounts.id, id)).limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    const refreshToken = decryptString({
      iv: r.encryptionIv,
      tag: r.encryptionTag,
      data: r.encryptedRefreshToken,
    });
    return { ...rowToSummary(r), refreshToken };
  }

  /** Get the default active account (most-recently-used, fallback to first). */
  async getDefaultActive(): Promise<GoogleAccountWithToken | null> {
    const rows = await getDb()
      .select()
      .from(googleAccounts)
      .where(eq(googleAccounts.isActive, true))
      .orderBy(desc(googleAccounts.lastUsedAt), desc(googleAccounts.createdAt))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0];
    const refreshToken = decryptString({
      iv: r.encryptionIv,
      tag: r.encryptionTag,
      data: r.encryptedRefreshToken,
    });
    return { ...rowToSummary(r), refreshToken };
  }

  /**
   * Insert or update an account. Uses ON CONFLICT (email) to upsert —
   * re-linking the same Google identity refreshes the token + scopes.
   */
  async save(input: SaveGoogleAccountInput): Promise<GoogleAccountSummary> {
    const enc = encryptString(input.refreshToken);
    const now = new Date().toISOString();
    const rows = await getDb()
      .insert(googleAccounts)
      .values({
        email: input.email,
        name: input.name ?? null,
        pictureUrl: input.pictureUrl ?? null,
        encryptedRefreshToken: enc.data,
        encryptionIv: enc.iv,
        encryptionTag: enc.tag,
        scopes: input.scopes,
        isActive: true,
        lastValidatedAt: now,
      })
      .onConflictDoUpdate({
        target: googleAccounts.email,
        set: {
          name: input.name ?? null,
          pictureUrl: input.pictureUrl ?? null,
          encryptedRefreshToken: enc.data,
          encryptionIv: enc.iv,
          encryptionTag: enc.tag,
          scopes: input.scopes,
          isActive: true,
          lastValidatedAt: now,
          updatedAt: now,
        },
      })
      .returning();
    log.info('Google account saved', { email: input.email });
    return rowToSummary(rows[0]);
  }

  async markUsed(id: string): Promise<void> {
    const now = new Date().toISOString();
    await getDb().update(googleAccounts).set({ lastUsedAt: now }).where(eq(googleAccounts.id, id));
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await getDb()
      .update(googleAccounts)
      .set({ isActive: active, updatedAt: new Date().toISOString() })
      .where(eq(googleAccounts.id, id));
  }

  async remove(id: string): Promise<boolean> {
    const r = await getDb().delete(googleAccounts).where(eq(googleAccounts.id, id)).returning({ id: googleAccounts.id });
    return r.length > 0;
  }

  async count(): Promise<number> {
    const r = await getDb().select({ count: sql<number>`count(*)::int` }).from(googleAccounts);
    return r[0]?.count ?? 0;
  }
}

function rowToSummary(r: typeof googleAccounts.$inferSelect): GoogleAccountSummary {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    pictureUrl: r.pictureUrl,
    scopes: r.scopes ?? [],
    isActive: r.isActive,
    lastValidatedAt: r.lastValidatedAt,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const googleAccountsStore = new GoogleAccountsStore();
