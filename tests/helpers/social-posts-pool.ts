import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * In-memory stand-in for the pg pool used by social-posts-store. It interprets
 * only the statements the store issues, honoring the WHERE guards (id,
 * site_id, allowed statuses, optimistic version) so transition tests exercise real semantics.
 */
export interface FakePostRow {
  id: string; site_id: string; platforms: string[]; message: string;
  image_url: string | null; image_key: string | null; scheduled_at: Date | null;
  status: string; created_by: string; approved_by: string | null; approved_at: Date | null;
  decision_note: string | null; remote_ids: Record<string, string>; last_error: string | null;
  version: number; publishing_started_at: Date | null; created_at: Date; updated_at: Date;
}

const toDate = (ms: unknown) => (ms == null ? null : new Date(Number(ms)));

export function createFakePostsPool() {
  const rows = new Map<string, FakePostRow>();
  const statements: string[] = [];
  const clone = (r: FakePostRow) => structuredClone(r);
  let lockOwner: object | null = null;

  async function query(sql: string, params: unknown[] = []) {
    statements.push(sql);
    const s = sql.trim();
    if (s.startsWith('INSERT INTO social_posts')) {
      const [siteId, platforms, message, imageUrl, imageKey, scheduledAt, createdBy] = params;
      const now = new Date();
      const row: FakePostRow = {
        id: randomUUID(), site_id: String(siteId), platforms: platforms as string[], message: String(message),
        image_url: (imageUrl as string | null) ?? null, image_key: (imageKey as string | null) ?? null,
        scheduled_at: toDate(scheduledAt), status: 'draft', created_by: String(createdBy),
        approved_by: null, approved_at: null, decision_note: null, remote_ids: {}, last_error: null,
        version: 1, publishing_started_at: null, created_at: now, updated_at: now,
      };
      rows.set(row.id, row);
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (s.startsWith("UPDATE social_posts SET status = 'publishing'")) {
      // claimNext: the subquery guard and the outer guard are honored only when present in the SQL,
      // so a statement that drops them is caught by the tests instead of being silently "fixed" here.
      const now = Number(params[0]);
      const innerGuard = /FROM social_posts WHERE status = 'approved'/.test(s);
      const outerGuard = /WHERE status = 'approved' AND id =/.test(s);
      const siteId = s.includes('site_id = $2') ? params[1] : null;
      const order = (r: FakePostRow) => (r.scheduled_at ?? r.approved_at ?? r.created_at).getTime();
      const pick = [...rows.values()]
        .filter(r => (!innerGuard || r.status === 'approved') && (siteId == null || r.site_id === siteId)
          && (r.scheduled_at == null || r.scheduled_at.getTime() <= now))
        .sort((a, b) => order(a) - order(b) || a.created_at.getTime() - b.created_at.getTime())[0];
      if (!pick || (outerGuard && pick.status !== 'approved')) return { rows: [], rowCount: 0 };
      Object.assign(pick, { status: 'publishing', publishing_started_at: new Date(now), version: pick.version + 1, updated_at: new Date() });
      return { rows: [clone(pick)], rowCount: 1 };
    }
    if (s.startsWith("UPDATE social_posts SET status = 'needs_review'")) {
      const [lastError, cutoff] = params as [string, number | null];
      const siteId = s.includes('site_id = $3') ? params[2] : null;
      const hit = [...rows.values()].filter(r => r.status === 'publishing'
        && (siteId == null || r.site_id === siteId)
        && (cutoff == null || r.publishing_started_at == null || r.publishing_started_at.getTime() < Number(cutoff)));
      for (const r of hit) Object.assign(r, { status: 'needs_review', last_error: lastError, version: r.version + 1, updated_at: new Date() });
      return { rows: hit.map(clone), rowCount: hit.length };
    }
    if (s.startsWith("UPDATE social_posts SET status = 'late'")) {
      const [lastError, cutoff] = params as [string, number];
      const siteId = s.includes('site_id = $3') ? params[2] : null;
      const hit = [...rows.values()].filter(r => r.status === 'approved' && (siteId == null || r.site_id === siteId)
        && r.scheduled_at != null && r.scheduled_at.getTime() < Number(cutoff));
      for (const r of hit) Object.assign(r, { status: 'late', last_error: lastError, version: r.version + 1, updated_at: new Date() });
      return { rows: hit.map(clone), rowCount: hit.length };
    }
    if (s.startsWith('UPDATE social_posts SET remote_ids')) {
      const [id, siteId, version, patch] = params as [string, string, number, string];
      const row = rows.get(id);
      if (!row || row.site_id !== siteId || row.status !== 'publishing' || row.version !== version) return { rows: [], rowCount: 0 };
      Object.assign(row, { remote_ids: { ...row.remote_ids, ...JSON.parse(patch) }, updated_at: new Date() });
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (s.startsWith('UPDATE social_posts SET status = $4::text, last_error')) {
      const [id, siteId, version, to, lastError] = params as [string, string, number, string, string | null];
      const row = rows.get(id);
      if (!row || row.site_id !== siteId || row.status !== 'publishing' || row.version !== version) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: to, last_error: lastError, version: row.version + 1, updated_at: new Date() });
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (s.startsWith('UPDATE social_posts SET status = $4::text, scheduled_at')) {
      const [id, siteId, from, to, version, patch] = params as [string, string, string, string, number, string];
      const row = rows.get(id);
      if (!row || row.site_id !== siteId || row.status !== from || row.version !== version) return { rows: [], rowCount: 0 };
      Object.assign(row, {
        status: to, scheduled_at: to === 'approved' ? null : row.scheduled_at, remote_ids: { ...row.remote_ids, ...JSON.parse(patch) },
        last_error: null, version: row.version + 1, updated_at: new Date(),
      });
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (s.startsWith('UPDATE social_posts SET status')) {
      const [id, siteId, to, from, approvedBy, note, expectedVersion] = params as [string, string, string, string[], string | null, string | null, number | null];
      const row = rows.get(id);
      if (!row || row.site_id !== siteId || !from.includes(row.status)) return { rows: [], rowCount: 0 };
      if (expectedVersion != null && row.version !== expectedVersion) return { rows: [], rowCount: 0 };
      row.version += 1;
      row.status = to;
      if (approvedBy != null) row.approved_by = approvedBy;
      if (to === 'approved') row.approved_at = new Date();
      row.decision_note = note;
      row.updated_at = new Date();
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (s.startsWith('UPDATE social_posts SET platforms')) {
      const [id, siteId, platforms, message, imageUrl, imageKey, scheduledAt] = params;
      const row = rows.get(String(id));
      if (!row || row.site_id !== siteId || row.status !== 'draft') return { rows: [], rowCount: 0 };
      Object.assign(row, {
        platforms, message, image_url: imageUrl ?? null, image_key: imageKey ?? null,
        scheduled_at: toDate(scheduledAt), version: row.version + 1, updated_at: new Date(),
      });
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM social_posts WHERE id = $1')) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('SELECT * FROM social_posts')) {
      const [siteId, statuses] = params as [string | null, string[] | null];
      const out = [...rows.values()]
        .filter(r => (siteId == null || r.site_id === siteId) && (statuses == null || statuses.includes(r.status)))
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map(clone);
      return { rows: out, rowCount: out.length };
    }
    throw new Error(`Fake pool: unexpected SQL ${s.slice(0, 60)}`);
  }

  async function connect() {
    const session = new EventEmitter();
    return Object.assign(session, {
      query: async (config: { text: string }) => {
        const sql = config.text;
        statements.push(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          const acquired = lockOwner === null;
          if (acquired) lockOwner = session;
          return { rows: [{ acquired }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          if (lockOwner === session) lockOwner = null;
          return { rows: [] };
        }
        if (sql === 'SELECT 1') return { rows: [{ ok: 1 }] };
        throw new Error(`Unexpected session query: ${sql}`);
      },
      release: () => { if (lockOwner === session) lockOwner = null; },
    });
  }
  return { rows, statements, pool: { query, connect } };
}
