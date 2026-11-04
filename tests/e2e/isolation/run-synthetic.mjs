import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readObservationReceipt } from './wfp-observation.mjs';
import { readEtwReceipt, readEtwEvidence } from './etw-observation.mjs';
import { finalizeEtwRun } from './etw-finalization.mjs';
import { validateNativeCase } from './native-case-validation.mjs';
import { collect, bounded, until, alive, cleanupOwnedRun } from './process-harness.mjs';

const observeEtw = process.argv[2] === 'observe-etw';
const etwKind = process.argv[3] ?? 'normal';
if (!['normal', 'error', 'launcher-kill', 'owner-kill'].includes(etwKind)) throw new Error('Unsupported ETW lifecycle.');
const observeNetwork = observeEtw || process.argv[2] === 'observe-network';
const validate = (...args) => validateNativeCase(...args, observeNetwork);
const observationDirectory = observeEtw ? 'etw' : 'wfp';
const stopRequest = observeEtw ? 'stop-etw.request' : 'stop-wfp.request';
if (process.argv.length > (observeEtw ? 4 : observeNetwork ? 3 : 2) || (!observeNetwork && process.argv.length !== 2)) throw new Error('Unsupported probe arguments.');
if (process.platform !== 'win32') throw new Error('This probe must run with native Windows Node.');
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const output = join(root, '.artifacts/tests/isolation');
const host = join(output, 'native/bin/host.exe');
const probe = join(output, 'native/bin/probe.exe');
const runRoot = join(output, 'runs', randomUUID());
await fs.mkdir(runRoot, { recursive: true });
const summary = { schema: 2, scope: observeNetwork ? (observeEtw ? 'synthetic-native-bound-loopback-etw' : 'synthetic-native-bound-loopback-observation') : 'synthetic-native-loopback-only', cases: [], passed: false, corePassed: false, originalMatrixRun: !observeNetwork, unrunOriginalCases: observeNetwork ? ['original-matrix-not-run'] : ['lpac/error', 'lpac/launcher-kill', 'lpac/owner-kill'] };

let sharedServers;
const completedCases = [];

async function endpoints() {
  const resources = [];
  const counts = { tcp4: 0, tcp6: 0, udp4: 0, udp6: 0 };
  const ports = []; const accepted = { tcp4: 0, tcp6: 0 };
  try {
    for (const [name, address] of [['tcp4', '127.0.0.1'], ['tcp6', '::1']]) {
      const sockets = new Set();
      const server = createServer(socket => {
        accepted[name]++; let payload = Buffer.alloc(0);
        sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
        socket.on('data', data => { payload = Buffer.concat([payload, data]); if (payload.length >= 4) { counts[name]++; socket.end(payload); } });
      });
      resources.push(() => new Promise(done => { for (const socket of sockets) socket.destroy(); server.close(done); }));
      await new Promise((done, fail) => { server.once('error', fail); server.listen({ host: address, port: 0, ipv6Only: true }, done); });
      ports.push(server.address().port);
    }
    for (const [name, address] of [['udp4', '127.0.0.1'], ['udp6', '::1']]) {
      const socket = createSocket(name);
      resources.push(() => new Promise(done => socket.close(done)));
      socket.on('message', (message, remote) => { counts[name]++; socket.send(message, remote.port, remote.address); });
      await new Promise((done, fail) => { socket.once('error', fail); socket.bind(0, address, done); });
      ports.push(socket.address().port);
    }
    // Reserved DNS port: no DNS query is made in this first probe.
    ports.push(1);
    return { ports, counts, accepted, close: async () => { for (const close of resources.reverse()) await close(); } };
  } catch (error) { for (const close of resources.reverse()) await close().catch(() => {}); throw error; }
}

