import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// A complete collection is not proof that a particular connection was blocked.
export function validateObservationReceipt(exit, done, records, appIdHex) {
  assert.equal(exit?.code, 0, 'Observer process failed.');
  assert.equal(done?.exitCode, 0, 'Missing or failed observer receipt.');
  assert(Array.isArray(records) && records.length <= 259, 'Observer record count.');
  const one = kind => { const found = records.filter(row => row.kind === kind); assert.equal(found.length, 1, `Exactly one ${kind} record required.`); return found[0]; };
  assert(records.every(row => ['baseline', 'ready', 'event', 'finished'].includes(row.kind)), 'Unknown or failed observer record.');
  const baseline = one('baseline'), ready = one('ready'), finished = one('finished');
  assert.equal(baseline.collect, 1);
  assert.equal(typeof baseline.keywords, 'string'); assert(/^\d+$/.test(baseline.keywords));
  assert.equal(typeof appIdHex, 'string'); assert(/^(?:[0-9a-f]{2})+$/.test(appIdHex));
  assert.equal(ready.appIdHex, appIdHex, 'Host and observer must name the same image.');
  for (const field of ['complete', 'unsubscribed', 'engineClosed', 'optionsUnchanged']) assert.equal(finished[field], true, field);
  assert.equal(finished.collectAfter, baseline.collect); assert.equal(finished.keywordsAfter, baseline.keywords);
  assert.equal(records[0], baseline); assert.equal(records[1], ready); assert.equal(records.at(-1), finished);
  const events = records.filter(row => row.kind === 'event');
  assert.equal(finished.matchedEvents, events.length);
  assert(events.every(row => row.appIdHex === appIdHex), 'Unexpected application in observer output.');
  return { complete: true, eventCount: events.length, networkVerified: false };
}

export async function readObservationReceipt(runRoot, exit, appIdHex) {
  const read = async (name, limit) => {
    const path = join(runRoot, 'wfp', name); const stat = await fs.stat(path);
    assert(stat.isFile() && stat.size <= limit, 'Observer output size.');
    const text = await fs.readFile(path, 'utf8'); assert(Buffer.byteLength(text) <= limit);
    return text;
  };
  const done = JSON.parse(await read('done.json', 1024));
  const text = await read('events.jsonl', 8 * 1024 * 1024); assert(text.endsWith('\n'), 'Incomplete observer line.');
  const records = text.trimEnd().split('\n').map(line => JSON.parse(line));
  return validateObservationReceipt(exit, done, records, appIdHex);
}
