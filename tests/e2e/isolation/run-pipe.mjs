import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, bounded, cleanupOwnedRun } from './process-harness.mjs';

if (process.platform !== 'win32') throw new Error('Native Windows Node is required.');
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..'), output = join(root, '.artifacts/tests/isolation');
const host = join(output, 'native/bin/host.exe'), probe = join(output, 'native/bin/pipe-probe.exe');
const runRoot = join(output, 'pipe-runs', randomUUID());
await fs.mkdir(runRoot, { recursive: true });
const hash = async path => createHash('sha256').update(await fs.readFile(path)).digest('hex');
const summary = { schema: 1, scope: 'win32-pipe-namespace-only', cases: [], passed: false,
  hostSha256: await hash(host), probeSha256: await hash(probe),
  sourceSha256: await hash(join(directory, 'native/pipe-probe.cpp')) };
async function runCase(mode) {
  const profile = `tahtiapuri.t09a.${randomUUID().replaceAll('-', '')}`;
  const caseRoot = join(runRoot, mode), staged = join(caseRoot, 'staged');
  for (const name of ['package', 'private', 'scratch', 'launcher']) await fs.mkdir(join(staged, name), { recursive: true });
  await fs.writeFile(join(staged, 'owner.marker'), 'TAHTIAPURI_T09A_SYNTHETIC_ONLY', { flag: 'wx' });
  await fs.copyFile(probe, join(staged, 'package/probe.exe'));
  const caseHost = join(staged, 'launcher/host.exe'); await fs.copyFile(host, caseHost);
  for (const name of ['package/allowed.txt', 'package/weights.fixture', 'package/legacy.fixture', 'package/module.mjs', 'private/secret.txt'])
    await fs.writeFile(join(staged, name), 'SYNTHETIC PIPE DIAGNOSTIC\n');
  assert.equal(await hash(caseHost), summary.hostSha256);
  assert.equal(await hash(join(staged, 'package/probe.exe')), summary.probeSha256);
  const child = spawn(caseHost, ['run', mode, profile, staged, '1', '1', '1', '1', '1', 'once'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const report = collect(child), result = { mode, records: report.records, passed: false };
  try {
    result.exit = await bounded(report.exited, 35000, 'Pipe diagnostic host timeout.'); report.checkComplete();
    assert.equal(result.exit.code, 0);
    assert(!report.records.some(r => ['error', 'probe-error'].includes(r.type)));
    const launches = report.records.filter(r => r.type === 'launched'); assert.equal(launches.length, 1);
    const token = launches[0];
    assert.equal(token.requestedPolicy, mode); assert.equal(token.job, true); assert.equal(token.aclsVerified, true);
    assert.equal(token.sentinelInherited, false); assert.equal(token.appContainer, mode === 'ac');
    assert.equal(token.capabilities, 0);
    if (mode === 'ac') {
      assert.equal(token.integrity, 4096);
      assert.equal(report.records.filter(r => r.type === 'profile').length, 1);
      assert.equal(report.records.find(r => r.type === 'cleanup')?.hresult, 0);
      if (token.lpac === null) assert.equal(token.lpacQueryError, 87); else assert.equal(token.lpac, false);
    }
    const pipes = report.records.filter(r => r.type === 'pipe-result'); assert.equal(pipes.length, 2);
    assert.deepEqual(pipes.map(r => r.namespace), ['ordinary', 'local']);
    for (const pipe of pipes) {
      const denied = mode === 'ac' && pipe.namespace === 'ordinary';
      assert.equal(pipe.attempts, 1); assert.equal(pipe.stage, denied ? 'create' : 'complete');
      assert.equal(pipe.code, denied ? 5 : 0); assert.equal(pipe.roundTrip, !denied);
    }
    const finished = report.records.filter(r => r.type === 'finished'); assert.equal(finished.length, 1);
    assert.equal(finished[0].exitCode, 0); assert.equal(finished[0].activeProcesses, 0); assert.equal(finished[0].ownerGone, false);
    result.observationsVerified = true;
  } catch (error) { result.error = error.stack; }
  finally {
    result.cleanup = await cleanupOwnedRun({ child, report, host, staged, profile, restricted: mode === 'ac' });
    result.stderr = report.stderr; result.passed = result.observationsVerified === true && result.cleanup.passed;
    await fs.writeFile(join(caseRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    summary.cases.push({ mode, passed: result.passed, cleanupPassed: result.cleanup.passed, error: result.error });
  }
  console.log(`${mode}: ${result.passed ? 'PASS (namespace diagnostic only)' : 'FAIL'}`);
  assert(result.passed, 'Unexpected namespace, identity, or cleanup result; stopped.');
}
try { for (const mode of ['control', 'ac']) await runCase(mode); summary.passed = true; }
catch (error) { summary.error = error.stack; process.exitCode = 1; }
finally { await fs.writeFile(join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); }
