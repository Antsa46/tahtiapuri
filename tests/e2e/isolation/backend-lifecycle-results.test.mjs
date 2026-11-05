import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateNegativeCase} from './backend-lifecycle-results.mjs';
import {validateNativeResult} from './backend-port.mjs';

const session='a'.repeat(64),childNonce='b'.repeat(64);
function payload(sequence,value){
  const body=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
  return {sequence,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex'),bodyBase64:body.toString('base64')};
}
function fixture(kind='early-close',mode='control'){
  const resumed=kind!=='owner-before-start';
  const prepared={pid:123,childNonce,requestedPolicy:mode,creationMode:'detached-backend-probe',appContainer:mode==='lpac',
    lpac:mode==='lpac'?null:false,lpacQueryError:mode==='lpac'?87:0,lpacQueryBytes:0,
    capabilitySids:mode==='lpac'?[{sid:'S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681',attributes:4}]:[],
    integrity:mode==='lpac'?4096:8192,job:true,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:536870912,
    sentinelInherited:false,aclsVerified:true,consoleAbsent:true,networkVerified:false};
  const frames=resumed?[payload(1,{type:'ready',protocol:1,session}),payload(2,{type:'probe.boundaries',session,
    operations:['package-read','scratch-write','private-read','private-write','code-write','aap-read'].map(name=>
      mode==='control'||['package-read','scratch-write'].includes(name)?{name,ok:true}:{name,ok:false,code:'EACCES'})})]:[];
  const ownerMessages=!resumed?0:kind==='early-close'?1:2;
  return {kind,mode,session,prepared,started:resumed,
    result:{passed:false,childCreated:true,childResumed:resumed,exitCode:!resumed?42:kind==='early-close'?67:65,
      watchdog:resumed?3:1,jobEmpty:true,persistentAclRestored:true,profileDeleted:true,consoleBefore:true,
      consoleAfterFirstFrame:resumed,consoleCheckedSequence:resumed?1:0,framesReceived:frames.length,
      bytesReceived:frames.reduce((sum,row)=>sum+row.bytes,0),ownerMessages,stderrComplete:resumed,stderrBytes:0,
      failure:resumed?'unexpected-worker-exit':'owner-eof',error:resumed?1067:109},
    frames,stderrBase64:'',brokerStderrBase64:'',brokerExitCode:1,brokerSignal:null,outerComplete:true,innerComplete:true,ownerMessages,
    terminal:{kind:!resumed?'owner-eof':kind==='early-close'?'close-child-input':'invalid-utf8',drained:true,bodyBase64:kind==='invalid-utf8'?'/w==':''},
    processesAbsent:true,writerFailure:null};
}
function replacePayload(evidence,index,value){
  evidence.frames[index]=payload(index+1,value);evidence.result.bytesReceived=evidence.frames.reduce((sum,row)=>sum+row.bytes,0);
}

for(const kind of ['owner-before-start','early-close','invalid-utf8'])for(const mode of ['control','lpac'])test('accepts only the specified '+mode+'/'+kind+' failure with verified cleanup',()=>{
  const evidence=fixture(kind,mode),original=structuredClone(evidence),receipt=validateNegativeCase(evidence);
  assert.deepEqual(evidence,original);assert.equal(receipt.kind,kind);assert.equal(receipt.expectedFailureHandled,true);assert.equal(receipt.normalExit,false);
  assert.equal(receipt.workerExitCode,evidence.result.exitCode);assert.equal(receipt.lpacTokenReported,mode==='lpac'?null:false);
  assert.throws(()=>validateNativeResult(evidence.result),'Normal validator must remain strict');
});
test('preserves the observed resumed stderr completion flag without upgrading uncertainty',()=>{
  for(const stderrComplete of [true,false]){const evidence=fixture();evidence.result.stderrComplete=stderrComplete;assert.equal(validateNegativeCase(evidence).stderrComplete,stderrComplete);}
  const before=fixture('owner-before-start');before.result.stderrComplete=true;assert.throws(()=>validateNegativeCase(before));
  const wrong=fixture();wrong.result.stderrComplete='false';assert.throws(()=>validateNegativeCase(wrong));
});
test('rejects unknown cases, policies, invalid sessions and mismatched prepared identity',()=>{
  for(const patch of [{kind:'normal'},{kind:'generic-failure'},{mode:'ac'},{session:'a'.repeat(63)},{session:'A'.repeat(64)}])
    assert.throws(()=>validateNegativeCase({...fixture(),...patch}));
  for(const change of [value=>value.mode='lpac',value=>value.prepared.childNonce='b'.repeat(63),value=>value.prepared.pid=0,
    value=>value.prepared.capabilitySids=[{sid:'S-1-1-0',attributes:4}]]){
    const evidence=fixture();change(evidence);assert.throws(()=>validateNegativeCase(evidence));
  }
});
test('rejects extra or omitted fields in evidence, RESULT, frame and terminal action',()=>{
  for(const choose of [value=>value,value=>value.result,value=>value.frames[0],value=>value.terminal]){
    for(const extra of [true,false]){const evidence=fixture(),value=choose(evidence);if(extra)value.extra=true;else delete value[Object.keys(value)[0]];assert.throws(()=>validateNegativeCase(evidence));}
  }
});
test('requires exact worker exit, native failure reason, stage and error for each case',()=>{
  for(const kind of ['owner-before-start','early-close','invalid-utf8'])for(const patch of [
    {exitCode:0},{exitCode:42},{watchdog:2},{failure:'probe-deadline'},{error:5},{passed:true}
  ]){
    const evidence=fixture(kind);if(Object.entries(patch).every(([key,value])=>evidence.result[key]===value))continue;
    Object.assign(evidence.result,patch);assert.throws(()=>validateNegativeCase(evidence));
  }
});
test('does not confuse the two resumed worker error exit codes',()=>{
  const early=fixture();early.result.exitCode=65;assert.throws(()=>validateNegativeCase(early));
  const invalid=fixture('invalid-utf8');invalid.result.exitCode=67;assert.throws(()=>validateNegativeCase(invalid));
});
test('requires actual STARTED/resume and before/after console checks in their correct phases',()=>{
  for(const kind of ['owner-before-start','early-close'])for(const choose of [
    value=>value.started=!value.started,value=>value.result.childResumed=!value.result.childResumed,
    value=>value.result.consoleBefore=false,value=>value.result.consoleAfterFirstFrame=!value.result.consoleAfterFirstFrame,
    value=>value.result.consoleCheckedSequence=2
  ]){const evidence=fixture(kind);choose(evidence);assert.throws(()=>validateNegativeCase(evidence));}
});
test('rejects incomplete cleanup, live processes, incomplete streams and writer failure',()=>{
  for(const key of ['childCreated','jobEmpty','persistentAclRestored','profileDeleted']){
    const evidence=fixture();evidence.result[key]=false;assert.throws(()=>validateNegativeCase(evidence));
  }
  for(const patch of [{processesAbsent:false},{outerComplete:false},{innerComplete:false},{writerFailure:'synthetic-write-failure'},
    {brokerExitCode:0},{brokerExitCode:74},{brokerSignal:'SIGTERM'}])assert.throws(()=>validateNegativeCase({...fixture(),...patch}));
});
test('requires exactly zero or two ordered inner frames, never a generic ready-like acknowledgement',()=>{
  const before=fixture('owner-before-start');before.frames=[payload(1,{type:'ready',protocol:1,session})];assert.throws(()=>validateNegativeCase(before));
  for(const mutate of [value=>value.frames.pop(),value=>value.frames.push(structuredClone(value.frames[0])),
    value=>value.frames.reverse(),value=>value.frames[0].sequence=0,value=>value.frames[1].sequence=3]){
    const evidence=fixture();mutate(evidence);assert.throws(()=>validateNegativeCase(evidence));
  }
  const fake=fixture();replacePayload(fake,0,{type:'ready',protocol:1,session,passed:true});assert.throws(()=>validateNegativeCase(fake));
});
test('binds ready and boundary receipt to the same session and actual OS access results',()=>{
  for(const index of [0,1]){
    const evidence=fixture(),message=JSON.parse(Buffer.from(evidence.frames[index].bodyBase64,'base64').toString());message.session='c'.repeat(64);
    replacePayload(evidence,index,message);assert.throws(()=>validateNegativeCase(evidence));
  }
  const evidence=fixture('early-close','lpac'),boundary=JSON.parse(Buffer.from(evidence.frames[1].bodyBase64,'base64').toString());
  boundary.operations[2]={name:'private-read',ok:true};replacePayload(evidence,1,boundary);assert.throws(()=>validateNegativeCase(evidence));
});
test('verifies each raw payload length, digest, canonical base64 and fatal UTF-8',()=>{
  for(const mutate of [value=>value.frames[0].bytes++,value=>value.frames[0].sha256='0'.repeat(64),
    value=>value.frames[0].bodyBase64+='\n',value=>value.frames[0].bodyBase64='!not-base64!',
    value=>value.frames[0].sha256=value.frames[0].sha256.toUpperCase()]){
    const evidence=fixture();mutate(evidence);assert.throws(()=>validateNegativeCase(evidence));
  }
  const invalid=fixture();replacePayload(invalid,0,Buffer.from([255]));assert.throws(()=>validateNegativeCase(invalid));
  const oversized=fixture();replacePayload(oversized,0,Buffer.alloc(16385,32));assert.throws(()=>validateNegativeCase(oversized));
});
test('binds native aggregate frame, byte and owner message counts to the exact case evidence',()=>{
  for(const patch of [{framesReceived:1},{bytesReceived:0},{ownerMessages:0}]){
    const evidence=fixture();Object.assign(evidence.result,patch);assert.throws(()=>validateNegativeCase(evidence));
  }
  const forged=fixture();forged.ownerMessages=forged.result.ownerMessages=2;assert.throws(()=>validateNegativeCase(forged));
});
test('requires the drained terminal action and the exact raw FF payload for invalid UTF-8',()=>{
  for(const kind of ['owner-before-start','early-close','invalid-utf8'])for(const patch of [
    {drained:false},{kind:'kill'},{bodyBase64:'AA=='}
  ]){const evidence=fixture(kind);Object.assign(evidence.terminal,patch);assert.throws(()=>validateNegativeCase(evidence));}
  const invalid=fixture('invalid-utf8');invalid.terminal.bodyBase64='';assert.throws(()=>validateNegativeCase(invalid));
});
test('rejects diagnostic bytes or mismatched native stderr counts instead of losing errors',()=>{
  for(const key of ['stderrBase64','brokerStderrBase64']){
    const evidence=fixture();evidence[key]=Buffer.from('SYNTHETIC ERROR\n').toString('base64');assert.throws(()=>validateNegativeCase(evidence));
  }
  const evidence=fixture();evidence.result.stderrBytes=1;assert.throws(()=>validateNegativeCase(evidence));
});
