import assert from 'node:assert/strict';
import { validateEtwReceipt } from './etw-observation.mjs';
import { validateNativeCase } from './native-case-validation.mjs';
import { validateEtwLifecycle } from './etw-lifecycle.mjs';
import { validateFilterDescriptor } from './filter-descriptor.mjs';

// Fixed Windows SDK identifiers, not names or IDs copied from a particular machine.
// fwpmu.h / fwpsu.h / fwptypes.h; see docs/experiments/etw-network-probe.md.
const policy = {
  provider: 'decc16ca-3f33-4346-be1e-8fb4ae0f3d62', // FWPM_PROVIDER_MPSSVC_WF
  sublayer: 'ffe221c3-92a8-4564-a59f-dafb70756020', // MPSSVC_APP_ISOLATION
  flags: '632ce23b-5167-435c-86d7-e903684aa80c',
  user: 'af043a0a-b34d-4f86-979c-c90371af6e66',
  layers: {
    4: { id: 44, key: 'e1cd9fe7-f4b5-4273-96c0-592e487b8650' },
    6: { id: 46, key: 'a3b42c97-9f04-4672-b87e-cee9c483257f' },
  },
};
const names = ['tcp4', 'tcp6', 'udp4', 'udp6'];
const phases = ['primary', 'descendant'];
const integer = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n > 0 && n <= max;
const hexBytes = (s, max = 65536) => typeof s === 'string' && s.length <= max * 2 && /^(?:[0-9a-f]{2})+$/.test(s);
const one = (rows, predicate, label) => {
  const found = rows.filter(predicate);
  assert.equal(found.length, 1, `Expected exactly one ${label}.`);
  return found[0];
};
const record = (rows, type) => one(rows, row => row.type === type, type);

