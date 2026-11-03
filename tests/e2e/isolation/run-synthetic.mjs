import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') throw new Error('This probe must run with native Windows Node.');
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const output = join(root, '.artifacts/tests/isolation');
const host = join(output, 'native/bin/host.exe');
const probe = join(output, 'native/bin/probe.exe');
const runRoot = join(output, 'runs', randomUUID());
await fs.mkdir(runRoot, { recursive: true });
const summary = { schema: 1, scope: 'synthetic-native-loopback-only', cases: [], passed: false, corePassed: false, unrunOriginalCases: ['lpac/error', 'lpac/launcher-kill', 'lpac/owner-kill'] };

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
function collect(child) {
  const records = []; let buffered = ''; let stderr = ''; let failure;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffered += data;
    if (buffered.length > 256 * 1024) { failure = new Error('Unbounded probe output.'); child.kill(); return; }
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end).trim(); buffered = buffered.slice(end + 1);
      try { if (line) records.push(JSON.parse(line)); } catch { failure = new Error('Malformed native report.'); }
      if (records.length > 500) { failure = new Error('Too many native records.'); child.kill(); }
    }
  });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-32768); });
  const exited = new Promise(done => { child.once('error', error => { failure = error; }); child.once('close', (code, signal) => done({ code, signal })); });
  return { records, exited, get stderr() { return stderr; }, check: () => { if (failure) throw failure; } };
}
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function helper(args) {
  const child = spawn(host, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const report = collect(child);
  try { const exit = await bounded(report.exited, 7000, 'Cleanup helper timeout.'); report.check(); return { ...exit, records: report.records }; }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill(); child.stdout.destroy(); child.stderr.destroy(); }
}
async function until(check, timeout = 22000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Probe observation deadline exceeded.'); await delay(25); }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function validate(report, mode, counts, accepted, primaryOnly = false) {
  const network = [];
  assert(!report.some(row => row.type === 'error' || row.type === 'probe-error'), 'Native error record.');
  const launched = report.find(row => row.type === 'launched'); assert(launched?.job); assert.equal(launched.requestedPolicy, mode); assert.equal(launched.aclsVerified, true); assert.equal(launched.sentinelInherited, mode === 'control-inherit');
  const profile = report.find(row => row.type === 'profile');
  for (const phase of primaryOnly ? ['primary'] : ['primary', 'descendant']) {
    const token = report.find(row => row.type === 'token' && row.phase === phase); assert(token?.job, `${phase} Job membership`);
    assert.equal(token.appContainer, ['ac', 'lpac'].includes(mode)); if (token.lpac === null) assert.equal(token.lpacQueryError, 87, 'Unknown LPAC query must retain observed error.');
    else { assert.equal(token.lpac, mode === 'lpac'); if (token.appContainer) assert.equal(token.lpacQueryBytes, 4); } assert.equal(token.capabilities, 0);
    if (['ac', 'lpac'].includes(mode)) { assert.equal(token.integrity, 4096); assert.equal(token.sid, profile.sid); }
    const operation = name => { const row = report.find(row => row.type === 'operation' && row.phase === phase && row.name === name); assert(row, `${phase}/${name}`); return row; };
    for (const name of ['package-read', 'weights-read', 'scratch-write']) assert.equal(operation(name).ok, true, `${phase}/${name}`);
    assert.equal(operation('aap-read').ok, mode !== 'lpac');
    if (mode === 'lpac') assert.equal(operation('aap-read').code, 5);
    for (const name of ['outside-read', 'outside-write', 'resource-write', 'code-write']) {
      const row = operation(name); assert.equal(row.ok, !['ac', 'lpac'].includes(mode), `${phase}/${name}`);
      if (['ac', 'lpac'].includes(mode)) assert.equal(row.code, 5, `${phase}/${name}: require ERROR_ACCESS_DENIED`);
    }
    for (const name of ['tcp4', 'tcp6', 'udp4', 'udp6']) {
      const row = operation(name); assert.equal(row.ok, !['ac', 'lpac'].includes(mode), `${phase}/${name}`);
      if (['ac', 'lpac'].includes(mode)) {
        if (row.attempted === false) {
          const failure = report.find(item => item.type === 'network-startup' && item.phase === phase);
          assert(failure && failure.code !== 0 && failure.code === row.code, 'Unattempted networking must retain startup failure.');
          network.push({ phase, name, code: row.code, evidence: 'startup-unavailable' }); continue;
        }
        assert.equal(row.attempted, true);
        assert([10013, 10060].includes(row.code), `${phase}/${name}: unexpected network failure`);
        network.push({ phase, name, code: row.code, evidence: row.code === 10013 ? 'os-access-denied' : 'timeout-unresolved' });
      }
    }
  }
  if (!primaryOnly) { const breakaway = report.find(row => row.name === 'breakaway'); assert.equal(breakaway?.ok, false); assert.equal(breakaway?.code, 5); }
  else assert(!report.some(row => row.type === 'descendant'));
  for (const name of Object.keys(counts)) assert.equal(counts[name], !['ac', 'lpac'].includes(mode) ? 2 : 0, `${name} observed requests`);
  for (const name of Object.keys(accepted)) assert.equal(accepted[name], !['ac', 'lpac'].includes(mode) ? 2 : 0, `${name} accepted sockets`);
  return { network, networkVerified: network.every(row => row.evidence === 'os-access-denied') };
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
  const servers = await endpoints();
  const args = ['run', mode, profile, staged, ...servers.ports.map(String), `${primaryOnly ? 'primary-' : ''}${kind === 'normal' ? 'once' : kind === 'error' ? 'fail' : 'hold'}`];
  const ownerCase = kind === 'owner-kill';
  const child = spawn(ownerCase ? process.execPath : caseHost, ownerCase ? [join(directory, 'owner.mjs'), caseHost, ...args] : args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const report = collect(child);
  const result = { mode, kind, primaryOnly, primaryDiagnosticPassed: false, cleanupPassed: false, passed: false, corePassed: false, profileIntent: profile, counts: servers.counts, accepted: servers.accepted, records: report.records };
  let exit;
  try {
    if (kind === 'launcher-kill' || ownerCase) {
      await until(() => { report.check(); return report.records.filter(row => row.type === 'ready').length >= (primaryOnly ? 1 : 2) || report.records.some(row => row.type === 'error' || row.type === 'probe-error'); });
      assert(!report.records.some(row => row.type === 'error' || row.type === 'probe-error'));
      result.validation = validate(report.records, mode, servers.counts, servers.accepted, primaryOnly);
      child.kill();
    }
    exit = await bounded(report.exited, 35000, 'Native launcher did not finish.');
    report.check();
    const pids = report.records.filter(row => ['launched', 'token', 'descendant', 'owner-host', 'escaped'].includes(row.type)).map(row => row.pid);
    assert(pids.length > 0, 'No owned process identity observed.');
    await until(() => pids.every(pid => !alive(pid)), 10000);
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
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const pids = [...new Set(report.records.filter(row => ['launched', 'token', 'descendant', 'owner-host', 'escaped'].includes(row.type)).map(row => row.pid))];
    let stopped = false;
    try { await until(() => pids.every(pid => !alive(pid)), 7000); stopped = true; }
    catch {
      result.corePassed = false; result.passed = false;
      result.cleanupError = 'Job lifecycle failed; emergency cleanup required.';
      result.emergency = [];
      // The native helper verifies the image belongs to this unique staged root.
      for (const pid of pids) if (alive(pid)) {
        try { result.emergency.push(await helper(['stop-owned', staged, String(pid)])); }
        catch (error) { result.emergency.push({ failed: error.message }); }
      }
      try { await until(() => pids.every(pid => !alive(pid)), 7000); stopped = true; }
      catch { result.cleanupError = 'Owned processes are still alive; profile and staged data retained.'; }
    }
    try { await bounded(report.exited, 3000, 'Inherited stdio stayed open.'); }
    catch (error) { result.corePassed = false; result.passed = false; result.cleanupError = error.message; }
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    let profileClean = !['ac', 'lpac'].includes(mode);
    if (stopped && !profileClean) {
      let receiptMatches = false;
      try { receiptMatches = await fs.readFile(join(staged, 'profile.receipt'), 'utf8') === profile; }
      catch (error) { if (error.code !== 'ENOENT') result.cleanupError = 'Profile receipt could not be read.'; }
      if (receiptMatches) {
        try { result.teardown = await helper(['cleanup', profile, staged]); }
        catch (error) { result.teardown = { code: null, error: error.message }; }
        profileClean = result.teardown.code === 0;
      } else {
        profileClean = report.records.some(row => row.type === 'error' && row.stage === 'create-profile');
      }
      if (!profileClean) { result.corePassed = false; result.passed = false; result.cleanupError = 'Profile ownership/deletion uncertain; staged data retained.'; }
    }
    await servers.close();
    result.exit = exit; result.stderr = report.stderr;
    if (stopped && profileClean) {
      try { await fs.rm(staged, { recursive: true }); }
      catch (error) { result.corePassed = false; result.passed = false; result.cleanupError = `Owned staged deletion failed: ${error.code}`; }
    }
    result.cleanupPassed = stopped && profileClean && !result.cleanupError;
    if (!result.cleanupPassed) result.primaryDiagnosticPassed = false;
    await fs.writeFile(join(caseRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    summary.cases.push({ mode, kind, primaryOnly, primaryDiagnosticPassed: result.primaryDiagnosticPassed, cleanupPassed: result.cleanupPassed, expectedCompatibilityFailure: result.expectedCompatibilityFailure, passed: result.passed, corePassed: result.corePassed, networkVerified: result.validation?.networkVerified ?? false, error: result.error, cleanupError: result.cleanupError });
  }
  console.log(`${mode}/${primaryOnly ? 'primary-' : ''}${kind}: ${result.passed ? 'PASS' : result.corePassed ? 'core PASS; network unresolved' : result.primaryDiagnosticPassed ? 'primary diagnostic PASS; original acceptance unchanged' : 'FAIL (details in ignored artifacts)'}`);
  assert(result.cleanupPassed && (result.corePassed || result.primaryDiagnosticPassed || result.expectedCompatibilityFailure), 'Unexpected isolation or cleanup failure; matrix stopped.');
}
try {
  for (const mode of ['control', 'control-inherit', 'ac', 'lpac']) await runCase(mode, 'normal');
  for (const kind of ['error', 'launcher-kill', 'owner-kill']) await runCase('ac', kind);
  for (const kind of ['normal', 'error', 'launcher-kill', 'owner-kill']) await runCase('lpac', kind, true);
  summary.corePassed = summary.cases.every(row => row.corePassed);
  summary.passed = summary.cases.every(row => row.passed);
  if (!summary.passed) process.exitCode = 1;
} finally {
  await fs.writeFile(join(runRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}
