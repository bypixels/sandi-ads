import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/dashboard/services/sites-store.js', () => ({ sitesStore: store }));
import { assertMutationScope } from '../../src/dashboard/services/mutation-scope.js';
import { MUTATING_TOOLS } from '../../src/dashboard/services/mutations.js';
import type { Site } from '../../src/dashboard/services/sites-store.js';

const siteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherSiteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let site: Site;
beforeEach(() => {
  site = { id: siteId, name: 'Cliente A', primaryUrl: 'https://client-a.test/', createdAt: '', updatedAt: '', bindings: {
    adsCustomerId: '111-111-1111', gtmAccountId: '10', gtmContainerId: '20',
    gscSiteUrl: 'sc-domain:client-a.test', cloudflareZoneId: 'a'.repeat(32),
    gbpAccountId: 'accounts/30', gbpLocationName: 'accounts/30/locations/40',
  } };
  store.get.mockReset().mockImplementation(async (id: string) => id === siteId ? structuredClone(site) : undefined);
});
afterEach(() => vi.unstubAllEnvs());

const cases = [
  ...['ads_create_campaign', 'ads_update_campaign', 'ads_add_keywords', 'ads_create_budget']
    .map((name) => [name, { customerId: '1111111111' }, { customerId: '2222222222' }] as const),
  ...['gtm_create_tag', 'gtm_create_trigger', 'gtm_create_variable', 'gtm_create_version',
    'gtm_update_tag', 'gtm_update_trigger', 'gtm_update_variable', 'gtm_delete_tag',
    'gtm_delete_trigger', 'gtm_delete_variable', 'gtm_publish_version']
    .map((name) => [name, { accountId: '10', containerId: '20' }, { accountId: '10', containerId: '21' }] as const),
  ...['gsc_submit_sitemap', 'gsc_delete_sitemap', 'fix_resubmit_sitemap']
    .map((name) => [name, { siteUrl: 'sc-domain:client-a.test' }, { siteUrl: 'sc-domain:client-b.test' }] as const),
  ...['cf_create_dns_record', 'cf_purge_cache']
    .map((name) => [name, { zoneId: 'a'.repeat(32) }, { zoneId: 'b'.repeat(32) }] as const),
  ...['gbp_create_post', 'gbp_upload_media']
    .map((name) => [name, { parent: 'accounts/30/locations/40' }, { parent: 'accounts/30/locations/41' }] as const),
  ['gbp_update_location', { name: 'locations/40' }, { name: 'locations/41' }],
  ...['gbp_reply_review', 'gbp_delete_review_reply']
    .map((name) => [name, { name: 'accounts/30/locations/40/reviews/review-1' }, { name: 'accounts/31/locations/40/reviews/review-1' }] as const),
  ['indexing_publish', { url: 'https://client-a.test/page' }, { url: 'https://client-b.test/page' }],
  ['indexing_batch_publish', { notifications: [{ url: 'https://client-a.test/page' }] },
    { notifications: [{ url: 'https://client-a.test/page' }, { url: 'https://client-b.test/page' }] }],
  ['fix_submit_pages_to_index', { siteUrl: 'sc-domain:client-a.test', urls: ['https://client-a.test/page'] },
    { siteUrl: 'sc-domain:client-a.test', urls: ['https://client-b.test/page'] }],
] as const;

it.each(cases)('%s accepts client A and rejects client B', async (name, allowed, denied) => {
  await expect(assertMutationScope(name, allowed, siteId)).resolves.toBe(siteId);
  await expect(assertMutationScope(name, denied, siteId)).rejects.toMatchObject({ code: 'RESOURCE_ACCESS_DENIED' });
});
it('covers every registered mutation policy', () => {
  expect(new Set(cases.map(([name]) => name))).toEqual(MUTATING_TOOLS);
});
it('does not accept a requested site as authority when server scope is missing', async () => {
  await expect(assertMutationScope('ads_create_campaign', { customerId: '1111111111' }, undefined, siteId))
    .rejects.toMatchObject({ code: 'RESOURCE_ACCESS_DENIED' });
  expect(store.get).not.toHaveBeenCalled();
});
it('rejects missing sites, mismatched sessions, absent bindings and unavailable DB', async () => {
  await expect(assertMutationScope('ads_create_campaign', { customerId: '1111111111' }, otherSiteId)).rejects.toThrow();
  await expect(assertMutationScope('ads_create_campaign', { customerId: '1111111111' }, siteId, otherSiteId)).rejects.toThrow();
  site.bindings.adsCustomerId = undefined;
  await expect(assertMutationScope('ads_create_campaign', { customerId: '1111111111' }, siteId)).rejects.toThrow();
  store.get.mockRejectedValueOnce(new Error('DB offline'));
  await expect(assertMutationScope('ads_create_campaign', { customerId: '1111111111' }, siteId))
    .rejects.toMatchObject({ code: 'RESOURCE_ACCESS_DENIED' });
});
it.each([
  'https://client-a.test.evil.test/page', 'https://client-b.test@client-a.test/page',
  'https://client-a.test/other/%2f/page', 'http://client-a.test/page', 'https://sub.client-a.test/page',
])('rejects confusing or out-of-scope URL %s', async (url) => {
  await expect(assertMutationScope('indexing_publish', { url }, siteId)).rejects.toThrow();
});
it('bounds indexing to the configured primary URL path', async () => {
  site.primaryUrl = 'https://client-a.test/store/';
  await expect(assertMutationScope('indexing_publish', { url: 'https://client-a.test/store/page' }, siteId)).resolves.toBe(siteId);
  await expect(assertMutationScope('indexing_publish', { url: 'https://client-a.test/other/page' }, siteId)).rejects.toThrow();
  await expect(assertMutationScope('indexing_publish', { url: 'https://client-a.test/store/../other/page' }, siteId)).rejects.toThrow();
});
it('rejects injection-shaped resource IDs and discovery that cannot be prevalidated', async () => {
  await expect(assertMutationScope('ads_update_campaign', { customerId: '1111111111', campaignId: '1 OR 1=1' }, siteId)).rejects.toThrow();
  await expect(assertMutationScope('gtm_publish_version', { accountId: '10', containerId: '20', containerVersionId: '../21' }, siteId)).rejects.toThrow();
  await expect(assertMutationScope('fix_submit_pages_to_index', { siteUrl: 'sc-domain:client-a.test' }, siteId)).rejects.toThrow();
});
it('fails closed for mutations without a scope rule', async () => {
  await expect(assertMutationScope('future_mutation', {}, siteId)).rejects.toMatchObject({ code: 'RESOURCE_ACCESS_DENIED' });
});
