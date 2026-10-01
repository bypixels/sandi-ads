import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enums } from 'google-ads-api';

const provider = vi.hoisted(() => ({
  customer: vi.fn(), query: vi.fn(), budgetCreate: vi.fn(), budgetUpdate: vi.fn(),
  campaignCreate: vi.fn(), campaignUpdate: vi.fn(),
}));
vi.mock('../../src/tools/google/ads/client.js', () => ({
  getAdsClient: () => ({ Customer: provider.customer }),
  getRefreshToken: () => 'mock', getLoginCustomerId: () => undefined,
}));
import { adsCreateCampaignTool, adsCreateBudgetTool, adsUpdateCampaignTool } from '../../src/tools/google/ads/management.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ADS_MAX_DAILY_BUDGET_MICROS', '10000000');
  provider.customer.mockReturnValue({ query: provider.query,
    campaignBudgets: { create: provider.budgetCreate, update: provider.budgetUpdate },
    campaigns: { create: provider.campaignCreate, update: provider.campaignUpdate },
  });
  provider.budgetCreate.mockResolvedValue({ results: [{ resource_name: 'customers/123/campaignBudgets/456' }] });
  provider.campaignCreate.mockResolvedValue({ results: [{ resource_name: 'customers/123/campaigns/789' }] });
  provider.query.mockResolvedValue([{ campaign: { campaign_budget: 'customers/123/campaignBudgets/456' },
    campaign_budget: { amount_micros: 1000000, explicitly_shared: false, reference_count: 1 } }]);
});
afterEach(() => vi.unstubAllEnvs());
const create = (amount = 1000000, status?: 'PAUSED' | 'ENABLED') => ({ customerId: '123',
  campaign: { name: 'Test', advertisingChannelType: 'SEARCH' as const, budgetAmountMicros: amount, status } });
const update = (updates: { budgetAmountMicros?: number; status?: 'PAUSED' | 'ENABLED'; name?: string }) => ({ customerId: '123', campaignId: '789', updates });

describe('Ads financial safety at the provider boundary', () => {
  it.each([undefined, 'ENABLED', 'PAUSED'] as const)('always creates PAUSED, requested %s', async status => {
    await adsCreateCampaignTool.handler(create(1000000, status));
    expect(provider.campaignCreate.mock.calls[0][0][0].status).toBe(enums.CampaignStatus.PAUSED);
  });
  it.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 10000001])('rejects invalid or over-cap micros %s before effect', async amount => {
    await expect(adsCreateCampaignTool.handler(create(amount))).rejects.toThrow();
    await expect(adsUpdateCampaignTool.handler(update({ name: 'Changed', budgetAmountMicros: amount }))).rejects.toThrow();
    await expect(adsCreateBudgetTool.handler({ customerId: '123', budget: { name: 'Test', amountMicros: amount } })).rejects.toThrow();
    expect(provider.customer).not.toHaveBeenCalled();
  });
  it.each(['', '0', '-1', '1.5', 'NaN', '9007199254740992'])('fails closed on invalid cap %s', async cap => {
    vi.stubEnv('ADS_MAX_DAILY_BUDGET_MICROS', cap);
    await expect(adsCreateCampaignTool.handler(create())).rejects.toThrow('ADS_MAX_DAILY_BUDGET_MICROS');
    expect(provider.budgetCreate).not.toHaveBeenCalled();
  });
  it('requires separate activation and budget requests', async () => {
    await expect(adsUpdateCampaignTool.handler(update({ status: 'ENABLED', budgetAmountMicros: 1000000 }))).rejects.toThrow('separate');
    expect(provider.customer).not.toHaveBeenCalled();
  });
  it('blocks shared existing budget before even renaming', async () => {
    provider.query.mockResolvedValue([{ campaign: { campaign_budget: 'budget' }, campaign_budget: { explicitly_shared: true, reference_count: 2 } }]);
    await expect(adsUpdateCampaignTool.handler(update({ name: 'Changed', budgetAmountMicros: 1000000 }))).rejects.toThrow('shared');
    expect(provider.campaignUpdate).not.toHaveBeenCalled();
    expect(provider.budgetUpdate).not.toHaveBeenCalled();
  });
  it('rejects missing campaign budget', async () => {
    provider.query.mockResolvedValue([]);
    await expect(adsUpdateCampaignTool.handler(update({ budgetAmountMicros: 1000000 }))).rejects.toThrow('missing');
    expect(provider.budgetUpdate).not.toHaveBeenCalled();
  });
  it('checks current budget before enabling', async () => {
    provider.query.mockResolvedValue([{ campaign: { campaign_budget: 'budget' }, campaign_budget: { amount_micros: 10000001, explicitly_shared: false, reference_count: 1 } }]);
    await expect(adsUpdateCampaignTool.handler(update({ status: 'ENABLED' }))).rejects.toThrow('exceeds');
    expect(provider.campaignUpdate).not.toHaveBeenCalled();
  });
  it('permits non-shared budget update at configured cap', async () => {
    await adsUpdateCampaignTool.handler(update({ budgetAmountMicros: 10000000 }));
    expect(provider.budgetUpdate.mock.calls[0][0][0].amount_micros).toBe(10000000);
  });
  it('blocks standalone shared budget creation', async () => {
    await expect(adsCreateBudgetTool.handler({ customerId: '123', budget: { name: 'Shared', amountMicros: 1000000, explicitlyShared: true } })).rejects.toThrow('Shared');
    expect(provider.budgetCreate).not.toHaveBeenCalled();
  });
  it('rejects removed delivery method in schema', () => {
    expect(adsCreateCampaignTool.inputSchema.safeParse({ ...create(), campaign: { ...create().campaign, budgetDeliveryMethod: 'ACCELERATED' } }).success).toBe(false);
  });
});
