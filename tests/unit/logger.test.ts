import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it.each(['development', 'production'])('shows nested startup errors instead of {} in %s', async (environment) => {
  vi.stubEnv('NODE_ENV', environment);
  vi.resetModules();
  const { logger } = await import('../../src/utils/logger.js');
  const error = Object.assign(new Error('password authentication failed'), { code: '28P01' });
  const formatted = logger.format.transform({ level: 'error', [Symbol.for('level')]: 'error', message: 'Failed to start server', error }, logger.format.options);
  expect(formatted).not.toBe(false);
  const rendered = (formatted as Record<symbol, string>)[Symbol.for('message')];
  expect(rendered).toContain('password authentication failed');
  expect(rendered).toContain('28P01');
  expect(rendered).not.toContain('"error":{}');
  logger.close();
});
