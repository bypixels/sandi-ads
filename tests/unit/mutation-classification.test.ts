import { describe, expect, it } from 'vitest';
import { registerAllTools, toolRegistry } from '../../src/tools/index.js';
import {
  MUTATING_TOOLS, READ_ONLY_EXCEPTIONS, WRITE_VERB, categoryFor, getMutationsStatus, isMutatingTool,
} from '../../src/dashboard/services/mutations.js';

registerAllTools();
const names = [...toolRegistry.keys()];

describe('fail-closed mutation classification', () => {
  const KNOWN_WRITE_TOOLS = ['ads_create_campaign', 'gtm_publish_version', 'gtm_create_tag', 'cf_purge_cache', 'gsc_submit_sitemap', 'gbp_reply_review'];
  it.each(KNOWN_WRITE_TOOLS)('registered write tool %s is mutating', (n) => {
    expect(toolRegistry.has(n)).toBe(true);
    expect(isMutatingTool(n)).toBe(true);
  });
  it.each([...READ_ONLY_EXCEPTIONS])('exception %s is not mutating', (n) => {
    expect(isMutatingTool(n)).toBe(false);
  });
  it('write-verb tools outside the exceptions all classify as mutating', () => {
    const verbTools = names.filter(n => WRITE_VERB.test(n));
    for (const n of verbTools) expect(isMutatingTool(n)).toBe(!READ_ONLY_EXCEPTIONS.has(n));
  });
  it('explicit exceptions only name registered tools', () => {
    expect([...READ_ONLY_EXCEPTIONS].filter(n => !toolRegistry.has(n))).toEqual([]);
  });
  it('exceptions are never in the explicit mutating list', () => {
    expect([...READ_ONLY_EXCEPTIONS].filter(n => MUTATING_TOOLS.has(n))).toEqual([]);
  });
  it('a new meta write tool is mutating and categorized as meta', () => {
    expect(isMutatingTool('meta_create_campaign')).toBe(true);
    expect(categoryFor('meta_create_campaign')).toBe('meta');
    expect(getMutationsStatus().perService).toHaveProperty('meta');
  });
  it('read-only names stay read-only', () => {
    expect(isMutatingTool('gtm_list_tags')).toBe(false);
  });
});
