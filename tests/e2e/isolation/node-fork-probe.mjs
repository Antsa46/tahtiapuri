// Synthetic fork/IPC preflight only. No SDK, addon, model or network.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { verifyRuntimeIdentity } from './sdk-runtime.mjs';
if (process.argv[2] === '--child') {
  assert.equal(typeof process.send, 'function');
  const timer = setTimeout(() => process.exit(77), 10000);
  process.once('message', value => {
    assert.equal(value, 'PING');
    process.send('PONG', error => { clearTimeout(timer); if (error) process.exitCode = 1; process.disconnect(); });
  });
  process.send('READY');
} else {
  const root = process.argv[2]; assert.equal(process.argv[8], 'once');
  const emit = row => process.stdout.write(JSON.stringify(row) + '\n');
  const profile = JSON.parse(await fs.readFile(join(root, 'package/sdk-profile.json'), 'utf8'));
  const identity = verifyRuntimeIdentity(profile.runtime, {
    platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron,
    uv:process.versions.uv,execPath:process.execPath,expectedExecPath:join(root,'package/node.exe'),
    sha256:createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'),
    runAsNode:process.env.ELECTRON_RUN_AS_NODE,nodeOptions:process.env.NODE_OPTIONS,nodePath:process.env.NODE_PATH
  });
  emit({type:'sdk-phase',phase:'runtime-contract',passed:true,...identity});
  emit({type:'sdk-phase',phase:'fork-call',started:true});
  const child = fork(import.meta.filename, ['--child'], {stdio:['ignore','ignore','ignore','ipc'],detached:false});
  assert.equal(child.spawnfile, process.execPath); assert(Number.isSafeInteger(child.pid));
  emit({type:'sdk-child',pid:child.pid,originalHelper:false,syntheticFork:true});
  let fail, readyResolve, pongResolve, gotReady=false, gotPong=false;
  const failure = new Promise((_,no) => { fail=no; }); failure.catch(() => {});
  const ready = new Promise(yes => { readyResolve=yes; });
  const pong = new Promise(yes => { pongResolve=yes; });
  const closed = new Promise(yes => child.once('close',(code,signal)=>yes({code,signal})));
  child.once('error',fail);
  child.once('exit',(code,signal) => {
    if (!gotPong || code!==0 || signal!==null) fail(new Error('Child exited before a successful roundtrip.'));
  });
  child.on('message',message => {
    if (message==='READY' && !gotReady) { gotReady=true; readyResolve(); }
    else if (message==='PONG' && gotReady && !gotPong) { gotPong=true; pongResolve(); }
    else fail(new Error('Unexpected child protocol message.'));
  });
  const input = createInterface({input:process.stdin,crlfDelay:Infinity});
  let acked=false, ackResolve;
  const acknowledged = new Promise(yes => { ackResolve=yes; });
  input.once('line',line => { try {
    assert(Buffer.byteLength(line)<4096);
    assert.deepEqual(JSON.parse(line),{type:'sdk-child-ack',nonce:profile.nonce,pid:child.pid});
    acked=true; ackResolve(); input.close(); process.stdin.destroy();
  } catch(error) { fail(error); } });
  input.once('close',() => { if (!acked) fail(new Error('Acknowledgement closed.')); });
  const timer = setTimeout(() => fail(new Error('Synthetic fork protocol deadline.')),15000);
  try {
    await Promise.race([Promise.all([ready,acknowledged]),failure]);
    child.send('PING',error => { if (error) fail(error); });
    const [,exit] = await Promise.race([Promise.all([pong,closed]),failure]);
    assert.deepEqual(exit,{code:0,signal:null});
    emit({type:'sdk-phase',phase:'fork-roundtrip',passed:true,childPid:child.pid});
  } finally {
    clearTimeout(timer); input.close(); process.stdin.destroy();
    if (child.exitCode===null && child.signalCode===null) child.kill();
    let cleanupTimer;
    try { await Promise.race([closed,new Promise((_,no) => { cleanupTimer=setTimeout(()=>no(new Error('Synthetic child cleanup deadline.')),5000); })]); }
    finally { clearTimeout(cleanupTimer); }
  }
}
