import assert from 'node:assert/strict';

const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const one = (rows, type) => {
  const found = rows.filter(row => row.type === type);
  assert.equal(found.length, 1, `Expected one ${type} lifecycle record.`);
  return found[0];
};

// Trusted development evidence: prove the selected termination and process exit
// before recovery. This never treats emergency cleanup as lifecycle success.
export function validateEtwLifecycle(result) {
  const { kind, records: rows } = result;
  assert(['normal', 'error', 'launcher-kill', 'owner-kill'].includes(kind), 'Unknown lifecycle.');
  assert(result.mode === 'ac' || kind === 'normal', 'Controls must complete normally.');
  const finished = rows.filter(row => row.type === 'finished');
  const owner = rows.filter(row => row.type === 'owner-host');
  const cleanup = rows.filter(row => row.type === 'cleanup');
  if (result.mode === 'ac') {
    assert.equal(result.cleanup.teardown?.code, 0, 'Profile teardown missing.');
    assert(result.cleanup.teardown.signal == null, 'Profile teardown terminated.');
    assert.equal(one(result.cleanup.teardown.records, 'cleanup').hresult, 0);
  }
  if (kind === 'normal' || kind === 'error') {
    assert.equal(finished.length, 1); assert.equal(owner.length, 0);
    assert.equal(finished[0].ownerGone, false); assert.equal(finished[0].activeProcesses, 0);
    assert.equal(finished[0].exitCode, kind === 'normal' ? 0 : 17);
    assert.equal(result.exit?.code, kind === 'normal' ? 0 : 1);
    assert(result.exit.signal == null, 'Unexpected termination signal.');
    assert(!result.termination, 'Unexpected forced termination.');
    if (result.mode === 'ac') { assert.equal(cleanup.length, 1); assert.equal(cleanup[0].hresult, 0); }
  }
  if (kind === 'normal') return; // Preserve acceptance of previously captured normal runs.
  const launched = one(rows, 'launched'), descendant = one(rows, 'descendant');
  const directPid = result.launchedChildPid;
  assert([result.driverPid, directPid, launched.pid, descendant.pid].every(pid), 'Missing process identities.');
  const expectedPids = [directPid, launched.pid, descendant.pid];
  if (kind === 'owner-kill') {
    assert.equal(owner.length, 1); assert(pid(owner[0].pid)); expectedPids.push(owner[0].pid);
  } else assert.equal(owner.length, 0);
  assert.equal(new Set([...expectedPids, result.driverPid]).size, expectedPids.length + 1, 'Process roles overlap.');
  const observation = result.processExitObservation;
  assert.equal(observation?.allAbsent, true); assert.equal(observation.beforeCleanup, true);
  assert(Array.isArray(observation.pids) && observation.pids.length === expectedPids.length, 'Incomplete process exit observation.');
  assert.deepEqual([...observation.pids].sort((a,b) => a-b), [...expectedPids].sort((a,b) => a-b));
  assert(Number.isSafeInteger(observation.checkedAtMs) && observation.checkedAtMs >= Date.parse(result.startedAt) && observation.checkedAtMs <= Date.parse(result.finishedAt), 'Exit check outside case.');
  const ready = rows.filter(row => row.type === 'ready');
  if (kind === 'error') {
    assert.deepEqual(ready.map(row => row.phase), ['descendant'], 'Error must follow descendant readiness.');
    return;
  }
  assert.deepEqual(ready.map(row => row.phase).sort(), ['descendant', 'primary'], 'Both processes must be ready before kill.');
  const termination = result.termination;
  assert.equal(termination?.targetPid, directPid, 'Wrong termination target.');
  assert.equal(termination.targetRole, kind === 'owner-kill' ? 'owner' : 'launcher');
  assert.equal(termination.signal, 'SIGTERM'); assert.equal(termination.succeeded, true);
  assert.equal(termination.targetAliveBeforeRequest, true, 'Target exited before requested kill.');
  assert(Number.isSafeInteger(termination.requestedAtMs) && termination.requestedAtMs >= Date.parse(result.startedAt) && termination.requestedAtMs <= observation.checkedAtMs, 'Kill outside lifecycle.');
  const attempts = rows.filter(row => row.type === 'network-detail');
  assert.equal(attempts.length, 8);
  assert(attempts.every(row => row.finishedAtMs <= termination.requestedAtMs), 'Network attempt after kill request.');
  assert.equal(result.exit?.code, null); assert.equal(result.exit.signal, 'SIGTERM', 'Unexpected child close receipt.');
  // The killed launcher cannot emit its final record. An owner-loss host may
  // finish before its pipe disappears; if a record arrives, it must match EOF.
  if (kind === 'launcher-kill') { assert.equal(finished.length, 0); assert.equal(cleanup.length, 0); }
  else {
    assert(finished.length <= 1 && cleanup.length <= 1, 'Duplicate owner-loss receipt.');
    if (finished.length) { assert.equal(finished[0].ownerGone, true); assert.equal(finished[0].exitCode, 42); assert.equal(finished[0].activeProcesses, 0); }
    if (cleanup.length) assert.equal(cleanup[0].hresult, 0);
  }
}
