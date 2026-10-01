import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  load: vi.fn(() => { throw new Error('credentials cannot be decrypted'); }),
  initialize: vi.fn(),
}));
vi.mock('../../src/licensing/index.js', () => ({ isPro: () => true }));
vi.mock('../../src/dashboard/index.js', () => ({ loadStoredCredentials: mocks.load }));
vi.mock('../../src/auth/index.js', () => ({ authManager: { initialize: mocks.initialize } }));
vi.mock('../../src/tools/index.js', () => ({ registerAllTools: vi.fn(), getAllTools: () => [], isToolProGated: () => false }));
import { createServer } from '../../src/server.js';

it('fails startup before auth when encrypted store cannot be read', async () => {
  await expect(createServer()).rejects.toThrow('cannot be decrypted');
  expect(mocks.initialize).not.toHaveBeenCalled();
});
