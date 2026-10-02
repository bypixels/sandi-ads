import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePostsPool } from '../helpers/social-posts-pool.js';

const m = vi.hoisted(() => ({
  fake: undefined as unknown as ReturnType<typeof import('../helpers/social-posts-pool.js').createFakePostsPool>,
  getSite: vi.fn(),
  append: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/db/index.js', () => ({ getPool: () => m.fake.pool }));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: { get: m.getSite } }));
vi.mock('../../src/dashboard/services/audit-log.js', () => ({ auditLog: { append: m.append } }));
vi.mock('../../src/utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/logger.js')>()),
  createServiceLogger: () => m.log,
}));

const { socialPostsStore } = await import('../../src/dashboard/services/social-posts-store.js');
const publisher = await import('../../src/dashboard/services/social-publisher.js');
const { getMonitorHealth, _resetForTests } = await import('../../src/dashboard/services/monitor-health.js');
type Deps = import('../../src/dashboard/services/social-publisher.js').PublisherDeps;
type Op = import('../../src/tools/meta/client.js').MetaWriteOp;

const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bindings = { metaPageId: '111', metaIgUserId: '222' };
const PAGE_TOKEN = 'EAAB-page-token-SECRET-1';
const USER_TOKEN = 'EAAB-system-user-SECRET-2';
const APP_SECRET = 'app-secret-SECRET-3';
const image = (site = siteA) => `https://media.example.com/sites/${site}/2026/10/0b0c0d0e-1111-4222-8333-444455556666.jpg`;
const MIN = 60_000;

let clock = 0;

function makeDeps(over: Partial<Deps> = {}) {
  const meta = {
    write: vi.fn(async (op: Op, _token: string, beforeSend: () => Promise<void>) => {
      await beforeSend();
      if (op.kind === 'page_photo') return { id: '9001', postId: '111_9001' };
      if (op.kind === 'page_feed') return { id: '111_9002' };
      if (op.kind === 'ig_container') return { id: '7001' };
      return { id: '8001' };
    }),
    pageToken: vi.fn(async () => PAGE_TOKEN),
    userToken: vi.fn(() => USER_TOKEN),
    igStatus: vi.fn(async () => 'FINISHED'),
    igQuota: vi.fn(async () => ({ usage: 1, total: 100 })),
    igPermalink: vi.fn(async () => 'https://www.instagram.com/p/abc/'),
  };
  const deps = {
    now: () => clock,
    store: socialPostsStore,
    meta,
    audit: m.append,
    sitesStore: { get: m.getSite },
    isEnabled: vi.fn(() => true),
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
    ...over,
  };
  return deps as typeof deps & Deps;
}

async function approved(over: Record<string, unknown> = {}) {
  const d = await socialPostsStore.createDraft({ siteId: siteA, platforms: ['facebook'], message: 'Hola', createdBy: 'dashboard', ...over });
  return (await socialPostsStore.approve(d.id, d.siteId, 'admin', d.version))!;
}
const row = (id: string) => m.fake.rows.get(id)!;
const ops = (deps: ReturnType<typeof makeDeps>) => deps.meta.write.mock.calls.map(c => c[0].kind);

