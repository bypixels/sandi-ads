import { afterEach, expect, it, vi } from 'vitest';
import { getAutoApproveList, isAutoApproved } from '../../src/dashboard/services/mutations.js';
afterEach(() => vi.unstubAllEnvs());
it('activation, budget updates and GTM publishing cannot bypass human approval via autoapply', () => {
  vi.stubEnv('MUTATIONS_ENABLED','true');
  vi.stubEnv('MUTATIONS_ADS','true');
  vi.stubEnv('MUTATIONS_GTM','true');
  vi.stubEnv('MUTATIONS_AUTOAPPLY','ads_update_campaign,gtm_publish_version,gsc_submit_sitemap');
  expect(getAutoApproveList()).toEqual(['gsc_submit_sitemap']);
  expect(isAutoApproved('ads_update_campaign')).toBe(false);
  expect(isAutoApproved('gtm_publish_version')).toBe(false);
});
