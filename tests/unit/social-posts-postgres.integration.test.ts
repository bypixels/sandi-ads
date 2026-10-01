import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Audit rows would land in the shared public.audit_events table; keep the DB clean.
vi.mock('../../src/dashboard/services/audit-log.js', () => ({ auditLog: { append: async () => {} } }));

const enabled = process.env.RUN_DB_INTEGRATION === '1';
const schema = `social_posts_it_${randomUUID().replace(/-/g, '')}`;

/**
 * Migration 0007 is applied into a throwaway schema placed first on the
 * search_path, so `social_posts` lives there while `sites` resolves to the
 * real public table. The schema is dropped at the end; no test rows remain.
 */
it.skipIf(!enabled)('PostgreSQL: concurrent approvals have exactly one winner, site_id guards, FK restricts site delete', async () => {
  const target = new URL(process.env.DATABASE_URL || 'postgres://sandi_ads:sandi_ads_dev@localhost:5434/sandi_ads');
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.port !== '5434' || target.pathname !== '/sandi_ads') {
    throw new Error('Integration restricted to own local sandi_ads on port5434');
  }
  target.searchParams.set('options', `-c search_path=${schema},public`);
  vi.stubEnv('DATABASE_URL', target.toString());
  vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://media.example.com');

  const { getPool, closeDb } = await import('../../src/db/index.js');
  const { socialPostsStore, SocialPostConflictError } = await import('../../src/dashboard/services/social-posts-store.js');
  const { sitesStore } = await import('../../src/dashboard/services/sites-store.js');
  const pool = getPool();
  const siteA = randomUUID();
  const siteB = randomUUID();
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(readFileSync(resolve('drizzle/0007_social_posts.sql'), 'utf-8'));
    const located = await pool.query(`SELECT table_schema FROM information_schema.tables WHERE table_name = 'social_posts'`);
    expect(located.rows.map(r => r.table_schema)).toEqual([schema]);
    await pool.query(
      `INSERT INTO sites (id, name, primary_url, bindings) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)`,
      [siteA, 'Posts integration A', 'https://example.invalid/', { metaPageId: '111' },
        siteB, 'Posts integration B', 'https://example.invalid/', { metaPageId: '222' }],
    );

    const draft = await socialPostsStore.createDraft({ siteId: siteA, platforms: ['facebook'], message: 'Hola', createdBy: 'dashboard' });
    expect(await socialPostsStore.approve(draft.id, siteB, 'admin', draft.version)).toBeNull();
    expect((await socialPostsStore.get(draft.id))!.status).toBe('draft');

    // Warm one idle connection per contender so every pre-check SELECT runs before any UPDATE lands;
    // only the SQL guard (status = ANY(...)) can then pick a single winner.
    await Promise.all(Array.from({ length: 5 }, () => pool.query('SELECT pg_sleep(0.05)')));
    const results = await Promise.all(Array.from({ length: 5 }, () => socialPostsStore.approve(draft.id, siteA, 'admin', draft.version)));
    expect(results.filter(r => r !== null)).toHaveLength(1);
    expect(results.find(r => r !== null)).toMatchObject({ status: 'approved', approvedBy: 'admin' });
    expect((await socialPostsStore.get(draft.id))!.status).toBe('approved');

    // Optimistic version: an edit between review and approval must not be approved unseen.
    const reviewed = await socialPostsStore.createDraft({ siteId: siteA, platforms: ['facebook'], message: 'A', createdBy: 'dashboard' });
    const edited = await socialPostsStore.updateDraft(reviewed.id, siteA, { message: 'B' }, 'admin');
    expect(edited!.version).toBe(reviewed.version + 1);
    await expect(socialPostsStore.approve(reviewed.id, siteA, 'admin', reviewed.version)).rejects.toBeInstanceOf(SocialPostConflictError);
    expect(await socialPostsStore.get(reviewed.id)).toMatchObject({ status: 'draft', message: 'B' });
    expect(await socialPostsStore.approve(reviewed.id, siteA, 'admin', edited!.version)).toMatchObject({ status: 'approved', message: 'B' });

    const fkBlock = await sitesStore.remove(siteA).then(() => null, (err: unknown) => err as { code?: string; cause?: { code?: string } });
    expect(fkBlock?.code ?? fkBlock?.cause?.code).toBe('23503');
    expect(await sitesStore.get(siteA)).toBeDefined();
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query('DELETE FROM sites WHERE id = ANY($1::uuid[])', [[siteA, siteB]]);
    await closeDb();
    vi.unstubAllEnvs();
  }
}, 20000);
