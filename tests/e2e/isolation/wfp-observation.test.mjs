import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateObservationReceipt } from './wfp-observation.mjs';
const fixture = () => [
  { kind: 'baseline', collect: 1, keywords: '0' },
  { kind: 'ready', appIdHex: '0102' },
  { kind: 'finished', complete: true, unsubscribed: true, engineClosed: true, optionsUnchanged: true, collectAfter: 1, keywordsAfter: '0', matchedEvents: 0 },
];
const validate = (records, done = { exitCode: 0 }, exit = { code: 0 }) => validateObservationReceipt(exit, done, records, '0102');
test('empty but complete collection never proves network isolation', () => assert.deepEqual(validate(fixture()), { complete: true, eventCount: 0, networkVerified: false }));
test('an event alone does not prove its cause or a matching network attempt', () => { const rows = fixture(); rows.splice(2, 0, { kind: 'event', appIdHex: '0102' }); rows.at(-1).matchedEvents = 1; assert.equal(validate(rows).networkVerified, false); });
for (const [name, mutate] of [
  ['missing completion', rows => rows.pop()],
  ['duplicate completion', rows => rows.push({ ...rows.at(-1) })],
  ['failed unsubscribe', rows => { rows.at(-1).unsubscribed = false; }],
  ['failed engine close', rows => { rows.at(-1).engineClosed = false; }],
  ['timed out collection', rows => { rows.at(-1).complete = false; }],
  ['changed engine option despite claimed stability', rows => { rows.at(-1).keywordsAfter = '16'; }],
  ['different image', rows => { rows[1].appIdHex = '0304'; }],
  ['missing event', rows => { rows.at(-1).matchedEvents = 1; }],
  ['extra error record', rows => rows.splice(2, 0, { kind: 'error' })],
  ['out of order receipt', rows => rows.reverse()],
]) test(name, () => { const rows = fixture(); mutate(rows); assert.throws(() => validate(rows)); });
test('exit zero cannot replace a missing final receipt', () => assert.throws(() => validate(fixture(), {})));
test('a valid receipt cannot replace a failing process', () => assert.throws(() => validate(fixture(), { exitCode: 0 }, { code: 1 })));
