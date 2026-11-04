import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {contextOptions,inferenceOptions,inferenceInput} from './inference-contract.mjs';
export async function runInference({model,life,emit}) {
  assert(['generate','cancel','context-hold'].includes(life));
  const {LlamaChatSession,JinjaTemplateChatWrapper}=await import('node-llama-cpp');
  let context,sequence,session;
  const phase=(name,data={})=>emit({type:'inference-phase',phase:name,passed:true,...data});
  try {
    context=await model.createContext({...contextOptions,createSignal:AbortSignal.timeout(30000)});
    const actual={contextSize:context.contextSize,batchSize:context.batchSize,sequences:context.totalSequences,idealThreads:context.idealThreads,currentThreads:context.currentThreads,flashAttention:context.flashAttention,allocatedContextSize:context.getAllocatedContextSize(),stateSize:context.stateSize};
    assert.equal(actual.contextSize,512);assert.equal(actual.batchSize,32);assert.equal(actual.sequences,1);assert.equal(actual.idealThreads,1);assert.equal(actual.currentThreads,1);assert.equal(actual.flashAttention,false);assert.equal(actual.allocatedContextSize,512);assert(Number.isSafeInteger(actual.stateSize)&&actual.stateSize>0);
    sequence=context.getSequence();
    const chatWrapper=new JinjaTemplateChatWrapper({template:model.fileInfo.metadata.tokenizer.chat_template,reasoning:false,tokenizer:model.tokenizer});
    session=new LlamaChatSession({contextSequence:sequence,chatWrapper,systemPrompt:inferenceInput.systemPrompt,autoDisposeSequence:false});
    assert.equal(session.disposed,false);assert.equal(sequence.disposed,false);assert.equal(context.disposed,false);
    phase('context',{options:contextOptions,actual,reasoning:false,sessionAlive:true,sequenceAlive:true,contextAlive:true});
    const before=sequence.tokenMeter.getState(),cancel=new AbortController(),timeout=AbortSignal.timeout(60000);
    const signal=AbortSignal.any([cancel.signal,timeout]);
    let firstBatch=0,streamTokens=0,cancelRequested=false,invalidTokenBatch=false;
    phase('generation-start',{options:inferenceOptions,tools:false,promptSha256:createHash('sha256').update(JSON.stringify(inferenceInput)).digest('hex')});
    const answer=await session.promptWithMeta(inferenceInput.prompt,{
      maxTokens:16,temperature:0,seed:42,signal,stopOnAbortSignal:true,
      onToken(tokens){
        if(!Array.isArray(tokens)||tokens.some(t=>!Number.isSafeInteger(t)||t<0)){invalidTokenBatch=true;return;}
        if(tokens.length===0)return;
        streamTokens+=tokens.length;
        if(firstBatch===0){firstBatch=tokens.length;if(life==='cancel'){cancelRequested=true;cancel.abort('t09f-first-token-batch');}}
      }
    });
    const meter=sequence.tokenMeter.diff(before);
    assert.equal(invalidTokenBatch,false);assert.equal(timeout.aborted,false);
    assert(Number.isSafeInteger(meter.usedInputTokens)&&meter.usedInputTokens>0&&meter.usedInputTokens<=512);
    assert(Number.isSafeInteger(meter.usedOutputTokens)&&meter.usedOutputTokens>0&&meter.usedOutputTokens<=16);
    assert(firstBatch>0&&streamTokens>=firstBatch&&streamTokens<=meter.usedOutputTokens);
    assert.equal(typeof answer.responseText,'string');if(life!=='cancel')assert(answer.responseText.trim().length>0);assert(Buffer.byteLength(answer.responseText)<=4096);
    if(life==='cancel'){assert.equal(cancelRequested,true);assert.equal(cancel.signal.reason,'t09f-first-token-batch');assert.equal(answer.stopReason,'abort');}
    else{assert.equal(cancelRequested,false);assert(['maxTokens','eogToken','stopGenerationTrigger'].includes(answer.stopReason));}
    phase('generation-finished',{meter,streamTokens,firstBatch,cancelRequested,cancelReason:cancelRequested?'first-token-batch':null,timeoutAborted:false,stopReason:answer.stopReason,responseBytes:Buffer.byteLength(answer.responseText),responseSha256:createHash('sha256').update(answer.responseText).digest('hex'),currentThreads:context.currentThreads});
    assert.equal(context.currentThreads,1);
    if(life==='context-hold'){
      assert(!session.disposed&&!sequence.disposed&&!context.disposed&&!model.disposed);
      phase('context-held',{sessionAlive:true,sequenceAlive:true,contextAlive:true,modelAlive:true,generationSettled:true});
      emit({type:'model-held',pid:process.pid});process.stdin.resume();await new Promise(()=>{});
    }
    session.dispose({disposeSequence:false});await sequence.dispose();assert.equal(session.disposed,true);assert.equal(sequence.disposed,true);phase('session-disposed',{disposed:true,sequenceDisposed:true});session=undefined;sequence=undefined;
    await context.dispose();assert.equal(context.disposed,true);phase('context-disposed',{disposed:true});context=undefined;
  } finally {
    session?.dispose({disposeSequence:false});await sequence?.dispose();await context?.dispose();
  }
}
