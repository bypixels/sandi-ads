import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getToken: vi.fn(), save: vi.fn(), get: vi.fn() }));
vi.mock('google-auth-library', () => ({ OAuth2Client: class {
  generateAuthUrl({state}: {state:string}) { return 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state; }
  getToken(code:string) { return mocks.getToken(code); }
} }));
vi.mock('axios', () => ({default:{get:mocks.get, post:vi.fn()}}));
vi.mock('../../src/dashboard/services/google-accounts-store.js', () => ({googleAccountsStore:{save:mocks.save}}));
import { buildAuthUrl, exchangeAndSave } from '../../src/dashboard/services/google-oauth-flow.js';
beforeEach(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID','test-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET','test-secret');
  vi.clearAllMocks();
  mocks.getToken.mockResolvedValue({tokens:{refresh_token:'synthetic-refresh',access_token:'synthetic-access',scope:'email'}});
  mocks.get.mockResolvedValue({data:{email:'synthetic@example.invalid'}});
  mocks.save.mockResolvedValue({id:'synthetic',email:'synthetic@example.invalid',name:null,pictureUrl:null});
});
afterEach(() => vi.unstubAllEnvs());
it('missing or wrong browser nonce is rejected before token exchange or persistence', async () => {
  const flow = buildAuthUrl();
  await expect(exchangeAndSave('code',flow.state)).rejects.toThrow('inválido');
  await expect(exchangeAndSave('code',flow.state,'another-browser')).rejects.toThrow('inválido');
  expect(mocks.getToken).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  await expect(exchangeAndSave('code',flow.state,flow.browserNonce)).resolves.toHaveProperty('account');
});
it('valid browser-bound state is one-use and expiration prevents exchange', async () => {
  const flow = buildAuthUrl();
  await exchangeAndSave('code',flow.state,flow.browserNonce);
  await expect(exchangeAndSave('code',flow.state,flow.browserNonce)).rejects.toThrow();
  expect(mocks.getToken).toHaveBeenCalledTimes(1);
  const expired = buildAuthUrl();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 301000);
  await expect(exchangeAndSave('code',expired.state,expired.browserNonce)).rejects.toThrow();
  clock.mockRestore();
  expect(mocks.getToken).toHaveBeenCalledTimes(1);
});
