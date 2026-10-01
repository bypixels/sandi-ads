import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { getPool, closeDb } from '../../src/db/index.js';
import { approvalStorage } from '../../src/dashboard/services/approval-storage.js';

const enabled = process.env.RUN_DB_INTEGRATION === '1';
it.skipIf(!enabled)('PostgreSQL shares approvals across real processes, scopes decisions and consumes once', async () => {
  const target = new URL(process.env.DATABASE_URL || 'postgres://sandi_ads:sandi_ads_dev@localhost:5434/sandi_ads');
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.port !== '5434' || target.pathname !== '/sandi_ads') {
    throw new Error('Integration restricted to own local sandi_ads on port5434');
  }
  const siteA = randomUUID();
  const siteB = randomUUID();
  const pool = getPool();
  const gateUrl = pathToFileURL(resolve('src/dashboard/services/approval-gate.ts')).href;
  const dbUrl = pathToFileURL(resolve('src/db/index.ts')).href;
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  let errorOutput = '';
  try {
    await pool.query('INSERT INTO sites (id,name,primary_url) VALUES ($1,$2,$3),($4,$5,$6)',
      [siteA,'Approval integration A','https://example.invalid/', siteB,'Approval integration B','https://example.invalid/']);
    const source = `
      import { createApprovalGate } from ${JSON.stringify(gateUrl)};
      import { approvalStorage } from ${JSON.stringify(pathToFileURL(resolve('src/dashboard/services/approval-storage.ts')).href)};
      import { closeDb } from ${JSON.stringify(dbUrl)};
      const gate = createApprovalGate(approvalStorage, { pollMs: 20, timeoutMs: 6000 });
      const r = gate.request({ source: {kind:'mcp',siteId:${JSON.stringify(siteA)}}, action:{tool:'integration_no_provider',input:{synthetic:true}} });
      console.log(JSON.stringify({id:r.id}));
      console.log(JSON.stringify({decision:await r.decision}));
      await closeDb();
    `;
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore','pipe','pipe'] });
    child.stdout!.on('data', data => { output += data.toString(); });
    child.stderr!.on('data', data => { errorOutput += data.toString(); });
    const completion = new Promise<number | null>((done, reject) => {
      child!.on('error', reject);
      child!.on('exit', done);
    });
    await vi.waitFor(() => expect(output).toContain('"id"'), { timeout: 5000 });
    const id = JSON.parse(output.split('\n')[0]).id as string;
    await vi.waitFor(async () => expect((await approvalStorage.list()).some(e => e.id === id)).toBe(true), { timeout: 3000 });
    expect(await approvalStorage.decide(id, true, 'wrong client', siteB)).toBe(false);
    // Reviewer is another actual Node process, not an in-memory gate alias.
    const reviewerSource = `
      import { resolve } from ${JSON.stringify(gateUrl)};
      import { closeDb } from ${JSON.stringify(dbUrl)};
      console.log(JSON.stringify({approved:await resolve(${JSON.stringify(id)},true,'integration',${JSON.stringify(siteA)})}));
      await closeDb();
    `;
    const reviewer = spawn(process.execPath, ['--import','tsx','--input-type=module','-e',reviewerSource], { env:process.env });
    let reviewerOut = '';
    reviewer.stdout.on('data', data => { reviewerOut += data.toString(); });
    await new Promise<void>((done, reject) => { reviewer.on('error',reject); reviewer.on('exit', code => code === 0 ? done() : reject(new Error('reviewer failed'))); });
    expect(reviewerOut).toContain('"approved":true');
    expect(await completion).toBe(0);
    expect(errorOutput).not.toContain('Error');
    expect(output).toContain('"approve":true');
    expect(await approvalStorage.decide(id, true, undefined, siteA)).toBe(false);
    const row = await pool.query('SELECT status FROM pending_approvals WHERE id=$1',[id]);
    expect(row.rows[0].status).toBe('consumed');
    expect(await approvalStorage.consume(id, randomUUID())).toBeNull();
  } finally {
    child?.kill();
    await pool.query('DELETE FROM sites WHERE id=ANY($1::uuid[])',[[siteA,siteB]]);
    await closeDb();
  }
}, 15000);
