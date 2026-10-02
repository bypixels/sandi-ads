import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFakePostsPool } from '../helpers/social-posts-pool.js';

const m = vi.hoisted(() => ({
  fake: undefined as unknown as ReturnType<typeof import('../helpers/social-posts-pool.js').createFakePostsPool>,
  getSite: vi.fn(),
  append: vi.fn(),
}));
vi.mock('../../src/db/index.js', () => ({ getPool: () => m.fake.pool }));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: { get: m.getSite } }));
vi.mock('../../src/dashboard/services/audit-log.js', () => ({ auditLog: { append: m.append } }));

const { socialPostsStore, SocialPostValidationError, SocialPostConflictError } = await import('../../src/dashboard/services/social-posts-store.js');

const siteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bindings = { metaPageId: '111', metaIgUserId: '222' };
const draft = (over: Record<string, unknown> = {}) =>
  socialPostsStore.createDraft({ siteId: siteA, platforms: ['facebook'], message: 'Hola', createdBy: 'dashboard', ...over });

beforeEach(() => {
  m.fake = createFakePostsPool();
  m.getSite.mockReset().mockImplementation(async (id: string) => ({ id, bindings }));
  m.append.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://media.example.com');
});

const setStatus = (id: string, status: string) => { m.fake.rows.get(id)!.status = status; };

