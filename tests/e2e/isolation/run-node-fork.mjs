import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRuntimeProfile, validateRuntimeEvidence, validateConsoleEvidence } from './sdk-runtime.mjs';
import { collect, bounded, cleanupOwnedRun } from './process-harness.mjs';

if (process.platform !== 'win32') throw new Error('Native Windows Node is required.');
const selection = process.argv[2];
assert(process.argv.length===3 && ['official','local-unpatched','local-patched'].includes(selection));
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..'), output = join(root, '.artifacts/tests/isolation');
const host = join(output, 'native/bin/host.exe');
const probe = selection==='official' ? join(root,'.local/toolchain/node-v24.22.2-win-x64/node.exe') : join(root,'.local/toolchain/node-comparison',selection,'node.exe');
const manifest = JSON.parse(await fs.readFile(join(root,'.artifacts/tests/t09c-node/runtimes.json'),'utf8'));
assert.equal(manifest.schema,1); const runtime = manifest.variants[selection]; validateRuntimeProfile(runtime);
assert.equal(runtime.kind,'node'); assert.equal(runtime.variant,selection);
const runRoot = join(output, 'node-fork-runs', randomUUID());
await fs.mkdir(runRoot, { recursive: true });
const hash = async path => createHash('sha256').update(await fs.readFile(path)).digest('hex');
const summary = { schema: 1, scope: 'synthetic-node-fork-only', runtime, cases: [], passed: false,
  hostSha256: await hash(host), probeSha256: await hash(probe),
  sourceSha256: await hash(join(directory, 'node-fork-probe.mjs')) };
assert.equal(summary.probeSha256,runtime.sha256);
async function runCase(mode) {
  const nonce=randomUUID().replaceAll('-',''),profile=`tahtiapuri.t09c.${nonce}`;
  const caseRoot = join(runRoot, mode), staged = join(caseRoot, 'staged');
  for (const name of ['package', 'private', 'scratch', 'launcher']) await fs.mkdir(join(staged, name), { recursive: true });
  await fs.writeFile(join(staged, 'owner.marker'), 'TAHTIAPURI_T09A_SYNTHETIC_ONLY', { flag: 'wx' });
  await fs.copyFile(probe, join(staged, 'package/node.exe'));
  await fs.copyFile(join(directory,'node-fork-probe.mjs'),join(staged,'package/sdk-probe.mjs'));
  await fs.copyFile(join(directory,'sdk-runtime.mjs'),join(staged,'package/sdk-runtime.mjs'));
  await fs.writeFile(join(staged,'package/sdk-profile.json'),JSON.stringify({nonce,runtime}));
  const caseHost = join(staged, 'launcher/host.exe'); await fs.copyFile(host, caseHost);
  for (const name of ['package/allowed.txt', 'package/weights.fixture', 'package/legacy.fixture', 'package/module.mjs', 'private/secret.txt'])
    await fs.writeFile(join(staged, name), 'SYNTHETIC PIPE DIAGNOSTIC\n');
  assert.equal(await hash(caseHost), summary.hostSha256);
  assert.equal(await hash(join(staged, 'package/node.exe')), summary.probeSha256);
  const child = spawn(caseHost, ['run-sdk-node', mode, profile, staged, '1', '1', '1', '1', '1', 'once'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const report = collect(child,{workerEnvelope:true}), result = { mode, records: report.records, passed: false };
  try {
    result.exit = await bounded(report.exited, 70000, 'Node fork diagnostic host timeout.'); report.checkComplete(); validateConsoleEvidence(report.records,runtime);
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
    validateRuntimeEvidence(report.records,runtime);
    const forks=report.records.filter(r=>r.type==='sdk-child'&&r.source==='worker');assert.equal(forks.length,1);
    assert.equal(forks[0].originalHelper,false);assert.equal(forks[0].syntheticFork,true);assert.notEqual(forks[0].pid,token.pid);
    const inspected=report.records.filter(r=>r.type==='inspected-child'&&r.source==='host');assert.equal(inspected.length,1);
    assert.equal(inspected[0].pid,forks[0].pid);assert.equal(inspected[0].job,true);assert.equal(inspected[0].imageVerified,true);
    assert.equal(inspected[0].appContainer,mode==='ac');assert.equal(inspected[0].capabilities,0);assert.equal(inspected[0].integrity,token.integrity);
    if(mode==='ac')assert.equal(inspected[0].sid,report.records.find(r=>r.type==='profile'&&r.source==='host')?.sid);
    const trip=report.records.filter(r=>r.type==='sdk-phase'&&r.phase==='fork-roundtrip');assert.equal(trip.length,1);
    assert.equal(trip[0].passed,true);assert.equal(trip[0].childPid,forks[0].pid);
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
  console.log(`${mode}: ${result.passed ? 'PASS (synthetic Node fork only)' : 'FAIL'}`);
  assert(result.passed, 'Unexpected Node fork, identity, or cleanup result; stopped.');
}
try { for (const mode of ['control', 'ac']) await runCase(mode); summary.passed = true; }
catch (error) { summary.error = error.stack; process.exitCode = 1; }
finally { await fs.writeFile(join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); }
