import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { collect } from './process-harness.mjs';
function fixture() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return { child, report: collect(child) };
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
