import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
export function observeSdkChild({ helper, preload, nonce, emit, hold }) {
  const cp = require('node:child_process'); const originalFork = cp.fork; let child; let originalEmit; let expectedPid; let acked = false; let terminal = false;
  let resolveAck, rejectAck;
  const acknowledgement = new Promise((yes, no) => { resolveAck = yes; rejectAck = no; });
  // Attach a rejection handler immediately; the fork may fail before ready arrives.
  acknowledgement.catch(() => {});
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity }); let ackBytes = 0;
  reader.on('line', line => {
    try {
      ackBytes += Buffer.byteLength(line); assert(ackBytes < 4096 && !acked);
      const value = JSON.parse(line); assert.deepEqual(Object.keys(value).sort(), ['nonce','pid','type']);
      assert.equal(value.type, 'sdk-child-ack'); assert.equal(value.nonce, nonce); assert.equal(value.pid, expectedPid); assert(Number.isSafeInteger(expectedPid) && expectedPid > 0);
      acked = true; resolveAck(value); reader.close(); process.stdin.destroy();
    } catch (error) { rejectAck(error); }
  });
  reader.on('close', () => { if (!acked && !terminal) rejectAck(new Error('Host acknowledgement channel ended.')); });
  const timer = setTimeout(() => rejectAck(new Error('Host child-token acknowledgement timed out.')), 10000);
  cp.fork = function(file, args, options) {
    assert(!child, 'Only one SDK test child is expected.'); assert.equal(resolve(file), resolve(helper)); assert.deepEqual(args, []);
    assert.equal(options.detached, false); assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(options.env.TEST_BINDING_CP, 'true');
    assert.equal(options.execArgv, undefined); assert.deepEqual(process.execArgv, ['--preserve-symlinks', '--preserve-symlinks-main']);
    const flags = [...process.execArgv, '--require', preload];
    emit({ type: 'sdk-phase', phase: 'fork-call', started: true });
    child = originalFork.call(this, file, args, { ...options, execArgv: flags }); expectedPid = child.pid;
    assert(Number.isSafeInteger(expectedPid) && expectedPid > 0); assert.equal(child.spawnfile, process.execPath);
    assert.deepEqual(child.spawnargs, [process.execPath, ...flags, file]);
    emit({ type: 'sdk-child', pid: expectedPid, flags, originalHelper: true });
    originalEmit = child.emit;
    child.emit = function(event, ...values) {
      if (event === 'message') {
        const value = values[0];
        if (value?.type === 'probe-policy') { assert.equal(value.pid, expectedPid); emit({ type: 'sdk-policy', pid: expectedPid, operations: value.operations }); return true; }
        if (['ready','loaded','done'].includes(value?.type)) emit({ type: 'sdk-child-message', pid: expectedPid, message: value.type });
        if (value?.type === 'ready') {
          void acknowledgement.then(() => {
            clearTimeout(timer);
            if (hold) { emit({ type: 'sdk-held', pid: expectedPid }); return; }
            originalEmit.call(child, event, ...values);
          }).catch(error => { emit({ type: 'sdk-instrumentation-error', code: error.message }); child.kill(); });
          return true;
        }
      }
      return originalEmit.call(this, event, ...values);
    };
    child.on('exit', (code, signal) => emit({ type: 'sdk-child-exit', pid: expectedPid, code, signal }));
    return child;
  };
  syncBuiltinESMExports();
  return {
    get pid() { return expectedPid; },
    close() { terminal = true; clearTimeout(timer); reader.close(); process.stdin.destroy(); cp.fork = originalFork; syncBuiltinESMExports(); if (child && originalEmit) child.emit = originalEmit; }
  };
}
