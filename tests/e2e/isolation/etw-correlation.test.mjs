import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlateEtwNetwork } from './etw-correlation.mjs';
import { correlationFixture, socketHex } from './etw-correlation.fixture.mjs';
const evaluate = f => correlateEtwNetwork(f.cases, f.evidence);
const event = f => f.evidence.records[2];
const attempt = f => f.cases[1].records.find(r => r.type === 'network-detail');
function recount(f) {
  const n = f.evidence.records.filter(r => r.kind === 'event').length;
  Object.assign(f.evidence.records.at(-1), { received: n, matchedEvents: n, ntMatches: n });
}
test('all eight attempts correlate, including TCP retransmissions and zero payload time', () => {
  const f = correlationFixture(), before = structuredClone(f), result = evaluate(f);
  assert.equal(result.networkVerified, true); assert.equal(result.fullIsolationVerified, false);
  assert.equal(result.scope, 'native-ac-bound-loopback-receive-v2');
  assert.equal(result.attemptCount, 8); assert.equal(result.eventCount, 12);
  assert.deepEqual(result.attempts.map(a => a.eventCount), [2, 2, 1, 1, 2, 2, 1, 1]);
  assert(result.attempts.every(a => a.protocolSource === 'probe' && a.packageIdentitySource === 'probe-token-and-driver'));
  assert.deepEqual(f, before, 'Raw evidence must not be rewritten.');
});
test('one drop per attempt suffices; count twelve is not a required magic number', () => {
  const f = correlationFixture(); f.evidence.records = f.evidence.records.filter(r => r.kind !== 'event' || r.atMs % 100 === 60); recount(f);
  assert.equal(evaluate(f).eventCount, 8);
});
test('closed time boundaries, case-insensitive NT path, and localized filter names', () => {
  const f = correlationFixture(); event(f).atMs = attempt(f).startedAtMs;
  f.evidence.records[3].atMs = attempt(f).finishedAtMs;
  event(f).observedAppIdHex = Buffer.from(Buffer.from(event(f).observedAppIdHex, 'hex').toString('utf16le').toUpperCase(), 'utf16le').toString('hex');
  event(f).filter.name = 'Arbitrary display name';
  assert.equal(evaluate(f).networkVerified, true);
});
for (const [name, mutate] of [
  ['missing after-control', f => f.cases.pop()],
  ['reordered controls', f => f.cases.reverse()],
  ['different endpoint after-control', f => f.cases[2].endpoints.tcp4++],
  ['different binary in after-control', f => { f.cases[2].probeSha256 = 'b'.repeat(64); }],
  ['missing server counters', f => { f.cases[0].counts = {}; }],
  ['missing accept counters', f => { f.cases[0].accepted = {}; }],
  ['control got no echo', f => { f.cases[2].counts.tcp4 = 0; }],
  ['AC accepted a connection', f => { f.cases[1].accepted.tcp6 = 1; }],
  ['unperformed attempt', f => { f.cases[1].records.find(r => r.type === 'operation' && r.name === 'tcp4').attempted = false; }],
  ['failed source bind', f => { attempt(f).stage = 'bind'; }],
  ['wrong protocol', f => { attempt(f).protocol = 17; }],
  ['wrong PID', f => { attempt(f).pid++; }],
  ['wrong package token', f => { f.cases[1].records.find(r => r.type === 'token').sid += '-1'; }],
  ['missing token', f => { f.cases[1].records = f.cases[1].records.filter(r => !(r.type === 'token' && r.phase === 'descendant')); }],
  ['duplicate attempt', f => f.cases[1].records.push(structuredClone(attempt(f)))],
  ['missing attempt', f => { f.cases[1].records = f.cases[1].records.filter(r => r !== attempt(f)); }],
  ['duplicate operation', f => f.cases[1].records.push(structuredClone(f.cases[1].records.find(r => r.type === 'operation' && r.name === 'tcp4')))],
  ['failed cleanup', f => { f.cases[2].cleanup.profileClean = false; }],
  ['emergency cleanup', f => { f.cases[1].cleanup.emergency = []; }],
  ['staged data left behind', f => { f.cases[2].cleanup.deletionAttempts[0].removed = false; }],
  ['after-control occurs before AC', f => { f.cases[2].startedAt = f.cases[0].startedAt; }],
  ['event just before attempt', f => { event(f).atMs = attempt(f).startedAtMs - 1; }],
  ['event just after attempt', f => { event(f).atMs = attempt(f).finishedAtMs + 1; }],
  ['payload clock selected', f => { event(f).timeSource = 'payload'; }],
  ['wrong remote port', f => { event(f).remoteSocketHex = socketHex(4, 49999); }],
  ['swapped socket direction', f => { [event(f).localSocketHex, event(f).remoteSocketHex] = [event(f).remoteSocketHex, event(f).localSocketHex]; }],
  ['not loopback', f => { event(f).localSocketHex = event(f).localSocketHex.replace('7f000001', '7f000002'); }],
  ['truncated socket', f => { event(f).localSocketHex = event(f).localSocketHex.slice(2); }],
  ['unknown version', f => { event(f).version = 3; }],
  ['different observed AppId with valid canonical', f => { event(f).observedAppIdHex = f.evidence.records[1].appIdHex; }],
  ['embedded NUL in AppId', f => { event(f).observedAppIdHex = '0000' + event(f).observedAppIdHex; }],
  ['DOS representation not reviewed', f => { event(f).appIdMatch = 'dos-path'; }],
  ['filter not found', f => { event(f).filter.queryCode = 5; }],
  ['wrong filter ID', f => { event(f).filter.id = '99'; }],
  ['wrong receive layer', f => { event(f).layerId = 46; }],
  ['wrong provider with convincing name', f => { event(f).filter.provider = 'unknown'; event(f).filter.name = 'AppContainerLoopback'; }],
  ['wrong sublayer', f => { event(f).filter.sublayer = 'unknown'; }],
  ['permit action', f => { event(f).filter.actionType = 4098; }],
  ['wrong flag semantics', f => { event(f).filter.conditions[0].match = 7; }],
  ['missing condition', f => event(f).filter.conditions.pop()],
  ['extra condition', f => event(f).filter.conditions.push(structuredClone(event(f).filter.conditions[0]))],
  ['malformed descriptor', f => { event(f).filter.conditions[1].value.hex = '00'.repeat(60); }],
  ['event loss', f => { f.evidence.records.at(-1).eventsLost = 1; }],
  ['collector failure', f => { f.evidence.done.exitCode = 1; }],
  ['guard timeout', f => { f.evidence.guard.timedOut = true; }],
  ['observer cleanup failure', f => { f.cases[1].observerCleanupPassed = false; }],
]) test(`rejects ${name}`, () => { const f = correlationFixture(); mutate(f); assert.throws(() => evaluate(f)); });
test('rejects incomplete coverage even if all remaining events have unique matches', () => {
  const f = correlationFixture(); f.evidence.records.splice(2, 2); recount(f); assert.throws(() => evaluate(f), /Missing drop/);
});
test('rejects ambiguous same-socket overlapping attempts without relying on protocol or PID in ETW', () => {
  const f = correlationFixture(), a = attempt(f), b = f.cases[1].records.find(r => r.type === 'network-detail' && r.phase === 'descendant' && r.name === 'tcp4');
  Object.assign(b, { localPort: a.localPort, startedAtMs: a.startedAtMs, finishedAtMs: a.finishedAtMs });
  assert.throws(() => evaluate(f), /exactly one attempt/);
});
