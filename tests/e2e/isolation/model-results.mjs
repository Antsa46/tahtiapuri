import assert from 'node:assert/strict';
import {validateCapabilityPolicy} from './capability-policy.mjs';
import {modelProfile,modelOptions,validateModelSelection} from './model-contract.mjs';
import {validateRuntimeEvidence,validateConsoleEvidence} from './sdk-runtime.mjs';
const one=(rows,type,source='host')=>{const found=rows.filter(x=>x.type===type&&x.source===source);assert.equal(found.length,1,`Expected one ${type}`);return found[0];};
export function validateModelProgress(rows,mode,kind,runtime,{held=false}={}){
 validateModelSelection(runtime.variant,mode,kind);assert.equal(runtime.kind,'node');
 assert(!rows.some(x=>['error','model-error','sdk-child','inspected-child'].includes(x.type)));
 const primary=one(rows,'launched');assert.equal(primary.requestedPolicy,mode);assert.equal(primary.appContainer,mode==='lpac');
 assert.equal(primary.job,true);assert.equal(primary.aclsVerified,true);assert.equal(primary.sentinelInherited,false);
 assert(Object.hasOwn(primary,'capabilitySids')&&Object.hasOwn(primary,'capabilityPolicy'));
 validateCapabilityPolicy(primary,mode,mode==='lpac'?'registryRead':'none');assert.equal(primary.integrity,mode==='lpac'?4096:8192);
 assert(Number.isInteger(primary.lpacQueryBytes)&&primary.lpacQueryBytes>=0);
 const profiles=rows.filter(x=>x.type==='profile'&&x.source==='host');assert.equal(profiles.length,mode==='lpac'?1:0);
 if(mode==='lpac'){assert.equal(primary.sid,profiles[0].sid);if(primary.lpac===null)assert.equal(primary.lpacQueryError,87);else{assert.equal(primary.lpac,true);assert.equal(primary.lpacQueryError,0);assert.equal(primary.lpacQueryBytes,4);}}
 else{assert.equal(primary.sid,'');assert.equal(primary.lpac,false);assert.equal(primary.lpacQueryError,0);assert.equal(primary.lpacQueryBytes,0);}
 const limits=one(rows,'model-limits');assert.deepEqual({...limits,type:undefined,source:undefined},{type:undefined,source:undefined,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:6442450944,readback:true});
 const pin=one(rows,'model-pin');assert.equal(pin.present,kind!=='missing-model');
 if(pin.present){assert.equal(pin.bytes,modelProfile.bytes);assert.equal(pin.inherit,false);assert.equal(pin.writeError,32);assert.equal(pin.deleteError,32);}else assert.equal(pin.missingError,2);
 assert(rows.indexOf(pin)<rows.indexOf(primary));assert(rows.indexOf(limits)<rows.indexOf(primary));
 const policy=one(rows,'model-policy','worker');assert.equal(policy.pid,primary.pid);
 const expected=['package-read','scratch-write','outside-read','outside-write','code-write','weights-fixture-write','aap-read'];
 assert.deepEqual(policy.operations.map(x=>x.name).sort(),expected.sort());
 for(const op of policy.operations){const allowed=mode==='control'||['package-read','scratch-write'].includes(op.name);assert.equal(op.ok,allowed,`Unexpected permission: ${op.name}`);if(!allowed)assert(['EACCES','EPERM'].includes(op.code));}
 const phases=rows.filter(x=>x.type==='model-phase'&&x.source==='worker');
 const phase=name=>{const matches=phases.filter(x=>x.phase===name);assert.equal(matches.length,1,`Expected phase ${name}`);assert.equal(matches[0].passed,true);return matches[0];};
 const runtimeRow=phase('runtime');validateRuntimeEvidence([{...runtimeRow,type:'sdk-phase',phase:'runtime-contract'}],runtime);
 const cpu=phase('cpu');assert.equal(cpu.gpu,false);assert.equal(cpu.buildType,'prebuilt');assert.equal(cpu.maxThreads,1);
 if(kind==='missing-model'){
  assert.deepEqual(phases.map(x=>x.phase),['runtime','cpu','llama-disposed']);const error=one(rows,'model-expected-failure','worker');assert.equal(error.code,'ENOENT');assert.equal(error.phase,'load');
 }else{
  const weight=phase('weights');assert.equal(weight.bytes,modelProfile.bytes);assert.equal(weight.sha256,modelProfile.sha256);
  const loaded=phase('loaded');assert.equal(loaded.id,modelProfile.id);assert.equal(loaded.templateSha256,modelProfile.templateSha256);assert.equal(loaded.gpuLayers,0);assert.equal(loaded.useMmap,true);assert.equal(loaded.contextCreated,false);assert.equal(loaded.generation,false);assert.deepEqual(loaded.options,modelOptions);assert(Number.isFinite(loaded.size)&&loaded.size>0);
  assert.equal(rows.filter(x=>x.type==='model-expected-failure').length,0);
  assert.deepEqual(phases.map(x=>x.phase),kind==='owner-loaded'?['runtime','weights','cpu','loaded']:['runtime','weights','cpu','loaded','model-disposed','llama-disposed']);
 }
 if(kind==='owner-loaded'){const hold=one(rows,'model-held','worker');assert.equal(hold.pid,primary.pid);assert(rows.indexOf(hold)>rows.indexOf(phases.find(x=>x.phase==='loaded')));}
 else{assert.equal(rows.filter(x=>x.type==='model-held').length,0);assert.equal(phase('llama-disposed').disposed,true);if(kind==='normal')assert.equal(phase('model-disposed').disposed,true);}
 validateConsoleEvidence(rows,runtime,{ownerLoss:held||kind==='owner-loaded'});
 return primary;
}
export function modelProcessIds(result){
 const rows=result.records,pids=[result.launchedChildPid,one(rows,'launched').pid,one(rows,'console-host').pid];
 const owners=rows.filter(x=>x.type==='owner-host');if(result.kind==='owner-loaded'){assert.equal(owners.length,1);assert.equal(owners[0].source,'host');pids.push(owners[0].pid);}else assert.equal(owners.length,0);
 assert([result.driverPid,...pids].every(x=>Number.isSafeInteger(x)&&x>0&&x<=0xffffffff));assert.equal(new Set([result.driverPid,...pids]).size,pids.length+1);return pids;
}
export function validateModelLifecycle(result){
 const pids=modelProcessIds(result),o=result.processExitObservation;assert.equal(o?.allAbsent,true);assert.equal(o.beforeCleanup,true);assert.deepEqual([...o.pids].sort(),[...pids].sort());assert(Number.isSafeInteger(o.checkedAtMs)&&o.checkedAtMs>=result.startedAtMs);
 const finishes=result.records.filter(x=>x.type==='finished'&&x.source==='host');
 if(result.kind==='owner-loaded'){
  const t=result.termination;assert.equal(t?.targetPid,result.launchedChildPid);assert.equal(t.targetRole,'owner');assert.equal(t.signal,'SIGTERM');assert.equal(t.succeeded,true);assert.equal(t.targetAliveBeforeRequest,true);assert(Number.isSafeInteger(t.requestedAtMs)&&t.requestedAtMs>=result.startedAtMs&&t.requestedAtMs<=o.checkedAtMs);
  assert.deepEqual(result.exit,{code:null,signal:'SIGTERM'});assert(finishes.length<=1);if(finishes.length){assert.equal(finishes[0].ownerGone,true);assert.equal(finishes[0].activeProcesses,0);assert.equal(finishes[0].exitCode,42);}
 }else{
  assert.equal(result.termination,undefined);assert.equal(finishes.length,1);assert.equal(finishes[0].ownerGone,false);assert.equal(finishes[0].activeProcesses,0);assert.equal(finishes[0].exitCode,result.kind==='normal'?0:17);assert.deepEqual(result.exit,{code:result.kind==='normal'?0:1,signal:null});
  if(result.kind==='normal'){const released=one(result.records,'model-pin-released');assert.equal(released.processesStopped,true);assert(result.records.indexOf(released)>result.records.indexOf(finishes[0]));}
 }
}
