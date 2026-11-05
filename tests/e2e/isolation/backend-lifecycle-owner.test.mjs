import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setImmediate as immediate} from 'node:timers/promises';
import {BackendLifecycleOwner} from './backend-lifecycle-owner.mjs';
import {KINDS,FrameReader,frame,encodeJson,decodeJson} from './backend-codec.mjs';

const ownerNonce='1'.repeat(64),childNonce='2'.repeat(64),session='3'.repeat(64);
const prepared={pid:1234,childNonce,requestedPolicy:'control',creationMode:'detached-backend-probe',appContainer:false,lpac:false,lpacQueryError:0,lpacQueryBytes:0,capabilitySids:[],integrity:8192,job:true,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:536870912,sentinelInherited:false,aclsVerified:true,consoleAbsent:true,networkVerified:false};
const boundaries={type:'probe.boundaries',session,operations:['package-read','scratch-write','private-read','private-write','code-write','aap-read'].map(name=>({name,ok:true}))};
function setup(){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.resume();
  const owner=new BackendLifecycleOwner(child,{mode:'control',ownerNonce,session}),outgoing=[];
  const reader=new FrameReader({nonce:ownerNonce,allowedKinds:[KINDS.START,KINDS.APP,KINDS.CLOSE_CHILD_INPUT,KINDS.KILL],maxPayloadBytes:65536,maxFrames:8,maxTotalBytes:128*1024});
  child.stdin.on('data',bytes=>outgoing.push(...reader.push(bytes)));let outer=0,inner=0;
  const send=(kind,body=Buffer.alloc(0))=>child.stdout.write(frame(kind,++outer,ownerNonce,body));
  const app=message=>send(KINDS.CHILD_CHUNK,frame(KINDS.APP,++inner,childNonce,encodeJson(message,16384)));
  async function close(){child.stdout.end();child.stderr.end();await immediate();child.emit('close',1,null);return owner.completion;}
  const cleanup=()=>{child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();};
  return {child,owner,outgoing,send,app,close,cleanup};
}
async function prepare(fixture){fixture.send(KINDS.PREPARED,encodeJson(prepared,16384));await fixture.owner.prepared;}
async function ready(fixture){
  await prepare(fixture);const started=fixture.owner.start();await immediate();fixture.send(KINDS.STARTED);
  fixture.app({type:'ready',protocol:1,session});fixture.app(boundaries);await started;
}

test('raw owner ends only the owner channel before START and retains actual completion flags',async()=>{
  const f=setup();try{
    await prepare(f);await f.owner.terminate('owner-before-start');assert.equal(f.child.stdin.writableEnded,true);assert.deepEqual(f.outgoing,[]);
    f.send(KINDS.STDERR);f.send(KINDS.RESULT,encodeJson({stderrComplete:false,stderrBytes:0},16384));
    const evidence=await f.close();assert.equal(evidence.started,false);assert.equal(evidence.frames.length,0);assert.equal(evidence.result.stderrComplete,false);
    assert.deepEqual(evidence.terminal,{kind:'owner-eof',drained:true,bodyBase64:''});assert(evidence.outerComplete&&evidence.innerComplete);assert.equal(evidence.writerFailure,null);
  }finally{f.cleanup();}
});

for(const kind of ['early-close','invalid-utf8'])test('raw owner drains and seals '+kind+' without owner EOF',async()=>{
  const f=setup();try{
    await ready(f);await f.owner.terminate(kind);assert.equal(f.child.stdin.writableEnded,false);
    const terminal=f.outgoing.at(-1);assert.equal(terminal.kind,kind==='early-close'?KINDS.CLOSE_CHILD_INPUT:KINDS.APP);
    assert.equal(terminal.body.toString('base64'),kind==='early-close'?'':'/w==');assert.equal(f.owner.ownerMessages,kind==='early-close'?1:2);
    assert.deepEqual(decodeJson(f.outgoing.find(record=>record.kind===KINDS.APP).body),{type:'initialize',protocol:1,session});
    f.send(KINDS.STDERR);f.send(KINDS.RESULT,encodeJson({stderrComplete:true,stderrBytes:0},16384));
    f.child.stdin.destroy();const evidence=await f.close();assert.equal(evidence.frames.length,2);assert.equal(evidence.writerFailure,null);assert.equal(evidence.brokerExitCode,1);
  }finally{f.cleanup();}
});

test('raw negative action waits for actual ready and validated boundaries',async()=>{
  const f=setup();try{
    await prepare(f);const start=f.owner.start();await immediate();f.send(KINDS.STARTED);f.app({type:'ready',protocol:1,session});
    const terminal=f.owner.terminate('early-close');await immediate();assert(!f.outgoing.some(record=>record.kind===KINDS.CLOSE_CHILD_INPUT));
    f.app({...boundaries,operations:[]});await assert.rejects(start);await assert.rejects(terminal);assert(f.owner.error instanceof Error);
    assert(!f.outgoing.some(record=>record.kind===KINDS.CLOSE_CHILD_INPUT));
  }finally{await f.close().catch(()=>{});f.cleanup();}
});

test('raw owner rejects a third worker APP without changing the positive port contract',async()=>{
  const f=setup();try{
    await ready(f);f.app({type:'unexpected'});assert((await f.owner.fatal) instanceof Error);
    assert.equal(f.owner.frames.length,2);assert.equal(f.owner._inner.options.maxPayloadBytes,16384);
  }finally{await f.close().catch(()=>{});f.cleanup();}
});

test('raw owner never accepts later terminal records after a retained protocol error',async()=>{
  const f=setup();try{
    await ready(f);await f.owner.terminate('early-close');
    f.send(KINDS.PREPARED,encodeJson(prepared,16384));assert((await f.owner.fatal) instanceof Error);
    f.send(KINDS.STDERR);f.send(KINDS.RESULT,encodeJson({stderrComplete:true,stderrBytes:0},16384));
    await assert.rejects(f.close());assert(f.owner.audit().error);
  }finally{f.cleanup();}
});

for(const invalid of [null,false,0,'',[]])test('raw owner rejects first RESULT '+JSON.stringify(invalid)+' before a later object RESULT',async()=>{
  const f=setup();try{
    await ready(f);await f.owner.terminate('early-close');f.send(KINDS.STDERR);
    f.send(KINDS.RESULT,encodeJson(invalid,16384));assert.match((await f.owner.fatal).message,/RESULT must be an object/);
    assert.equal(f.owner._seenResult,true);assert.equal(f.owner.result,undefined);
    f.send(KINDS.RESULT,encodeJson({stderrComplete:true,stderrBytes:0,passed:false,jobEmpty:true,persistentAclRestored:true,profileDeleted:true},16384));
    assert.equal(f.owner.result,undefined,'A later object RESULT must not replace the rejected first receipt');
    await assert.rejects(f.close(),/RESULT must be an object/);
  }finally{f.cleanup();}
});
