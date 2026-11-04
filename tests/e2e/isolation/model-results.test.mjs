import test from 'node:test';
import assert from 'node:assert/strict';
import {modelCase,runtime} from './model-results.fixture.mjs';
import {validateModelProgress,validateModelLifecycle} from './model-results.mjs';
import {modelProfile,validateModelProfile,validateModelSelection} from './model-contract.mjs';
const verify=r=>{validateModelProgress(r.records,r.mode,r.kind,runtime);validateModelLifecycle(r);};
for(const mode of ['control','lpac'])for(const kind of ['normal','missing-model','owner-loaded'])test(`${mode}/${kind}: complete named evidence`,()=>verify(modelCase(mode,kind)));
for(const field of ['file','id','bytes','sha256','templateSha256'])test(`model profile rejects modified ${field}`,()=>assert.throws(()=>validateModelProfile({...modelProfile,[field]:'unapproved'})));
test('candidate selection rejects unknown profiles, lifetimes and runtimes',()=>{
 for(const args of [['official','lpac','normal'],['local-patched','ac','normal'],['local-patched','lpac','missing-binary']])assert.throws(()=>validateModelSelection(...args));
});
const changes={
 'different capability':r=>{r.records.find(x=>x.type==='launched').capabilitySids[0].sid='S-1-15-3-1';},
 'unexpected capability':r=>{r.records.find(x=>x.type==='launched').capabilitySids.push({sid:'S-1-15-3-1',attributes:4});},
 'different package':r=>{r.records.find(x=>x.type==='launched').sid='S-1-15-2-OTHER';},
 'unknown query failure':r=>{r.records.find(x=>x.type==='launched').lpacQueryError=5;},
 'missing weight pin':r=>{r.records=r.records.filter(x=>x.type!=='model-pin');},
 'inheritable pin':r=>{r.records.find(x=>x.type==='model-pin').inherit=true;},
 'sharing is not ACL evidence':r=>{r.records.find(x=>x.type==='model-pin').writeError=5;},
 'missing file pin':r=>{r.records.find(x=>x.type==='model-pin').present=false;},
 'unverified job limits':r=>{r.records.find(x=>x.type==='model-limits').readback=false;},
 'two active workers':r=>{r.records.find(x=>x.type==='model-limits').activeProcessLimit=2;},
 'wrong weight hash':r=>{r.records.find(x=>x.phase==='weights').sha256='b'.repeat(64);},
 'wrong template':r=>{r.records.find(x=>x.phase==='loaded').templateSha256='b'.repeat(64);},
 'GPU fallback':r=>{r.records.find(x=>x.phase==='loaded').gpuLayers=1;},
 'vocabulary-only load':r=>{r.records.find(x=>x.phase==='loaded').options.vocabOnly=true;},
 'context created':r=>{r.records.find(x=>x.phase==='loaded').contextCreated=true;},
 'generation attempted':r=>{r.records.find(x=>x.phase==='loaded').generation=true;},
 'missing model disposal':r=>{r.records=r.records.filter(x=>x.phase!=='model-disposed');},
 'false model disposal':r=>{r.records.find(x=>x.phase==='model-disposed').disposed=false;},
 'false llama disposal':r=>{r.records.find(x=>x.phase==='llama-disposed').disposed=false;},
 'model error mixed with success':r=>{r.records.push({type:'model-error',source:'worker',phase:'load',code:'EACCES'});},
 'private file readable':r=>{r.records.find(x=>x.type==='model-policy').operations.find(x=>x.name==='outside-read').ok=true;},
 'weight fixture writable':r=>{r.records.find(x=>x.type==='model-policy').operations.find(x=>x.name==='weights-fixture-write').ok=true;},
 'missing AAP fixture':r=>{r.records.find(x=>x.type==='model-policy').operations.find(x=>x.name==='aap-read').code='ENOENT';},
 'worker forges host token':r=>{r.records.find(x=>x.type==='launched').source='worker';},
 'child evidence required instead of model':r=>{r.records.push({type:'sdk-child',source:'worker',pid:106});},
 'console not stopped':r=>{r.records.find(x=>x.type==='console-finished').stopped=false;},
 'wrong exit':r=>{r.exit.code=1;},
 'pin released before process stop':r=>{r.records.find(x=>x.type==='model-pin-released').processesStopped=false;},
 'missing PID observation':r=>{delete r.processExitObservation;},
 'missing console PID':r=>{r.processExitObservation.pids.pop();},
 'cleanup cannot substitute for exit':r=>{r.processExitObservation.beforeCleanup=false;},
 'overlapping process roles':r=>{r.driverPid=102;}
};
for(const [name,mutate] of Object.entries(changes))test(`rejects ${name}`,()=>{const r=modelCase();mutate(r);assert.throws(()=>verify(r));});
for(const code of ['EACCES','EPERM','ENOMEM',undefined])test(`missing-model rejects ${code} instead of ENOENT`,()=>{const r=modelCase('lpac','missing-model');r.records.find(x=>x.type==='model-expected-failure').code=code;assert.throws(()=>verify(r));});
for(const flaw of ['wrong-target','already-exited','before-loaded','missing-owner'])test(`owner loss rejects ${flaw}`,()=>{
 const r=modelCase('lpac','owner-loaded');if(flaw==='wrong-target')r.termination.targetPid=102;if(flaw==='already-exited')r.termination.targetAliveBeforeRequest=false;if(flaw==='before-loaded')r.records=r.records.filter(x=>x.phase!=='loaded');if(flaw==='missing-owner')r.processExitObservation.pids.pop();assert.throws(()=>verify(r));
});

for(const value of [undefined,-1,0.5])test(`rejects invalid LPAC query byte count ${value}`,()=>{const r=modelCase();r.records.find(x=>x.type==='launched').lpacQueryBytes=value;assert.throws(()=>verify(r));});
test('pin release cannot precede process finish',()=>{const r=modelCase();const i=r.records.findIndex(x=>x.type==='model-pin-released');const [release]=r.records.splice(i,1);r.records.unshift(release);assert.throws(()=>verify(r));});
