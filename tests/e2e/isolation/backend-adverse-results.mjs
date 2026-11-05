import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {isReady,isResponse,isSession} from '../../../packages/validation/dist/backend-protocol.js';
import {isJobId} from '../../../packages/validation/dist/assistant.js';
import {isModelRun} from '../../../packages/validation/dist/model-wire.js';
import {decodeJson} from './backend-codec.mjs';
import {validatePrepared,validateBoundaries} from './backend-port.mjs';
import {ADVERSE_CASE_IDS,PENDING_MODEL_PROMPT,SKY_REQUEST_INPUT,CHILD_ABSENCE_BUDGET_MS} from './backend-adverse-contract.mjs';

const MiB=1024*1024;
const evidenceKeys=['caseId','mode','ownerNonce','session','prepared','started','result','frames','stderrBase64','brokerStderrBase64',
  'brokerExitCode','brokerSignal','outerComplete','innerComplete','ownerMessages','terminal','processesAbsent','writerFailure','activity','partial'];
const resultKeys=['passed','childCreated','childResumed','exitCode','watchdog','jobEmpty','persistentAclRestored','profileDeleted',
  'consoleBefore','consoleAfterFirstFrame','consoleCheckedSequence','framesReceived','bytesReceived','ownerMessages',
  'stderrComplete','stderrBytes','failure','error'];
