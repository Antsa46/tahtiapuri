import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rename,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {KINDS,HEADER,FrameReader,frame,encodeJson,decodeJson} from './backend-codec.mjs';
import {collectBackendPins,stageBackendPackage} from './backend-resources.mjs';
import {bounded,until} from './process-harness.mjs';
import {isSkyResult} from '../../../packages/validation/dist/sky.js';

const project=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
let suiteRoot,template;
before(async()=>{
  const base=join(project,'.artifacts/tests/backend-worker-unit');await mkdir(base,{recursive:true});
  suiteRoot=await mkdtemp(join(base,'suite-'));template=join(suiteRoot,'package');
  await stageBackendPackage({projectRoot:project,packageRoot:template,manifest:await collectBackendPins(project)});
});
after(async()=>{if(suiteRoot)await rm(suiteRoot,{recursive:true});});

async function withWorker(action){
  const caseRoot=join(suiteRoot,'case-'+randomBytes(16).toString('hex')),workerRoot=join(caseRoot,'worker-'+randomBytes(16).toString('hex'));
  const dataRoot=join(caseRoot,'data'),packageRoot=join(workerRoot,'package');
  await mkdir(workerRoot,{recursive:true});await mkdir(dataRoot);
  await writeFile(join(caseRoot,'owner.marker'),'TAHTIAPURI_BACKEND_CASE');await writeFile(join(workerRoot,'owner.marker'),'TAHTIAPURI_BACKEND_PROBE');
  for(const directory of ['scratch','private','aap'])await mkdir(join(workerRoot,directory));
  await writeFile(join(workerRoot,'private/secret.txt'),'SYNTHETIC PRIVATE\n');await writeFile(join(workerRoot,'aap/read.txt'),'SYNTHETIC AAP\n');
  await rename(template,packageRoot);await writeFile(join(packageRoot,'code.txt'),'SYNTHETIC CODE\n');
  const nonce=randomBytes(32).toString('hex'),session='a'.repeat(64),records=[],reader=new FrameReader({nonce,allowedKinds:[KINDS.APP],
    maxPayloadBytes:16*1024*1024,maxFrames:256,maxTotalBytes:64*1024*1024+256*HEADER});
  const child=spawn(join(packageRoot,'node.exe'),['--preserve-symlinks','--preserve-symlinks-main',join(packageRoot,'backend-worker.mjs'),workerRoot,dataRoot,nonce],
    {cwd:workerRoot,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}});
  let sequence=1,failure,stderr='',closed=false;
  child.stdout.on('data',bytes=>{try{for(const row of reader.push(bytes))records.push(decodeJson(row.body));}catch(error){failure??=error;child.kill();}});
  child.stderr.on('data',bytes=>{stderr+=bytes.toString('utf8');if(Buffer.byteLength(stderr)>16384){failure??=new Error('Unbounded worker stderr');child.kill();}});
  child.stdin.on('error',error=>{failure??=error;child.kill();});
  const close=new Promise(resolve=>{child.once('error',error=>{failure??=error;});child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
  const timer=setTimeout(()=>{failure??=new Error('Worker unit deadline');child.kill();},12000);
  const check=()=>{if(failure)throw failure;};
  const send=message=>new Promise((resolve,reject)=>child.stdin.write(frame(KINDS.APP,sequence++,nonce,encodeJson(message,65536)),error=>error?reject(error):resolve()));
  async function waitFor(predicate){
    await until(()=>{check();if(records.some(predicate))return true;if(closed)throw new Error('Worker exited before expected message: '+JSON.stringify({records:records.map(row=>row.type),stderr}));return false;},5000);
    return records.find(predicate);
  }
  async function initialize(){
    await send({type:'initialize',protocol:1,session});await waitFor(row=>row.type==='ready');
    assert.deepEqual(records[0],{type:'ready',protocol:1,session});
    const boundary=await waitFor(row=>row.type==='probe.boundaries');assert.equal(boundary.session,session);
    assert.deepEqual(boundary.operations,['package-read','scratch-write','private-read','private-write','code-write','aap-read'].map(name=>({name,ok:true})));
  }
  async function request(operation,input){
    const id=randomUUID();await send({type:'request',protocol:1,session,id,operation,expiresAtUnixMs:Date.now()+2500,...(input===undefined?{}:{input})});
    return waitFor(row=>row.type==='response'&&row.id===id&&row.operation===operation);
  }
  try{await action({child,records,close,send,waitFor,initialize,request,session,nonce,nextSequence:()=>sequence++});check();reader.finish();assert.equal(stderr,'');}
  finally{
    clearTimeout(timer);if(!closed)child.kill();await bounded(close,5000,'Worker close unconfirmed');
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    await rename(packageRoot,template);await rm(caseRoot,{recursive:true});
  }
}

test('actual staged backend composes status, atomic places, full sky and mock-owner model before EOF-gated shutdown',async()=>{
  await withWorker(async({child,records,close,send,waitFor,initialize,request,session})=>{
    await initialize();assert.deepEqual((await request('runtime.status')).result,{state:'ready',model:'managed-separately',protocolVersion:1});
    const saved=(await request('observing.save',{expectedRevision:0,id:null,place:{name:'Synthetic site',observer:{latitudeDeg:0,longitudeDeg:0,elevationMeters:0},timeZone:'UTC'}})).result;
    assert.equal(saved.ok,true);assert.equal(saved.state.revision,1);assert.deepEqual((await request('observing.read')).result,saved);
    const sky=(await request('sky.snapshot',{atUtc:'2024-01-01T00:00:00.000Z',timeZone:'UTC',observer:{latitudeDeg:0,longitudeDeg:0,elevationMeters:0}})).result;
    assert.equal(isSkyResult(sky),true);assert.equal(sky.snapshot.objects.length,5079);
    const submitted=(await request('assistant.submit',{prompt:'SYNTHETIC TEST',backend:'cpu'})).result;assert.equal(submitted.ok,true);
    const run=await waitFor(row=>row.type==='model.run'&&row.id===submitted.job.id);
    assert.equal(run.session,session);await send({type:'model.progress',session,id:run.id});
    await send({type:'model.result',session,id:run.id,reply:{text:'SYNTHETIC ANSWER',error:null,info:{backend:'cpu',gpuLayers:0,loadMs:0,generationMs:0,
      contextSize:4096,engineVersion:'llama.cpp-v0.9.0-cpu',modelId:'qwen3-4b-q4-k-m'}}});
    const completed=(await request('assistant.get',run.id)).result;assert.equal(completed.job.state,'completed');assert.equal(completed.job.text,'SYNTHETIC ANSWER');
    assert.equal((await request('runtime.ping')).result,null);
    assert.equal((await request('runtime.shutdown')).result,null);const count=records.length;
    await delay(150);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.equal(records.length,count);
    child.stdin.end();assert.deepEqual(await bounded(close,5000,'Shutdown EOF deadline'),{code:0,signal:null});
  });
});
test('actual worker rejects EOF without an accepted shutdown',async()=>{
  await withWorker(async({child,close,initialize})=>{await initialize();child.stdin.end();assert.deepEqual(await close,{code:67,signal:null});});
});
for(const tail of ['complete','partial'])test('actual worker rejects '+tail+' application bytes after shutdown',async()=>{
  await withWorker(async({child,close,initialize,request,session,nonce,nextSequence})=>{
    await initialize();await request('runtime.shutdown');
    const trailing=frame(KINDS.APP,nextSequence(),nonce,encodeJson({type:'model.progress',session,id:randomUUID()},65536));
    child.stdin.end(tail==='complete'?trailing:trailing.subarray(0,20));assert.deepEqual(await close,{code:65,signal:null});
  });
});
test('actual worker rejects an application request before initialize',async()=>{
  await withWorker(async({close,send,session})=>{
    await send({type:'request',protocol:1,session,id:randomUUID(),operation:'runtime.ping',expiresAtUnixMs:Date.now()+2500});
    assert.deepEqual(await close,{code:65,signal:null});
  });
});
