import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {encode,Reader} from './node-stdio-wire.mjs';
const project=fileURLToPath(new URL('../../../',import.meta.url));
for(const extra of ['partial','complete','valid'])test(extra==='valid'?'valid shutdown waits for EOF and returns bye':'shutdown rejects '+extra+' trailing frame before bye',async()=>{
 const root=join(project,'.artifacts/tests/node-stdio-unit',randomUUID());await fs.mkdir(root,{recursive:true});
 const session=Buffer.alloc(32,1),reader=new Reader(session),responses=[];
 const child=spawn(process.execPath,['--preserve-symlinks','--preserve-symlinks-main',fileURLToPath(new URL('node-stdio-probe.mjs',import.meta.url)),root,'normal',session.toString('hex')],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}});
 let rejectReady;const ready=new Promise((resolve,reject)=>{rejectReady=reject;child.stdout.on('data',b=>{responses.push(...reader.push(b));if(responses.some(f=>f.op===129))resolve();});});
 const close=new Promise(resolve=>{child.once('error',e=>rejectReady(e));child.once('close',(code,signal)=>resolve({code,signal}));});
 const timeout=setTimeout(()=>{rejectReady(new Error('probe deadline'));child.kill();},5000);
 try{
  child.stdin.write(encode(1,1,session));await ready;
  const trailing=encode(2,3,session,Buffer.from('x'));
  if(extra==='valid'){
   await new Promise((resolve,reject)=>child.stdin.write(encode(6,2,session),error=>error?reject(error):resolve()));
   // Keep stdin open long enough to observe an eager bye or exit before sending EOF.
   await delay(150);assert.deepEqual(responses.map(frame=>frame.op),[129]);
   assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.equal(child.stdin.writableEnded,false);
   child.stdin.end();
  }else child.stdin.write(Buffer.concat([encode(6,2,session),extra==='partial'?trailing.subarray(0,20):trailing]));
  assert.deepEqual(await close,{code:extra==='valid'?0:65,signal:null});assert.deepEqual(responses.map(f=>f.op),extra==='valid'?[129,134]:[129]);reader.finish();
 }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill();await close;child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();await fs.rm(root,{recursive:true});}
});
