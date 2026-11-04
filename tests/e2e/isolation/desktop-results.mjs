import assert from 'node:assert/strict';
const one = (rows, type, source) => { const values=rows.filter(row=>row.type===type&&row.source===source); assert.equal(values.length,1,`Expected one ${type}`); return values[0]; };
export function validateDesktopProgress(rows, mode, version, expectedProfile) {
  assert(!rows.some(row=>row.type==='desktop-debug'),'Debugger observations cannot accept a normal GUI run.');
  assert(['control','ac'].includes(mode));assert.match(expectedProfile,/^tahtiapuri\.t09g\.[a-f0-9]{32}$/);
  assert(!rows.some(row=>row.type==='error'||row.type==='desktop-phase'&&['error','timeout','renderer-gone'].includes(row.phase)));
  const launch=one(rows,'launched','host');
  assert.equal(launch.requestedPolicy,mode);assert.equal(launch.appContainer,mode==='ac');
  assert.equal(launch.job,true);assert.equal(launch.aclsVerified,true);assert.equal(launch.sentinelInherited,false);
  assert.equal(launch.capabilities,0);assert.deepEqual(launch.capabilitySids,[]);assert.equal(launch.capabilityPolicy,'none');
  if(mode==='ac'){assert.equal(launch.integrity,4096);assert.match(launch.sid,/^S-1-15-2-/);}else{assert.equal(launch.sid,'');assert.equal(launch.integrity,8192);assert(!rows.some(row=>['profile','cleanup'].includes(row.type)));}
  if(launch.lpac===null){assert.equal(launch.lpacQueryError,87);assert.equal(launch.lpacQueryBytes,0);}else assert.equal(launch.lpac,false);
  const limits=one(rows,'desktop-limits','host');
  assert.deepEqual(limits,{type:'desktop-limits',activeProcessLimit:16,affinity:1,priority:'BelowNormal',jobCommitBytes:6442450944,readback:true,source:'host'});
  const phases=rows.filter(row=>row.type==='desktop-phase');assert(phases.every(row=>row.source==='worker'));
  assert.deepEqual(phases.map(row=>row.phase),['main','renderer-ready','processes','complete']);
  const [main,renderer,inventory]=phases;
  assert.equal(main.pid,launch.pid);assert.equal(main.processType,'browser');assert.equal(main.electron,version);assert.equal(main.softwareRendering,true);
  assert.equal(renderer.sandboxed,true);assert.equal(renderer.contextIsolation,true);assert.equal(renderer.nodeIntegration,false);
  assert.equal(renderer.webSecurity,true);assert.equal(renderer.pageVerified,true);assert.notEqual(renderer.pid,main.pid);
  const children=rows.filter(row=>row.type==='inspected-child'&&row.source==='host');assert(children.length>0&&children.length<=64);
  assert.equal(new Set(children.map(row=>row.pid)).size,children.length);
  for(const child of children){
    assert.equal(child.job,true);assert.equal(child.imageVerified,true);assert.equal(child.capabilities,0);assert.deepEqual(child.capabilitySids,[]);
    if(mode==='ac'){assert.equal(child.appContainer,true);assert.equal(child.sid,launch.sid);assert(child.integrity<=4096);}
  }
  const nativePids=new Set([launch.pid,...children.map(row=>row.pid)]);assert(nativePids.has(renderer.pid));
  assert(Array.isArray(inventory.metrics)&&inventory.metrics.length>=2&&inventory.metrics.length<=16);
  assert.equal(new Set(inventory.metrics.map(row=>row.pid)).size,inventory.metrics.length);
  for(const item of inventory.metrics){assert(nativePids.has(item.pid));assert.equal(typeof item.type,'string');assert(item.type.length>0&&item.type.length<=64);}
  assert(inventory.metrics.some(row=>row.pid===main.pid&&row.type==='Browser'));
  assert(inventory.metrics.some(row=>row.pid===renderer.pid&&row.type==='Tab'&&row.sandboxed===true));
  const policy=one(rows,'desktop-policy','worker');assert.equal(policy.pid,main.pid);
  assert.deepEqual(policy.operations.map(row=>row.name),['package-read','scratch-write','outside-read','outside-write','code-write']);
  for(const op of policy.operations){const allowed=mode==='control'||['package-read','scratch-write'].includes(op.name);assert.equal(op.ok,allowed,op.name);if(!allowed)assert(['EPERM','EACCES'].includes(op.code));}
  const finished=one(rows,'finished','host');assert.equal(finished.exitCode,0);assert.equal(finished.ownerGone,false);assert.equal(finished.activeProcesses,0);assert.equal(finished.totalProcesses,children.length+1,'A short-lived Job child was not inspected.');
  const console=one(rows,'console-host','host');assert.equal(console.soleClient,true);assert.equal(console.hidden,true);assert.equal(console.imageVerified,true);
  const closed=one(rows,'console-finished','host');assert.equal(closed.detached,true);assert.equal(closed.stopped,true);
  if(mode==='ac'){assert.equal(one(rows,'cleanup','host').hresult,0);const profile=one(rows,'profile','host');assert.equal(profile.sid,launch.sid);assert.equal(profile.name,expectedProfile);}
  assert(rows.indexOf(launch)<rows.indexOf(main));assert(rows.indexOf(phases.at(-1))<rows.indexOf(finished));
  return [...nativePids,console.pid];
}
