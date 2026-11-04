import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlationFixture } from './etw-correlation.fixture.mjs';
import { finalizeEtwRun } from './etw-finalization.mjs';
test('publishes the complete variation only after the successful AC result is saved', async () => {
  const f = correlationFixture(), original = structuredClone(f);
  let release, saved, returned = false;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = finalizeEtwRun(f.cases, f.evidence, async result => { saved = result; await gate; }).then(result => { returned = true; return result; });
  await Promise.resolve(); assert.equal(returned, false); assert.equal(saved.passed, true);
  release(); const result = await pending;
  assert.equal(result.passed, true); assert(result.cases.every(c => c.passed && c.networkVerified));
  assert.equal(result.networkEvidence.fullIsolationVerified, false);
  assert.deepEqual(f, original, 'Do not alter supplied raw case records.');
});
test('persistence failure cannot produce a successful final result', async () => {
  const f = correlationFixture(), original = structuredClone(f);
  await assert.rejects(finalizeEtwRun(f.cases, f.evidence, async () => { throw new Error('Disk unavailable'); }), /Disk unavailable/);
  assert.deepEqual(f, original);
});
test('missing drop evidence never reaches successful-result persistence', async () => {
  const f = correlationFixture(); f.evidence.records.at(-1).eventsLost = 1;
  let writes = 0;
  await assert.rejects(finalizeEtwRun(f.cases, f.evidence, async () => { writes++; }));
  assert.equal(writes, 0);
});
