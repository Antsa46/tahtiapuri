import assert from 'node:assert/strict';
import {TextDecoder} from 'node:util';

const cases=['normal','fail','owner-loss','owner-early','stalled-reader','startup-fail','invalid-utf8'];
const creationModes=['no-window-candidate','detached-control-diagnostic','detached-normal-candidate','detached-matrix-candidate'];
function exact(value,keys){
  assert(value&&typeof value==='object'&&!Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(),keys.sort());
}
function decode(hex){
  assert.equal(typeof hex,'string');assert(hex.length<=32768);assert(/^(?:[a-f0-9]{2})*$/.test(hex));
  return Buffer.from(hex,'hex');
}

export function validateResult(records,mode,kind,exit,{nodeVersion,creationMode}){
  assert(['control','ac','lpac'].includes(mode));assert(cases.includes(kind));assert(creationModes.includes(creationMode));
  assert.equal(typeof nodeVersion,'string');assert(/^\d+\.\d+\.\d+$/.test(nodeVersion));
  if(creationMode==='detached-control-diagnostic'){assert.equal(mode,'control');assert.equal(kind,'normal');}
  if(creationMode==='detached-normal-candidate')assert.equal(kind,'normal');
  if(creationMode==='detached-matrix-candidate'&&mode==='ac')assert.equal(kind,'normal');
  assert.deepEqual(exit,{code:0,signal:null});assert(Array.isArray(records));
  const expected=kind==='normal'?[[129,1],[130,2],[130,3],[134,4]]:
    ['owner-early','startup-fail'].includes(kind)?[]:kind==='stalled-reader'?[[129,1],[131,2]]:[[129,1]];
  const types=['launched',...expected.map(()=> 'worker-frame'),
    ...(kind.startsWith('owner-')?['await-owner']:[]),...(kind==='owner-early'?[]:['worker-stderr']),'result'];
  // The entire sequence is authoritative: an earlier failure cannot be hidden by a later result.
  assert.deepEqual(records.map(row=>row?.type),types);
  const l=records[0];
  exact(l,['type','pid','requestedPolicy','creationMode','appContainer','lpac','lpacQueryError','lpacQueryBytes','capabilitySids','integrity','job','activeProcessLimit','affinity','priority','jobCommitBytes','sentinelInherited','aclsVerified','consoleAbsent','networkVerified']);
  assert(Number.isSafeInteger(l.pid)&&l.pid>0&&l.pid<=0xffffffff);
  assert.equal(l.requestedPolicy,mode);assert.equal(l.creationMode,creationMode);assert.equal(l.appContainer,mode!=='control');assert.equal(l.integrity,mode==='control'?8192:4096);
  if(l.lpac===null){assert.equal(l.lpacQueryError,87);assert.equal(l.lpacQueryBytes,0);}
  else{assert.equal(l.lpac,mode==='lpac');assert.equal(l.lpacQueryError,0);}
  assert.deepEqual(l.capabilitySids,mode==='lpac'?[{sid:'S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681',attributes:4}]:[]);
  for(const key of ['job','aclsVerified','consoleAbsent'])assert.equal(l[key],true);
  assert.equal(l.sentinelInherited,false);assert.equal(l.networkVerified,false);assert.equal(l.activeProcessLimit,1);assert.equal(l.affinity,1);assert.equal(l.priority,'BelowNormal');assert.equal(l.jobCommitBytes,536870912);
  const result=records.at(-1);
  exact(result,['type','passed','launchReported','childCreated','childResumed','exitCode','watchdog','jobEmpty','profileDeleted','failure','error']);
  assert.equal(result.childResumed,kind!=='owner-early');
  for(const key of ['passed','launchReported','childCreated','jobEmpty','profileDeleted'])assert.equal(result[key],true);
  assert.equal(result.failure,'');assert.equal(result.error,0);
  assert.equal(result.exitCode,{fail:17,'owner-loss':42,'owner-early':42,'stalled-reader':42,'startup-fail':19,'invalid-utf8':65,normal:0}[kind]);
  if(kind==='stalled-reader')assert.equal(result.watchdog,2);
  else if(kind.startsWith('owner-'))assert([0,1].includes(result.watchdog));
  else assert.equal(result.watchdog,0);
  const frames=records.filter(row=>row.type==='worker-frame');
  for(const frame of frames){exact(frame,['type','op','id','bodyHex']);decode(frame.bodyHex);}
  assert.deepEqual(frames.map(frame=>[frame.op,frame.id]),expected);
  if(frames.length){
    const ready=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(frames[0].bodyHex)));
    exact(ready,['node','pid','execArgv','operations']);assert.equal(ready.pid,l.pid);assert.equal(ready.node,nodeVersion);
    assert.deepEqual(ready.execArgv,['--preserve-symlinks','--preserve-symlinks-main']);
    const names=['package-read','scratch-write','private-read','private-write','code-write','aap-read'];
    assert.deepEqual(ready.operations.map(operation=>operation.name),names);
    for(const operation of ready.operations){
      const allowed=mode==='control'||['package-read','scratch-write'].includes(operation.name)||(mode==='ac'&&operation.name==='aap-read');
      if(allowed)assert.deepEqual(operation,{name:operation.name,ok:true});
      else{exact(operation,['name','ok','code']);assert.equal(operation.ok,false);assert(['EACCES','EPERM'].includes(operation.code));}
    }
  }
  if(kind==='normal'){
    assert.deepEqual(decode(frames[1].bodyHex),Buffer.from('kuu'));
    assert.deepEqual(decode(frames[2].bodyHex),Buffer.alloc(16384,88));assert.equal(frames[3].bodyHex,'');
  }
  for(const diagnostic of records.filter(row=>row.type==='worker-stderr')){
    exact(diagnostic,['type','bodyHex']);
    assert.deepEqual(decode(diagnostic.bodyHex),Buffer.from(kind==='fail'?'SYNTHETIC JS FAILURE\n':''));
  }
  for(const owner of records.filter(row=>row.type==='await-owner'))assert.deepEqual(owner,{type:'await-owner'});
  return {pid:l.pid,exitCode:result.exitCode,consoleAbsent:true,jobEmpty:true,profileDeleted:true};
}
