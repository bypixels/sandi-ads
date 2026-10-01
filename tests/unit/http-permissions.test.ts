import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
const mocks = vi.hoisted(() => ({ sites:vi.fn(), settings:vi.fn(), api:vi.fn(), agent:vi.fn(), oauth:vi.fn() }));
vi.mock('../../src/dashboard/routes/sites.js', () => ({handleSitesRoute:mocks.sites}));
vi.mock('../../src/dashboard/routes/settings.js', () => ({handleSettingsRoute:mocks.settings}));
vi.mock('../../src/dashboard/routes/api.js', () => ({handleApiRoute:mocks.api}));
vi.mock('../../src/dashboard/routes/agent.js', () => ({handleAgentRoute:mocks.agent}));
vi.mock('../../src/dashboard/routes/oauth.js', () => ({handleOAuthRoute:mocks.oauth}));
import { createDashboardServer } from '../../src/dashboard/http-server.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DASHBOARD_API_KEY','admin-secret');
  vi.stubEnv('DASHBOARD_REVIEWER_API_KEY','review-secret');
  vi.stubEnv('SANDI_ADS_SITE_ID','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  vi.stubEnv('DASHBOARD_AUTH_REQUIRED','true');
});
afterEach(() => vi.unstubAllEnvs());
async function request(method:string, url:string, token?:string) {
  let status:number|undefined;
  const res = { setHeader:vi.fn(), writeHead:vi.fn((code:number)=>{status=code;}), end:vi.fn() } as unknown as ServerResponse;
  const req = {method,url,headers:{host:'localhost:3737',...(token?{authorization:'Bearer '+token}:{})}} as IncomingMessage;
  const server = createDashboardServer();
  await (server.listeners('request')[0] as (req:IncomingMessage,res:ServerResponse)=>Promise<void>)(req,res);
  return status;
}
it.each([['PUT','/api/sites/id'],['POST','/api/settings/credentials'],['POST','/api/tool/ads_create_campaign'],['POST','/api/oauth/google/init']])('reviewer HTTP %s %s denied before route effects',async(method,path)=>{
  expect(await request(method,path,'review-secret')).toBe(403);
  for(const fn of Object.values(mocks)) expect(fn).not.toHaveBeenCalled();
});
it('admin dispatches settings; reviewer dispatches approvals; anonymous OAuth init denied',async()=>{
  mocks.settings.mockResolvedValue(true);
  mocks.agent.mockResolvedValue(true);
  await request('POST','/api/settings/credentials','admin-secret');
  expect(mocks.settings).toHaveBeenCalledTimes(1);
  await request('POST','/api/agent/approve','review-secret');
  expect(mocks.agent).toHaveBeenCalledTimes(1);
  expect(await request('POST','/api/oauth/google/init')).toBe(401);
  expect(mocks.oauth).not.toHaveBeenCalled();
});
it('identical configured admin and reviewer keys fail closed',async()=>{
  vi.stubEnv('DASHBOARD_REVIEWER_API_KEY','admin-secret');
  expect(await request('POST','/api/settings/credentials','admin-secret')).toBe(401);
  expect(mocks.settings).not.toHaveBeenCalled();
});