function pathText(hex) {
  assert(hexBytes(hex) && hex.length % 4 === 0, 'Malformed AppId.');
  const text = Buffer.from(hex, 'hex').toString('utf16le');
  assert(text.endsWith('\0') && text.length > 1 && !text.slice(0, -1).includes('\0'), 'Invalid AppId terminator.');
  return text.slice(0, -1).toLowerCase();
}
function socket(hex) {
  assert(hexBytes(hex, 28), 'Malformed socket.');
  const bytes = Buffer.from(hex, 'hex');
  assert([16, 28].includes(bytes.length), 'Unsupported socket length.');
  const family = bytes.readUInt16LE(0), port = bytes.readUInt16BE(2);
  assert(integer(port, 65535), 'Missing socket port.');
  if (family === 2 && bytes.length === 16) {
    assert.equal(bytes.subarray(4, 8).toString('hex'), '7f000001', 'Not exact IPv4 loopback.');
    return { family: 4, address: '127.0.0.1', port };
  }
  assert(family === 23 && bytes.length === 28, 'Unsupported socket family.');
  assert.equal(bytes.subarray(8, 24).toString('hex'), '00000000000000000000000000000001', 'Not exact IPv6 loopback.');
  assert.equal(bytes.readUInt32LE(24), 0, 'Unexpected IPv6 scope.');
  return { family: 6, address: '::1', port };
}
function caseAttempts(result, mode, endpoints) {
  assert(result && result.mode === mode && (mode === 'ac' || result.kind === 'normal') && result.primaryOnly === false, 'Wrong case.');
  for (const flag of ['corePassed', 'cleanupPassed']) assert.equal(result[flag], true, flag);
  assert(!result.error && !result.cleanupError && !result.expectedCompatibilityFailure, 'Failed case.');
  for (const flag of ['passed', 'stopped', 'profileClean']) assert.equal(result.cleanup?.[flag], true, `Cleanup ${flag}.`);
  assert.deepEqual(result.cleanup.errors, [], 'Cleanup error.');
  assert(!result.cleanup.emergency, 'Emergency cleanup is not normal lifecycle evidence.');
  assert(result.cleanup.deletionAttempts?.at(-1)?.removed === true, 'Staged data not removed.');
  assert.deepEqual(result.endpoints, endpoints, 'Controls use different endpoints.');
  assert.deepEqual(Object.keys(result.counts ?? {}).sort(), [...names].sort(), 'Incomplete server counters.');
  assert.deepEqual(Object.keys(result.accepted ?? {}).sort(), ['tcp4', 'tcp6'], 'Incomplete accept counters.');
  const start = Date.parse(result.startedAt), end = Date.parse(result.finishedAt);
  assert(integer(start) && integer(end) && start <= end, 'Invalid case window.');
  const rows = result.records;
  assert(Array.isArray(rows) && rows.length <= 500, 'Unbounded case records.');
  validateNativeCase(rows, mode, result.counts, result.accepted, false, true);
  const launched = record(rows, 'launched');
  validateEtwLifecycle(result);
  const identity = record(rows, 'network-identity'); assert.equal(identity.code, 0); pathText(identity.appIdHex);
  const descendant = record(rows, 'descendant');
  assert(integer(launched.pid, 0xffffffff) && integer(descendant.pid, 0xffffffff) && launched.pid !== descendant.pid, 'Invalid process identities.');
  const restricted = mode === 'ac';
  const profile = restricted ? record(rows, 'profile') : null;
  if (restricted) {
    assert(typeof profile.sid === 'string' && /^S-1-15-2-(?:\d+-)*\d+$/.test(profile.sid), 'Missing package identity.');
  }
  assert.equal(rows.filter(row => row.type === 'token').length, 2, 'Unexpected token count.');
  assert.equal(rows.filter(row => row.type === 'network-detail').length, 8, 'Incomplete attempt matrix.');
  const attempts = [];
  for (const phase of phases) {
    const token = one(rows, row => row.type === 'token' && row.phase === phase, `${phase} token`);
    assert.equal(token.pid, phase === 'primary' ? launched.pid : descendant.pid, 'Token/process mismatch.');
    assert.equal(token.integrity, restricted ? 4096 : 8192);
    assert(token.lpac === false || (token.lpac === null && token.lpacQueryError === 87), 'Unknown AC/LPAC result.');
    for (const name of names) {
      const detail = one(rows, row => row.type === 'network-detail' && row.phase === phase && row.name === name, `${phase}/${name} attempt`);
      const operation = one(rows, row => row.type === 'operation' && row.phase === phase && row.name === name, `${phase}/${name} operation`);
      assert.equal(operation.attempted, true, 'Attempt not performed.');
      assert.equal(detail.pid, token.pid); assert.equal(detail.ok, !restricted); assert.equal(detail.code, operation.code);
      assert.equal(detail.protocol, name.startsWith('tcp') ? 6 : 17, 'Protocol/name mismatch.');
      assert.equal(detail.localEndpointError, 0, 'Unknown source endpoint.');
      const address = name.endsWith('4') ? '127.0.0.1' : '::1';
      assert.equal(detail.localAddress, address); assert.equal(detail.remoteAddress, address);
      assert(integer(detail.localPort, 65535)); assert.equal(detail.remotePort, endpoints[name]);
      assert(integer(detail.startedAtMs) && integer(detail.finishedAtMs) && detail.startedAtMs <= detail.finishedAtMs, 'Invalid attempt window.');
      assert(detail.startedAtMs >= start && detail.finishedAtMs <= end, 'Attempt outside case window.');
      if (restricted) {
        assert.equal(detail.code, 10060, 'Unreviewed failure shape.');
        assert.equal(detail.stage, name.startsWith('tcp') ? 'connect-deadline' : 'receive', 'No actual connect/send attempt.');
      } else { assert.equal(detail.code, 0); assert.equal(detail.stage, 'echo'); }
      attempts.push(detail);
    }
  }
  return { attempts, start, end, appIdHex: identity.appIdHex };
}
function validatePolicy(event, family) {
  const filter = event.filter, layer = policy.layers[family];
  assert.equal(filter?.queryCode, 0, 'Filter lookup unavailable.');
  assert(typeof event.filterId === 'string' && /^[1-9]\d{0,19}$/.test(event.filterId), 'Invalid filter identity.');
  assert.equal(filter.id, event.filterId, 'Filter lookup mismatch.');
  assert.equal(event.layerId, layer.id); assert.equal(filter.layer, layer.key, 'Unexpected filter layer.');
  assert.equal(filter.provider, policy.provider, 'Unreviewed provider.');
  assert.equal(filter.sublayer, policy.sublayer, 'Unreviewed sublayer.');
  assert.equal(filter.actionType, 4097, 'Filter action is not BLOCK.');
  assert(Array.isArray(filter.conditions) && filter.conditions.length === 2, 'Unreviewed filter conditions.');
  const flags = one(filter.conditions, c => c.field === policy.flags, 'loopback condition');
  assert.equal(flags.match, 6); assert.deepEqual(flags.value, { type: 3, value: 1 });
  const user = one(filter.conditions, c => c.field === policy.user, 'user condition');
  assert.equal(user.match, 0); assert.equal(user.value?.type, 14);
  assert(hexBytes(user.value.hex) && !user.value.unsupported, 'Missing security descriptor.');
  validateFilterDescriptor(Buffer.from(user.value.hex, 'hex'));
  // The OS reported a match. This does not replay each ACE's access check.
}

