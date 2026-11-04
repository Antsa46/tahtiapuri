import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {modelCases,modelSha256,validateResult,validateFailedCreationCleanup} from './native-model-results.mjs';
const launch=(mode='lpac')=>({type:'launched',requestedPolicy:mode,pid:123,appContainer:mode!=='control',
  lpac:mode==='control'?false:null,lpacQueryError:mode==='control'?0:87,lpacQueryBytes:0,capabilities:0,integrity:mode==='control'?8192:4096,
  sid:mode==='control'?'':'S-1-15-2-1-2-3-4-5-6-7',job:true,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:6*1024**3,
  sentinelInherited:false,aclsVerified:true,networkVerified:false});
const result=kind=>({type:'result',case:kind,passed:true,jobEmpty:true,profileDeleted:true,watchdogReason:kind==='owner-loss'?1:0,failure:'',error:0});
const rows=(kind='normal',mode='lpac')=>[launch(mode),
  {type:'model-identity',modelPinned:kind!=='missing-model',modelSha256:kind==='missing-model'?'':modelSha256,runtimePinned:true},
  ...(kind.startsWith('missing-')?[{type:'model-expected-failure',stage:kind==='missing-model'?'model-load':'engine-library-ggml-cpu.dll'}]:[
    {type:'model-loaded',context:512,batch:32,threads:1,gpuLayers:0,cpuDevices:1,templateVerified:true,
      privateReadError:mode==='control'?0:5,readonlyWriteError:mode==='control'?0:5,scratchWriteError:0},
    ...(kind==='owner-loss'?[{type:'await-owner',pid:123}]:[
      ...(kind==='shutdown-pending'?[]:[{type:'model-output',inputTokens:50,outputTokens:kind==='normal'?2:0,
        reason:kind==='normal'?0:2,decodeAborted:kind!=='normal',textHex:kind==='normal'?Buffer.from('Jupiter').toString('hex'):''}]),
      {type:'model-shutdown',disposedAfterJoin:true,decodeAborted:kind!=='normal'}])]),result(kind)];
for(const mode of ['control','lpac'])for(const kind of modelCases)test('validates '+mode+'/'+kind,()=>{
  const verdict=validateResult(rows(kind,mode),mode,kind,{code:0,signal:null});
  assert.equal(verdict.networkVerified,false);assert.equal(verdict.cpuModelCompatible,!kind.startsWith('missing-'));
  assert.equal(verdict.expectedFailureHandled,kind.startsWith('missing-'));
  assert.equal(verdict.lpacTokenReported,mode==='control'?false:null);
});
for(const [label,mutate] of [
  ['unverified weights',r=>r[1].modelPinned=false],['wrong digest',r=>r[1].modelSha256='0'.repeat(64)],
  ['unverified DLLs',r=>r[1].runtimePinned=false],['model load missing',r=>r.splice(2,1)],
  ['extra capabilities',r=>r[0].capabilities=1],['larger memory budget',r=>r[0].jobCommitBytes*=2],
  ['template mismatch',r=>r[2].templateVerified=false],['private data readable',r=>r[2].privateReadError=0],
  ['readonly writable',r=>r[2].readonlyWriteError=0],['no scratch access',r=>r[2].scratchWriteError=5],
  ['wrong answer',r=>r[3].textHex=Buffer.from('Saturnus').toString('hex')],['invalid UTF8',r=>r[3].textHex='ff'],
  ['generation truncated',r=>r[3].reason=1],['output above limit',r=>r[3].outputTokens=17],
  ['dispose before join',r=>r[4].disposedAfterJoin=false],['worker survives',r=>r[5].jobEmpty=false],
  ['profile retained',r=>r[5].profileDeleted=false],['unexpected timeout',r=>r[5].watchdogReason=2],
  ['unexpected report',r=>r.splice(1,0,{type:'success'})],['network overclaim',r=>r[0].networkVerified=true],
])test('rejects '+label,()=>{const r=rows();mutate(r);assert.throws(()=>validateResult(r,'lpac','normal',{code:0,signal:null}));});
test('cancel needs actual native decode abort',()=>{
  const r=rows('cancel');r[3].decodeAborted=false;
  assert.throws(()=>validateResult(r,'lpac','cancel',{code:0,signal:null}));
});
test('owner loss requires matching actual worker identity',()=>{
  const r=rows('owner-loss');r[3].pid++;
  assert.throws(()=>validateResult(r,'lpac','owner-loss',{code:0,signal:null}));
});
test('creation failure cleanup is explicit and cannot pass model validation',()=>{
  const r=[{...result('normal'),passed:false,failure:'create-child',error:5}];
  assert(validateFailedCreationCleanup(r,'normal',{code:1,signal:null}));
  for(const bad of [[],[{...r[0],jobEmpty:false}],[{...r[0],failure:'sha-read'}]])
    assert.throws(()=>validateFailedCreationCleanup(bad,'normal',{code:1,signal:null}));
  assert.throws(()=>validateResult(r,'lpac','normal',{code:1,signal:null}));
});
test('compiled fixture and pinned identities agree with source profiles',async()=>{
  const json=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
  const model=await json('../../../resources/models/qwen3-4b.json');
  const runtime=await json('../../../resources/runtimes/llama-cpp-cpu.json');
  const fixture=await json('../../fixtures/native-cpu-prompt.json');
  const header=await readFile(new URL('native/native-model-fixture.h',import.meta.url),'utf8');
  const pins=await readFile(new URL('native/native-model-pins.h',import.meta.url),'utf8');
  assert.equal(JSON.parse(header.match(/constexpr char prompt\[\]=(.*);/)[1]),fixture.formatted);
  assert.equal(createHash('sha256').update(fixture.formatted).digest('hex'),fixture.formattedSha256);
  assert.equal(fixture.templateSha256,model.expectedChatTemplateSha256);
  assert(header.includes(fixture.templateSha256));assert(pins.includes(model.sha256));assert.equal(modelSha256,model.sha256);
  const source=await json('../../../resources/runtimes/llama-cpp-source-cpu.json');
  assert.equal(source.revision,runtime.revision);
  assert.deepEqual(source.dlls,['ggml-base.dll','ggml.dll','llama.dll','ggml-cpu.dll']);
  for(const [name,entry]of Object.entries(source.headersAndLicense))assert.equal(entry.sha256,runtime.files[name].sha256);
  assert(pins.includes('#include "native-model-runtime-pins.h"'));
});
