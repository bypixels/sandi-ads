import { beforeEach, describe, expect, it, vi } from 'vitest';
const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({ createServiceLogger: () => logs }));
const mocks = vi.hoisted(() => ({ execute: vi.fn(), resolve: vi.fn(), upsert: vi.fn(), profile: vi.fn() }));
vi.mock('../../src/dashboard/services/dashboard-data.js', () => ({ executeToolByName: mocks.execute }));
vi.mock('../../src/dashboard/services/gsc-signals.js', () => ({ signalsRepo: { resolveByTypes: mocks.resolve, upsertOpen: mocks.upsert } }));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: { list: vi.fn() } }));
vi.mock('../../src/dashboard/services/site-profile.js', () => ({ siteProfileRepo: { get: mocks.profile } }));
import { recordFailure, recordSuccess, isPaused, getMonitorHealth, _resetForTests } from '../../src/dashboard/services/monitor-health.js';
import { runDiscussionMonitorForSite } from '../../src/dashboard/services/discussion-monitor.js';

const HOUR = 3600_000;
beforeEach(() => { vi.clearAllMocks(); _resetForTests(); });

describe('monitor circuit breaker', () => {
  it('pauses after 3 consecutive failures', () => {
    recordFailure('discussion', 'reddit', new Error('403'));
    recordFailure('discussion', 'reddit', new Error('403'));
    expect(isPaused('discussion', 'reddit')).toBe(false);
    expect(getMonitorHealth()[0].status).toBe('degraded');
    recordFailure('discussion', 'reddit', new Error('403'));
    expect(isPaused('discussion', 'reddit')).toBe(true);
    expect(getMonitorHealth()[0]).toMatchObject({ status: 'paused', consecutiveFailures: 3 });
  });
  it('success resets the failure streak', () => {
    recordFailure('discussion', 'reddit', 'x');
    recordFailure('discussion', 'reddit', 'x');
    recordSuccess('discussion', 'reddit');
    recordFailure('discussion', 'reddit', 'x');
    expect(isPaused('discussion', 'reddit')).toBe(false);
    expect(getMonitorHealth()[0]).toMatchObject({ status: 'degraded', consecutiveFailures: 1 });
    recordSuccess('discussion', 'reddit');
    expect(getMonitorHealth()[0]).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });
  it('cooldown expiry unpauses', () => {
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) recordFailure('discussion', 'hn', 'x');
    expect(isPaused('discussion', 'hn', t0 + 23 * HOUR)).toBe(true);
    expect(isPaused('discussion', 'hn', t0 + 25 * HOUR)).toBe(false);
    expect(logs.info).toHaveBeenCalledTimes(1);
  });
  it('logs a single warn however many failures follow', () => {
    for (let i = 0; i < 10; i++) recordFailure('discussion', 'reddit', 'x');
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });
  it('non-pausable failures stay degraded, never pause, and warn once', () => {
    for (let i = 0; i < 5; i++) recordFailure('security', 'security-monitor', 'x', { pausable: false });
    const h = getMonitorHealth()[0];
    expect(h.status).toBe('degraded');
    expect(h.pausedUntil).toBeUndefined();
    expect(h.consecutiveFailures).toBe(5);
    expect(isPaused('security', 'security-monitor')).toBe(false);
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });
  it('truncates errors to 200 chars and strips query strings', () => {
    recordFailure('m', 'p', new Error('GET https://x.test/a?token=SECRET failed ' + 'y'.repeat(400)));
    const e = getMonitorHealth()[0].lastError as string;
    expect(e.length).toBeLessThanOrEqual(200);
    expect(e).not.toContain('SECRET');
  });
});

describe('discussion-monitor circuit breaker', () => {
  const site = { id: 's', name: 'S', primaryUrl: 'https://e.com', bindings: {}, createdAt: '', updatedAt: '' };
  beforeEach(() => {
    mocks.resolve.mockResolvedValue(0);
    mocks.upsert.mockResolvedValue(undefined);
    mocks.profile.mockResolvedValue({ niche: 'marketing', competitors: [{ name: 'HubSpot' }] });
  });
  it('skips a paused provider and keeps querying the healthy one', async () => {
    for (let i = 0; i < 3; i++) recordFailure('discussion', 'reddit', 'x');
    mocks.execute.mockImplementation(async (name: string) => name === 'hn_search_discussions' ? { hits: [] } : { threads: [] });
    await runDiscussionMonitorForSite(site);
    expect(mocks.execute.mock.calls.filter((c) => c[0] === 'reddit_search_threads')).toHaveLength(0);
    expect(mocks.execute.mock.calls.filter((c) => c[0] === 'hn_search_discussions').length).toBeGreaterThan(0);
    expect(mocks.resolve).toHaveBeenCalledWith('s', ['hn_discussion_match'], []);
  });
  it('opens the breaker from repeated Reddit 403s with a single warn', async () => {
    mocks.execute.mockImplementation(async (name: string) => { if (name === 'hn_search_discussions') return { hits: [] }; throw new Error('403'); });
    await runDiscussionMonitorForSite(site);
    await runDiscussionMonitorForSite(site);
    expect(isPaused('discussion', 'reddit')).toBe(true);
    expect(logs.warn).toHaveBeenCalledTimes(1);
  });
});
