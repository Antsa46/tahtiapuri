import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateAdverseCase} from './backend-adverse-results.mjs';
import {validateNativeResult} from './backend-port.mjs';
import {requireAdverseRuntimeFiles} from './run-backend-adverse-probe.mjs';

// Independent golden signatures: these do not import the production case table or frame encoder.
const cases=['owner-eof-model-pending','owner-header20-eof-before-start','owner-app65537-header-before-start','sky-output-pause-kill'];
const session='a'.repeat(64),childNonce='b'.repeat(64),ownerNonce='c'.repeat(64);
const requestId='11111111-2222-4333-8444-555555555555',jobId='66666666-7777-4888-8999-000000000000';
const pendingInput={prompt:'SYNTHETIC PENDING OWNER',backend:'cpu'};
const skyInput={atUtc:'2026-01-01T00:00:00.000Z',timeZone:'UTC',observer:{latitudeDeg:0,longitudeDeg:0,elevationMeters:0}};
const raw20=Buffer.from('54424950010001000100000000000000cccccccc','hex');
const raw48=Buffer.from('54424950010002000100000001000100'+'cc'.repeat(32),'hex');
const skyHeader=Buffer.from('54424950010002000300000000002000'+'bb'.repeat(32),'hex');
function payload(sequence,value){
  const body=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
  return {sequence,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex'),bodyBase64:body.toString('base64')};
}
function fixture(caseId='owner-eof-model-pending',mode='control'){
  const prepared={pid:123,childNonce,requestedPolicy:mode,creationMode:'detached-backend-probe',appContainer:mode==='lpac',
    lpac:mode==='lpac'?null:false,lpacQueryError:mode==='lpac'?87:0,lpacQueryBytes:0,
    capabilitySids:mode==='lpac'?[{sid:'S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681',attributes:4}]:[],
    integrity:mode==='lpac'?4096:8192,job:true,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:536870912,
    sentinelInherited:false,aclsVerified:true,consoleAbsent:true,networkVerified:false};
  const resumed=caseId===cases[0]||caseId===cases[3];
  const frames=resumed?[payload(1,{type:'ready',protocol:1,session}),payload(2,{type:'probe.boundaries',session,
    operations:['package-read','scratch-write','private-read','private-write','code-write','aap-read'].map(name=>
      mode==='control'||['package-read','scratch-write'].includes(name)?{name,ok:true}:{name,ok:false,code:'EACCES'})})]:[];
  const evidence={caseId,mode,ownerNonce,session,prepared,started:resumed,result:{passed:false,childCreated:true,childResumed:resumed,
    exitCode:42,jobEmpty:true,persistentAclRestored:true,profileDeleted:true,consoleBefore:true,consoleAfterFirstFrame:resumed,
    consoleCheckedSequence:resumed?1:0,framesReceived:0,bytesReceived:0,ownerMessages:resumed?2:0,stderrComplete:resumed,stderrBytes:0},
    frames,stderrBase64:'',brokerStderrBase64:'',brokerExitCode:1,brokerSignal:null,outerComplete:true,innerComplete:true,
    ownerMessages:resumed?2:0,terminal:null,processesAbsent:true,writerFailure:null,activity:null,partial:null};
  if(caseId==='owner-eof-model-pending'){
    Object.assign(evidence.result,{watchdog:1,failure:'owner-eof',error:109});evidence.terminal={kind:'owner-eof',drained:true,bodyBase64:''};
    frames.push(payload(3,{type:'model.run',session,id:jobId,input:pendingInput}),payload(4,{type:'response',protocol:1,session,id:requestId,
      operation:'assistant.submit',result:{ok:true,job:{id:jobId,state:'loading',text:'',error:null,info:null}}}));
    evidence.activity={requestId,jobId,input:structuredClone(pendingInput),replySent:false};
  }else if(caseId==='owner-header20-eof-before-start'){
    Object.assign(evidence.result,{watchdog:3,failure:'frame-truncated',error:109});evidence.terminal={kind:'header20-eof',drained:true,bodyBase64:raw20.toString('base64')};
  }else if(caseId==='owner-app65537-header-before-start'){
    Object.assign(evidence.result,{watchdog:3,failure:'frame-header',error:13});evidence.terminal={kind:'app65537-header',drained:true,bodyBase64:raw48.toString('base64')};
  }else if(caseId==='sky-output-pause-kill'){
    Object.assign(evidence.result,{watchdog:4,failure:'owner-kill',error:995});evidence.terminal={kind:'kill',drained:true,bodyBase64:''};evidence.innerComplete=false;
    evidence.activity={requestId,input:structuredClone(skyInput),childPid:123,childAbsenceBudgetMs:1500,pausedBytes:4096,
      trace:[{event:'pause',atMs:100},{event:'kill-requested',atMs:101},{event:'kill-drained',atMs:102},{event:'child-absent',atMs:110},{event:'stdout-resumed',atMs:111}]};
    const opening='{"type":"response","protocol":1,"session":"'+session+'","id":"'+requestId+'","operation":"sky.snapshot","result":{"ok":true,"snapshot":{"syntheticPartial":"';
    const prefix=Buffer.from(opening+'x'.repeat(4096-opening.length));
    evidence.partial={sequence:3,headerBase64:skyHeader.toString('base64'),declaredBytes:2097152,receivedBytes:8192,prefixBase64:prefix.toString('base64'),eofError:'Truncated TBIP frame.'};
  }else throw new Error('Unknown fixture');
  evidence.result.framesReceived=frames.length;evidence.result.bytesReceived=frames.reduce((sum,value)=>sum+value.bytes,0);return evidence;
}
function replace(evidence,index,value){evidence.frames[index]=payload(index+1,value);evidence.result.bytesReceived=evidence.frames.reduce((sum,row)=>sum+row.bytes,0);}
function changeMessage(evidence,index,mutate){const value=JSON.parse(Buffer.from(evidence.frames[index].bodyBase64,'base64'));mutate(value);replace(evidence,index,value);}
function rejected(caseId,mutate){const evidence=fixture(caseId);mutate(evidence);assert.throws(()=>validateAdverseCase(evidence));}

for(const caseId of cases)for(const mode of ['control','lpac'])test('accepts exactly '+mode+'/'+caseId+' with confirmed cleanup',()=>{
  const evidence=fixture(caseId,mode),before=structuredClone(evidence),receipt=validateAdverseCase(evidence);
  assert.deepEqual(evidence,before);assert.equal(receipt.caseId,caseId);assert.equal(receipt.expectedFailureHandled,true);assert.equal(receipt.normalExit,false);
  assert.equal(receipt.workerExitCode,42);assert.equal(receipt.brokerExitCode,1);assert.equal(receipt.lpacTokenReported,mode==='lpac'?null:false);
  assert.throws(()=>validateNativeResult(evidence.result),'Positive validator must retain its normal success contract');
});
test('keeps resumed stderr completion uncertainty and suspended false unchanged',()=>{
  for(const caseId of [cases[0],cases[3]])for(const value of [true,false]){const evidence=fixture(caseId);evidence.result.stderrComplete=value;assert.equal(validateAdverseCase(evidence).stderrComplete,value);}
  for(const caseId of [cases[1],cases[2]])rejected(caseId,value=>value.result.stderrComplete=true);
  rejected(cases[0],value=>value.result.stderrComplete='false');
});
test('uses an exact case whitelist and rejects invalid policy or nonce/session identities',()=>{
  for(const caseId of ['generic-failure','normal','owner-before-start','__proto__','constructor','',null])assert.throws(()=>validateAdverseCase({...fixture(),caseId}));
  for(const patch of [{mode:'ac'},{session:'A'.repeat(64)},{session:'a'.repeat(63)},{ownerNonce:'z'.repeat(64)},{ownerNonce:childNonce}])assert.throws(()=>validateAdverseCase({...fixture(),...patch}));
  rejected(cases[0],value=>value.prepared.childNonce='b'.repeat(63));rejected(cases[0],value=>value.prepared.pid=0);
  rejected(cases[0],value=>value.mode='lpac');
});
test('rejects missing or extra fields throughout evidence and native RESULT',()=>{
  for(const choose of [value=>value,value=>value.result,value=>value.prepared,value=>value.frames[0],value=>value.terminal,value=>value.activity])for(const extra of [true,false]){
    rejected(cases[0],evidence=>{const value=choose(evidence);if(extra)value.extra=true;else delete value[Object.keys(value)[0]];});
  }
  for(const choose of [value=>value.partial,value=>value.activity,value=>value.activity.trace[0]])for(const extra of [true,false]){
    rejected(cases[3],evidence=>{const value=choose(evidence);if(extra)value.extra=true;else delete value[Object.keys(value)[0]];});
  }
});
test('requires exact native reason, stage, error and worker/broker exits independently for each case',()=>{
  const golden=[[cases[0],1,'owner-eof',109],[cases[1],3,'frame-truncated',109],[cases[2],3,'frame-header',13],[cases[3],4,'owner-kill',995]];
  for(const [caseId,watchdog,failure,error]of golden){
    const evidence=fixture(caseId);assert.equal(evidence.result.watchdog,watchdog);assert.equal(evidence.result.failure,failure);assert.equal(evidence.result.error,error);
    for(const patch of [{watchdog:2},{failure:'probe-deadline'},{error:5},{exitCode:0},{exitCode:65},{passed:true}])rejected(caseId,value=>Object.assign(value.result,patch));
    for(const patch of [{brokerExitCode:0},{brokerExitCode:74},{brokerSignal:'SIGTERM'}])rejected(caseId,value=>Object.assign(value,patch));
  }
  rejected(cases[1],value=>value.result.error=13);rejected(cases[2],value=>value.result.error=109);
});
test('requires real STARTED and exact console and complete-frame counters for the phase',()=>{
  for(const caseId of cases)for(const mutate of [value=>value.started=!value.started,value=>value.result.childResumed=!value.result.childResumed,
    value=>value.result.consoleAfterFirstFrame=!value.result.consoleAfterFirstFrame,value=>value.result.consoleCheckedSequence=2,
    value=>value.result.framesReceived++,value=>value.result.bytesReceived++,value=>value.result.ownerMessages++])rejected(caseId,mutate);
  for(const caseId of cases)rejected(caseId,value=>{value.ownerMessages++;value.result.ownerMessages++;});
});
test('requires complete outer EOF, exact allowed inner EOF, actual process absence and all cleanup evidence',()=>{
  for(const caseId of cases){
    for(const key of ['childCreated','jobEmpty','persistentAclRestored','profileDeleted','consoleBefore'])rejected(caseId,value=>value.result[key]=false);
    for(const patch of [{outerComplete:false},{processesAbsent:false},{writerFailure:'synthetic error'}])rejected(caseId,value=>Object.assign(value,patch));
    rejected(caseId,value=>value.innerComplete=!value.innerComplete);
  }
});
test('requires exact drained terminal bytes with no replacement zero-read error alternative',()=>{
  for(const caseId of cases)for(const mutate of [value=>value.terminal.drained=false,value=>value.terminal.kind='generic-error',
    value=>value.terminal.bodyBase64+='AA=='])rejected(caseId,mutate);
  for(const caseId of [cases[1],cases[2]])for(const offset of [0,4,6,8,12,16])rejected(caseId,value=>{
    const bytes=Buffer.from(value.terminal.bodyBase64,'base64');bytes[offset]^=1;value.terminal.bodyBase64=bytes.toString('base64');
  });
  rejected(cases[1],value=>value.terminal.bodyBase64=raw20.subarray(0,19).toString('base64'));
  rejected(cases[2],value=>value.terminal.bodyBase64=Buffer.concat([raw48,Buffer.from([0])]).toString('base64'));
});
test('verifies full raw bodies by canonical base64, exact bytes, digest, UTF-8 and sequence',()=>{
  for(const mutate of [value=>value.frames[0].bytes++,value=>value.frames[0].sha256='0'.repeat(64),value=>value.frames[0].bodyBase64+='\n',
    value=>value.frames[0].bodyBase64='not-base64!',value=>value.frames[0].sequence=2,value=>value.frames.reverse(),value=>value.frames.pop(),
    value=>value.frames.push(structuredClone(value.frames[0]))])rejected(cases[0],mutate);
  rejected(cases[0],value=>replace(value,0,Buffer.from([255])));rejected(cases[0],value=>replace(value,0,Buffer.alloc(16385,32)));
  for(const index of [0,1,2,3])rejected(cases[0],value=>changeMessage(value,index,message=>message.session='d'.repeat(64)));
  rejected(cases[0],value=>changeMessage(value,0,message=>message.extra=true));
  const lpac=fixture(cases[0],'lpac');changeMessage(lpac,1,message=>message.operations[2]={name:'private-read',ok:true});assert.throws(()=>validateAdverseCase(lpac));
});
test('binds model.run input and pending loading response to the exact request and job',()=>{
  for(const mutate of [value=>value.activity.replySent=true,value=>value.activity.jobId=requestId,value=>value.activity.requestId=jobId,
    value=>value.activity.input.prompt='other synthetic',value=>value.activity.input.backend='cuda',value=>value.activity.input.extra=true,
    value=>value.partial={},value=>changeMessage(value,2,message=>message.type='model.progress'),
    value=>changeMessage(value,2,message=>message.input.prompt='other synthetic'),value=>changeMessage(value,3,message=>message.operation='assistant.get'),
    value=>changeMessage(value,3,message=>message.result.job.id=requestId),value=>changeMessage(value,3,message=>message.result.job.state='queued'),
    value=>changeMessage(value,3,message=>message.result.job.text='EARLY RESPONSE'),value=>changeMessage(value,3,message=>message.result.job.error='CANCELLED')])rejected(cases[0],mutate);
});
test('never accepts partial framing for another case or a completed third pressure frame',()=>{
  for(const caseId of [cases[0],cases[1],cases[2]]){rejected(caseId,value=>value.partial=fixture(cases[3]).partial);rejected(caseId,value=>value.innerComplete=false);}
  rejected(cases[3],value=>{value.frames.push(payload(3,{type:'response',protocol:1,session,id:requestId,operation:'sky.snapshot',result:{ok:false,code:'BUSY'}}));value.result.framesReceived=3;value.result.bytesReceived+=value.frames[2].bytes;});
  for(const eofError of ['',null,'Invalid TBIP header.','TBIP byte budget exceeded.'])rejected(cases[3],value=>value.partial.eofError=eofError);
  const receipt=validateAdverseCase(fixture(cases[3]));assert.equal(receipt.fullSkyResultValidated,false);assert.equal(receipt.partialSkyEnvelopeObserved,true);
});
test('requires a large original sequence 3 child header and bounded incomplete body/prefix',()=>{
  for(const mutate of [value=>value.partial.sequence=4,value=>value.partial.declaredBytes=1048576,value=>value.partial.declaredBytes=16777217,
    value=>value.partial.receivedBytes=0,value=>value.partial.receivedBytes=value.partial.declaredBytes,value=>value.activity.pausedBytes=0,
    value=>value.activity.pausedBytes=value.partial.receivedBytes+1,value=>value.partial.prefixBase64='',
    value=>value.partial.prefixBase64=Buffer.alloc(4097,32).toString('base64'),value=>value.partial.prefixBase64+='\n'])rejected(cases[3],mutate);
  for(const offset of [0,4,6,8,12,16,47])rejected(cases[3],value=>{const bytes=Buffer.from(value.partial.headerBase64,'base64');bytes[offset]^=1;value.partial.headerBase64=bytes.toString('base64');});
  rejected(cases[3],value=>value.partial.headerBase64=skyHeader.subarray(0,47).toString('base64'));
  const short=fixture(cases[3]);short.partial.receivedBytes=short.activity.pausedBytes=32;short.partial.prefixBase64=Buffer.from(short.partial.prefixBase64,'base64').subarray(0,32).toString('base64');validateAdverseCase(short);
});
test('binds only available pressure envelope bytes to the synthetic sky request and session',()=>{
  for(const mutate of [value=>value.activity.requestId=jobId,value=>value.activity.input.atUtc='2026-01-02T00:00:00.000Z',
    value=>value.activity.childPid=124,value=>value.activity.childAbsenceBudgetMs=1501,value=>value.activity.input.observer.latitudeDeg=1,
    value=>{const bytes=Buffer.from(value.partial.prefixBase64,'base64');bytes[0]=255;value.partial.prefixBase64=bytes.toString('base64');},
    value=>{const text=Buffer.from(value.partial.prefixBase64,'base64').toString().replace('sky.snapshot','sky.select  ');value.partial.prefixBase64=Buffer.from(text).toString('base64');}])rejected(cases[3],mutate);
});
test('requires receiver pause, drained KILL, bounded actual child absence then resumed reads in order',()=>{
  for(const mutate of [value=>value.activity.trace.reverse(),value=>value.activity.trace.pop(),value=>value.activity.trace[0].event='pause-requested',
    value=>value.activity.trace[0].atMs=NaN,value=>value.activity.trace[0].atMs=-1,value=>value.activity.trace[1].atMs=100,
    value=>value.activity.trace[2].atMs=110,value=>value.activity.trace[4].atMs=110,
    value=>{value.activity.trace[3].atMs=1603;value.activity.trace[4].atMs=1604;},
    value=>value.activity.trace[3].event='broker-closed'])rejected(cases[3],mutate);
});
test('rejects diagnostic bytes and fake activity on suspended cases',()=>{
  for(const caseId of cases){
    for(const key of ['stderrBase64','brokerStderrBase64'])rejected(caseId,value=>value[key]=Buffer.from('SYNTHETIC ERROR').toString('base64'));
    rejected(caseId,value=>value.result.stderrBytes=1);
  }
  for(const caseId of [cases[1],cases[2]])rejected(caseId,value=>value.activity={replySent:false});
});
test('requires each new runtime source in the original build provenance',()=>{
  const paths=['backend-adverse-contract.mjs','backend-adverse-owner.mjs','backend-adverse-results.mjs','run-backend-adverse-probe.mjs','run-backend-adverse-limited.ps1'].map(name=>'tests/e2e/isolation/'+name);
  const build={files:paths.map(path=>({path}))};requireAdverseRuntimeFiles(build);
  for(const path of paths)assert.throws(()=>requireAdverseRuntimeFiles({files:build.files.filter(file=>file.path!==path)}));
});
