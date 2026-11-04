import test from 'node:test';
import assert from 'node:assert/strict';
import {inferenceCase} from './inference-results.fixture.mjs';
import {runtime,modelCase} from './model-results.fixture.mjs';
import {validateInferenceProgress,validateInferenceLifecycle} from './inference-results.mjs';
import {validateInferenceSelection} from './inference-contract.mjs';
const verify=r=>{validateInferenceProgress(r.records,r.mode,r.kind,runtime);validateInferenceLifecycle(r);};
const phase=(r,name)=>r.records.find(x=>x.type==='inference-phase'&&x.phase===name);
for(const mode of ['control','lpac'])for(const kind of ['normal','cancel','owner-context'])test(`${mode}/${kind}: bounded real-generation evidence`,()=>verify(inferenceCase(mode,kind)));
test('loading-only evidence cannot pass as inference',()=>assert.throws(()=>verify(modelCase())));
for(const args of [['ac','normal'],['lpac','missing-model'],['lpac','owner-loaded']])test(`rejects unapproved selection ${args}`,()=>assert.throws(()=>validateInferenceSelection(...args)));
const changes={
 'wrong context size':r=>phase(r,'context').actual.contextSize=2048,
 'parallel sequences':r=>phase(r,'context').actual.sequences=2,
 'wrong batch':r=>phase(r,'context').actual.batchSize=512,
 'unbounded threads':r=>phase(r,'context').actual.currentThreads=8,
 'missing context allocation':r=>phase(r,'context').actual.stateSize=0,
 'reasoning enabled':r=>phase(r,'context').reasoning=true,
 'different prompt':r=>phase(r,'generation-start').promptSha256='c'.repeat(64),
 'tools enabled':r=>phase(r,'generation-start').tools=true,
 'unbounded output options':r=>phase(r,'generation-start').options.maxTokens=1000,
 'no input evaluation':r=>phase(r,'generation-finished').meter.usedInputTokens=0,
 'no real output':r=>phase(r,'generation-finished').meter.usedOutputTokens=0,
 'too many output tokens':r=>phase(r,'generation-finished').meter.usedOutputTokens=17,
 'no streamed tokens':r=>phase(r,'generation-finished').streamTokens=0,
 'stream exceeds real generation':r=>phase(r,'generation-finished').streamTokens=17,
 'empty response':r=>phase(r,'generation-finished').responseBytes=0,
 'oversized response':r=>phase(r,'generation-finished').responseBytes=4097,
 'invalid response hash':r=>phase(r,'generation-finished').responseSha256='model control command',
 'deadline mistaken for success':r=>phase(r,'generation-finished').timeoutAborted=true,
 'unexpected abort':r=>phase(r,'generation-finished').stopReason='abort',
 'tools called':r=>phase(r,'generation-finished').stopReason='functionCalls',
 'sequence left alive':r=>phase(r,'session-disposed').sequenceDisposed=false,
 'context left alive':r=>phase(r,'context-disposed').disposed=false,
 'missing disposal':r=>{r.records=r.records.filter(x=>x.phase!=='context-disposed');},
 'duplicate generation':r=>r.records.push({...phase(r,'generation-finished')}),
 'host-forged inference record':r=>phase(r,'context').source='host',
 'foreign experiment prefix':r=>r.profileIntent='tahtiapuri.t09e.'+'a'.repeat(32),
 'different profile name':r=>r.records.find(x=>x.type==='profile').name='other',
 'model disposed before context':r=>{const i=r.records.findIndex(x=>x.phase==='model-disposed');r.records.unshift(...r.records.splice(i,1));}
};
for(const [name,change]of Object.entries(changes))test(`rejects ${name}`,()=>{const r=inferenceCase();change(r);assert.throws(()=>verify(r));});
for(const key of ['cancelRequested','cancelReason','stopReason'])test(`cancel requires own first-batch ${key}`,()=>{const r=inferenceCase('lpac','cancel');phase(r,'generation-finished')[key]=null;assert.throws(()=>verify(r));});
for(const key of ['sessionAlive','sequenceAlive','contextAlive','modelAlive','generationSettled'])test(`owner loss requires ${key}`,()=>{const r=inferenceCase('lpac','owner-context');phase(r,'context-held')[key]=false;assert.throws(()=>verify(r));});

test('first-batch cancellation need not produce completed visible text',()=>{const r=inferenceCase('lpac','cancel');phase(r,'generation-finished').responseBytes=0;phase(r,'generation-finished').responseSha256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';verify(r);});
for(const bytes of [-1,0.5,4097])test(`cancel rejects invalid response byte count ${bytes}`,()=>{const r=inferenceCase('lpac','cancel');phase(r,'generation-finished').responseBytes=bytes;assert.throws(()=>verify(r));});