beforeEach(() => {
  clock = Date.now();
  m.fake = createFakePostsPool();
  m.getSite.mockReset().mockImplementation(async (id: string) => ({ id, bindings }));
  m.append.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(m.log)) fn.mockReset();
  _resetForTests();
  vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://media.example.com');
  vi.stubEnv('META_ACCESS_TOKEN', USER_TOKEN);
  vi.stubEnv('META_APP_SECRET', APP_SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe('social publisher — what gets published', () => {
  it.each(['draft', 'rejected', 'cancelled', 'late', 'failed', 'needs_review', 'published', 'publishing'])('never publishes a post in status %s', async (status) => {
    const p = await approved();
    Object.assign(row(p.id), { status, publishing_started_at: new Date(clock) });
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(deps.meta.write).not.toHaveBeenCalled();
    expect(deps.meta.pageToken).not.toHaveBeenCalled();
    expect(row(p.id).status).toBe(status);
  });

  it('does not publish a post scheduled in the future', async () => {
    const p = await approved({ scheduledAt: clock + 30 * MIN });
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(deps.meta.write).not.toHaveBeenCalled();
    expect(row(p.id).status).toBe('approved');
  });

  it('kill switch off: no claim, no Meta call, post stays approved', async () => {
    const p = await approved();
    const deps = makeDeps({ isEnabled: () => false });
    m.fake.statements.length = 0;
    await publisher.tick(deps);
    expect(m.fake.statements.some(s => s.includes("SET status = 'publishing'"))).toBe(false);
    expect(await publisher.claimNext(deps)).toBeNull();
    expect(deps.meta.write).not.toHaveBeenCalled();
    expect(deps.meta.pageToken).not.toHaveBeenCalled();
    expect(row(p.id)).toMatchObject({ status: 'approved', version: p.version });
  });

  it('the default switch follows MUTATIONS_META, then MUTATIONS_ENABLED', () => {
    vi.stubEnv('MUTATIONS_META', ''); vi.stubEnv('MUTATIONS_ENABLED', '');
    expect(publisher.isMetaPublishingEnabled()).toBe(false);
    vi.stubEnv('MUTATIONS_ENABLED', 'true');
    expect(publisher.isMetaPublishingEnabled()).toBe(true);
    vi.stubEnv('MUTATIONS_META', 'false');
    expect(publisher.isMetaPublishingEnabled()).toBe(false);
    vi.stubEnv('MUTATIONS_ENABLED', 'false'); vi.stubEnv('MUTATIONS_META', 'true');
    expect(publisher.isMetaPublishingEnabled()).toBe(true);
  });

  it('Facebook with image → page photo with the Page token; stores post id + permalink', async () => {
    const p = await approved({ imageUrl: image(), message: 'Con foto' });
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(deps.meta.pageToken).toHaveBeenCalledWith('111');
    expect(deps.meta.write).toHaveBeenCalledTimes(1);
    expect(deps.meta.write).toHaveBeenCalledWith({ kind: 'page_photo', pageId: '111', url: image(), caption: 'Con foto' }, PAGE_TOKEN, expect.any(Function));
    expect(row(p.id)).toMatchObject({
      status: 'published', last_error: null,
      remote_ids: { facebook: '111_9001', facebook_permalink: 'https://www.facebook.com/111_9001' },
    });
    expect(getMonitorHealth().find(h => h.monitor === 'publisher')).toMatchObject({ provider: 'meta', status: 'ok' });
  });

  it('Facebook without image → page feed', async () => {
    const p = await approved({ message: 'Solo texto' });
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(deps.meta.write).toHaveBeenCalledWith({ kind: 'page_feed', pageId: '111', message: 'Solo texto' }, PAGE_TOKEN, expect.any(Function));
    expect(row(p.id)).toMatchObject({ status: 'published', remote_ids: { facebook: '111_9002' } });
  });

  it('Instagram: quota → container → poll every 2 s until FINISHED → publish with the system-user token', async () => {
    const p = await approved({ platforms: ['instagram'], imageUrl: image(), message: 'IG' });
    const deps = makeDeps();
    deps.meta.igStatus.mockResolvedValueOnce('IN_PROGRESS').mockResolvedValueOnce('IN_PROGRESS').mockResolvedValue('FINISHED');
    await publisher.tick(deps);
    expect(deps.meta.igQuota).toHaveBeenCalledWith('222');
    expect(deps.meta.write.mock.calls).toEqual([
      [{ kind: 'ig_container', igUserId: '222', imageUrl: image(), caption: 'IG' }, USER_TOKEN, expect.any(Function)],
      [{ kind: 'ig_publish', igUserId: '222', creationId: '7001' }, USER_TOKEN, expect.any(Function)],
    ]);
    expect(deps.meta.igStatus).toHaveBeenCalledWith('7001', expect.any(Number));
    expect(deps.sleep.mock.calls).toEqual([[2000], [2000]]);
    expect(row(p.id)).toMatchObject({
      status: 'published', remote_ids: { instagram: '8001', instagram_permalink: 'https://www.instagram.com/p/abc/' },
    });
  });

  it.each([['ERROR'], ['EXPIRED'], ['IN_PROGRESS']])('Instagram container %s (or 60 s timeout) → failed, never published', async (status) => {
    const p = await approved({ platforms: ['instagram'], imageUrl: image() });
    const deps = makeDeps();
    deps.meta.igStatus.mockResolvedValue(status);
    await publisher.tick(deps);
    expect(ops(deps)).toEqual(['ig_container']);
    if (status === 'IN_PROGRESS') expect(deps.sleep.mock.calls.reduce((a, c) => a + c[0], 0)).toBe(60_000);
    expect(row(p.id).status).toBe('failed');
    expect(row(p.id).last_error).toMatch(/^Instagram:/);
  });

  it('Instagram quota exhausted → failed in Spanish, no container created', async () => {
    const p = await approved({ platforms: ['instagram'], imageUrl: image() });
    const deps = makeDeps();
    deps.meta.igQuota.mockResolvedValue({ usage: 100, total: 100 });
    await publisher.tick(deps);
    expect(deps.meta.write).not.toHaveBeenCalled();
    expect(row(p.id).status).toBe('failed');
    expect(row(p.id).last_error).toMatch(/cuota/i);
  });

  it('invalid bindings at publish time → failed with Spanish reasons, nothing sent', async () => {
    const p = await approved();
    m.getSite.mockResolvedValue({ id: siteA, bindings: {} });
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(m.getSite).toHaveBeenCalledWith(siteA);
    expect(deps.meta.pageToken).not.toHaveBeenCalled();
    expect(deps.meta.write).not.toHaveBeenCalled();
    expect(row(p.id).status).toBe('failed');
    expect(row(p.id).last_error).toContain('no tiene una página de Facebook vinculada');
  });

  it('an image of another client at publish time → failed, nothing sent', async () => {
    const p = await approved({ imageUrl: image() });
    Object.assign(row(p.id), { image_url: image(siteB), image_key: null });
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(deps.meta.write).not.toHaveBeenCalled();
    expect(row(p.id).status).toBe('failed');
  });
});

describe('social publisher — partial success, crashes and retries', () => {
  it('keeps an uncertain Facebook outcome in needs_review when the switch turns off before Instagram', async () => {
    const p = await approved({ platforms: ['facebook', 'instagram'], imageUrl: image() });
    let on = true;
    const deps = makeDeps({ isEnabled: () => on });
    deps.meta.write.mockImplementation(async () => {
      on = false;
      throw Object.assign(new Error('socket closed after sending'), { details: { uncertain: true } });
    });
    await publisher.tick(deps);
    expect(row(p.id).status).toBe('needs_review');
    on = true;
    await publisher.tick(deps);
    expect(deps.meta.write).toHaveBeenCalledTimes(1);
    expect(row(p.id).last_error).toContain('verifica en Meta');
  });

  it('FB ok + IG fails → failed keeping the FB id; retry publishes only IG', async () => {
    const p = await approved({ platforms: ['facebook', 'instagram'], imageUrl: image() });
    const deps = makeDeps();
    deps.meta.write.mockImplementation(async (op: Op) => {
      if (op.kind === 'page_photo') return { id: '9001', postId: '111_9001' };
      throw new Error('(#9004) The media could not be fetched');
    });
    await publisher.tick(deps);
    expect(row(p.id)).toMatchObject({ status: 'failed', remote_ids: { facebook: '111_9001' } });
    expect(row(p.id).last_error).toMatch(/^Instagram: no se pudo publicar/);
    expect(getMonitorHealth().find(h => h.monitor === 'publisher')).toMatchObject({ status: 'degraded' });

    const retried = await socialPostsStore.retry(p.id, siteA, row(p.id).version, 'admin');
    expect(retried).toMatchObject({ status: 'approved', remoteIds: { facebook: '111_9001' } });
    const again = makeDeps();
    await publisher.tick(again);
    expect(ops(again)).toEqual(['ig_container', 'ig_publish']);
    expect(row(p.id)).toMatchObject({ status: 'published', remote_ids: { facebook: '111_9001', instagram: '8001' } });
  });

  it('crash right after the FB id is persisted → recovery marks needs_review and FB is never posted again', async () => {
    const p = await approved({ platforms: ['facebook', 'instagram'], imageUrl: image() });
    const crashing = {
      ...socialPostsStore,
      recordRemoteIds: async (...args: Parameters<typeof socialPostsStore.recordRemoteIds>) => {
        await socialPostsStore.recordRemoteIds(...args);
        throw new Error('process killed');
      },
      finishPublishing: async () => { throw new Error('process killed'); },
    };
    const deps = makeDeps({ store: crashing });
    await publisher.tick(deps);
    expect(ops(deps)).toEqual(['page_photo']);
    expect(row(p.id)).toMatchObject({ status: 'publishing', remote_ids: { facebook: '111_9001' } });

    const later = makeDeps();
    clock += 5 * MIN;
    expect(await publisher.recoverInterrupted(later)).toBe(0);
    clock += 6 * MIN;
    await publisher.tick(later);
    expect(later.meta.write).not.toHaveBeenCalled();
    expect(row(p.id)).toMatchObject({ status: 'needs_review', remote_ids: { facebook: '111_9001' } });
    expect(row(p.id).last_error).toBe('Interrumpido durante la publicación; verifica en Meta si se publicó antes de reintentar.');

    await socialPostsStore.resolve(p.id, siteA, row(p.id).version, 'not_published', 'admin');
    const resumed = makeDeps();
    await publisher.tick(resumed);
    expect(ops(resumed)).toEqual(['ig_container', 'ig_publish']);
    expect(row(p.id).status).toBe('published');
  });

  it('an unexpected error mid-publish marks the post needs_review right away when the DB still answers', async () => {
    const p = await approved();
    const deps = makeDeps({
      store: { ...socialPostsStore, recordRemoteIds: async () => { throw new Error('connection reset'); } },
    });
    await publisher.tick(deps);
    expect(row(p.id).status).toBe('needs_review');
  });

  it('startup recovery takes every publishing post, the periodic one only those older than 10 min', async () => {
    const fresh = await approved();
    Object.assign(row(fresh.id), { status: 'publishing', publishing_started_at: new Date(clock - 2 * MIN) });
    const deps = makeDeps();
    expect(await publisher.recoverInterrupted(deps)).toBe(0);
    expect(row(fresh.id).status).toBe('publishing');
    expect(await publisher.recoverInterrupted(deps, { all: true })).toBe(1);
    expect(row(fresh.id).status).toBe('needs_review');
    expect(m.append).toHaveBeenCalledWith(expect.objectContaining({
      siteId: siteA, input: expect.objectContaining({ postId: fresh.id, actor: 'publisher' }),
    }));
  });

  it('an uncertain Meta answer (network/5xx) → needs_review, never failed (no blind retry)', async () => {
    const p = await approved();
    const deps = makeDeps();
    deps.meta.write.mockRejectedValue(Object.assign(new Error('Meta: Network error: socket hang up'), { details: { uncertain: true } }));
    await publisher.tick(deps);
    expect(row(p.id).status).toBe('needs_review');
    expect(row(p.id).last_error).toMatch(/verifica en Meta/);
  });

  it('kill switch turned off before the first write → back to approved with version+1, nothing sent', async () => {
    const p = await approved();
    const enabled = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    const deps = makeDeps({ isEnabled: enabled });
    await publisher.tick(deps);
    expect(deps.meta.write).not.toHaveBeenCalled();
    expect(row(p.id)).toMatchObject({ status: 'approved', version: p.version + 2 });
  });

  it('kill switch turned off after FB was sent → failed keeping the FB id, IG never sent', async () => {
    const p = await approved({ platforms: ['facebook', 'instagram'], imageUrl: image() });
    let on = true;
    const deps = makeDeps({ isEnabled: () => on });
    deps.meta.write.mockImplementation(async () => { on = false; return { id: '9001', postId: '111_9001' }; });
    await publisher.tick(deps);
    expect(ops(deps)).toEqual(['page_photo']);
    expect(row(p.id)).toMatchObject({ status: 'failed', remote_ids: { facebook: '111_9001' } });
  });
});

describe('social publisher — queue', () => {
  it('pinned worker only claims its client and leaves other clients recovery and schedules untouched', async () => {
    const own = await approved();
    const other = await approved({ siteId: siteB });
    const interrupted = await approved({ siteId: siteB });
    Object.assign(row(interrupted.id), { status: 'publishing', publishing_started_at: new Date(clock - 11 * MIN) });
    const late = await approved({ siteId: siteB, scheduledAt: clock + 10 * MIN });
    row(late.id).scheduled_at = new Date(clock - 20 * MIN);
    vi.stubEnv('SANDI_ADS_SITE_ID', siteA);
    const deps = makeDeps();
    await publisher.tick(deps, { recoverAll: true });
    expect(row(own.id).status).toBe('published');
    expect(row(other.id).status).toBe('approved');
    expect(row(interrupted.id).status).toBe('publishing');
    expect(row(late.id).status).toBe('approved');
    expect(deps.meta.write).toHaveBeenCalledTimes(1);
  });

  it('honors the legacy pin and fails closed for an invalid pin', async () => {
    const p = await approved({ siteId: siteB });
    vi.stubEnv('SANDI_ADS_SITE_ID', '');
    vi.stubEnv('WEBSITE_OPS_SITE_ID', siteA);
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(row(p.id).status).toBe('approved');
    vi.stubEnv('SANDI_ADS_SITE_ID', 'invalid');
    await expect(publisher.tick(deps)).rejects.toThrow('cliente fijado');
    expect(deps.meta.write).not.toHaveBeenCalled();
  });

  it('a second worker cannot recover a live claim, even at startup or past the stale cutoff', async () => {
    const p = await approved();
    const first = makeDeps();
    const second = makeDeps();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    first.meta.pageToken.mockImplementation(async () => { entered(); await waiting; return PAGE_TOKEN; });
    const active = publisher.tick(first);
    await ready;
    clock += 11 * MIN;
    expect(await publisher.tick(second, { recoverAll: true })).toBe(false);
    expect(await publisher.recoverInterrupted(second, { all: true })).toBe(0);
    expect(row(p.id).status).toBe('publishing');
    expect(second.meta.write).not.toHaveBeenCalled();
    release();
    await active;
    expect(row(p.id).status).toBe('published');
    expect(first.meta.write).toHaveBeenCalledTimes(1);
  });

  it('lost claims cannot send or report a false published result', async () => {
    const p = await approved();
    const deps = makeDeps();
    deps.meta.pageToken.mockImplementation(async () => {
      Object.assign(row(p.id), { status: 'needs_review', version: row(p.id).version + 1 });
      return PAGE_TOKEN;
    });
    await publisher.tick(deps);
    expect(deps.meta.write).not.toHaveBeenCalled();
    expect(row(p.id).status).toBe('needs_review');
    expect(m.append.mock.calls.some(([e]) => e.resultSummary === 'status=published')).toBe(false);
  });

  it('rechecks the claim after the provider queue wait, before sending', async () => {
    const p = await approved();
    const deps = makeDeps();
    const actualSend = vi.fn();
    deps.meta.write.mockImplementation(async (_op, _token, beforeSend) => {
      Object.assign(row(p.id), { status: 'needs_review', version: row(p.id).version + 1 });
      await beforeSend();
      actualSend();
      return { id: '111_5' };
    });
    await publisher.tick(deps);
    expect(actualSend).not.toHaveBeenCalled();
    expect(row(p.id).status).toBe('needs_review');
  });

  it('Instagram poll deadline includes network time, not just sleep', async () => {
    const p = await approved({ platforms: ['instagram'], imageUrl: image() });
    const deps = makeDeps();
    deps.meta.igStatus.mockImplementation(async () => { clock += 21_000; return 'IN_PROGRESS'; });
    await publisher.tick(deps);
    expect(ops(deps)).toEqual(['ig_container']);
    expect(row(p.id).status).toBe('failed');
    expect(row(p.id).last_error).toContain('60 segundos');
    expect(deps.meta.igStatus).toHaveBeenCalledTimes(3);
    expect(deps.sleep.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBeLessThan(60_000);
  });

  it('approved posts due more than 15 min ago become late (even with the switch off); recent ones publish', async () => {
    const old = await approved({ scheduledAt: clock + 10 * MIN });
    const recent = await approved({ scheduledAt: clock + 10 * MIN });
    row(old.id).scheduled_at = new Date(clock - 20 * MIN);
    row(recent.id).scheduled_at = new Date(clock - 10 * MIN);
    expect(await publisher.markLate(makeDeps({ isEnabled: () => false }))).toBe(1);
    expect(row(old.id).status).toBe('late');
    expect(row(old.id).last_error).toMatch(/apagado/);
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(deps.meta.write).toHaveBeenCalledTimes(1);
    expect(row(recent.id).status).toBe('published');
    expect(row(old.id).status).toBe('late');
  });

  it('publishes at most 3 posts per tick and fetches each Page token once per tick', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await approved({ message: `p${i}` })).id);
    const deps = makeDeps();
    await publisher.tick(deps);
    expect(deps.meta.write).toHaveBeenCalledTimes(3);
    expect(deps.meta.pageToken).toHaveBeenCalledTimes(1);
    await publisher.tick(deps);
    expect(deps.meta.write).toHaveBeenCalledTimes(4);
    expect(deps.meta.pageToken).toHaveBeenCalledTimes(2);
    expect(ids.map(id => row(id).status)).toEqual(['published', 'published', 'published', 'published']);
  });

  it('claim is one guarded UPDATE with FOR UPDATE SKIP LOCKED', async () => {
    await approved();
    m.fake.statements.length = 0;
    const claimed = await publisher.claimNext(makeDeps());
    expect(claimed).toMatchObject({ status: 'publishing' });
    const sql = m.fake.statements.find(s => s.includes("SET status = 'publishing'"))!;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(await publisher.claimNext(makeDeps())).toBeNull();
  });

  it('audits every attempt and result with actor publisher, site, post, platform and remote id', async () => {
    const p = await approved();
    await publisher.tick(makeDeps());
    const inputs = m.append.mock.calls.map(c => c[0]).filter(e => e.input?.actor === 'publisher');
    expect(inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ siteId: siteA, input: expect.objectContaining({ postId: p.id, platform: 'facebook', phase: 'attempt' }) }),
      expect.objectContaining({ siteId: siteA, status: 'success', input: expect.objectContaining({ postId: p.id, platform: 'facebook', remoteId: '111_9002' }) }),
      expect.objectContaining({ siteId: siteA, input: expect.objectContaining({ postId: p.id, phase: 'result' }), resultSummary: 'status=published' }),
    ]));
  });

  it('tokens and the app secret never reach the DB, the audit trail, the logs or the health card', async () => {
    const p = await approved({ platforms: ['facebook', 'instagram'], imageUrl: image() });
    const deps = makeDeps();
    deps.meta.write.mockImplementation(async (op: Op) => {
      throw new Error(`boom ${op.kind} ${PAGE_TOKEN} ${USER_TOKEN} ${APP_SECRET}`);
    });
    await publisher.tick(deps);
    const crash = await approved();
    await publisher.tick(makeDeps({ store: { ...socialPostsStore, recordRemoteIds: async () => { throw new Error(`db ${PAGE_TOKEN}`); } } }));
    const everything = JSON.stringify([
      [...m.fake.rows.values()], m.append.mock.calls, Object.values(m.log).map(f => f.mock.calls), getMonitorHealth(),
    ]);
    expect(row(p.id).status).toBe('failed');
    expect(row(crash.id).status).toBe('needs_review');
    for (const secret of [PAGE_TOKEN, USER_TOKEN, APP_SECRET]) expect(everything).not.toContain(secret);
    expect(everything).toContain('[REDACTED]');
  });
});
