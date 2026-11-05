import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {setImmediate as immediate} from 'node:timers/promises';
import {BackendAdverseOwner} from './backend-adverse-owner.mjs';
import {BackendLifecycleOwner} from './backend-lifecycle-owner.mjs';
import {KINDS,FrameReader,frame,encodeJson,decodeJson} from './backend-codec.mjs';
import {ADVERSE_CASE_IDS,PENDING_MODEL_PROMPT,SKY_REQUEST_INPUT,CHILD_ABSENCE_BUDGET_MS} from './backend-adverse-contract.mjs';

const ownerNonce='1'.repeat(64),childNonce='2'.repeat(64),session='3'.repeat(64),jobId='12345678-1234-1234-1234-123456789abc';
const pending='owner-eof-model-pending',pressure='sky-output-pause-kill';
const prepared={pid:1234,childNonce,requestedPolicy:'control',creationMode:'detached-backend-probe',appContainer:false,lpac:false,lpacQueryError:0,lpacQueryBytes:0,capabilitySids:[],integrity:8192,job:true,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:536870912,sentinelInherited:false,aclsVerified:true,consoleAbsent:true,networkVerified:false};
const boundaries={type:'probe.boundaries',session,operations:['package-read','scratch-write','private-read','private-write','code-write','aap-read'].map(name=>({name,ok:true}))};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

function setup(caseId,{waitChildAbsent=async()=>true,stdin}={}){
  const child=new EventEmitter();child.stdin=stdin??new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const outgoing=[],raw=[];
  const reader=new FrameReader({nonce:ownerNonce,allowedKinds:[KINDS.START,KINDS.APP,KINDS.KILL],maxPayloadBytes:65536,maxFrames:4,maxTotalBytes:128*1024});
  if(!stdin){
    child.stdin.on('data',bytes=>{raw.push(Buffer.from(bytes));if([pending,pressure].includes(caseId))outgoing.push(...reader.push(bytes));});
    child.stdin.resume();
  }
  const owner=new BackendAdverseOwner(child,{caseId,mode:'control',ownerNonce,session,waitChildAbsent});let outer=0,inner=0;
  const send=(kind,body=Buffer.alloc(0))=>child.stdout.write(frame(kind,++outer,ownerNonce,body));
  const app=message=>send(KINDS.CHILD_CHUNK,frame(KINDS.APP,++inner,childNonce,encodeJson(message,16384)));
  const request=()=>decodeJson(outgoing.filter(record=>record.kind===KINDS.APP).at(-1).body);
  const receipts=()=>{send(KINDS.STDERR);send(KINDS.RESULT,encodeJson({passed:false,stderrComplete:true,stderrBytes:0},16384));};
  async function close(){child.stdout.end();child.stderr.end();await immediate();child.emit('close',1,null);return owner.completion;}
  const cleanup=()=>{owner.resumeOutput();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();};
  return {child,owner,outgoing,raw,send,app,request,receipts,close,cleanup};
}
async function prepare(f){f.send(KINDS.PREPARED,encodeJson(prepared,16384));await f.owner.prepared;}
async function ready(f){
  await prepare(f);const started=f.owner.start();await immediate();f.send(KINDS.STARTED);f.app({type:'ready',protocol:1,session});f.app(boundaries);await started;
}
async function begin(f){await ready(f);const execution=f.owner.execute();await immediate();return {execution,request:f.request()};}
function modelRun(input={prompt:PENDING_MODEL_PROMPT,backend:'cpu'}){return {type:'model.run',session,id:jobId,input};}
function pendingResponse(id,job={id:jobId,state:'loading',text:'',error:null,info:null}){return {type:'response',protocol:1,session,id,operation:'assistant.submit',result:{ok:true,job}};}
function pressurePrefix(id){return Buffer.from(JSON.stringify({type:'response',protocol:1,session,id,operation:'sky.snapshot'}).slice(0,-1)+',"result":{"ok":true,');}
function partial(f,id,{declared=1024*1024+4096,body=pressurePrefix(id),nonce=childNonce,sequence=3,kind=KINDS.APP}={}){
  const header=frame(kind,sequence,nonce);header.writeUInt32LE(declared,12);f.send(KINDS.CHILD_CHUNK,Buffer.concat([header,body]));return header;
}
async function rejectedClose(f){await assert.rejects(f.close());}

