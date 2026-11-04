import assert from 'node:assert/strict';
export const transportCases = Object.freeze(['normal','generation','shutdown-pending','bad-magic','bad-version','bad-session','bad-id','bad-op','oversize','truncated-header','truncated-body','bad-reply','flood','stalled-reader','owner-loss','broker-loss','crash','request-budget','valid-eof','owner-loss-prepare']);
const keys=(value,names)=>assert.deepEqual(Object.keys(value).sort(),names.split(' ').sort());
export function validateLaunch(records,mode,expectedJobCommitBytes=268435456) {
  assert(['control','ac','lpac'].includes(mode));
  const rows=records.filter(x=>x.type==='launched');assert.equal(rows.length,1);
  const row=rows[0];
  keys(row,'type requestedPolicy pid appContainer lpac lpacQueryError lpacQueryBytes capabilities integrity sid job activeProcessLimit affinity priority jobCommitBytes sentinelInherited aclsVerified networkVerified');
  assert.equal(row.requestedPolicy,mode);
  assert(Number.isSafeInteger(row.pid)&&row.pid>0&&row.pid<=0xffffffff);
  assert.equal(row.appContainer,mode!=='control');assert.equal(row.capabilities,0);
  assert.equal(row.job,true);assert.equal(row.activeProcessLimit,1);assert.equal(row.affinity,1);
  assert.equal(row.priority,'BelowNormal');assert.equal(row.jobCommitBytes,expectedJobCommitBytes);
  assert.equal(row.sentinelInherited,false);assert.equal(row.aclsVerified,true);assert.equal(row.networkVerified,false);
  if(mode==='control') {
    assert.equal(row.lpac,false);assert.equal(row.lpacQueryError,0);assert.equal(row.lpacQueryBytes,0);
    assert.equal(row.sid,'');assert(Number.isSafeInteger(row.integrity)&&row.integrity>=8192);
  } else {
    assert.equal(row.integrity,4096);assert(/^S-1-15-2-(?:\d+-){6}\d+$/.test(row.sid));
    if(row.lpac===null) { assert.equal(row.lpacQueryError,87);assert.equal(row.lpacQueryBytes,0); }
    else { assert.equal(row.lpac,mode==='lpac');assert.equal(row.lpacQueryError,0);assert.equal(row.lpacQueryBytes,4); }
  }
  return row;
}
export function validateResult(records,mode,kind,exit) {
  assert(transportCases.includes(kind) && kind!=='owner-loss-prepare');const launch=validateLaunch(records,mode);
  const owner=kind==='owner-loss'||kind==='broker-loss';
  const types=kind==='broker-loss'?['launched','await-owner']:owner?['launched','await-owner','result']:['launched','result'];
  assert.deepEqual(records.map(x=>x.type),types);
  if(owner) {keys(records[1],'type pid');assert.equal(records[1].pid,launch.pid);}
  if(kind==='broker-loss') {keys(exit,'code signal');assert((Number.isInteger(exit.code)&&exit.code>0&&exit.code<=0xffffffff&&exit.signal===null)||(exit.code===null&&exit.signal==='SIGTERM')); return {transportCompatible:true,networkVerified:false,lpacTokenReported:launch.lpac};}
  assert.deepEqual(exit,{code:0,signal:null});
  const row=records.at(-1);keys(row,'type case passed jobEmpty profileDeleted watchdogReason failure error');
  assert.equal(row.case,kind);assert.equal(row.passed,true);assert.equal(row.jobEmpty,true);assert.equal(row.profileDeleted,true);
  assert.equal(row.watchdogReason,kind==='owner-loss'?1:kind==='stalled-reader'?2:0);
  assert.equal(row.failure,'');assert.equal(row.error,0);
  // Token query evidence alone is not a complete LPAC security acceptance.
  return {transportCompatible:true,networkVerified:false,lpacTokenReported:launch.lpac};
}

export function validateFailedCreationCleanup(records,kind,exit) {
  assert(transportCases.includes(kind));assert.deepEqual(exit,{code:1,signal:null});
  assert.equal(records.length,1);const row=records[0];
  keys(row,'type case passed jobEmpty profileDeleted watchdogReason failure error');
  assert.equal(row.type,'result');assert.equal(row.case,kind);assert.equal(row.passed,false);
  assert.equal(row.jobEmpty,true);assert.equal(row.profileDeleted,true);assert.equal(row.watchdogReason,0);
  assert.equal(row.failure,'create-child');assert(Number.isInteger(row.error)&&row.error>0&&row.error<=0xffffffff);
  // Only a verified broker failure BEFORE a worker existed. The case stays failed.
  return true;
}

export function validatePrepareOwnerLoss(records,exit) {
  assert.deepEqual(exit,{code:1,signal:null});
  assert.deepEqual(records.map(x=>x.type),['await-prepare-owner','result']);
  keys(records[0],'type');
  const row=records[1];keys(row,'type case passed jobEmpty profileDeleted watchdogReason failure error');
  assert.equal(row.case,'owner-loss-prepare');assert.equal(row.passed,false);
  assert.equal(row.jobEmpty,true);assert.equal(row.profileDeleted,true);
  assert([0,1].includes(row.watchdogReason));assert.equal(row.failure,'owner-stopped');assert.equal(row.error,995);
  return {launchRejected:true,jobEmpty:true,profileDeleted:true,networkVerified:false};
}
