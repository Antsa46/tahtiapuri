import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setImmediate as immediate} from 'node:timers/promises';
import {BackendProbePort,validatePrepared,validateBoundaries} from './backend-port.mjs';
import {KINDS,FrameReader,frame,encodeJson,decodeJson} from './backend-codec.mjs';

const ownerNonce='1'.repeat(64),childNonce='2'.repeat(64),session='3'.repeat(64);
function prepared(mode='control'){
  return {pid:1234,childNonce,requestedPolicy:mode,creationMode:'detached-backend-probe',appContainer:mode==='lpac',lpac:mode==='lpac'?null:false,lpacQueryError:mode==='lpac'?87:0,lpacQueryBytes:0,capabilitySids:mode==='lpac'?[{sid:'S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681',attributes:4}]:[],integrity:mode==='lpac'?4096:8192,job:true,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:536870912,sentinelInherited:false,aclsVerified:true,consoleAbsent:true,networkVerified:false};
}
function setup(){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin.resume();
  const port=new BackendProbePort(child,{mode:'control',ownerNonce});let outer=0,inner=0;const outgoing=[];
  const ownerReader=new FrameReader({nonce:ownerNonce,maxPayloadBytes:65536,allowedKinds:[KINDS.START,KINDS.APP,KINDS.CLOSE_CHILD_INPUT,KINDS.KILL],maxFrames:260,maxTotalBytes:5*1024*1024});
  child.stdin.on('data',bytes=>outgoing.push(...ownerReader.push(bytes)));
  const send=(kind,body=Buffer.alloc(0))=>child.stdout.write(frame(kind,++outer,ownerNonce,body));
  const app=message=>send(KINDS.CHILD_CHUNK,frame(KINDS.APP,++inner,childNonce,encodeJson(message,16*1024*1024)));
  const cleanup=()=>{child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();};
  return {child,port,send,app,cleanup,outgoing};
}
async function start(fixture){
  fixture.send(KINDS.PREPARED,encodeJson(prepared(),16384));await fixture.port.prepared;
  fixture.port.on('spawn',()=>fixture.port.postMessage({type:'initialize',protocol:1,session}));
  await fixture.port.activate();fixture.send(KINDS.STARTED);
  fixture.app({type:'ready',protocol:1,session});
}
function result(port,overrides={}){
  return {passed:true,childCreated:true,childResumed:true,exitCode:0,watchdog:0,jobEmpty:true,persistentAclRestored:true,profileDeleted:true,consoleBefore:true,consoleAfterFirstFrame:true,consoleCheckedSequence:1,framesReceived:port.applicationFrames.length,bytesReceived:port.applicationFrames.reduce((sum,entry)=>sum+entry.bytes,0),ownerMessages:2,stderrComplete:true,stderrBytes:0,failure:'',error:0,...overrides};
}

test('ChildPort uses verified identity and waits for native cleanup and actual close',async()=>{
  const fixture=setup();const {child,port,send,app}=fixture;let exits=0;port.on('exit',()=>exits++);
  try{
    assert.equal(port.pid,undefined);await start(fixture);assert.equal(port.pid,1234);
    // Worker JSON cannot create an outer trusted RESULT receipt.
    app({type:'RESULT',passed:true,jobEmpty:true});assert.equal(port.nativeResult,undefined);
    port.postMessage({type:'request',protocol:1,session,id:'shutdown',operation:'runtime.shutdown',expiresAtUnixMs:Date.now()+1000});
    app({type:'response',protocol:1,session,id:'shutdown',operation:'runtime.shutdown',result:null});
    send(KINDS.STDERR);send(KINDS.RESULT,encodeJson(result(port),16384));await immediate();assert.equal(exits,0);assert.equal(child.stdin.writableEnded,false);
    assert.deepEqual(decodeJson(fixture.outgoing.find(record=>record.kind===KINDS.APP).body),{type:'initialize',protocol:1,session});
    child.emit('close',0,null);assert.equal((await port.completion).passed,true);assert.equal(exits,1);
  }finally{fixture.cleanup();}
});

