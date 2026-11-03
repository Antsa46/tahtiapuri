import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareElectronFixture } from './electron-fixture.mjs';
import { collect, bounded, until, cleanupOwnedRun } from './process-harness.mjs';

if (process.platform !== 'win32') throw new Error('Native Windows Node is required.');
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const tools = JSON.parse(await fs.readFile(join(root, 'scripts/dev/toolchain.json'), 'utf8'));
const output = join(root, '.artifacts/tests/isolation');
const host = join(output, 'native/bin/host.exe');
const runRoot = join(output, 'electron-runs', randomUUID());
await fs.mkdir(runRoot, { recursive: true });
const template = join(runRoot, 'runtime-template');
const summary = { schema: 1, scope: 'electron-node-bootstrap-only', electron: tools.electron.version, archiveSha256: null, cases: [], passed: false, unrunCases: [] };

async function prepareTemplate() { const prepared = await prepareElectronFixture(root, template); summary.archiveSha256 = prepared.archiveSha256; }
function validateLaunch(records, mode) {
  const launch = records.find(row => row.type === 'launched'); assert(launch?.job && launch.aclsVerified);
  assert.equal(launch.requestedPolicy, mode); assert.equal(launch.sentinelInherited, false);
  assert.equal(launch.appContainer, mode !== 'control'); assert.equal(launch.capabilities, 0);
  if (mode !== 'control') assert.equal(launch.integrity, 4096);
  if (launch.lpac === null) assert.equal(launch.lpacQueryError, 87); else assert.equal(launch.lpac, mode === 'lpac');
  assert(!records.some(row => row.type === 'error'), 'Native launcher error.');
  return launch;
}
function validateRuntime(records, mode) {
  const launch = validateLaunch(records, mode);
  const runtime = records.find(row => row.type === 'runtime'); assert(runtime, 'The fixed JavaScript probe did not run.');
  assert.equal(runtime.pid, launch.pid); assert.equal(runtime.electron, tools.electron.version); assert.equal(runtime.arch, 'x64');
  assert.match(runtime.node, /^\d+\.\d+\.\d+/); assert.deepEqual(runtime.execArgv, ['--preserve-symlinks', '--preserve-symlinks-main']);
  for (const name of ['package-read', 'scratch-write', 'outside-read', 'outside-write', 'code-write']) {
    const operation = records.find(row => row.type === 'runtime-operation' && row.name === name); assert(operation, `Missing ${name}`);
    const allowed = ['package-read', 'scratch-write'].includes(name) || mode === 'control'; assert.equal(operation.ok, allowed, name);
    if (!allowed) assert(['EACCES', 'EPERM'].includes(operation.code), `${name} requires actual permission denial`);
  }
  return runtime;
}
async function runCase(mode, kind, attempt = 1) {
  const profile = `tahtiapuri.t09b.${randomUUID().replaceAll('-', '')}`;
  const caseRoot = join(runRoot, `${mode}-${kind}-${attempt}`); const staged = join(caseRoot, 'staged');
  for (const name of ['private', 'scratch', 'launcher']) await fs.mkdir(join(staged, name), { recursive: true });
  await fs.writeFile(join(staged, 'owner.marker'), 'TAHTIAPURI_T09A_SYNTHETIC_ONLY', { flag: 'wx' });
  await fs.cp(template, join(staged, 'package'), { recursive: true, dereference: false });
  await fs.copyFile(join(directory, 'runtime-probe.mjs'), join(staged, 'package/runtime-probe.mjs'));
  await fs.writeFile(join(staged, 'package/allowed.txt'), 'SYNTHETIC ALLOWED\n');
  await fs.writeFile(join(staged, 'package/module.mjs'), 'export const synthetic = true;\n');
  await fs.writeFile(join(staged, 'private/secret.txt'), 'SYNTHETIC PRIVATE\n');
  const caseHost = join(staged, 'launcher/host.exe'); await fs.copyFile(host, caseHost);
  const args = ['run-electron', mode, profile, staged, '1', '1', '1', '1', '1', kind === 'normal' ? 'once' : kind === 'js-error' ? 'fail' : 'hold'];
  const ownerCase = kind === 'owner-kill';
  const child = spawn(ownerCase ? process.execPath : caseHost, ownerCase ? [join(directory, 'owner.mjs'), caseHost, ...args] : args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const report = collect(child);
  const result = { mode, kind, attempt, profileIntent: profile, javascriptExecuted: false, observationsVerified: false, passed: false, records: report.records };
  try {
    if (ownerCase) {
      await until(() => { report.check(); return report.records.some(row => row.type === 'runtime-ready' || row.type === 'error' || row.type === 'finished'); }, 22000);
      validateRuntime(report.records, mode); assert(report.records.some(row => row.type === 'runtime-ready')); assert(child.kill(), 'Owner termination was not initiated.');
    }
    result.exit = await bounded(report.exited, 40000, 'Electron launcher timeout.'); report.checkComplete();
    result.runtime = validateRuntime(report.records, mode); result.javascriptExecuted = true;
    if (kind === 'normal') { assert.equal(result.exit.code, 0); assert(report.records.some(row => row.type === 'runtime-ready')); }
    if (kind === 'js-error') { assert.equal(result.exit.code, 1); assert(report.records.some(row => row.type === 'runtime-failure')); assert.equal(report.records.find(row => row.type === 'finished')?.exitCode, 1); }
    if (!ownerCase) assert.equal(report.records.find(row => row.type === 'finished')?.activeProcesses, 0);
    result.observationsVerified = true;
  } catch (error) {
    result.error = error.stack;
    if (kind === 'normal' && !report.records.some(row => row.type === 'runtime')) {
      try {
        report.checkComplete();
        validateLaunch(report.records, mode);
        const finished = report.records.find(row => row.type === 'finished');
        if (finished && finished.exitCode !== 0 && finished.activeProcesses === 0) {
          result.bootstrapFailure = { exitCode: finished.exitCode, javascriptExecuted: false };
        }
      } catch { /* A failed identity/permission check is never a compatibility verdict. */ }
    }
  }
  finally {
    result.javascriptExecuted = report.records.some(row => row.type === 'runtime');
    result.cleanup = await cleanupOwnedRun({ child, report, host, staged, profile, restricted: mode !== 'control' });
    result.stderr = report.stderr; result.passed = result.observationsVerified && result.cleanup.passed;
    await fs.writeFile(join(caseRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    summary.cases.push({ mode, kind, attempt, passed: result.passed, javascriptExecuted: result.javascriptExecuted, cleanupPassed: result.cleanup.passed, exit: result.exit, nativeErrors: report.records.filter(row => row.type === 'error'), bootstrapFailure: result.bootstrapFailure, error: result.error });
  }
  console.log(`${mode}/${kind}/${attempt}: ${result.passed ? 'PASS' : 'FAILED (preserved diagnostic result)'}`);
  assert(result.cleanup.passed, 'Cleanup failed; experiment stopped.');
  assert(result.passed || result.bootstrapFailure, 'Unexpected identity, permission, or runtime behavior; experiment stopped.');
  return result;
}
try {
  await prepareTemplate();
  const control = await runCase('control', 'normal'); assert(control.passed, 'Unconfined runtime control failed.');
  assert((await runCase('control', 'js-error')).passed);
  assert((await runCase('control', 'owner-kill')).passed);
  for (const mode of ['ac', 'lpac']) {
    const normal = await runCase(mode, 'normal');
    if (normal.passed) {
      assert((await runCase(mode, 'js-error')).passed); assert((await runCase(mode, 'owner-kill')).passed);
    } else {
      const repeated = await runCase(mode, 'normal', 2);
      assert.deepEqual(repeated.bootstrapFailure, normal.bootstrapFailure, 'Bootstrap behavior changed between independent staged runs.');
      summary.unrunCases.push(`${mode}/js-error`, `${mode}/owner-kill`);
    }
  }
  summary.passed = summary.cases.every(row => row.passed);
  if (!summary.passed) process.exitCode = 1;
} finally {
  try { await fs.rm(template, { recursive: true, force: true }); }
  catch (error) { summary.templateCleanupError = error.code; summary.passed = false; process.exitCode = 1; }
  await fs.writeFile(join(runRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
