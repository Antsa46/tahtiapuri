import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isReady,isSession} from '../../../packages/validation/dist/backend-protocol.js';
import {decodeJson} from './backend-codec.mjs';
import {validatePrepared,validateBoundaries} from './backend-port.mjs';

const cases=Object.freeze({
  'owner-before-start':{resumed:false,exitCode:42,watchdog:1,failure:'owner-eof',error:109,ownerMessages:0,terminalKind:'owner-eof',terminalBody:''},
  'early-close':{resumed:true,exitCode:67,watchdog:3,failure:'unexpected-worker-exit',error:1067,ownerMessages:1,terminalKind:'close-child-input',terminalBody:''},
  'invalid-utf8':{resumed:true,exitCode:65,watchdog:3,failure:'unexpected-worker-exit',error:1067,ownerMessages:2,terminalKind:'invalid-utf8',terminalBody:'/w=='},
});
const evidenceKeys=['kind','mode','session','prepared','started','result','frames','stderrBase64','brokerStderrBase64',
  'brokerExitCode','brokerSignal','outerComplete','innerComplete','ownerMessages','terminal','processesAbsent','writerFailure'];
const resultKeys=['passed','childCreated','childResumed','exitCode','watchdog','jobEmpty','persistentAclRestored','profileDeleted',
  'consoleBefore','consoleAfterFirstFrame','consoleCheckedSequence','framesReceived','bytesReceived','ownerMessages',
  'stderrComplete','stderrBytes','failure','error'];
function exact(value,keys){
  assert(value&&typeof value==='object'&&!Array.isArray(value),'Expected an evidence object');
  assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),'Unexpected evidence fields');
}
function base64(value,maxBytes){
  assert.equal(typeof value,'string');assert(value.length<=4*Math.ceil(maxBytes/3),'Base64 evidence exceeds budget');
  const bytes=Buffer.from(value,'base64');
  assert.equal(bytes.toString('base64'),value,'Noncanonical base64 evidence');assert(bytes.length<=maxBytes);
  return bytes;
}

/** Expected negative outcomes are distinct from the normal ChildPort success contract. */
export function validateNegativeCase(evidence){
  exact(evidence,evidenceKeys);
  assert.equal(typeof evidence.kind,'string');
  assert(Object.hasOwn(cases,evidence.kind),'Unknown negative lifecycle case');
  assert(['control','lpac'].includes(evidence.mode),'Unknown negative lifecycle policy');assert(isSession(evidence.session));
  const expected=cases[evidence.kind],prepared=validatePrepared(evidence.prepared,evidence.mode);
  assert.equal(typeof prepared.childNonce,'string');
  assert.equal(evidence.started,expected.resumed);
  assert.equal(evidence.brokerExitCode,1);assert.equal(evidence.brokerSignal,null);assert.equal(evidence.writerFailure,null);
  for(const key of ['outerComplete','innerComplete','processesAbsent'])assert.equal(evidence[key],true,key+' was not confirmed');
  assert.deepEqual(evidence.terminal,{kind:expected.terminalKind,drained:true,bodyBase64:expected.terminalBody},'Wrong or undrained terminal action');
  assert.equal(base64(evidence.terminal.bodyBase64,1).length,evidence.kind==='invalid-utf8'?1:0);
  assert.equal(base64(evidence.stderrBase64,0).length,0);assert.equal(base64(evidence.brokerStderrBase64,0).length,0);
  assert.equal(evidence.ownerMessages,expected.ownerMessages);

  assert(Array.isArray(evidence.frames));assert.equal(evidence.frames.length,expected.resumed?2:0,'Unexpected inner frame count');
  let bytesReceived=0;
  const messages=evidence.frames.map((record,index)=>{
    exact(record,['sequence','bytes','sha256','bodyBase64']);assert.equal(record.sequence,index+1);
    assert(Number.isSafeInteger(record.bytes)&&record.bytes>0&&record.bytes<=16384,'Invalid inner payload size');
    assert.equal(typeof record.sha256,'string');assert(/^[a-f0-9]{64}$/.test(record.sha256),'Invalid inner payload digest');
    const bytes=base64(record.bodyBase64,16384);assert.equal(bytes.length,record.bytes,'Inner payload length differs');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256,'Inner payload digest differs');
    bytesReceived+=bytes.length;return decodeJson(bytes);
  });
  if(expected.resumed){
    assert(isReady(messages[0],evidence.session),'First APP is not actual backend ready');
    validateBoundaries(messages[1],evidence.mode,evidence.session);
  }

  const result=evidence.result;exact(result,resultKeys);
  assert.equal(result.passed,false,'A negative case cannot claim normal success');
  for(const key of ['childCreated','jobEmpty','persistentAclRestored','profileDeleted','consoleBefore'])assert.equal(result[key],true,key+' was not confirmed');
  assert.equal(result.childResumed,expected.resumed);assert.equal(result.exitCode,expected.exitCode);
  assert.equal(result.watchdog,expected.watchdog);assert.equal(result.failure,expected.failure);assert.equal(result.error,expected.error);
  assert.equal(result.consoleAfterFirstFrame,expected.resumed);assert.equal(result.consoleCheckedSequence,expected.resumed?1:0);
  assert.equal(result.framesReceived,evidence.frames.length);assert.equal(result.bytesReceived,bytesReceived);
  assert.equal(result.ownerMessages,evidence.ownerMessages);assert.equal(result.stderrBytes,0);
  assert.equal(typeof result.stderrComplete,'boolean');
  if(!expected.resumed)assert.equal(result.stderrComplete,false,'Suspended child had no stderr reader');
  return {kind:evidence.kind,mode:evidence.mode,expectedFailureHandled:true,normalExit:false,
    workerExitCode:result.exitCode,brokerExitCode:1,jobEmpty:true,persistentAclRestored:true,profileDeleted:true,processesAbsent:true,
    stderrComplete:result.stderrComplete,lpacTokenReported:prepared.lpac};
}
