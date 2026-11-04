import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEtwReceipt } from './etw-observation.mjs';
const fixture = () => ({
  exit: { code: 0 }, done: { exitCode: 0, guardExitCode: 0 },
  guard: { cleanupPassed: true, sessionAbsent: true, identityVerified: true, timedOut: false },
  records: [
    { kind: 'baseline', collect: 1, keywords: '0' },
    { kind: 'ready', appIdHex: '0102', endpointAppIdHex: '0304' },
    { kind: 'finished', complete: true, providerDisabled: true, sessionStopped: true, sessionAbsent: true, consumerStopped: true, engineClosed: true, optionsUnchanged: true, collectAfter: 1, keywordsAfter: '0', eventsLost: 0, realTimeBuffersLost: 0, logBuffersLost: 0, callbackFailed: false, received: 0, matchedEvents: 0, providerMismatch: 0, otherEventId: 0, emptyAppId: 0, otherAppId: 0, otherEndpoint: 0, ntMatches: 0, dosMatches: 0 },
  ],
});
const validate = f => validateEtwReceipt(f.exit, f.done, f.guard, f.records, '0102');
test('successful empty ETW collection does not prove isolation', () => assert.deepEqual(validate(fixture()), { complete: true, eventCount: 0, networkVerified: false }));
test('a matching drop still requires protocol and policy correlation', () => { const f = fixture(); f.records.splice(2, 0, { kind: 'event', eventId: 1001, identityRole: 'probe', canonicalAppIdHex: '0102', observedAppIdHex: '0102', appIdMatch: 'nt-path' }); f.records.at(-1).received = 1; f.records.at(-1).matchedEvents = 1; f.records.at(-1).ntMatches = 1; assert.equal(validate(f).networkVerified, false); });
for (const [name, mutate] of [
  ['missing guard receipt', f => { f.guard = {}; }],
  ['guard timeout', f => { f.guard.timedOut = true; }],
  ['guard failed despite claimed cleanup', f => { f.done.guardExitCode = 1; }],
  ['session left running', f => { f.records.at(-1).sessionAbsent = false; }],
  ['lost events', f => { f.records.at(-1).eventsLost = 1; }],
  ['lost realtime buffers', f => { f.records.at(-1).realTimeBuffersLost = 1; }],
  ['callback failed', f => { f.records.at(-1).callbackFailed = true; }],
  ['changed global options', f => { f.records.at(-1).keywordsAfter = '4'; }],
  ['different appId', f => { f.records[1].appIdHex = '0304'; }],
  ['unaccounted callback', f => { f.records.at(-1).received = 1; }],
  ['unaccounted accepted identity', f => { f.records.at(-1).ntMatches = 1; }],
  ['missing event', f => { f.records.at(-1).matchedEvents = 1; }],
  ['failed process', f => { f.exit.code = 1; }],
  ['duplicate completion', f => { f.records.push({ ...f.records.at(-1) }); }],
]) test(name, () => { const f = fixture(); mutate(f); assert.throws(() => validate(f)); });

test('endpoint-owner drop is distinct and still does not prove the client policy', () => {
  const f = fixture(); f.records.splice(2, 0, { kind: 'event', eventId: 1001, identityRole: 'endpoint-owner', canonicalAppIdHex: '0304', observedAppIdHex: '0304', appIdMatch: 'nt-path' });
  Object.assign(f.records.at(-1), { received: 1, matchedEvents: 1, ntMatches: 1 });
  assert.equal(validate(f).networkVerified, false);
  f.records[2].canonicalAppIdHex = '0102'; assert.throws(() => validate(f));
});
test('an undeclared identity role cannot bypass the target identities', () => {
  const f = fixture(); f.records.splice(2, 0, { kind: 'event', eventId: 1001, identityRole: 'unknown', canonicalAppIdHex: null, observedAppIdHex: '0102', appIdMatch: 'nt-path' });
  Object.assign(f.records.at(-1), { received: 1, matchedEvents: 1, ntMatches: 1 });
  assert.throws(() => validate(f));
});