test('Batch B constructor accepts only its four closed cases and requires the pressure observer',()=>{
  const f=setup(pending);try{
    assert.equal(ADVERSE_CASE_IDS.length,4);
    assert.throws(()=>new BackendAdverseOwner(f.child,{caseId:'anything',mode:'control',ownerNonce,session}));
    assert.throws(()=>new BackendAdverseOwner(f.child,{caseId:pressure,mode:'control',ownerNonce,session}));
    assert.equal(typeof f.owner.emit,'undefined','Raw owner must not emit a clean ChildPort exit');
  }finally{f.cleanup();}
});

for(const caseId of ['owner-header20-eof-before-start','owner-app65537-header-before-start'])test(caseId+' writes one exact raw header and retains only explicit EOF',async()=>{
  const f=setup(caseId);try{
    await prepare(f);await assert.rejects(f.owner.start(),/Prestart/);await f.owner.execute();
    assert.equal(f.raw.length,1);const raw=f.raw[0],short=caseId.includes('header20');
    const expected=frame(short?KINDS.START:KINDS.APP,1,ownerNonce);if(!short)expected.writeUInt32LE(65537,12);
    assert.deepEqual(raw,short?expected.subarray(0,20):expected);assert.equal(f.child.stdin.writableEnded,short);
    assert.equal(f.owner.started,false);assert.equal(f.owner.ownerMessages,0);assert.equal(f.owner.frames.length,0);
    assert.equal(f.owner.terminal.drained,true);assert.equal(f.owner.terminal.bodyBase64,raw.toString('base64'));
    assert.throws(()=>f.owner.execute(),/Repeated/);
    f.receipts();const evidence=await f.close();assert(evidence.outerComplete&&evidence.innerComplete);assert.equal(evidence.partial,null);assert.equal(evidence.activity,null);assert.equal(evidence.writerFailure,null);
  }finally{f.cleanup();}
});

for(const caseId of ['owner-header20-eof-before-start','owner-app65537-header-before-start'])test(caseId+' waits for actual write callback before EOF or seal and before close acceptance',async()=>{
  let callback;const writes=[];const stdin=new Writable({write(bytes,encoding,done){writes.push(Buffer.from(bytes));callback=done;}});
  const f=setup(caseId,{stdin});try{
    await prepare(f);const execution=f.owner.execute();await immediate();assert.equal(writes.length,1);assert.equal(stdin.writableEnded,false);assert.equal(f.owner.terminal,undefined);
    f.receipts();f.child.stdout.end();f.child.stderr.end();await immediate();f.child.emit('close',1,null);
    let settled=false;f.owner.completion.then(()=>{settled=true;},()=>{settled=true;});await immediate();assert.equal(settled,false,'close cannot bypass an in-flight terminal write');
    callback();await execution;const evidence=await f.owner.completion;assert.equal(evidence.terminal.drained,true);assert.equal(evidence.writerFailure,null);
    assert.equal(stdin.writableEnded,caseId.includes('header20'));
  }finally{f.cleanup();}
});

test('pending EOF requires real ready, boundaries, model.run, matching loading job, and no reply',async()=>{
  const f=setup(pending);try{
    const {execution,request}=await begin(f);assert.equal(request.operation,'assistant.submit');assert.deepEqual(request.input,{prompt:PENDING_MODEL_PROMPT,backend:'cpu'});
    assert.equal(f.owner.ownerMessages,2);assert.equal(f.child.stdin.writableEnded,false);
    f.app(modelRun());await immediate();assert.equal(f.child.stdin.writableEnded,false,'model.run alone cannot trigger EOF');
    f.app(pendingResponse(request.id));await execution;assert.equal(f.child.stdin.writableEnded,true);
    assert.equal(f.owner.frames.length,4);assert.deepEqual(f.owner.activity,{requestId:request.id,jobId,input:request.input,replySent:false});
    const apps=f.outgoing.filter(record=>record.kind===KINDS.APP).map(record=>decodeJson(record.body));
    assert.deepEqual(apps.map(message=>message.type),['initialize','request']);assert(!apps.some(message=>['model.result','model.progress'].includes(message.type)));
    f.receipts();const evidence=await f.close();assert.equal(evidence.innerComplete,true);assert.equal(evidence.partial,null);assert.deepEqual(evidence.terminal,{kind:'owner-eof',drained:true,bodyBase64:''});
  }finally{f.cleanup();}
});

