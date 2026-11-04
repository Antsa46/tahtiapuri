import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSdkSelection, sdkProcessIds, validateSdkLifecycle } from './sdk-candidate.mjs';
import { validateSdkEvidence } from './sdk-results.mjs';
import { registryReadSid } from './capability-policy.mjs';
const host = type => ({type,source:'host'}), worker = type => ({type,source:'worker'});
export function candidateRecords(mode='lpac') {
  const restricted=mode!=='control', lpac=mode==='lpac';
  const token={appContainer:restricted,sid:restricted?'S-1-15-2-SYNTHETIC':'',capabilities:lpac?1:0,capabilityPolicy:lpac?'registryRead':'none',capabilitySids:lpac?[{sid:registryReadSid,attributes:4}]:[],integrity:restricted?4096:8192,lpac:restricted?null:false,lpacQueryError:restricted?87:0,lpacQueryBytes:0};
  return [
    ...(restricted?[{...host('profile'),sid:token.sid}]:[]),
    {...host('launched'),...token,pid:102,job:true,aclsVerified:true,sentinelInherited:false,requestedPolicy:mode},
    {...worker('sdk-parent-policy'),pid:102,operations:[{name:'aap-read',ok:!lpac,...(lpac?{code:'EACCES'}:{})}]},
    {...worker('sdk-child'),pid:103,originalHelper:true,flags:['--preserve-symlinks','--preserve-symlinks-main','--require','synthetic-preload.cjs']},
    {...host('inspected-child'),...token,pid:103,job:true,imageVerified:true},
    {...worker('sdk-policy'),pid:103,operations:['package-read','scratch-write','outside-read','outside-write','code-write','aap-read'].map(name=>{
      const ok=name==='aap-read'?!lpac:['package-read','scratch-write'].includes(name)||!restricted;
      return {name,ok,...(!ok?{code:'EACCES'}:{})};
    })},
    {...host('console-host'),pid:104},
    {...host('finished'),ownerGone:false,activeProcesses:0,exitCode:0}
  ];
}
const validate=(rows,mode='lpac')=>validateSdkEvidence(rows,mode,{candidate:true,requireChild:true});
for(const mode of ['control','ac','lpac']) test(`${mode}: exact token and parent/helper AAP proof`,()=>validate(candidateRecords(mode),mode));
for(const runtime of ['electron','official','local-unpatched']) test(`candidate rejects ${runtime}`,()=>assert.throws(()=>validateSdkSelection(runtime,'lpac-registry-read',4)));
test('candidate selection is explicit and closed',()=>{validateSdkSelection('local-patched','lpac-registry-read',4);assert.throws(()=>validateSdkSelection('local-patched','lpac-typo',4));assert.throws(()=>validateSdkSelection('local-patched','lpac-registry-read',5));});
test('baseline validator cannot opt in to LPAC from records',()=>assert.throws(()=>validateSdkEvidence(candidateRecords(),'lpac',{requireChild:true})));
for(const type of ['launched','inspected-child']) {
  for(const change of ['extra-capability','wrong-sid','disabled','missing-set','wrong-profile','high-integrity','wrong-query'])test(`${type}: rejects ${change}`,()=>{
    const rows=candidateRecords(),row=rows.find(r=>r.type===type);
    if(change==='extra-capability')row.capabilitySids.push({sid:'S-1-15-3-1',attributes:4});
    if(change==='wrong-sid')row.capabilitySids[0].sid='S-1-15-3-1';
    if(change==='disabled')row.capabilitySids[0].attributes=0;
    if(change==='missing-set')delete row.capabilitySids;
    if(change==='wrong-profile')row.sid='S-1-15-2-OTHER';
    if(change==='high-integrity')row.integrity=8192;
    if(change==='wrong-query')row.lpacQueryError=5;
    assert.throws(()=>validate(rows));
  });
}
for(const type of ['sdk-parent-policy','sdk-policy'])for(const change of ['allowed','missing','wrong-error'])test(`${type}: rejects false AAP evidence ${change}`,()=>{
 const rows=candidateRecords(),row=rows.find(r=>r.type===type),op=row.operations.find(r=>r.name==='aap-read');
 if(change==='allowed')op.ok=true;if(change==='missing')row.operations=row.operations.filter(x=>x!==op);if(change==='wrong-error')op.code='ENOENT';
 assert.throws(()=>validate(rows));
});
function lifecycle(kind='normal') {
 const r={kind,records:candidateRecords(),driverPid:99,launchedChildPid:101,startedAtMs:1000,exit:{code:kind==='missing-binary'?1:0,signal:null}};
 if(kind==='missing-binary')r.records.find(x=>x.type==='finished').exitCode=17;
 if(kind==='owner-child'){
  r.records=r.records.filter(x=>x.type!=='finished');r.records.push({...host('owner-host'),pid:105});
  r.exit={code:null,signal:'SIGTERM'};r.termination={targetPid:101,targetRole:'owner',signal:'SIGTERM',succeeded:true,targetAliveBeforeRequest:true,requestedAtMs:1500};
 }
 r.processExitObservation={pids:sdkProcessIds(r),allAbsent:true,beforeCleanup:true,checkedAtMs:2000};return r;
}
for(const kind of ['normal','missing-binary','owner-child'])test(`${kind}: exact process disappearance proof`,()=>validateSdkLifecycle(lifecycle(kind)));
for(const change of ['missing-console','missing-parent','overlap','after-cleanup','wrong-owner','already-dead','wrong-exit'])test(`lifecycle rejects ${change}`,()=>{
 const r=lifecycle('owner-child');
 if(change==='missing-console')r.processExitObservation.pids=r.processExitObservation.pids.filter(p=>p!==104);
 if(change==='missing-parent')r.processExitObservation.pids=r.processExitObservation.pids.filter(p=>p!==102);
 if(change==='overlap')r.driverPid=103;
 if(change==='after-cleanup')r.processExitObservation.beforeCleanup=false;
 if(change==='wrong-owner')r.termination.targetPid=105;
 if(change==='already-dead')r.termination.targetAliveBeforeRequest=false;
 if(change==='wrong-exit')r.exit.code=0;
 assert.throws(()=>validateSdkLifecycle(r));
});

for(const type of ['launched','inspected-child']){
 test(`${type}: control is medium integrity and not an unknown AppContainer`,()=>{
  for(const field of ['integrity','lpac']){
   const rows=candidateRecords('control'),row=rows.find(r=>r.type===type);
   if(field==='integrity')row.integrity=4096;else{row.lpac=null;row.lpacQueryError=87;}
   assert.throws(()=>validate(rows,'control'));
  }
 });
 test(`${type}: successful LPAC flag query needs four bytes`,()=>{
  const rows=candidateRecords();for(const row of rows.filter(r=>['launched','inspected-child'].includes(r.type))){row.lpac=true;row.lpacQueryError=0;row.lpacQueryBytes=4;}
  validate(rows);rows.find(r=>r.type===type).lpacQueryBytes=0;assert.throws(()=>validate(rows));
 });
}