const signatures=Object.freeze({
  'owner-eof-model-pending':{resumed:true,watchdog:1,failure:'owner-eof',error:109,ownerMessages:2,frames:4,terminal:'owner-eof'},
  'owner-header20-eof-before-start':{resumed:false,watchdog:3,failure:'frame-truncated',error:109,ownerMessages:0,frames:0,terminal:'header20-eof'},
  'owner-app65537-header-before-start':{resumed:false,watchdog:3,failure:'frame-header',error:13,ownerMessages:0,frames:0,terminal:'app65537-header'},
  'sky-output-pause-kill':{resumed:true,watchdog:4,failure:'owner-kill',error:995,ownerMessages:2,frames:2,terminal:'kill'},
});
function exact(value,keys){
  assert(value&&typeof value==='object'&&!Array.isArray(value),'Expected an evidence object');
  assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),'Unexpected evidence fields');
}
function integer(value,min,max=Number.MAX_SAFE_INTEGER){assert(Number.isSafeInteger(value)&&value>=min&&value<=max,'Invalid evidence integer');}
function base64(value,maxBytes){
  assert.equal(typeof value,'string');assert(value.length<=4*Math.ceil(maxBytes/3),'Base64 evidence exceeds budget');
  const bytes=Buffer.from(value,'base64');assert.equal(bytes.toString('base64'),value,'Noncanonical base64 evidence');
  assert(bytes.length<=maxBytes);return bytes;
}
function header(kind,nonce,length){
  const bytes=Buffer.alloc(48);bytes.write('TBIP',0,'ascii');bytes.writeUInt16LE(1,4);bytes.writeUInt16LE(kind,6);
  bytes.writeUInt32LE(1,8);bytes.writeUInt32LE(length,12);Buffer.from(nonce,'hex').copy(bytes,16);return bytes;
}
function validatePending(evidence,messages){
  const activity=evidence.activity;exact(activity,['requestId','jobId','input','replySent']);
  assert(isJobId(activity.requestId)&&isJobId(activity.jobId),'Invalid pending request or job identity');
  assert.deepEqual(activity.input,{prompt:PENDING_MODEL_PROMPT,backend:'cpu'});assert.equal(activity.replySent,false);
  const run=messages[2],response=messages[3];assert(isModelRun(run,evidence.session),'Third frame is not a typed model.run');
  assert.equal(run.id,activity.jobId);assert.deepEqual(run.input,activity.input);
  assert(isResponse(response,evidence.session),'Fourth frame is not a typed backend response');
  assert.equal(response.operation,'assistant.submit');assert.equal(response.id,activity.requestId);
  assert.deepEqual(response.result,{ok:true,job:{id:activity.jobId,state:'loading',text:'',error:null,info:null}},'Pending job was already changed');
  assert.equal(evidence.partial,null);
}
function validatePressure(evidence,prepared){
  const activity=evidence.activity;exact(activity,['requestId','input','childPid','childAbsenceBudgetMs','trace','pausedBytes']);
  assert(isJobId(activity.requestId));assert.deepEqual(activity.input,SKY_REQUEST_INPUT);
  assert.equal(activity.childPid,prepared.pid);assert.equal(activity.childAbsenceBudgetMs,CHILD_ABSENCE_BUDGET_MS);
  assert(Array.isArray(activity.trace));
  const events=['pause','kill-requested','kill-drained','child-absent','stdout-resumed'];assert.equal(activity.trace.length,events.length);
  activity.trace.forEach((entry,index)=>{exact(entry,['event','atMs']);assert.equal(entry.event,events[index]);
    assert(typeof entry.atMs==='number'&&Number.isFinite(entry.atMs)&&entry.atMs>=0,'Invalid monotonic observation');
    if(index)assert(entry.atMs>=activity.trace[index-1].atMs,'Out-of-order pressure observations');});
  const times=activity.trace.map(entry=>entry.atMs);
  assert(times[0]<times[1]&&times[2]<times[3]&&times[3]<times[4],'Pressure read pause did not span the KILL and verified child absence');
  assert(times[3]-times[2]<=CHILD_ABSENCE_BUDGET_MS,'Child absence exceeded the bounded paused interval');
  const partial=evidence.partial;exact(partial,['sequence','headerBase64','declaredBytes','receivedBytes','prefixBase64','eofError']);
  assert.equal(partial.sequence,3);integer(partial.declaredBytes,MiB+1,16*MiB);
  integer(partial.receivedBytes,1,partial.declaredBytes-1);integer(activity.pausedBytes,1,partial.receivedBytes);
  assert.equal(partial.eofError,'Truncated TBIP frame.','Only the specified incomplete inner body is expected');
  const rawHeader=base64(partial.headerBase64,48);assert.equal(rawHeader.length,48);
  const expected=header(2,prepared.childNonce,partial.declaredBytes);expected.writeUInt32LE(3,8);
  assert(rawHeader.equals(expected),'Partial sky frame header differs from the original child APP sequence 3');
  const prefix=base64(partial.prefixBase64,4096);assert.equal(prefix.length,Math.min(4096,partial.receivedBytes));
  // The prefix authenticates only the available envelope bytes, never the full sky result.
  new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(prefix,{stream:true});
  const opening=Buffer.from(JSON.stringify({type:'response',protocol:1,session:evidence.session,id:activity.requestId,operation:'sky.snapshot'}).slice(0,-1)+',"result":');
  const compared=Math.min(prefix.length,opening.length);assert(prefix.subarray(0,compared).equals(opening.subarray(0,compared)),'Partial sky response identity differs');
}

