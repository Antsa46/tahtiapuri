import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlateEtwNetwork } from './etw-correlation.mjs';
import { finalizeEtwRun } from './etw-finalization.mjs';
import { correlationFixture } from './etw-correlation.fixture.mjs';
const evaluate = f => correlateEtwNetwork(f.cases, f.evidence);
for (const kind of ['error', 'launcher-kill', 'owner-kill']) {
  test(`${kind}: accepts eight blocked attempts and exact pre-cleanup process exit evidence`, async () => {
    const f = correlationFixture(kind), original = structuredClone(f);
    const evidence = evaluate(f);
    assert.equal(evidence.lifecycleKind, kind); assert.equal(evidence.lifecycleVerified, true);
    assert.equal(evidence.fullIsolationVerified, false); assert.equal(evidence.attemptCount, 8);
    let saved; const result = await finalizeEtwRun(f.cases, f.evidence, async value => { saved = value; });
    assert.equal(saved.kind, kind); assert.equal(saved.passed, true); assert(result.cases.every(c => c.passed));
    assert.deepEqual(f, original);
  });
  for (const [name, mutate] of [
    ['missing direct child', c => { delete c.launchedChildPid; }],
    ['driver is termination target', c => { c.driverPid = c.launchedChildPid; }],
    ['process omitted from exit check', c => c.processExitObservation.pids.pop()],
    ['duplicate exit PID', c => { c.processExitObservation.pids[1] = c.processExitObservation.pids[0]; }],
    ['extra PID', c => c.processExitObservation.pids.push(999)],
    ['exit check after cleanup', c => { c.processExitObservation.beforeCleanup = false; }],
    ['live process', c => { c.processExitObservation.allAbsent = false; }],
    ['exit check outside case', c => { c.processExitObservation.checkedAtMs = 1; }],
    ['missing profile cleanup receipt', c => { delete c.cleanup.teardown; }],
    ['failed profile deletion', c => { c.cleanup.teardown.records[0].hresult = 5; }],
    ['emergency recovery', c => { c.cleanup.emergency = []; }],
    ['missing ready', c => { c.records = c.records.filter(r => r.type !== 'ready'); }],
    ['incorrect child close code', c => { c.exit.code = 0; }],
  ]) test(`${kind}: rejects ${name}`, () => { const f = correlationFixture(kind); mutate(f.cases[1]); assert.throws(() => evaluate(f)); });
}
for (const kind of ['launcher-kill','owner-kill']) {
  for (const [name, mutate] of [
    ['missing termination receipt', c => { delete c.termination; }],
    ['killed worker instead of owner/launcher', c => { c.termination.targetPid = 110; }],
    ['wrong target role', c => { c.termination.targetRole = 'worker'; }],
    ['target already exited', c => { c.termination.targetAliveBeforeRequest = false; }],
    ['failed kill call', c => { c.termination.succeeded = false; }],
    ['different signal', c => { c.exit.signal = 'SIGKILL'; }],
    ['kill before networking finished', c => { c.termination.requestedAtMs -= 300; }],
    ['exit check before kill', c => { c.processExitObservation.checkedAtMs -= 100; }],
    ['duplicate ready phase', c => { c.records.find(r => r.type === 'ready').phase = 'descendant'; }],
  ]) test(`${kind}: rejects ${name}`, () => { const f = correlationFixture(kind); mutate(f.cases[1]); assert.throws(() => evaluate(f)); });
}
test('error: wrong deliberate exit cannot masquerade as expected failure', () => {
  const f = correlationFixture('error'); f.cases[1].records.find(r => r.type === 'finished').exitCode = 18; assert.throws(() => evaluate(f));
});
test('owner-kill: missing host identity is rejected', () => {
  const f = correlationFixture('owner-kill'); f.cases[1].records = f.cases[1].records.filter(r => r.type !== 'owner-host'); assert.throws(() => evaluate(f));
});
test('owner-kill: if host completion arrives it must prove owner loss', () => {
  const f = correlationFixture('owner-kill'); f.cases[1].records.push({ type: 'finished', ownerGone: true, activeProcesses: 0, exitCode: 42 });
  assert.equal(evaluate(f).lifecycleVerified, true); f.cases[1].records.at(-1).ownerGone = false; assert.throws(() => evaluate(f));
});
test('unknown lifecycle and lifecycle controls are rejected', () => {
  const f = correlationFixture(); f.cases[1].kind = 'unknown'; assert.throws(() => evaluate(f));
  const g = correlationFixture(); g.cases[0].kind = 'error'; assert.throws(() => evaluate(g));
});