test('ChildPort rejects a clean broker close without persistent ACL restoration',async()=>{
  const fixture=setup();let exits=0;fixture.port.on('exit',()=>exits++);try{
    await start(fixture);fixture.port.postMessage({type:'request',protocol:1,session,id:'shutdown',operation:'runtime.shutdown'});
    fixture.app({type:'response',protocol:1,session,id:'shutdown',operation:'runtime.shutdown',result:null});
    await immediate();fixture.child.stdin.destroy();await immediate();
    fixture.send(KINDS.STDERR);fixture.send(KINDS.RESULT,encodeJson(result(fixture.port,{persistentAclRestored:false}),16384));await immediate();fixture.child.emit('close',0,null);
    await assert.rejects(fixture.port.completion,/persistentAclRestored/);
    assert.equal(exits,0,'Unverified cleanup must not emit ChildPort exit');
  }finally{fixture.cleanup();}
});

test('ChildPort permits drained owner stdin closure before buffered valid RESULT',async()=>{
  const fixture=setup();try{
    await start(fixture);fixture.port.postMessage({type:'request',protocol:1,session,id:'shutdown',operation:'runtime.shutdown'});
    fixture.app({type:'response',protocol:1,session,id:'shutdown',operation:'runtime.shutdown',result:null});
    await immediate();assert.equal(fixture.outgoing.at(-1).kind,KINDS.CLOSE_CHILD_INPUT);
    fixture.child.stdin.destroy();await immediate();assert.equal(fixture.port.error,undefined);
    fixture.send(KINDS.STDERR);fixture.send(KINDS.RESULT,encodeJson(result(fixture.port),16384));
    fixture.child.emit('close',0,null);assert.equal((await fixture.port.completion).passed,true);
  }finally{fixture.cleanup();}
});

test('ChildPort rejects owner stdin closure before an ordered drained CLOSE',async()=>{
  const fixture=setup();try{
    await start(fixture);fixture.child.stdin.destroy();assert((await fixture.port.fatal) instanceof Error);
    fixture.child.emit('close',0,null);await assert.rejects(fixture.port.completion);
  }finally{fixture.cleanup();}
});

test('ChildPort rejects replayed outer records without unhandled error events',async()=>{
  const fixture=setup();try{
    fixture.send(KINDS.PREPARED,encodeJson(prepared(),16384));await fixture.port.prepared;
    fixture.child.stdout.write(frame(KINDS.STARTED,1,ownerNonce));
    assert((await fixture.port.fatal) instanceof Error);fixture.child.emit('close',1,null);await assert.rejects(fixture.port.completion);
  }finally{fixture.cleanup();}
});

test('ChildPort requires STDERR receipt even when diagnostics are empty',async()=>{
  const fixture=setup();try{
    await start(fixture);fixture.send(KINDS.RESULT,encodeJson(result(fixture.port),16384));assert.match((await fixture.port.fatal).message,/STDERR/);
    fixture.child.emit('close',0,null);await assert.rejects(fixture.port.completion);
  }finally{fixture.cleanup();}
});

test('prepared policy rejects capability expansion and false LPAC evidence',()=>{
  const value=prepared('lpac');validatePrepared(value,'lpac');assert.throws(()=>validatePrepared({...value,lpac:false},'lpac'));
  assert.throws(()=>validatePrepared({...value,capabilitySids:[...value.capabilitySids,{sid:'S-1-1-0',attributes:4}]},'lpac'));
  assert.throws(()=>validatePrepared({...prepared(),sentinelInherited:true},'control'));
  assert.throws(()=>validatePrepared({...prepared(),integrity:12288},'control'));
});

test('boundary failures require an OS access denial',()=>{
  const value={type:'probe.boundaries',session,operations:['package-read','scratch-write','private-read','private-write','code-write','aap-read'].map((name,index)=>index<2?{name,ok:true}:{name,ok:false,code:'EACCES'})};
  validateBoundaries(value,'lpac',session);value.operations[2].code='ENOENT';assert.throws(()=>validateBoundaries(value,'lpac',session));
});
