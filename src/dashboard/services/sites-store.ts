/**
 * Sites store — Postgres-backed.
 *
 * A "site" groups external resources (GA4, GSC, GTM, Ads, GBP, Cloudflare)
 * for one client/property. Bindings are stored as a JSONB column so the
 * shape can evolve without schema migrations.
 *
 * Public API is async (was sync when JSON-backed). Callers must await.
 */

import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { sites } from '../../db/schema.js';
import { createServiceLogger } from '../../utils/logger.js';
import { runLegacyMigration, type MigrationResult } from './migration.js';

const log = createServiceLogger('sites-store');

export interface Site {
  id: string;
  name: string;
  primaryUrl: string;
  bindings: SiteBindings;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteBindings {
  ga4PropertyId?: string;
  gscSiteUrl?: string;
  gtmAccountId?: string;
  gtmContainerId?: string;
  adsCustomerId?: string;
  gbpAccountId?: string;
  gbpLocationName?: string;
  cloudflareZoneId?: string;
  metaAdAccountId?: string;
  metaPageId?: string;
  metaIgUserId?: string;
}

export type SiteInput = Omit<Site, 'id' | 'createdAt' | 'updatedAt'>;
export type SitePatch = Partial<Omit<Site, 'id' | 'createdAt'>>;

const ALLOWED_BINDING_KEYS: Array<keyof SiteBindings> = [
  'ga4PropertyId', 'gscSiteUrl',
  'gtmAccountId', 'gtmContainerId',
  'adsCustomerId',
  'gbpAccountId', 'gbpLocationName',
  'cloudflareZoneId',
  'metaAdAccountId', 'metaPageId', 'metaIgUserId',
];

/** Strip empty-string values so optional bindings aren't stored as "" */
function cleanBindings(b: SiteBindings | Record<string, unknown> | undefined): SiteBindings {
  const out: SiteBindings = {};
  if (!b) return out;
  for (const k of ALLOWED_BINDING_KEYS) {
    const v = (b as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) {
      out[k] = v.trim();
    }
  }
  return out;
}

function rowToSite(r: typeof sites.$inferSelect): Site {
  return {
    id: r.id,
    name: r.name,
    primaryUrl: r.primaryUrl,
    bindings: cleanBindings(r.bindings as Record<string, string>),
    notes: r.notes ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

class SitesStore {
  async list(): Promise<Site[]> {
    const rows = await getDb().select().from(sites).orderBy(sites.createdAt);
    return rows.map(rowToSite);
  }

  async get(id: string): Promise<Site | undefined> {
    const rows = await getDb().select().from(sites).where(eq(sites.id, id)).limit(1);
    return rows[0] ? rowToSite(rows[0]) : undefined;
  }

  async create(input: SiteInput): Promise<Site> {
    const rows = await getDb()
      .insert(sites)
      .values({
        name: input.name.trim(),
        primaryUrl: input.primaryUrl.trim(),
        bindings: cleanBindings(input.bindings) as Record<string, string>,
        notes: input.notes?.trim() || null,
      })
      .returning();
    return rowToSite(rows[0]);
  }

  async update(id: string, patch: SitePatch): Promise<Site | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;

    const next: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.name !== undefined) next.name = patch.name.trim();
    if (patch.primaryUrl !== undefined) next.primaryUrl = patch.primaryUrl.trim();
    if (patch.bindings !== undefined) {
      next.bindings = cleanBindings({ ...current.bindings, ...patch.bindings }) as Record<string, string>;
    }
    if (patch.notes !== undefined) next.notes = patch.notes?.trim() || null;

    const rows = await getDb().update(sites).set(next).where(eq(sites.id, id)).returning();
    return rows[0] ? rowToSite(rows[0]) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    const r = await getDb().delete(sites).where(eq(sites.id, id)).returning({ id: sites.id });
    return r.length > 0;
  }

  /**
   * One-shot import of legacy `.website-ops-sites.json`. The shape orchestration
   * (path resolution, idempotency, rename) lives in migration.ts; this method
   * just supplies the spec.
   */
  async importLegacyJson(): Promise<MigrationResult> {
    return runLegacyMigration({
      name: 'sites JSON',
      pathEnvVars: ['SITES_STORE_PATH'],
      fileName: '.website-ops-sites.json',
      isAlreadyPopulated: async () => {
        const existing = await getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(sites);
        return (existing[0]?.count ?? 0) > 0;
      },
      importEntries: async (filePath) => {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as { sites?: Array<Site & Record<string, unknown>> };
        const list = Array.isArray(parsed?.sites) ? parsed.sites : [];
        let imported = 0;
        for (const s of list) {
          try {
            await getDb().insert(sites).values({
              id: s.id, // preserve original UUID so bindings to other tables stay valid
              name: s.name,
              primaryUrl: s.primaryUrl,
              bindings: cleanBindings(s.bindings as Record<string, string>) as Record<string, string>,
              notes: s.notes ?? null,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
            });
            imported++;
          } catch (err) {
            log.warn('Skipped site row during import', {
              id: s.id,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
        return imported;
      },
    });
  }
}

export const sitesStore = new SitesStore();