describe('socialPostsStore', () => {
  it('createDraft stores a draft and audits the actor', async () => {
    const p = await draft();
    expect(p).toMatchObject({ siteId: siteA, status: 'draft', platforms: ['facebook'], createdBy: 'dashboard', remoteIds: {} });
    expect(typeof p.createdAt).toBe('number');
    expect(m.append).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'social_post_create', siteId: siteA, status: 'success',
      input: expect.objectContaining({ postId: p.id, action: 'create', actor: 'dashboard' }),
    }));
  });
  it('createDraft refuses invalid input without inserting', async () => {
    await expect(draft({ platforms: ['instagram'] })).rejects.toBeInstanceOf(SocialPostValidationError);
    expect(m.fake.rows.size).toBe(0);
    expect(m.append).not.toHaveBeenCalled();
  });
  it('approve moves draft → approved atomically, records approver and audits', async () => {
    const p = await draft();
    const a = await socialPostsStore.approve(p.id, siteA, 'admin', p.version, 'ok');
    expect(a).toMatchObject({ status: 'approved', approvedBy: 'admin', decisionNote: 'ok' });
    expect(typeof a!.approvedAt).toBe('number');
    expect(m.append).toHaveBeenLastCalledWith(expect.objectContaining({
      tool: 'social_post_approve', siteId: siteA, input: expect.objectContaining({ postId: p.id, action: 'approve', actor: 'admin' }),
    }));
    expect(await socialPostsStore.approve(p.id, siteA, 'admin', p.version)).toBeNull();
  });
  it('approve with the wrong siteId returns null and leaves the draft untouched', async () => {
    const p = await draft();
    expect(await socialPostsStore.approve(p.id, siteB, 'admin', p.version)).toBeNull();
    expect(m.fake.rows.get(p.id)!.status).toBe('draft');
  });
  it.each(['rejected', 'cancelled', 'approved', 'published', 'late'])('approve refuses a post in status %s', async (status) => {
    const p = await draft();
    setStatus(p.id, status);
    expect(await socialPostsStore.approve(p.id, siteA, 'admin', p.version)).toBeNull();
    expect(m.fake.rows.get(p.id)!.status).toBe(status);
  });
  it('approve re-validates and refuses if the site lost its binding', async () => {
    const p = await draft();
    m.getSite.mockResolvedValue({ id: siteA, bindings: {} });
    await expect(socialPostsStore.approve(p.id, siteA, 'admin', p.version)).rejects.toBeInstanceOf(SocialPostValidationError);
    expect(m.fake.rows.get(p.id)!.status).toBe('draft');
  });
  it('approve allows a schedule that already passed (treated as due)', async () => {
    const p = await draft({ scheduledAt: Date.now() + 10 * 60_000 });
    m.fake.rows.get(p.id)!.scheduled_at = new Date(Date.now() - 60_000);
    expect(await socialPostsStore.approve(p.id, siteA, 'admin', p.version)).toMatchObject({ status: 'approved' });
  });
  it('reject only from draft and audits', async () => {
    const p = await draft();
    expect(await socialPostsStore.reject(p.id, siteA, 'admin', 'tono')).toMatchObject({ status: 'rejected', decisionNote: 'tono' });
    expect(m.append).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'social_post_reject', input: expect.objectContaining({ actor: 'admin' }) }));
    const q = await draft();
    setStatus(q.id, 'approved');
    expect(await socialPostsStore.reject(q.id, siteA, 'admin')).toBeNull();
  });
  it('cancel from draft, approved or late; never from published or with wrong site', async () => {
    for (const status of ['draft', 'approved', 'late']) {
      const p = await draft();
      setStatus(p.id, status);
      expect(await socialPostsStore.cancel(p.id, siteA, 'admin')).toMatchObject({ status: 'cancelled' });
    }
    expect(m.append).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'social_post_cancel', siteId: siteA }));
    const p = await draft();
    expect(await socialPostsStore.cancel(p.id, siteB, 'admin')).toBeNull();
    setStatus(p.id, 'published');
    expect(await socialPostsStore.cancel(p.id, siteA, 'admin')).toBeNull();
  });
  it('updateDraft only edits drafts of the same site and re-validates', async () => {
    const p = await draft();
    expect(await socialPostsStore.updateDraft(p.id, siteA, { message: 'Nuevo' }, 'admin')).toMatchObject({ message: 'Nuevo', platforms: ['facebook'] });
    expect(await socialPostsStore.updateDraft(p.id, siteB, { message: 'X' }, 'admin')).toBeNull();
    await expect(socialPostsStore.updateDraft(p.id, siteA, { platforms: ['instagram'] }, 'admin')).rejects.toBeInstanceOf(SocialPostValidationError);
    setStatus(p.id, 'approved');
    expect(await socialPostsStore.updateDraft(p.id, siteA, { message: 'Tarde' }, 'admin')).toBeNull();
  });
  it('list filters by site and status', async () => {
    const p = await draft();
    await draft({ siteId: siteB });
    setStatus(p.id, 'approved');
    expect(await socialPostsStore.list({ siteId: siteA })).toHaveLength(1);
    expect(await socialPostsStore.list({ status: ['draft'] })).toHaveLength(1);
    expect(await socialPostsStore.list({})).toHaveLength(2);
  });
  it.each(['approve', 'reject', 'cancel'] as const)('%s guards the UPDATE in SQL by site_id and allowed statuses (atomic)', async (action) => {
    const p = await draft();
    m.fake.statements.length = 0;
    const result = action === 'approve' ? await socialPostsStore.approve(p.id, siteA, 'admin', p.version) : await socialPostsStore[action](p.id, siteA, 'admin');
    expect(result).not.toBeNull();
    const update = m.fake.statements.find(sql => sql.trim().startsWith('UPDATE social_posts SET status'));
    expect(update).toBeDefined();
    expect(update).toContain('status = ANY(');
    expect(update).toContain('site_id =');
    if (action === 'approve') expect(update).toContain('version = $7');
  });
  it('updateDraft guards the UPDATE in SQL by site_id and draft status', async () => {
    const p = await draft();
    m.fake.statements.length = 0;
    await socialPostsStore.updateDraft(p.id, siteA, { message: 'Nuevo' }, 'admin');
    const update = m.fake.statements.find(sql => sql.trim().startsWith('UPDATE social_posts SET platforms'))!;
    expect(update).toContain('site_id =');
    expect(update).toContain("status = 'draft'");
    expect(update).toContain('version = version + 1');
  });
  it('new drafts start at version 1 and every edit bumps it', async () => {
    const p = await draft();
    expect(p.version).toBe(1);
    expect((await socialPostsStore.updateDraft(p.id, siteA, { message: 'B' }, 'admin'))!.version).toBe(2);
  });
  it('approve with a stale version conflicts and leaves the edited draft untouched', async () => {
    const p = await draft();
    await socialPostsStore.updateDraft(p.id, siteA, { message: 'B' }, 'admin');
    await expect(socialPostsStore.approve(p.id, siteA, 'admin', p.version)).rejects.toBeInstanceOf(SocialPostConflictError);
    expect(m.fake.rows.get(p.id)).toMatchObject({ status: 'draft', message: 'B' });
    expect(await socialPostsStore.approve(p.id, siteA, 'admin', p.version + 1)).toMatchObject({ status: 'approved', message: 'B', version: 3 });
  });
  it('approve loses the race when an edit lands between the read and the UPDATE', async () => {
    const p = await draft();
    // The validation lookup runs after approve read the row and before its UPDATE: edit the draft right there.
    m.getSite.mockImplementationOnce(async (id: string) => {
      await socialPostsStore.updateDraft(p.id, siteA, { message: 'B' }, 'admin');
      return { id, bindings };
    });
    await expect(socialPostsStore.approve(p.id, siteA, 'admin', p.version)).rejects.toBeInstanceOf(SocialPostConflictError);
    expect(m.fake.rows.get(p.id)).toMatchObject({ status: 'draft', message: 'B' });
  });
  it('approval audit carries a snapshot of the approved content', async () => {
    const message = 'M'.repeat(250);
    const scheduledAt = Date.now() + 10 * 60_000;
    const p = await draft({ message, scheduledAt });
    await socialPostsStore.approve(p.id, siteA, 'admin', p.version);
    expect(m.append).toHaveBeenLastCalledWith(expect.objectContaining({
      tool: 'social_post_approve',
      input: expect.objectContaining({
        snapshot: {
          platforms: ['facebook'],
          messageSha256: createHash('sha256').update(message).digest('hex'),
          messagePreview: 'M'.repeat(200),
          imageKey: null,
          scheduledAt: new Date(scheduledAt).toISOString(),
          version: p.version + 1,
        },
      }),
    }));
  });
  it('updateDraft emits an audit event', async () => {
    const p = await draft();
    m.append.mockClear();
    await socialPostsStore.updateDraft(p.id, siteA, { message: 'Nuevo' }, 'admin');
    expect(m.append).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'social_post_update', siteId: siteA, status: 'success',
      input: expect.objectContaining({ postId: p.id, action: 'update', actor: 'admin' }),
    }));
  });
  it('refuses duplicated platforms', async () => {
    await expect(draft({ platforms: ['facebook', 'facebook'] })).rejects.toBeInstanceOf(SocialPostValidationError);
    expect(m.fake.rows.size).toBe(0);
  });
});