/** Trusted local probe artifacts only. No network, processes, filesystem writes or policy changes. */
export function correlateEtwNetwork(cases, evidence) {
  assert(Array.isArray(cases) && cases.length === 3, 'Both controls and one AC case are required.');
  const endpoints = cases[0]?.endpoints;
  assert(endpoints && Object.keys(endpoints).length === 4 && names.every(name => integer(endpoints[name], 65535)), 'Invalid endpoint set.');
  assert.equal(new Set(Object.values(endpoints)).size, 4, 'Protocol-less events need distinct endpoint ports.');
  assert(typeof cases[0].probeSha256 === 'string' && /^[0-9a-f]{64}$/.test(cases[0].probeSha256), 'Missing probe digest.');
  assert(cases.every(c => c.probeSha256 === cases[0].probeSha256), 'Controls use different probe binaries.');
  const [before, isolated, after] = cases.map((c, i) => caseAttempts(c, ['control', 'ac', 'control-inherit'][i], endpoints));
  assert(before.end <= isolated.start && isolated.end <= after.start, 'Controls do not surround AC case.');
  assert.equal(cases[1].observerCleanupPassed, true, 'Observer cleanup unverified.');
  assert.deepEqual(evidence.exit, cases[1].observerExit, 'Collector exit mismatch.');
  validateEtwReceipt(evidence.exit, evidence.done, evidence.guard, evidence.records, isolated.appIdHex);
  const ready = evidence.records[1], events = evidence.records.filter(row => row.kind === 'event');
  assert(events.length > 0, 'No drop evidence.');
  const endpointApp = pathText(ready.endpointAppIdHex);
  assert.notEqual(endpointApp, pathText(isolated.appIdHex), 'Server and probe identities overlap.');
  const hits = isolated.attempts.map(() => []);
  for (const [index, event] of events.entries()) {
    // Only the reviewed receiver-side v2 schema is accepted. Other valid receipts stay unresolved.
    assert.equal(event.version, 2); assert.equal(event.identityRole, 'endpoint-owner');
    assert.equal(event.appIdMatch, 'nt-path', 'Unreviewed AppId representation.');
    assert.equal(pathText(event.observedAppIdHex), endpointApp, 'Observed AppId mismatch.');
    assert.equal(event.timeSource, 'etw-header-system-time'); assert(integer(event.atMs), 'Invalid event time.');
    assert.equal(event.loopback, 1);
    const local = socket(event.localSocketHex), remote = socket(event.remoteSocketHex);
    assert.equal(local.family, remote.family, 'Mixed address families.');
    validatePolicy(event, local.family);
    const matches = isolated.attempts.flatMap((attempt, i) => (
      local.address === attempt.remoteAddress && local.port === attempt.remotePort &&
      remote.address === attempt.localAddress && remote.port === attempt.localPort &&
      event.atMs >= attempt.startedAtMs && event.atMs <= attempt.finishedAtMs ? [i] : []
    ));
    assert.equal(matches.length, 1, 'Drop does not identify exactly one attempt.');
    hits[matches[0]].push(index);
  }
  assert(hits.every(eventsForAttempt => eventsForAttempt.length > 0), 'Missing drop for an attempt.');
  return {
    scope: cases[1].kind === 'normal' ? 'native-ac-bound-loopback-receive-v2' : 'native-ac-bound-loopback-lifecycle-receive-v2',
    lifecycleKind: cases[1].kind, lifecycleVerified: true, networkVerified: true, fullIsolationVerified: false,
    attemptCount: isolated.attempts.length, eventCount: events.length,
    attempts: isolated.attempts.map((attempt, i) => ({
      phase: attempt.phase, name: attempt.name, code: attempt.code,
      evidence: 'etw-app-isolation-loopback-drop', eventCount: hits[i].length,
      protocolSource: 'probe', packageIdentitySource: 'probe-token-and-driver',
    })),
  };
}
