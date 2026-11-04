import assert from 'node:assert/strict';

export function validateSdkSelection(runtime, policy, argc) {
  assert(['electron', 'official', 'local-unpatched', 'local-patched'].includes(runtime));
  assert(['baseline', 'lpac-registry-read'].includes(policy), 'Unknown SDK policy.');
  assert(argc <= 4, 'Unexpected SDK arguments.');
  if (policy === 'lpac-registry-read') assert.equal(runtime, 'local-patched');
}
const isPid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const one = (rows, type, source) => {
  const found = rows.filter(row => row.type === type && row.source === source);
  assert.equal(found.length, 1, `Expected one ${type}.`); return found[0];
};
export function sdkProcessIds(result) {
  const { records: rows } = result;
  const main = one(rows, 'launched', 'host'), child = one(rows, 'inspected-child', 'host');
  assert.equal(one(rows, 'sdk-child', 'worker').pid, child.pid);
  const console = one(rows, 'console-host', 'host');
  const pids = [result.launchedChildPid, main.pid, child.pid, console.pid];
  const owners = rows.filter(row => row.type === 'owner-host');
  if (result.kind === 'owner-child') {
    assert.equal(owners.length, 1); assert.equal(owners[0].source, 'host'); pids.push(owners[0].pid);
  } else assert.equal(owners.length, 0);
  assert([result.driverPid, ...pids].every(isPid), 'Missing process identities.');
  assert.equal(new Set([result.driverPid, ...pids]).size, pids.length + 1, 'Process roles overlap.');
  return pids;
}
export function validateSdkLifecycle(result) {
  assert(['normal', 'missing-binary', 'owner-child'].includes(result.kind));
  const expected = sdkProcessIds(result), observation = result.processExitObservation;
  assert.equal(observation?.allAbsent, true); assert.equal(observation.beforeCleanup, true);
  assert(Array.isArray(observation.pids));
  assert.deepEqual([...observation.pids].sort((a,b)=>a-b), [...expected].sort((a,b)=>a-b));
  assert(Number.isSafeInteger(result.startedAtMs));
  assert(Number.isSafeInteger(observation.checkedAtMs) && observation.checkedAtMs >= result.startedAtMs);
  const finishes = result.records.filter(row => row.type === 'finished' && row.source === 'host');
  if (result.kind === 'owner-child') {
    const termination = result.termination;
    assert.equal(termination?.targetPid, result.launchedChildPid); assert.equal(termination.targetRole, 'owner');
    assert.equal(termination.signal, 'SIGTERM'); assert.equal(termination.succeeded, true);
    assert.equal(termination.targetAliveBeforeRequest, true);
    assert(Number.isSafeInteger(termination.requestedAtMs) && termination.requestedAtMs >= result.startedAtMs && termination.requestedAtMs <= observation.checkedAtMs);
    assert.equal(result.exit?.code, null); assert.equal(result.exit.signal, 'SIGTERM');
    assert(finishes.length <= 1);
    if (finishes.length) { assert.equal(finishes[0].ownerGone, true); assert.equal(finishes[0].exitCode, 42); assert.equal(finishes[0].activeProcesses, 0); }
  } else {
    assert.equal(result.termination, undefined); assert.equal(finishes.length, 1);
    assert.equal(finishes[0].ownerGone, false); assert.equal(finishes[0].activeProcesses, 0);
    assert.equal(finishes[0].exitCode, result.kind === 'normal' ? 0 : 17);
    assert.equal(result.exit?.code, result.kind === 'normal' ? 0 : 1); assert.equal(result.exit.signal, null);
  }
}