test('execute can own START while initialize waits for STARTED and boundaries precede the request',async()=>{
  const f=setup(pending);try{
    await prepare(f);const execution=f.owner.execute();await immediate();assert.deepEqual(f.outgoing.map(record=>record.kind),[KINDS.START]);
    f.send(KINDS.STARTED);f.app({type:'ready',protocol:1,session});await immediate();assert.equal(f.outgoing.length,2);
    f.app(boundaries);await immediate();const request=f.request();assert.equal(request.operation,'assistant.submit');
    f.app(modelRun());f.app(pendingResponse(request.id));await execution;f.receipts();await f.close();
  }finally{f.cleanup();}
});

for(const [name,mutate] of [
  ['wrong model input',f=>f.app(modelRun({prompt:'wrong',backend:'cpu'}))],
  ['wrong model nonce',f=>f.send(KINDS.CHILD_CHUNK,frame(KINDS.APP,3,ownerNonce,encodeJson(modelRun(),16384)))],
  ['wrong model sequence',f=>f.send(KINDS.CHILD_CHUNK,frame(KINDS.APP,4,childNonce,encodeJson(modelRun(),16384)))],
  ['response before model run',(f,id)=>f.app(pendingResponse(id))],
  ['different response request',(f,id)=>{f.app(modelRun());f.app(pendingResponse('f'.repeat(36)));}],
  ['different loading job',(f,id)=>{f.app(modelRun());f.app(pendingResponse(id,{id:'abcdefab-1234-1234-1234-123456789abc',state:'loading',text:'',error:null,info:null}));}],
  ['queued response',(f,id)=>{f.app(modelRun());f.app(pendingResponse(id,{id:jobId,state:'queued',text:'',error:null,info:null}));}],
  ['oversize small frame',f=>{const header=frame(KINDS.APP,3,childNonce);header.writeUInt32LE(16385,12);f.send(KINDS.CHILD_CHUNK,header);}],
])test('pending rejects '+name+' without accepting EOF as success',async()=>{
  const f=setup(pending);try{const {execution,request}=await begin(f);mutate(f,request.id);await assert.rejects(execution);assert(f.owner.error);assert.equal(f.child.stdin.writableEnded,false);await rejectedClose(f);}finally{f.cleanup();}
});

test('pending rejects a fifth APP and retained failure survives valid terminal receipts',async()=>{
  const f=setup(pending);try{
    const {execution,request}=await begin(f);f.app(modelRun());f.app(pendingResponse(request.id));await execution;
    f.app({type:'extra'});const failure=await f.owner.fatal;assert.match(failure.message,/count/);f.receipts();await rejectedClose(f);assert.equal(f.owner.error,failure);
  }finally{f.cleanup();}
});

test('pressure pauses actual stdout, drains KILL, verifies child absence while paused, then resumes and retains bounded partial evidence',async()=>{
  const absent=deferred();let observed=false;let f;
  f=setup(pressure,{waitChildAbsent:async(pid,budget)=>{assert.equal(pid,prepared.pid);assert.equal(budget,1500);assert(f.child.stdout.isPaused());assert.equal(f.outgoing.at(-1).kind,KINDS.KILL);observed=true;return absent.promise;}});
  try{
    const {execution,request}=await begin(f);assert.equal(request.operation,'sky.snapshot');assert.deepEqual(request.input,SKY_REQUEST_INPUT);
    const header=partial(f,request.id);await immediate();assert(observed);assert(f.child.stdout.isPaused());assert.equal(f.owner.terminal,undefined);
    const first=f.owner.partial.receivedBytes;f.send(KINDS.CHILD_CHUNK,Buffer.alloc(5000,0x20));assert.equal(f.owner.partial.receivedBytes,first,'paused stream must defer later chunks');
    absent.resolve(true);await execution;await immediate();assert.equal(f.child.stdout.isPaused(),false);assert.equal(f.child.stdin.writableEnded,false);
    f.receipts();const evidence=await f.close();assert.equal(evidence.innerComplete,false);assert.equal(evidence.frames.length,2);assert.equal(evidence.partial.receivedBytes,first+5000);
    assert.equal(evidence.partial.headerBase64,header.toString('base64'));assert.equal(Buffer.from(evidence.partial.prefixBase64,'base64').length,4096);assert.equal(evidence.partial.eofError,'Truncated TBIP frame.');
    assert.equal(evidence.activity.pausedBytes,first);assert.equal(evidence.activity.childAbsenceBudgetMs,CHILD_ABSENCE_BUDGET_MS);
    assert.deepEqual(evidence.activity.trace.map(item=>item.event),['pause','kill-requested','kill-drained','child-absent','stdout-resumed']);
    for(let i=1;i<evidence.activity.trace.length;i++)assert(evidence.activity.trace[i].atMs>=evidence.activity.trace[i-1].atMs);
    assert.deepEqual(evidence.terminal,{kind:'kill',drained:true,bodyBase64:''});assert.equal(evidence.ownerMessages,2);assert.equal(evidence.writerFailure,null);
    assert.equal(f.owner._body,undefined,'large partial frame must not allocate its declared body');
  }finally{absent.resolve(true);f.cleanup();}
});

