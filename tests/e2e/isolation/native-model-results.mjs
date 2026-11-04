import assert from 'node:assert/strict';
import {validateLaunch as launch} from './transport-results.mjs';
export const modelCases=Object.freeze(['normal','cancel','shutdown-pending','owner-loss','missing-model','missing-library']);
export const modelSha256='7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5';
const keys=(x,names)=>assert.deepEqual(Object.keys(x).sort(),names.split(' ').sort());
export const validateLaunch=(records,mode)=>launch(records,mode,6*1024**3);
export function validateResult(records,mode,kind,exit) {
  assert(modelCases.includes(kind));const child=validateLaunch(records,mode);
  assert.deepEqual(exit,{code:0,signal:null});
  const failure=kind.startsWith('missing-');
  const types=['launched','model-identity',...(failure?['model-expected-failure']:['model-loaded',
    ...(kind==='owner-loss'?['await-owner']:kind==='shutdown-pending'?['model-shutdown']:['model-output','model-shutdown'])]),'result'];
  assert.deepEqual(records.map(r=>r.type),types);
  assert.deepEqual(records[1],{type:'model-identity',modelPinned:kind!=='missing-model',modelSha256:kind==='missing-model'?'':modelSha256,runtimePinned:true});
  if(failure) assert.deepEqual(records[2],{type:'model-expected-failure',stage:kind==='missing-model'?'model-load':'engine-library-ggml-cpu.dll'});
  else {
    assert.deepEqual(records[2],{type:'model-loaded',context:512,batch:32,threads:1,gpuLayers:0,cpuDevices:1,templateVerified:true,
      privateReadError:mode==='control'?0:5,readonlyWriteError:mode==='control'?0:5,scratchWriteError:0});
    if(kind==='owner-loss')assert.deepEqual(records[3],{type:'await-owner',pid:child.pid});
    else {
      assert.deepEqual(records.at(-2),{type:'model-shutdown',disposedAfterJoin:true,decodeAborted:kind!=='normal'});
      if(kind!=='shutdown-pending') {
        const row=records[3];keys(row,'type inputTokens outputTokens reason decodeAborted textHex');
        assert(Number.isInteger(row.inputTokens)&&row.inputTokens>0&&row.inputTokens<=240);
        assert(Number.isInteger(row.outputTokens)&&row.outputTokens>=0&&row.outputTokens<=16);
        assert(typeof row.textHex==='string'&&/^(?:[0-9a-f]{2}){0,4096}$/.test(row.textHex));
        const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(row.textHex,'hex'));
        assert.equal(row.reason,kind==='normal'?0:2);assert.equal(row.decodeAborted,kind!=='normal');
        if(kind==='normal'){assert(row.outputTokens>0);assert.equal(text.trim(),'Jupiter');}
      }
    }
  }
  assert.deepEqual(records.at(-1),{type:'result',case:kind,passed:true,jobEmpty:true,profileDeleted:true,
    watchdogReason:kind==='owner-loss'?1:0,failure:'',error:0});
  return {cpuModelCompatible:!failure,expectedFailureHandled:failure,networkVerified:false,lpacTokenReported:child.lpac,fileProbes:failure?0:3};
}
export function validateFailedCreationCleanup(records,kind,exit) {
  assert(modelCases.includes(kind));assert.deepEqual(exit,{code:1,signal:null});assert.equal(records.length,1);
  const row=records[0];keys(row,'type case passed jobEmpty profileDeleted watchdogReason failure error');
  assert.equal(row.type,'result');assert.equal(row.case,kind);assert.equal(row.passed,false);
  assert.equal(row.jobEmpty,true);assert.equal(row.profileDeleted,true);assert.equal(row.watchdogReason,0);
  // Explicitly observed CreateProcess failure; no-launch alone is not cleanup proof.
  assert.equal(row.failure,'create-child');assert(Number.isInteger(row.error)&&row.error>0&&row.error<=0xffffffff);
  return true;
}
