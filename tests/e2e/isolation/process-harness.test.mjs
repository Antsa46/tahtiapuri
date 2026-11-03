import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { collect } from './process-harness.mjs';
function fixture(options) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return { child, report: collect(child, options) };
}
async function finish(child) {
  const ended = once(child.stdout, 'end'); child.stdout.end(); child.stderr.end(); await ended; child.emit('close', 0, null);
}
test('valid framed reports complete; an active stream is not a completed report', async () => {
  const { child, report } = fixture(); child.stdout.write('{"type":"launched","pid":101}\n{"type":"finished","activeProcesses":0}\n');
  assert.throws(report.checkComplete, /Incomplete/); await finish(child); await report.exited; report.checkComplete(); assert.equal(report.records.length, 2); assert.equal(child.killed, false);
});
for (const value of ['null', '[]', '42', '"text"', '{}', '{"type":1}', '{"type":"launched"}', '{"type":"launched","pid":0}', '{"type":"launched","pid":-1}', '{"type":"launched","pid":1.5}', '{"type":"launched","pid":4294967296}', '{"type":"launched","pid":"101"}']) {
  test(`invalid record cannot supply cleanup metadata: ${value}`, async () => {
    const { child, report } = fixture(); child.stdout.write(value + '\n'); await finish(child); await report.exited;
    assert.throws(report.checkComplete, /Malformed/); assert.deepEqual(report.records, []); assert(child.killed);
  });
}
test('a final JSON record without its newline is not silently dropped', async () => {
  const { child, report } = fixture(); child.stdout.write('{"type":"finished"}'); await finish(child); await report.exited; assert.throws(report.checkComplete, /Unterminated/);
});
test('malformed output after a valid launch stays fatal after a failed exit', async () => {
  const { child, report } = fixture(); child.stdout.write('{"type":"launched","pid":101}\nnot-json\n{"type":"finished","exitCode":5}\n'); await finish(child); await report.exited; assert.throws(report.checkComplete, /Malformed/); assert.equal(report.records.length, 2);
});
test('total stdout volume is bounded across individually short records', () => {
  const { child, report } = fixture(); child.stdout.write((' '.repeat(1000) + '\n').repeat(263)); assert.throws(report.check, /Unbounded/); assert(child.killed);
});
test('stderr is bounded separately and retained only as a diagnostic tail', () => {
  const { child, report } = fixture(); child.stderr.write('x'.repeat(1024 * 1024 + 1)); assert.throws(report.check, /diagnostics/); assert.equal(report.stderr.length, 32768); assert(child.killed);
});

const envelope = value => JSON.stringify({ type: 'worker-output', data: Buffer.from(JSON.stringify(value)).toString('base64') }) + '\n';
test('SDK transport keeps host evidence distinct from worker messages', async () => {
  const { child, report } = fixture({ workerEnvelope: true }); child.stdout.write('{"type":"launched","pid":101}\n' + envelope({ type: 'sdk-child', pid: 102, source: 'host' })); await finish(child); await report.exited; report.checkComplete(); assert.equal(report.records[0].source, 'host'); assert.equal(report.records[1].source, 'worker');
});
test('worker cannot forge a trusted token inspection', async () => {
  const { child, report } = fixture({ workerEnvelope: true }); child.stdout.write(envelope({ type: 'inspected-child', pid: 102, job: true })); await finish(child); await report.exited; assert.throws(report.checkComplete, /Malformed/); assert.deepEqual(report.records, []);
});
test('a raw SDK worker record cannot impersonate the host transport', async () => {
  const { child, report } = fixture({ workerEnvelope: true }); child.stdout.write('{"type":"sdk-child","pid":102}\n'); await finish(child); await report.exited; assert.throws(report.checkComplete, /Malformed/);
});

test('worker cannot forge console ownership evidence', async () => {
  const { child, report } = fixture({ workerEnvelope: true }); child.stdout.write(envelope({ type: 'console-host', pid: 102, soleClient: true })); await finish(child); await report.exited; assert.throws(report.checkComplete, /Malformed/);
});