for(const [name,observer] of [['observer rejection',async()=>{throw new Error('observer failed');}],['unconfirmed absence',async()=>false]])test('pressure resumes in finally after '+name+' and fails the case',async()=>{
  const f=setup(pressure,{waitChildAbsent:observer});try{
    const {execution,request}=await begin(f);partial(f,request.id);await assert.rejects(execution);assert.equal(f.child.stdout.isPaused(),false);assert.equal(f.owner._outputPaused,false);
    assert.deepEqual(f.owner.activity.trace.map(item=>item.event),['pause','kill-requested','kill-drained','stdout-resumed']);await rejectedClose(f);
  }finally{f.cleanup();}
});

test('pressure emergency resume is synchronous, idempotent, and invalidates an early process-check sequence',async()=>{
  const absent=deferred();const f=setup(pressure,{waitChildAbsent:()=>absent.promise});try{
    const {execution,request}=await begin(f);partial(f,request.id);await immediate();assert(f.child.stdout.isPaused());
    f.owner.resumeOutput();assert.equal(f.child.stdout.isPaused(),false);f.owner.resumeOutput();assert.equal(f.owner.activity.trace.filter(item=>item.event==='stdout-resumed').length,1);
    absent.resolve(true);await assert.rejects(execution,/Output resumed/);await rejectedClose(f);
  }finally{absent.resolve(true);f.cleanup();}
});

for(const [name,options] of [
  ['small third frame',{declared:1024*1024}],['overlimit third frame',{declared:16*1024*1024+1}],
  ['wrong nonce',{nonce:ownerNonce}],['wrong sequence',{sequence:4}],['wrong kind',{kind:KINDS.START}],
  ['wrong response prefix',{body:Buffer.from('{"wrong":')}],
])test('pressure rejects '+name+' before a KILL can claim success',async()=>{
  const f=setup(pressure);try{
    const {execution,request}=await begin(f);partial(f,request.id,options);await assert.rejects(execution);assert.equal(f.owner.activity.trace.length,0);assert(!f.outgoing.some(record=>record.kind===KINDS.KILL));await rejectedClose(f);
  }finally{f.cleanup();}
});

test('pressure requires at least one payload byte before pause and cannot accept an otherwise complete inner EOF',async()=>{
  const f=setup(pressure);try{
    const {execution,request}=await begin(f);partial(f,request.id,{body:Buffer.alloc(0)});await immediate();assert.equal(f.child.stdout.isPaused(),false);assert.equal(f.owner.activity.trace.length,0);
    f.child.stdout.end();f.child.stderr.end();await immediate();f.child.emit('close',1,null);
    await assert.rejects(execution);await assert.rejects(f.owner.completion);
  }finally{f.cleanup();}
});

test('pressure refuses a completed third frame even after a valid pause and child absence',async()=>{
  const absent=deferred();const f=setup(pressure,{waitChildAbsent:()=>absent.promise});try{
    const {execution,request}=await begin(f);partial(f,request.id);await immediate();const remaining=f.owner.partial.declaredBytes-f.owner.partial.receivedBytes;
    for(let offset=0;offset<remaining;offset+=65536)f.send(KINDS.CHILD_CHUNK,Buffer.alloc(Math.min(65536,remaining-offset),0x20));
    absent.resolve(true);await execution;await immediate();assert.match(f.owner.error.message,/completed/);await rejectedClose(f);
  }finally{absent.resolve(true);f.cleanup();}
});

for(const caseId of [pending,'owner-header20-eof-before-start','owner-app65537-header-before-start'])test(caseId+' never accepts partial inner EOF',async()=>{
  const f=setup(caseId);try{
    if(caseId===pending){
      const {execution,request}=await begin(f);f.app(modelRun());f.app(pendingResponse(request.id));await execution;
      f.send(KINDS.CHILD_CHUNK,Buffer.from('T'));
    }else{await prepare(f);await f.owner.execute();f.send(KINDS.CHILD_CHUNK,Buffer.from('T'));}
    f.receipts();await rejectedClose(f);
  }finally{f.cleanup();}
});

