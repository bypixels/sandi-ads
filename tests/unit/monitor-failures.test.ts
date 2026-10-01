import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Site } from '../../src/dashboard/services/sites-store.js';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), resolve: vi.fn(), upsert: vi.fn(), profile: vi.fn(), list: vi.fn() }));
vi.mock('../../src/dashboard/services/dashboard-data.js', () => ({ executeToolByName: mocks.execute }));
vi.mock('../../src/dashboard/services/gsc-signals.js', () => ({ signalsRepo: { resolveByTypes: mocks.resolve, upsertOpen: mocks.upsert } }));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: { list: mocks.list } }));
vi.mock('../../src/dashboard/services/site-profile.js', () => ({ siteProfileRepo: { get: mocks.profile } }));
import { runDiscussionMonitorForSite, startDiscussionMonitorScheduler, stopDiscussionMonitorScheduler } from '../../src/dashboard/services/discussion-monitor.js';
import { runSecurityMonitorForSite, startSecurityMonitorScheduler, stopSecurityMonitorScheduler } from '../../src/dashboard/services/security-monitor.js';
const site: Site = { id: 'site-a', name: 'Cliente A', primaryUrl: 'https://example.com', bindings: {}, createdAt: '', updatedAt: '' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue(1);
  mocks.upsert.mockResolvedValue(undefined);
  mocks.profile.mockResolvedValue({ niche: 'marketing', competitors: [{ name: 'HubSpot' }] });
  mocks.list.mockResolvedValue([]);
  vi.stubEnv('GOOGLE_SAFE_BROWSING_API_KEY', 'test-key');
});
afterEach(() => { stopDiscussionMonitorScheduler(); stopSecurityMonitorScheduler(); vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('monitor failure reconciliation', () => {
  it('preserves Reddit alerts after even one failed query while reconciling HN independently', async () => {
    mocks.execute.mockImplementation(async (name: string, input: { query: string }) => {
      if (name === 'hn_search_discussions') return { hits: [] };
      if (input.query === 'HubSpot') throw new Error('403');
      return { threads: [] };
    });
    const result = await runDiscussionMonitorForSite(site);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('403');
    expect(mocks.resolve).toHaveBeenCalledWith(site.id, ['hn_discussion_match'], []);
  });
  it('never resolves alerts when all discussion searches fail', async () => {
    mocks.execute.mockRejectedValue(new Error('network offline'));
    expect((await runDiscussionMonitorForSite(site)).ok).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('resolves both platforms after complete successful empty searches', async () => {
    mocks.execute.mockImplementation(async (name: string) => name === 'hn_search_discussions' ? { hits: [] } : { threads: [] });
    expect((await runDiscussionMonitorForSite(site)).ok).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledWith(site.id, ['reddit_thread_opportunity', 'hn_discussion_match'], []);
  });
  it('does not close missing-header or certificate alerts after DNS failure', async () => {
    mocks.execute.mockImplementation(async (name: string) => {
      if (name === 'security_safe_browsing') return { safe: true, matches: [] };
      throw new Error('ENOTFOUND');
    });
    const result = await runSecurityMonitorForSite(site);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(mocks.resolve).toHaveBeenCalledWith(site.id, ['safe_browsing_flag'], []);
  });
  it('does not close Safe Browsing alerts when its key is missing', async () => {
    vi.stubEnv('GOOGLE_SAFE_BROWSING_API_KEY', '');
    mocks.execute.mockImplementation(async (name: string) => name === 'security_headers_check' ? { missingHeaders: [] } : { daysUntilExpiry: 90 });
    const result = await runSecurityMonitorForSite(site);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('skipped');
    expect(mocks.resolve).toHaveBeenCalledWith(site.id, ['security_header_missing', 'ssl_expiring'], []);
    expect(mocks.execute).not.toHaveBeenCalledWith('security_safe_browsing', expect.anything());
  });
  it('treats malformed fulfilled detector responses as unknown', async () => {
    mocks.execute.mockResolvedValue({});
    expect((await runSecurityMonitorForSite(site)).ok).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('keeps detected alerts open during independent detector failures', async () => {
    mocks.execute.mockImplementation(async (name: string) => {
      if (name === 'monitor_certificate') return { daysUntilExpiry: 3 };
      throw new Error('timeout');
    });
    const result = await runSecurityMonitorForSite(site);
    expect(result.ok).toBe(false);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ signalType: 'ssl_expiring', severity: 'high' }));
    expect(mocks.resolve).toHaveBeenCalledWith(site.id, ['ssl_expiring'], ['ssl_expiring']);
  });
  it('reconciles every security detector after a complete successful scan', async () => {
    mocks.execute.mockImplementation(async (name: string) => {
      if (name === 'security_headers_check') return { missingHeaders: [] };
      if (name === 'monitor_certificate') return { daysUntilExpiry: 90 };
      return { safe: true, matches: [] };
    });
    expect((await runSecurityMonitorForSite(site)).ok).toBe(true);
    expect(mocks.resolve).toHaveBeenCalledWith(site.id, ['security_header_missing', 'ssl_expiring', 'safe_browsing_flag'], []);
  });
  it('does not overlap scheduled runs while a previous run is pending', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DISCUSSION_MONITOR_INITIAL_DELAY_MS', '1');
    vi.stubEnv('SECURITY_MONITOR_INITIAL_DELAY_MS', '1');
    vi.stubEnv('DISCUSSION_MONITOR_INTERVAL_MIN', '1');
    vi.stubEnv('SECURITY_MONITOR_INTERVAL_MIN', '1');
    let finish!: (sites: Site[]) => void;
    const pending = new Promise<Site[]>((resolve) => { finish = resolve; });
    mocks.list.mockReturnValue(pending);
    startDiscussionMonitorScheduler(); startSecurityMonitorScheduler();
    await vi.advanceTimersByTimeAsync(120001);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    finish([]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.list).toHaveBeenCalledTimes(4);
  });
  it('cancels both initial scheduler callbacks when stopped', async () => {
    vi.useFakeTimers();
    startDiscussionMonitorScheduler(); startSecurityMonitorScheduler();
    stopDiscussionMonitorScheduler(); stopSecurityMonitorScheduler();
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
