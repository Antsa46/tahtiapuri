import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {contextOptions,inferenceOptions,inferenceInput,validateInferenceSelection,loadKind} from './inference-contract.mjs';
import {validateModelProgress,validateModelLifecycle,modelProcessIds} from './model-results.mjs';
const promptSha256=createHash('sha256').update(JSON.stringify(inferenceInput)).digest('hex');
const positive=(value,max)=>assert(Number.isSafeInteger(value)&&value>0&&value<=max);
export function validateInferenceProgress(rows,mode,kind,runtime,options={}){
  validateInferenceSelection(mode,kind);
  // The unchanged loader/Job/token/console evidence is a prefix of T09f.
  validateModelProgress(rows,mode,loadKind(kind),runtime,options);
  const phases=rows.filter(x=>x.type==='inference-phase');
  assert(phases.every(x=>x.source==='worker'&&x.passed===true));
  const expected=['context','generation-start','generation-finished',...(kind==='owner-context'?['context-held']:['session-disposed','context-disposed'])];
  assert.deepEqual(phases.map(x=>x.phase),expected);
  const [context,start,finished]=phases;
  assert.deepEqual(context.options,contextOptions);assert.equal(context.reasoning,false);
  for(const key of ['sessionAlive','sequenceAlive','contextAlive'])assert.equal(context[key],true);
  const a=context.actual;positive(a.stateSize,Number.MAX_SAFE_INTEGER);
  assert.deepEqual({...a,stateSize:undefined},{contextSize:512,batchSize:32,sequences:1,idealThreads:1,currentThreads:1,flashAttention:false,allocatedContextSize:512,stateSize:undefined});
  assert.deepEqual(start.options,inferenceOptions);assert.equal(start.tools,false);assert.equal(start.promptSha256,promptSha256);
  positive(finished.meter.usedInputTokens,512);positive(finished.meter.usedOutputTokens,16);
  positive(finished.firstBatch,16);positive(finished.streamTokens,16);assert(finished.streamTokens>=finished.firstBatch&&finished.streamTokens<=finished.meter.usedOutputTokens);
  if(kind==='cancel')assert(Number.isSafeInteger(finished.responseBytes)&&finished.responseBytes>=0&&finished.responseBytes<=4096);else positive(finished.responseBytes,4096);assert.match(finished.responseSha256,/^[a-f0-9]{64}$/);assert.equal(finished.currentThreads,1);assert.equal(finished.timeoutAborted,false);
  assert.equal(finished.cancelRequested,kind==='cancel');assert.equal(finished.cancelReason,kind==='cancel'?'first-token-batch':null);
  if(kind==='cancel')assert.equal(finished.stopReason,'abort');else assert(['maxTokens','eogToken','stopGenerationTrigger'].includes(finished.stopReason));
  assert(rows.indexOf(context)>rows.indexOf(rows.find(x=>x.type==='model-phase'&&x.phase==='loaded')));
  if(kind==='owner-context'){
    const held=phases[3];for(const key of ['sessionAlive','sequenceAlive','contextAlive','modelAlive','generationSettled'])assert.equal(held[key],true);
    assert(rows.indexOf(held)<rows.indexOf(rows.find(x=>x.type==='model-held')));
  }else{
    assert.equal(phases[3].disposed,true);assert.equal(phases[3].sequenceDisposed,true);assert.equal(phases[4].disposed,true);
    assert(rows.indexOf(phases[4])<rows.indexOf(rows.find(x=>x.type==='model-phase'&&x.phase==='model-disposed')));
  }
}
const loaderResult=result=>({...result,kind:loadKind(result.kind)});
export function inferenceProcessIds(result){return modelProcessIds(loaderResult(result));}
export function validateInferenceLifecycle(result){
  validateInferenceSelection(result.mode,result.kind);assert.match(result.profileIntent,/^tahtiapuri\.t09f\.[a-f0-9]{32}$/);
  if(result.mode==='lpac')assert.equal(result.records.find(x=>x.type==='profile'&&x.source==='host').name,result.profileIntent);
  validateModelLifecycle(loaderResult(result));
}
