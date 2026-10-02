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

const publisherSchema = `social_posts_it_${randomUUID().replace(/-/g, '')}`;

it.skipIf(!enabled)('PostgreSQL publisher queue: concurrent claims never share a post, recovery and late marking', async () => {
  const target = new URL(process.env.DATABASE_URL || 'postgres://sandi_ads:sandi_ads_dev@localhost:5434/sandi_ads');
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.port !== '5434' || target.pathname !== '/sandi_ads') {
    throw new Error('Integration restricted to own local sandi_ads on port5434');
  }
  target.searchParams.set('options', `-c search_path=${publisherSchema},public`);
  vi.stubEnv('DATABASE_URL', target.toString());
  vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://media.example.com');

  const { getPool, closeDb } = await import('../../src/db/index.js');
  const { socialPostsStore } = await import('../../src/dashboard/services/social-posts-store.js');
  const publisher = await import('../../src/dashboard/services/social-publisher.js');
  type Deps = import('../../src/dashboard/services/social-publisher.js').PublisherDeps;
  const deps = { now: () => Date.now(), store: socialPostsStore, isEnabled: () => true, audit: async () => {} } as unknown as Deps;
  const pool = getPool();
  const site = randomUUID();
  const approved = async () => {
    const d = await socialPostsStore.createDraft({ siteId: site, platforms: ['facebook'], message: 'Hola', createdBy: 'dashboard' });
    return (await socialPostsStore.approve(d.id, site, 'admin', d.version))!;
  };
  try {
    await pool.query(`CREATE SCHEMA ${publisherSchema}`);
    await pool.query(readFileSync(resolve('drizzle/0007_social_posts.sql'), 'utf-8'));
    await pool.query(`INSERT INTO sites (id, name, primary_url, bindings) VALUES ($1, $2, $3, $4)`,
      [site, 'Publisher integration', 'https://example.invalid/', { metaPageId: '111' }]);

    // One due post, five contenders on warm connections: exactly one claims it.
    const one = await approved();
    await Promise.all(Array.from({ length: 5 }, () => pool.query('SELECT pg_sleep(0.05)')));
    const claims = await Promise.all(Array.from({ length: 5 }, () => publisher.claimNext(deps)));
    expect(claims.filter(c => c !== null).map(c => c!.id)).toEqual([one.id]);
    expect(await socialPostsStore.get(one.id)).toMatchObject({ status: 'publishing', version: one.version + 1 });

    // Two due posts, two contenders: each gets a different one (SKIP LOCKED never hands out the same row).
    const a = await approved();
    const b = await approved();
    const pair = await Promise.all([publisher.claimNext(deps), publisher.claimNext(deps)]);
    expect(pair.map(c => c?.id).sort()).toEqual([a.id, b.id].sort());

    // recoverInterrupted: only publishing rows older than 10 minutes.
    await pool.query(`UPDATE social_posts SET publishing_started_at = now() - interval '11 minutes' WHERE id = $1`, [one.id]);
    expect(await publisher.recoverInterrupted(deps)).toBe(1);
    expect(await socialPostsStore.get(one.id)).toMatchObject({ status: 'needs_review' });
    expect((await socialPostsStore.get(a.id))!.status).toBe('publishing');

    // A lock held by a live worker prevents another process's startup recovery.
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = socialPostsStore.withPublisherLock(async isHeld => {
      expect(await isHeld()).toBe(true);
      entered();
      await gate;
    });
    await ready;
    try {
      expect(await publisher.tick(deps, { recoverAll: true })).toBe(false);
      expect(await publisher.recoverInterrupted(deps, { all: true })).toBe(0);
      expect((await socialPostsStore.get(a.id))!.status).toBe('publishing');
    } finally { release(); await holder; }
    expect(await publisher.recoverInterrupted(deps, { all: true })).toBe(2);
    expect((await socialPostsStore.get(a.id))!.status).toBe('needs_review');
    // Work errors cannot leak a session advisory lock into the pool.
    await expect(socialPostsStore.withPublisherLock(async () => { throw new Error('probe'); })).rejects.toThrow('probe');
    expect(await socialPostsStore.withPublisherLock(async () => {})).toBe(true);

    // markLate: approved and due more than 15 minutes ago.
    const old = await approved();
    const recent = await approved();
    await pool.query(`UPDATE social_posts SET scheduled_at = now() - interval '20 minutes' WHERE id = $1`, [old.id]);
    await pool.query(`UPDATE social_posts SET scheduled_at = now() - interval '5 minutes' WHERE id = $1`, [recent.id]);
    expect(await publisher.markLate(deps)).toBe(1);
    expect((await socialPostsStore.get(old.id))!.status).toBe('late');
    expect((await socialPostsStore.get(recent.id))!.status).toBe('approved');

    const otherSite = randomUUID();
    await pool.query(`INSERT INTO sites (id, name, primary_url, bindings) VALUES ($1, $2, $3, $4)`,
      [otherSite, 'Other synthetic client', 'https://example.invalid/', { metaPageId: '333' }]);
    try {
      const d = await socialPostsStore.createDraft({ siteId: otherSite, platforms: ['facebook'], message: 'Otro', createdBy: 'dashboard' });
      const other = (await socialPostsStore.approve(d.id, otherSite, 'admin', d.version))!;
      vi.stubEnv('SANDI_ADS_SITE_ID', site);
      const ownClaim = await publisher.claimNext(deps);
      expect(ownClaim?.siteId).toBe(site);
      expect(await publisher.claimNext(deps)).toBeNull();
      expect((await socialPostsStore.get(other.id))!.status).toBe('approved');
      await pool.query(`UPDATE social_posts SET status = 'publishing', publishing_started_at = now() - interval '11 minutes' WHERE id = $1`, [other.id]);
      await publisher.recoverInterrupted(deps, { all: true });
      expect((await socialPostsStore.get(other.id))!.status).toBe('publishing');
      await pool.query(`UPDATE social_posts SET status = 'approved', scheduled_at = now() - interval '20 minutes' WHERE id = $1`, [other.id]);
      await publisher.markLate(deps);
      expect((await socialPostsStore.get(other.id))!.status).toBe('approved');
    } finally {
      await pool.query('DELETE FROM social_posts WHERE site_id = $1', [otherSite]);
      await pool.query('DELETE FROM sites WHERE id = $1', [otherSite]);
    }

  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${publisherSchema} CASCADE`);
    await pool.query('DELETE FROM sites WHERE id = $1', [site]);
    await closeDb();
    vi.unstubAllEnvs();
  }
}, 20000);
