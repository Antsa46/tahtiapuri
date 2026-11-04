import {createHash} from 'node:crypto';
import {modelCase} from './model-results.fixture.mjs';
import {contextOptions,inferenceOptions,inferenceInput,loadKind} from './inference-contract.mjs';
const phase=(name,values)=>({type:'inference-phase',source:'worker',phase:name,passed:true,...values});
export function inferenceCase(mode='lpac',kind='normal'){
  const result=modelCase(mode,loadKind(kind));result.kind=kind;result.profileIntent='tahtiapuri.t09f.'+'a'.repeat(32);
  const profile=result.records.find(x=>x.type==='profile');if(profile)profile.name=result.profileIntent;
  const phases=[
    phase('context',{options:{...contextOptions},reasoning:false,sessionAlive:true,sequenceAlive:true,contextAlive:true,actual:{contextSize:512,batchSize:32,sequences:1,idealThreads:1,currentThreads:1,flashAttention:false,allocatedContextSize:512,stateSize:1024}}),
    phase('generation-start',{options:{...inferenceOptions},tools:false,promptSha256:createHash('sha256').update(JSON.stringify(inferenceInput)).digest('hex')}),
    phase('generation-finished',{meter:{usedInputTokens:32,usedOutputTokens:kind==='cancel'?3:16},streamTokens:kind==='cancel'?3:16,firstBatch:3,cancelRequested:kind==='cancel',cancelReason:kind==='cancel'?'first-token-batch':null,timeoutAborted:false,stopReason:kind==='cancel'?'abort':'maxTokens',responseBytes:12,responseSha256:'b'.repeat(64),currentThreads:1}),
    ...(kind==='owner-context'?[phase('context-held',{sessionAlive:true,sequenceAlive:true,contextAlive:true,modelAlive:true,generationSettled:true})]:[phase('session-disposed',{disposed:true,sequenceDisposed:true}),phase('context-disposed',{disposed:true})])
  ];
  const loaded=result.records.findIndex(x=>x.type==='model-phase'&&x.phase==='loaded');result.records.splice(loaded+1,0,...phases);return result;
}