describe('socialPostsStore — after the publisher', () => {
  const put = (id: string, fields: Record<string, unknown>) => Object.assign(m.fake.rows.get(id)!, fields);

  it('publishNow: late → approved without schedule, guarded by site, status and version; audited', async () => {
    const p = await draft({ scheduledAt: Date.now() + 10 * 60_000 });
    put(p.id, { status: 'late', version: 4, last_error: 'tarde' });
    expect(await socialPostsStore.publishNow(p.id, siteB, 4, 'admin')).toBeNull();
    await expect(socialPostsStore.publishNow(p.id, siteA, 3, 'admin')).rejects.toBeInstanceOf(SocialPostConflictError);
    const r = await socialPostsStore.publishNow(p.id, siteA, 4, 'admin');
    expect(r).toMatchObject({ status: 'approved', scheduledAt: null, version: 5, lastError: null });
    expect(m.append).toHaveBeenLastCalledWith(expect.objectContaining({
      tool: 'social_post_publish_now', siteId: siteA, input: expect.objectContaining({ postId: p.id, actor: 'admin' }),
    }));
    expect(await socialPostsStore.publishNow(p.id, siteA, 5, 'admin')).toBeNull();
  });

  it('retry: failed → approved keeping remote ids; refuses other statuses', async () => {
    const p = await draft();
    put(p.id, { status: 'failed', remote_ids: { facebook: '111_1' } });
    expect(await socialPostsStore.retry(p.id, siteA, p.version, 'admin')).toMatchObject({ status: 'approved', remoteIds: { facebook: '111_1' } });
    expect(m.append).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'social_post_retry' }));
    put(p.id, { status: 'published' });
    expect(await socialPostsStore.retry(p.id, siteA, p.version + 1, 'admin')).toBeNull();
  });

  it('resolve: needs_review → published (merging remote ids) or → approved', async () => {
    const p = await draft({ platforms: ['facebook'] });
    put(p.id, { status: 'needs_review', remote_ids: { facebook: '111_1' } });
    const done = await socialPostsStore.resolve(p.id, siteA, p.version, 'published', 'admin', { facebook: '111_2' });
    expect(done).toMatchObject({ status: 'published', remoteIds: { facebook: '111_2' } });
    expect(m.append).toHaveBeenLastCalledWith(expect.objectContaining({
      tool: 'social_post_resolve', input: expect.objectContaining({ outcome: 'published', actor: 'admin' }),
    }));
    const q = await draft({ scheduledAt: Date.now() + 10 * 60_000 });
    put(q.id, { status: 'needs_review' });
    expect(await socialPostsStore.resolve(q.id, siteA, q.version, 'not_published', 'admin')).toMatchObject({ status: 'approved', scheduledAt: null });
    expect(await socialPostsStore.resolve(q.id, siteA, q.version + 1, 'published', 'admin')).toBeNull();
  });

  it('resolve refuses remote ids for platforms the post does not have or with a bad shape', async () => {
    const p = await draft({ platforms: ['facebook'] });
    put(p.id, { status: 'needs_review' });
    await expect(socialPostsStore.resolve(p.id, siteA, p.version, 'published', 'admin', { instagram: '1' })).rejects.toBeInstanceOf(SocialPostValidationError);
    await expect(socialPostsStore.resolve(p.id, siteA, p.version, 'published', 'admin', { facebook: '1/../x' })).rejects.toBeInstanceOf(SocialPostValidationError);
    expect(m.fake.rows.get(p.id)!.status).toBe('needs_review');
  });

  it('human recovery UPDATEs are guarded in SQL by site_id, status and version', async () => {
    const p = await draft();
    put(p.id, { status: 'late' });
    m.fake.statements.length = 0;
    await socialPostsStore.publishNow(p.id, siteA, p.version, 'admin');
    const sql = m.fake.statements.find(s => s.trim().startsWith('UPDATE social_posts SET status = $4::text, scheduled_at'))!;
    expect(sql).toContain('site_id = $2');
    expect(sql).toContain('status = $3');
    expect(sql).toContain('version = $5');
  });
});

