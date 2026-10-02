import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { registerAllTools, toolRegistry } from '../../src/tools/index.js';
import { isMutatingTool } from '../../src/dashboard/services/mutations.js';

/**
 * The Meta writer must stay unreachable from MCP tools and the agent: only the
 * dashboard publisher may use it, and only the dashboard entry point may start
 * the publisher.
 */
const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [relative(ROOT, full)] : [];
  });
}

const files = sourceFiles(join(ROOT, 'src'));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

describe('Meta write boundary', () => {
  it('only the client and the publisher mention the write helpers', () => {
    const users = files.filter(f => /\b(metaWrite|getPageAccessToken|MetaWriteOp)\b/.test(read(f))).sort();
    expect(users).toEqual(['src/dashboard/services/social-publisher.ts', 'src/tools/meta/client.ts']);
  });

  it('only the dashboard entry point imports the publisher', () => {
    const importers = files.filter(f => /(from|import\()\s*['"][^'"]*social-publisher(\.js)?['"]/.test(read(f))).sort();
    expect(importers).toEqual(['src/dashboard/index.ts']);
  });

  it('no file under src/tools re-exports the whole client', () => {
    const wildcard = files.filter(f => f.startsWith('src/tools/') && /export \*\s+from\s+['"][^'"]*meta\/client(\.js)?['"]/.test(read(f)));
    expect(wildcard).toEqual([]);
  });

  it('no registered MCP tool publishes to Meta', () => {
    registerAllTools();
    const metaWriters = [...toolRegistry.keys()].filter(n => n.startsWith('meta_') && isMutatingTool(n) && n !== 'meta_draft_post');
    expect(metaWriters).toEqual([]);
  });
});
