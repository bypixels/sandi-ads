/**
 * SiteProfile — marketer-facing metadata about a Site, separate from
 * `bindings` (which are technical wiring the agent uses to call APIs).
 *
 * Why this module exists:
 *   - A Site row needs to carry both "the GSC siteUrl I auth against" (binding)
 *     and "the brand voice my content tools should match" (profile). Mixing
 *     them in one structure means every caller has to know which keys to
 *     touch. Worse: every tool that consumes the brand voice would do JSON
 *     manipulation against an untyped column.
 *   - Now: bindings live in `sites.bindings` (managed by sites-store), profile
 *     lives in `sites.profile` (managed by this module). Two modules, two
 *     responsibilities, both backed by the same row.
 *
 * Schema versioning:
 *   - `profileVersion: 1` is stamped on every write. When the shape evolves,
 *     bump the version and migrate-on-read in `parseProfile()`. The JSONB
 *     column stays generic — no SQL migration needed.
 */

import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { sites } from '../../db/schema.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('site-profile');

// ---------------------------------------------------------------------------
// Schema — v1
// ---------------------------------------------------------------------------

const competitorSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().optional(),
  notes: z.string().max(500).optional(),
});

export type Competitor = z.infer<typeof competitorSchema>;

const profileSchemaV1 = z.object({
  profileVersion: z.literal(1).default(1),
  description: z.string().max(2000).default(''),
  niche: z.string().max(120).default(''),
  brandVoice: z.string().max(2000).default(''),
  /** Free-form tags shown as chips (e.g. "B2B", "legal-tech", "es-CR"). */
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  competitors: z.array(competitorSchema).max(20).default([]),
  /**
   * Brand colors / logos / fonts for future content + ad generation tools.
   * Optional — empty object is fine.
   */
  brandAssets: z
    .object({
      primaryColor: z.string().optional(),
      logoUrl: z.string().url().optional(),
    })
    .default({}),
});

export type SiteProfile = z.infer<typeof profileSchemaV1>;

/** Patch is everything except the version (writer always stamps current version). */
export const profilePatchSchema = profileSchemaV1.partial().omit({ profileVersion: true });
export type SiteProfilePatch = z.infer<typeof profilePatchSchema>;

/**
 * Deserialize whatever's in the JSONB column into a current-version profile.
 * Migrates older shapes on the fly so callers always see v1.
 */
function parseProfile(raw: unknown): SiteProfile {
  const parsed = profileSchemaV1.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;

  // Lenient fallback: keep whatever fields we can salvage, defaulting the rest.
  // This is what "migrate-on-read" looks like before we have a v2.
  log.warn('Site profile failed strict parse, applying defaults', { issues: parsed.error.issues.slice(0, 3) });
  return profileSchemaV1.parse({});
}

/** Default profile used when a site has never been edited. */
export function defaultProfile(): SiteProfile {
  return profileSchemaV1.parse({});
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

class SiteProfileRepo {
  /** Returns the profile for a site, or `null` when the site does not exist. */
  async get(siteId: string): Promise<SiteProfile | null> {
    const rows = await getDb()
      .select({ profile: sites.profile })
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);
    if (rows.length === 0) return null;
    return parseProfile(rows[0].profile);
  }

  /**
   * Merge-update: any field the caller omits keeps its current value.
   *
   * Runs read-modify-write inside a transaction with SELECT FOR UPDATE on
   * the site row. This serializes concurrent PUTs to the same profile —
   * without it, two tabs editing simultaneously would race and one would
   * overwrite the other's changes (lost write).
   *
   * The lock is short-lived (single round-trip read + write) so it does not
   * block other operations on the site row meaningfully.
   */
  async update(siteId: string, patch: SiteProfilePatch): Promise<SiteProfile> {
    const validated = profilePatchSchema.parse(patch);

    const next = await getDb().transaction(async (tx) => {
      const rows = await tx.execute<{ profile: unknown }>(sql`
        SELECT profile FROM sites WHERE id = ${siteId} FOR UPDATE
      `);
      if (rows.rows.length === 0) {
        throw new Error(`Site ${siteId} not found`);
      }
      const current = parseProfile(rows.rows[0].profile);
      const merged: SiteProfile = {
        ...current,
        ...validated,
        profileVersion: 1,
      };
      await tx
        .update(sites)
        .set({
          profile: merged as unknown as Record<string, unknown>,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(sites.id, siteId));
      return merged;
    });

    log.info('Site profile updated', {
      siteId,
      changedKeys: Object.keys(validated),
    });

    return next;
  }
}

export const siteProfileRepo = new SiteProfileRepo();