describe('socialPostsStore — publisher lease failures', () => {
  it('a lost session invalidates the lease, destroys the connection and frees the lock', async () => {
    const session = await m.fake.pool.connect();
    const release = vi.spyOn(session, 'release');
    const connect = vi.spyOn(m.fake.pool, 'connect').mockResolvedValueOnce(session);
    try {
      await socialPostsStore.withPublisherLock(async isHeld => {
        expect(await isHeld()).toBe(true);
        session.emit('error', new Error('connection lost'));
        expect(await isHeld()).toBe(false);
      });
      expect(release).toHaveBeenCalledWith(true);
      expect(await socialPostsStore.withPublisherLock(async () => {})).toBe(true);
    } finally { connect.mockRestore(); }
  });

  it('destroys a connection when the lock acknowledgement fails, even if the server acquired it', async () => {
    const session = await m.fake.pool.connect();
    const originalQuery = session.query.bind(session);
    vi.spyOn(session, 'query').mockImplementationOnce(async config => {
      await originalQuery(config);
      throw new Error('lock acknowledgement timed out');
    });
    const release = vi.spyOn(session, 'release');
    const connect = vi.spyOn(m.fake.pool, 'connect').mockResolvedValueOnce(session);
    const work = vi.fn(async () => {});
    try {
      await expect(socialPostsStore.withPublisherLock(work)).rejects.toThrow('acknowledgement');
      expect(work).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(true);
      expect(await socialPostsStore.withPublisherLock(async () => {})).toBe(true);
    } finally { connect.mockRestore(); }
  });
});
