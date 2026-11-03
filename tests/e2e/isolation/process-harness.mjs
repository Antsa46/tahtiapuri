import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function collect(child, { workerEnvelope = false } = {}) {
  const records = []; let buffered = ''; let outputBytes = 0; let stderrBytes = 0; let stderr = ''; let failure; let ended = false; let closed = false;
  const fail = message => { failure ??= new Error(message); child.kill(); };
  const pidTypes = new Set(['launched', 'token', 'descendant', 'owner-host', 'escaped', 'runtime', 'sdk-child', 'inspected-child']);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => {
    outputBytes += Buffer.byteLength(data);
    if (outputBytes > 256 * 1024) { fail('Unbounded probe output.'); child.stdout.destroy(); return; }
    buffered += data;
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end).trim(); buffered = buffered.slice(end + 1);
      if (!line) continue;
      try {
        let row = JSON.parse(line);
        if (workerEnvelope) {
          if (row?.type === 'worker-output') {
            if (typeof row.data !== 'string' || Buffer.from(row.data, 'base64').toString('base64') !== row.data) throw new Error('Invalid worker envelope.');
            row = JSON.parse(Buffer.from(row.data, 'base64').toString('utf8'));
            if (!['sdk-phase','sdk-child','sdk-child-message','sdk-policy','sdk-held','sdk-child-exit','sdk-ready','sdk-error','sdk-expected-failure','sdk-instrumentation-error'].includes(row?.type)) throw new Error('Worker cannot emit host records.');
            row = { ...row, source: 'worker' };
          } else {
            if (!['profile','launched','inspected-child','finished','error','cleanup','owner-host'].includes(row?.type)) throw new Error('Invalid host record.');
            row = { ...row, source: 'host' };
          }
        }
        if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string' || !row.type || row.type.length > 64) throw new Error('Invalid record type.');
        if (pidTypes.has(row.type) || Object.hasOwn(row, 'pid')) {
          if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || row.pid > 0xffffffff) throw new Error('Invalid process identity.');
        }
        if (records.length >= 500) throw new Error('Too many native records.');
        records.push(row);
      } catch { fail('Malformed native report.'); }
    }
  });
  child.stdout.once('end', () => { ended = true; if (buffered.trim()) fail('Unterminated native record.'); });
  child.stderr.on('data', data => {
    stderrBytes += Buffer.byteLength(data); stderr = (stderr + data).slice(-32768);
    if (stderrBytes > 1024 * 1024) { fail('Unbounded probe diagnostics.'); child.stderr.destroy(); }
  });
  const exited = new Promise(done => {
    child.once('error', error => { failure ??= error; });
    child.once('close', (code, signal) => { closed = true; done({ code, signal }); });
  });
  const check = () => { if (failure) throw failure; };
  return { records, exited, get stderr() { return stderr; }, check, checkComplete: () => { check(); if (!ended || !closed) throw new Error('Incomplete native report.'); } };
}
export async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export async function helper(host, args) {
  const child = spawn(host, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const report = collect(child);
  try { const exit = await bounded(report.exited, 7000, 'Cleanup helper timeout.'); report.check(); return { ...exit, records: report.records }; }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill(); child.stdout.destroy(); child.stderr.destroy(); }
}
export async function until(check, timeout = 22000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Probe observation deadline exceeded.'); await delay(25); }
}
export function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (['EPERM', 'EACCES'].includes(error.code)) return true; throw error; } }

// Cleanup is shared by both native and Electron probes. A recovered failure still fails the case.
export async function cleanupOwnedRun({ child, report, host, staged, profile, restricted }) {
  const result = { passed: false, stopped: false, profileClean: !restricted, errors: [] };
  if (child.exitCode === null && child.signalCode === null) child.kill();
  const pids = [...new Set(report.records.filter(row => ['launched', 'token', 'descendant', 'owner-host', 'escaped', 'sdk-child', 'inspected-child'].includes(row.type)).map(row => row.pid))];
  try { await until(() => pids.every(pid => !alive(pid)), 7000); result.stopped = true; }
  catch {
    result.errors.push('Job lifecycle failed; emergency cleanup required.'); result.emergency = [];
    for (const pid of pids) if (alive(pid)) {
      try { result.emergency.push(await helper(host, ['stop-owned', staged, String(pid)])); }
      catch (error) { result.emergency.push({ failed: error.message }); }
    }
    try { await until(() => pids.every(pid => !alive(pid)), 7000); result.stopped = true; }
    catch { result.errors.push('Owned processes remain alive; profile and staged data retained.'); }
  }
  try { await bounded(report.exited, 3000, 'Inherited stdio stayed open.'); }
  catch (error) { result.errors.push(error.message); }
  child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  if (result.stopped && restricted) {
    let matches = false;
    try { matches = await fs.readFile(join(staged, 'profile.receipt'), 'utf8') === profile; }
    catch (error) { if (error.code !== 'ENOENT') result.errors.push('Profile receipt could not be read.'); }
    if (matches) {
      try { result.teardown = await helper(host, ['cleanup', profile, staged]); }
      catch (error) { result.teardown = { code: null, error: error.message }; }
      result.profileClean = result.teardown.code === 0;
    } else result.profileClean = report.records.some(row => row.type === 'error' && row.stage === 'create-profile');
    if (!result.profileClean) result.errors.push('Profile ownership/deletion uncertain; staged data retained.');
  }
  if (result.stopped && result.profileClean) {
    result.deletionAttempts = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await fs.rm(staged, { recursive: true, force: true });
        try { await fs.lstat(staged); throw new Error('Owned staged root still exists.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        result.deletionAttempts.push({ attempt, removed: true }); break;
      } catch (error) {
        result.deletionAttempts.push({ attempt, removed: false, code: error.code, path: error.path, syscall: error.syscall });
        if (attempt < 5 && ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) { await delay(attempt * 100); continue; }
        result.errors.push(`Owned staged deletion failed: ${error.code ?? error.message}`); break;
      }
    }
  }
  result.passed = result.stopped && result.profileClean && result.errors.length === 0;
  return result;
}