async function runCase(mode, kind, primaryOnly = false) {
  const id = randomUUID().replaceAll('-', ''); const profile = `tahtiapuri.t09a.${id}`;
  const caseRoot = join(runRoot, `${mode}-${primaryOnly ? 'primary-' : ''}${kind}`);
  const staged = join(caseRoot, 'staged');
  for (const dir of ['package', 'private', 'scratch', 'launcher']) await fs.mkdir(join(staged, dir), { recursive: true });
  await fs.writeFile(join(staged, 'owner.marker'), 'TAHTIAPURI_T09A_SYNTHETIC_ONLY', { flag: 'wx' });
  // A real copy: changing these ACLs must never modify a repository/pnpm hardlink.
  await fs.copyFile(probe, join(staged, 'package/probe.exe'));
  const caseHost = join(staged, 'launcher/host.exe'); await fs.copyFile(host, caseHost);
  await fs.writeFile(join(staged, 'package/allowed.txt'), 'SYNTHETIC ALLOWED\n');
  await fs.writeFile(join(staged, 'package/weights.fixture'), 'SYNTHETIC WEIGHTS\n');
  await fs.writeFile(join(staged, 'package/legacy.fixture'), 'SYNTHETIC AAP-ONLY\n');
  await fs.writeFile(join(staged, 'package/module.mjs'), 'export const synthetic = true;\n');
  await fs.writeFile(join(staged, 'private/secret.txt'), 'SYNTHETIC PRIVATE\n');
  for (const name of ['package/probe.exe', 'package/allowed.txt', 'package/weights.fixture', 'package/legacy.fixture', 'package/module.mjs', 'private/secret.txt']) assert.equal((await fs.stat(join(staged, name))).nlink, 1);
  const servers = sharedServers ?? await endpoints();
  for (const key of Object.keys(servers.counts)) servers.counts[key] = 0;
  for (const key of Object.keys(servers.accepted)) servers.accepted[key] = 0;
  const lifetime = kind === 'normal' ? 'once' : kind === 'error' ? 'fail' : 'hold';
  const args = ['run', mode, profile, staged, ...servers.ports.map(String), `${primaryOnly ? 'primary-' : observeNetwork ? 'network-' : ''}${lifetime}`];
  const ownerCase = kind === 'owner-kill';
  const probeSha256 = createHash('sha256').update(await fs.readFile(join(staged, 'package/probe.exe'))).digest('hex');
  let observer;
  if (observeNetwork && mode === 'ac') {
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    observer = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(directory, observeEtw ? 'start-etw-observer.ps1' : 'start-wfp-observer.ps1'), '-RunId', runRoot.split(/[\\/]/).at(-1), '-OwnerPid', String(process.pid), ...(observeEtw ? ['-Scenario', kind === 'normal' ? 'observe' : `observe-${kind}`, '-Ports', servers.ports.slice(0, 4).join(','), '-OwnerImage', process.execPath] : [])], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const observation = collect(observer); observer.observation = observation;
    observation.exited.then(value => { observer.exitResult = value; });
    try {
      await waitForObserver(async () => {
        observation.check();
        if (observer.exitResult) throw new Error('Observer process exited before readiness.');
        if (await fs.stat(join(runRoot, observationDirectory, 'done.json')).then(() => true, () => false)) throw new Error('Observer stopped before readiness; inspect its local evidence.');
        return fs.stat(join(runRoot, observationDirectory, 'ready.json')).then(() => true, () => false);
      }, 60000);
    } catch (error) {
      await fs.writeFile(join(runRoot, stopRequest), 'STOP\n', { flag: 'wx' }).catch(() => {});
      let observerExit;
      try { observerExit = await bounded(observation.exited, 65000, 'Observer wrapper did not finish.'); }
      catch { observer.kill(); observerExit = { incomplete: true }; }
      // No native process/profile exists yet. Remove only this run's own staged files.
      await fs.rm(staged, { recursive: true, force: true });
      await fs.writeFile(join(caseRoot, 'observer-failure.json'), JSON.stringify({ error: error.message, observerExit, stderr: observation.stderr, stagedRemoved: true }, null, 2));
      throw error;
    }
  }
  const startedAt = new Date().toISOString();
  const child = spawn(ownerCase ? process.execPath : caseHost, ownerCase ? [join(directory, 'owner.mjs'), caseHost, ...args] : args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const report = collect(child);
  const result = { startedAt, probeSha256, probeImage: join(staged, 'package/probe.exe'), driverPid: process.pid, launchedChildPid: child.pid, endpoints: Object.fromEntries(['tcp4', 'tcp6', 'udp4', 'udp6'].map((name, index) => [name, servers.ports[index]])), mode, kind, primaryOnly, primaryDiagnosticPassed: false, cleanupPassed: false, passed: false, corePassed: false, profileIntent: profile, counts: servers.counts, accepted: servers.accepted, records: report.records };
  let exit;
  try {
    if (kind === 'launcher-kill' || ownerCase) {
      await until(() => { report.check(); return (primaryOnly ? ['primary'] : ['primary', 'descendant']).every(phase => report.records.filter(row => row.type === 'ready' && row.phase === phase).length === 1) || report.records.some(row => row.type === 'error' || row.type === 'probe-error'); });
      assert(!report.records.some(row => row.type === 'error' || row.type === 'probe-error'));
      result.validation = validate(report.records, mode, servers.counts, servers.accepted, primaryOnly);
      const targetAlive = child.exitCode === null && child.signalCode === null && alive(child.pid);
      assert.equal(targetAlive, true, 'Termination target already exited.');
      const requestedAtMs = Date.now();
      const succeeded = child.kill('SIGTERM');
      result.termination = { targetPid: child.pid, targetRole: ownerCase ? 'owner' : 'launcher',
        requestedAtMs, signal: 'SIGTERM', succeeded, targetAliveBeforeRequest: targetAlive };
      assert.equal(succeeded, true, 'Owned termination request failed.');
    }
    exit = await bounded(report.exited, 35000, 'Native launcher did not finish.');
    report.checkComplete();
    const pids = [...new Set([child.pid, ...report.records.filter(row => ['launched', 'token', 'descendant', 'owner-host', 'escaped'].includes(row.type)).map(row => row.pid)])];
    assert(pids.length > 0, 'No owned process identity observed.');
    await until(() => pids.every(pid => !alive(pid)), 10000);
    result.processExitObservation = { pids, allAbsent: true, checkedAtMs: Date.now(), beforeCleanup: true };
    if (kind === 'normal') { assert.equal(exit.code, 0); result.validation = validate(report.records, mode, servers.counts, servers.accepted, primaryOnly); }
    if (kind === 'error') { result.validation = validate(report.records, mode, servers.counts, servers.accepted, primaryOnly); assert.equal(exit.code, 1); assert.equal(report.records.find(row => row.type === 'finished')?.exitCode, 17); if (!primaryOnly) assert(report.records.some(row => row.type === 'descendant')); }
    if (ownerCase) assert(report.records.some(row => row.type === 'profile'));
    if (!['launcher-kill', 'owner-kill'].includes(kind) && ['ac', 'lpac'].includes(mode)) assert.equal(report.records.find(row => row.type === 'cleanup')?.hresult, 0);
    if (kind === 'normal' || kind === 'error') assert.equal(report.records.find(row => row.type === 'finished')?.activeProcesses, 0);
    result.corePassed = !primaryOnly; result.primaryDiagnosticPassed = primaryOnly; result.passed = !primaryOnly && result.validation.networkVerified;
  } catch (error) {
    result.error = error.stack;
    // Preserve the failed original LPAC case; this only permits later diagnostics.
    const known = report.records.filter(row => row.type === 'probe-error' || row.type === 'error');
    if (mode === 'lpac' && !primaryOnly && kind === 'normal' && known.length === 1 && known[0].stage === 'descendant-create' && known[0].code === 5) {
      try {
        result.primaryEvidence = validate(report.records.filter(row => row !== known[0]), mode, servers.counts, servers.accepted, true);
        result.expectedCompatibilityFailure = true;
      } catch { /* Unexpected isolation changes stop the matrix. */ }
    }
  }
  finally {
    result.cleanup = await cleanupOwnedRun({ child, report, host, staged, profile, restricted: ['ac', 'lpac'].includes(mode) });
    result.cleanupPassed = result.cleanup.passed;
    if (!result.cleanupPassed) { result.corePassed = false; result.passed = false; result.primaryDiagnosticPassed = false; result.cleanupError = result.cleanup.errors.join('; '); }
    if (observer) {
      await fs.writeFile(join(runRoot, stopRequest), 'STOP\n', { flag: 'wx' }).catch(() => {});
      try { result.observerExit = await bounded(observer.observation.exited, 65000, 'Read-only observer did not finish.'); }
      catch (error) { observer.kill(); result.observerExit = { incomplete: true, error: error.message }; }
      try {
        const identity = report.records.find(row => row.type === 'network-identity');
        assert.equal(identity?.code, 0);
        result.observation = await (observeEtw ? readEtwReceipt : readObservationReceipt)(runRoot, result.observerExit, identity.appIdHex);
        result.observerCleanupPassed = true;
      } catch (error) { result.observerCleanupPassed = false; result.observerError = error.message; }
      if (!result.observerCleanupPassed) { result.corePassed = false; result.passed = false; result.error = 'Read-only observer did not finish successfully.'; }
    }
    if (!sharedServers) await servers.close();
    result.counts = { ...servers.counts }; result.accepted = { ...servers.accepted };
    result.exit = exit; result.stderr = report.stderr; result.finishedAt = new Date().toISOString();
    await fs.writeFile(join(caseRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    completedCases.push(result);
    summary.cases.push({ mode, kind, primaryOnly, primaryDiagnosticPassed: result.primaryDiagnosticPassed, cleanupPassed: result.cleanupPassed, observerCleanupPassed: result.observerCleanupPassed, expectedCompatibilityFailure: result.expectedCompatibilityFailure, passed: result.passed, corePassed: result.corePassed, networkVerified: result.validation?.networkVerified ?? false, error: result.error, cleanupError: result.cleanupError });
  }
  console.log(`${mode}/${primaryOnly ? 'primary-' : ''}${kind}: ${result.passed ? 'PASS' : result.corePassed ? 'core PASS; network unresolved' : result.primaryDiagnosticPassed ? 'primary diagnostic PASS; original acceptance unchanged' : 'FAIL (details in ignored artifacts)'}`);
  assert(result.cleanupPassed && (result.corePassed || result.primaryDiagnosticPassed || result.expectedCompatibilityFailure), 'Unexpected isolation or cleanup failure; matrix stopped.');
}
async function waitForObserver(check, timeout) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done, 50)); }
  throw new Error('Observer readiness deadline reached.');
}
try {
  if (observeNetwork) {
    sharedServers = await endpoints();
    for (const mode of ['control', 'ac', 'control-inherit']) await runCase(mode, mode === 'ac' && observeEtw ? etwKind : 'normal');
  } else {
  for (const mode of ['control', 'control-inherit', 'ac', 'lpac']) await runCase(mode, 'normal');
  for (const kind of ['error', 'launcher-kill', 'owner-kill']) await runCase('ac', kind);
  for (const kind of ['normal', 'error', 'launcher-kill', 'owner-kill']) await runCase('lpac', kind, true);
  }
  if (observeEtw) {
    try {
      const isolated = completedCases[1];
      const evidence = await readEtwEvidence(runRoot, isolated.observerExit);
      Object.assign(summary, await finalizeEtwRun(completedCases, evidence, updated =>
        fs.writeFile(join(runRoot, `ac-${etwKind}/result.json`), `${JSON.stringify(updated, null, 2)}\n`)));
      console.log(`ETW bound-loopback ${etwKind} variation: verified ${summary.networkEvidence.attemptCount} attempts; full isolation remains unverified.`);
    } catch (error) {
      summary.networkEvidence = { networkVerified: false, error: error.message };
    }
  }
  summary.corePassed = summary.cases.every(row => row.corePassed);
  summary.passed = summary.cases.every(row => row.passed);
  if (!summary.passed) process.exitCode = 1;
} finally {
  if (sharedServers) await sharedServers.close();
  console.log(`Local evidence: ${runRoot}`);
  await fs.writeFile(join(runRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