for(const invalid of [null,false,0,'',[]])test('sticky RESULT rejects '+JSON.stringify(invalid)+' before a later valid object',async()=>{
  const f=setup('owner-header20-eof-before-start');try{
    await prepare(f);await f.owner.execute();f.send(KINDS.STDERR);f.send(KINDS.RESULT,encodeJson(invalid,16384));
    const error=await f.owner.fatal;assert.match(error.message,/RESULT must be an object/);assert.equal(f.owner._seenResult,true);assert.equal(f.owner.result,undefined);
    f.send(KINDS.RESULT,encodeJson({passed:false,jobEmpty:true},16384));assert.equal(f.owner.result,undefined);await assert.rejects(f.close(),/RESULT must be an object/);assert.equal(f.owner.error,error);
  }finally{f.cleanup();}
});

test('truncated outer EOF is never excused by the pressure inner exception',async()=>{
  const f=setup(pressure);try{
    const {execution,request}=await begin(f);partial(f,request.id);await execution;f.receipts();f.child.stdout.write(Buffer.from('T'));await assert.rejects(f.close(),/Truncated TBIP/);
  }finally{f.cleanup();}
});

test('raw owner budgets broker stderr and rejects duplicate native STDERR',async()=>{
  const f=setup('owner-header20-eof-before-start');try{
    await prepare(f);await f.owner.execute();f.send(KINDS.STDERR);f.send(KINDS.STDERR);assert(f.owner.error);await rejectedClose(f);
  }finally{f.cleanup();}
  const g=setup('owner-app65537-header-before-start');try{
    await prepare(g);await g.owner.execute();g.child.stderr.write(Buffer.alloc(16385));assert.match(g.owner.error.message,/stderr limit/);await rejectedClose(g);
  }finally{g.cleanup();}
});

test('Batch A retains its independent two-frame 16KiB contract',()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.resume();
  const owner=new BackendLifecycleOwner(child,{mode:'control',ownerNonce,session});
  try{
    child.stdout.write(frame(KINDS.PREPARED,1,ownerNonce,encodeJson(prepared,16384)));
    assert.equal(owner._inner.options.maxPayloadBytes,16384);assert.equal(owner._inner.options.maxFrames,2);assert.equal(owner._inner.options.maxTotalBytes,32768+96);
  }finally{child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();}
});

for(const order of ['callback-first','drain-first'])test('raw malformed header requires both write callback and drain: '+order,async()=>{
  const stdin=new EventEmitter();let callback;let writes=0;stdin.writableEnded=false;stdin.destroyed=false;
  stdin.write=(bytes,done)=>{writes++;assert.equal(bytes.length,20);callback=done;return false;};
  stdin.end=done=>{stdin.writableEnded=true;stdin.emit('finish');done?.();};
  stdin.destroy=()=>{stdin.destroyed=true;stdin.emit('close');};
  const f=setup('owner-header20-eof-before-start',{stdin});try{
    await prepare(f);const execution=f.owner.execute();await immediate();assert.equal(writes,1);assert.equal(stdin.writableEnded,false);
    if(order==='callback-first')callback();else stdin.emit('drain');
    await immediate();assert.equal(stdin.writableEnded,false,'One completion signal is insufficient');assert.equal(f.owner.terminal,undefined);
    if(order==='callback-first')stdin.emit('drain');else callback();
    await execution;assert.equal(stdin.writableEnded,true);f.receipts();await f.close();
  }finally{f.cleanup();}
});

test('pressure observer rejection is preserved even if later terminal receipts are valid',async()=>{
  const f=setup(pressure,{waitChildAbsent:async()=>{throw new Error('explicit observer failure');}});try{
    const {execution,request}=await begin(f);partial(f,request.id);await assert.rejects(execution,/explicit observer failure/);
    f.receipts();await assert.rejects(f.close(),/explicit observer failure/);assert.equal(f.owner.audit().error,'explicit observer failure');
  }finally{f.cleanup();}
});

test('pending broker close before a matching loading response rejects instead of waiting for missing input forever',async()=>{
  const f=setup(pending);try{
    const {execution}=await begin(f);f.app(modelRun());const close=f.close();await assert.rejects(execution,/before pending job evidence/);await assert.rejects(close,/before pending job evidence/);
  }finally{f.cleanup();}
});
