import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export function validateEtwReceipt(exit, done, guard, records, appIdHex) {
  assert.equal(exit?.code, 0); assert.equal(done?.exitCode, 0); assert.equal(done?.guardExitCode, 0);
  for (const field of ['cleanupPassed', 'sessionAbsent', 'identityVerified']) assert.equal(guard?.[field], true, field);
  assert.equal(guard.timedOut, false);
  assert(Array.isArray(records) && records.length >= 3 && records.length <= 259);
  const one = kind => { const found = records.filter(row => row.kind === kind); assert.equal(found.length, 1, kind); return found[0]; };
  const baseline = one('baseline'), ready = one('ready'), finished = one('finished');
  assert.equal(records[0], baseline); assert.equal(records[1], ready); assert.equal(records.at(-1), finished);
  assert(records.every(row => ['baseline', 'ready', 'event', 'finished'].includes(row.kind)));
  assert([0, 1].includes(baseline.collect)); assert.equal(typeof baseline.keywords, 'string'); assert(/^\d+$/.test(baseline.keywords));
  assert.equal(typeof appIdHex, 'string'); assert(/^(?:[0-9a-f]{2})+$/.test(appIdHex)); assert.equal(ready.appIdHex, appIdHex);
  assert.equal(typeof ready.endpointAppIdHex, 'string'); assert(/^(?:[0-9a-f]{2})+$/.test(ready.endpointAppIdHex));
  for (const field of ['complete', 'providerDisabled', 'sessionStopped', 'sessionAbsent', 'consumerStopped', 'engineClosed', 'optionsUnchanged']) assert.equal(finished[field], true, field);
  assert.equal(finished.collectAfter, baseline.collect); assert.equal(finished.keywordsAfter, baseline.keywords);
  for (const field of ['eventsLost', 'realTimeBuffersLost', 'logBuffersLost']) assert.equal(finished[field], 0, field);
  assert.equal(finished.callbackFailed, false); assert(Number.isInteger(finished.received) && finished.received >= 0 && finished.received <= 4096);
  const events = records.filter(row => row.kind === 'event'); assert.equal(finished.matchedEvents, events.length); assert(finished.received >= events.length);
  const counters = ['providerMismatch', 'otherEventId', 'emptyAppId', 'otherAppId', 'otherEndpoint', 'ntMatches', 'dosMatches'];
  for (const field of counters) assert(Number.isInteger(finished[field]) && finished[field] >= 0 && finished[field] <= 4096);
  assert.equal(finished.providerMismatch + finished.otherEventId + finished.emptyAppId + finished.otherAppId + finished.otherEndpoint + events.length, finished.received);
  assert.equal(finished.ntMatches + finished.dosMatches, events.length);
  assert(events.every(row => row.eventId === 1001 && ['probe', 'endpoint-owner'].includes(row.identityRole) && row.canonicalAppIdHex === (row.identityRole === 'probe' ? appIdHex : row.identityRole === 'endpoint-owner' ? ready.endpointAppIdHex : null) && ['nt-path', 'dos-path'].includes(row.appIdMatch) && typeof row.observedAppIdHex === 'string' && /^(?:[0-9a-f]{2})+$/.test(row.observedAppIdHex)));
  // An ETW drop alone does not establish protocol, package SID or policy origin.
  return { complete: true, eventCount: events.length, networkVerified: false };
}
export async function readEtwReceipt(runRoot, exit, appIdHex) {
  const read = async (name, maximum) => {
    const path = join(runRoot, 'etw', name); const stat = await fs.stat(path); assert(stat.isFile() && stat.size <= maximum);
    const text = await fs.readFile(path, 'utf8'); assert(Buffer.byteLength(text) <= maximum); return text;
  };
  const done = JSON.parse(await read('done.json', 1024)), guard = JSON.parse(await read('guard-done.json', 1024));
  const text = await read('events.jsonl', 8 * 1024 * 1024); assert(text.endsWith('\n'));
  return validateEtwReceipt(exit, done, guard, text.trimEnd().split('\n').map(line => JSON.parse(line)), appIdHex);
}
