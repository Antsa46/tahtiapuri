import assert from 'node:assert/strict';
const policyNames=['package-read','scratch-write','outside-read','outside-write','code-write'];
export function validateSdkEvidence(records,mode,{requireChild=false}={}) {
  const launches=records.filter(r=>r.type==='launched'&&r.source==='host');assert.equal(launches.length,1);
  const main=launches[0];assert(main.job&&main.aclsVerified&&main.sentinelInherited===false);assert.equal(main.requestedPolicy,mode);assert.equal(main.appContainer,mode==='ac');assert.equal(main.capabilities,0);if(mode==='ac')assert.equal(main.integrity,4096);
  assert(!records.some(r=>r.type==='error'||r.type==='sdk-instrumentation-error'));
  const children=records.filter(r=>r.type==='sdk-child'),inspections=records.filter(r=>r.type==='inspected-child'),policies=records.filter(r=>r.type==='sdk-policy');
  assert(children.length<=1&&inspections.length<=1&&policies.length<=1,'Duplicate child evidence.');
  const child=children[0],inspected=inspections[0],policy=policies[0];
  if(requireChild)assert(child&&inspected&&policy,'Child evidence is incomplete.');
  if(child){assert.equal(child.source,'worker');assert.notEqual(child.pid,main.pid);assert.equal(child.originalHelper,true);assert.deepEqual(child.flags.slice(0,3),['--preserve-symlinks','--preserve-symlinks-main','--require']);assert.equal(child.flags.length,4);}
  if(inspected){assert(child);assert.equal(inspected.source,'host');assert.equal(inspected.pid,child.pid);assert(inspected.job&&inspected.imageVerified);assert.equal(inspected.appContainer,mode==='ac');assert.equal(inspected.capabilities,0);assert.equal(inspected.integrity,main.integrity);if(mode==='ac')assert.equal(inspected.sid,records.find(r=>r.type==='profile'&&r.source==='host')?.sid);}
  if(policy){assert(child);assert.equal(policy.source,'worker');assert.equal(policy.pid,child.pid);assert(Array.isArray(policy.operations));assert.deepEqual(policy.operations.map(r=>r.name).sort(),[...policyNames].sort());
    for(const operation of policy.operations){const allowed=['package-read','scratch-write'].includes(operation.name)||mode==='control';assert.equal(operation.ok,allowed,`Unexpected permission: ${operation.name}`);if(!allowed)assert(['EACCES','EPERM'].includes(operation.code));}
  }
  return {main,child,inspected,policy};
}
export function classifySdkFailure(records,mode,exit) {
  // Validate every received permission/identity record even when the SDK also failed.
  const evidence=validateSdkEvidence(records,mode);
  const errors=records.filter(r=>r.type==='sdk-error');assert.equal(errors.length,1);const error=errors[0];assert.equal(error.source,'worker');
  const finishes=records.filter(r=>r.type==='finished'&&r.source==='host');assert.equal(finishes.length,1);assert.equal(exit.code,1);assert.notEqual(finishes[0].exitCode,0);assert.equal(finishes[0].activeProcesses,0);
  const passed=phase=>records.some(r=>r.source==='worker'&&r.type==='sdk-phase'&&r.phase===phase&&r.passed===true);
  assert(passed('integrity'),'Package integrity must have completed.');
  assert(records.some(r=>r.source==='worker'&&r.type==='sdk-phase'&&r.phase==='electron-resolution'&&r.passed===true&&r.resolved==='electron:electron'),'Electron ESM builtin resolution must have completed.');
  if(['import','public-cpu'].includes(error.phase)) {
    assert(!evidence.child&&!evidence.inspected&&!evidence.policy,'Unexpected child on the public CPU path.');
    if(error.phase==='public-cpu')assert(passed('import'));
  } else {
    assert.equal(error.phase,'instrumented-binary-test');assert.equal(error.name,'BinaryTestFailure');assert.equal(error.code,'BINARY_TEST_FAILED');assert(passed('import')&&passed('public-cpu'));
    validateSdkEvidence(records,mode,{requireChild:true});
    const messages=records.filter(r=>r.type==='sdk-child-message').map(r=>r.message);assert(messages.length>=1&&messages.length<=2&&messages[0]==='ready'&&(messages.length===1||messages[1]==='loaded'));
    const childExit=records.find(r=>r.type==='sdk-child-exit'&&r.pid===evidence.child.pid);assert(childExit&&Number.isInteger(childExit.code)&&childExit.code!==0);
  }
  return {phase:error.phase,name:error.name,code:error.code,message:error.message};
}