/** Accepts exactly four deliberate adverse outcomes, separately from normal ChildPort exit. */
export function validateAdverseCase(evidence){
  exact(evidence,evidenceKeys);assert(ADVERSE_CASE_IDS.includes(evidence.caseId),'Unknown backend adverse case');
  assert(Object.hasOwn(signatures,evidence.caseId),'Unspecified backend adverse case');
  assert(['control','lpac'].includes(evidence.mode));assert(isSession(evidence.ownerNonce)&&isSession(evidence.session));
  const expected=signatures[evidence.caseId],pressure=evidence.caseId==='sky-output-pause-kill';
  const prepared=validatePrepared(evidence.prepared,evidence.mode);assert.notEqual(evidence.ownerNonce,prepared.childNonce,'Nonce domains overlap');
  assert.equal(evidence.started,expected.resumed);assert.equal(evidence.brokerExitCode,1);assert.equal(evidence.brokerSignal,null);
  assert.equal(evidence.writerFailure,null);assert.equal(evidence.processesAbsent,true);assert.equal(evidence.outerComplete,true);
  assert.equal(evidence.innerComplete,!pressure,'Unexpected incomplete inner channel');
  assert.equal(base64(evidence.stderrBase64,0).length,0);assert.equal(base64(evidence.brokerStderrBase64,0).length,0);
  assert.equal(evidence.ownerMessages,expected.ownerMessages);
  exact(evidence.terminal,['kind','drained','bodyBase64']);assert.equal(evidence.terminal.kind,expected.terminal);assert.equal(evidence.terminal.drained,true);
  const terminal=base64(evidence.terminal.bodyBase64,48);
  if(evidence.caseId==='owner-header20-eof-before-start')assert(terminal.equals(header(1,evidence.ownerNonce,0).subarray(0,20)),'Expected the exact first 20 START header bytes');
  else if(evidence.caseId==='owner-app65537-header-before-start')assert(terminal.equals(header(2,evidence.ownerNonce,65537)),'Expected only the exact oversized APP header');
  else assert.equal(terminal.length,0);

  assert(Array.isArray(evidence.frames));assert.equal(evidence.frames.length,expected.frames,'Unexpected complete inner frame count');
  let bytesReceived=0;
  const messages=evidence.frames.map((record,index)=>{
    exact(record,['sequence','bytes','sha256','bodyBase64']);assert.equal(record.sequence,index+1);integer(record.bytes,1,16384);
    assert.equal(typeof record.sha256,'string');assert(/^[a-f0-9]{64}$/.test(record.sha256));
    const bytes=base64(record.bodyBase64,16384);assert.equal(bytes.length,record.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256,'Inner payload digest differs');
    bytesReceived+=bytes.length;return decodeJson(bytes);
  });
  if(expected.resumed){assert(isReady(messages[0],evidence.session),'First frame is not actual backend ready');validateBoundaries(messages[1],evidence.mode,evidence.session);}
  if(evidence.caseId==='owner-eof-model-pending')validatePending(evidence,messages);
  else if(pressure)validatePressure(evidence,prepared);
  else{assert.equal(evidence.activity,null);assert.equal(evidence.partial,null);}

  const result=evidence.result;exact(result,resultKeys);assert.equal(result.passed,false,'Adverse evidence cannot claim normal success');
  for(const key of ['childCreated','jobEmpty','persistentAclRestored','profileDeleted','consoleBefore'])assert.equal(result[key],true,key+' was not confirmed');
  assert.equal(result.childResumed,expected.resumed);assert.equal(result.exitCode,42);assert.equal(result.watchdog,expected.watchdog);
  assert.equal(result.failure,expected.failure);assert.equal(result.error,expected.error);
  assert.equal(result.consoleAfterFirstFrame,expected.resumed);assert.equal(result.consoleCheckedSequence,expected.resumed?1:0);
  assert.equal(result.framesReceived,evidence.frames.length);assert.equal(result.bytesReceived,bytesReceived);
  assert.equal(result.ownerMessages,evidence.ownerMessages);assert.equal(result.stderrBytes,0);assert.equal(typeof result.stderrComplete,'boolean');
  if(!expected.resumed)assert.equal(result.stderrComplete,false,'Suspended child had no stderr reader');
  return {caseId:evidence.caseId,mode:evidence.mode,expectedFailureHandled:true,normalExit:false,workerExitCode:42,brokerExitCode:1,
    jobEmpty:true,persistentAclRestored:true,profileDeleted:true,processesAbsent:true,stderrComplete:result.stderrComplete,
    lpacTokenReported:prepared.lpac,...(pressure?{partialSkyEnvelopeObserved:true,fullSkyResultValidated:false}:{})};
}
