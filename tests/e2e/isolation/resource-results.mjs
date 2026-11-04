import assert from 'node:assert/strict';
import {validateStartupIdentity} from './startup-results.mjs';
const uint=n=>Number.isSafeInteger(n)&&n>=0&&n<=0xffffffff;
const pid=n=>uint(n)&&n>0;
const one=(rows,type)=>{const found=rows.filter(r=>r.type===type);assert.equal(found.length,1,`Expected one ${type}`);return found[0];};
function outcome(row){assert.equal(typeof row.ok,'boolean');assert(uint(row.code));assert.equal(row.ok,row.code===0);}
export function validateResourceCase(result,{capabilityPolicy='none'}={}){
  if(capabilityPolicy!=='none'||Object.hasOwn(result,'capabilityPolicy'))assert.equal(result.capabilityPolicy,capabilityPolicy);
  const {mode,records:rows}=result,restricted=['ac','lpac'].includes(mode);
  assert(['control','ac','lpac','control-inherit'].includes(mode));assert.equal(result.kind,'resource-once');
  assert(Array.isArray(rows)&&rows.length<=20&&!result.error);
  assert(rows.every(r=>['profile','network-identity','launched','token','resource-open','resource-dacl','resource-policy','resource-complete','finished','cleanup'].includes(r.type)));
  assert.equal(result.exit?.code,0);assert.equal(result.exit.signal,null);
  const launch=one(rows,'launched'),token=one(rows,'token'),done=one(rows,'resource-complete'),finished=one(rows,'finished');
  if(capabilityPolicy==='registryRead')assert.equal(launch.capabilityPolicy,capabilityPolicy);
  validateStartupIdentity(launch,mode,capabilityPolicy);validateStartupIdentity(token,mode,capabilityPolicy);
  assert.equal(launch.requestedPolicy,mode);assert.equal(launch.aclsVerified,true);assert.equal(launch.sentinelInherited,mode==='control-inherit');
  assert.equal(token.phase,'primary');assert.equal(token.pid,launch.pid);assert.equal(done.phase,'primary');assert.equal(done.observations,7);
  assert.equal(finished.exitCode,0);assert.equal(finished.activeProcesses,0);assert.equal(finished.ownerGone,false);
  const pids=[result.launchedChildPid,launch.pid];assert([...pids,result.driverPid].every(pid));assert.equal(new Set([...pids,result.driverPid]).size,3);
  assert.equal(rows.filter(r=>r.type==='profile').length,restricted?1:0);
  assert.equal(rows.filter(r=>r.type==='cleanup').length,restricted?1:0);
  if(restricted){const profile=one(rows,'profile');assert(/^S-1-15-2-(?:\d+-)*\d+$/.test(profile.sid));assert.equal(token.sid,profile.sid);assert.equal(one(rows,'cleanup').hresult,0);}
  else assert.equal(token.sid,'');
  const reads=rows.filter(r=>r.type==='resource-open');assert.equal(reads.length,5);
  const names=['self-read','self-execute','allowed','aap','outside'];assert.deepEqual(reads.map(r=>r.name),names);
  for(const r of reads){outcome(r);assert.equal(r.mask,r.name==='self-execute'?32:1);assert.equal(r.disposition,3);}
  for(const [name,ok] of [['allowed',true],['aap',mode!=='lpac'],['outside',!restricted]]){const r=reads.find(r=>r.name===name);assert.equal(r.ok,ok);assert.equal(r.code,ok?0:5);}
  const dacl=one(rows,'resource-dacl');outcome(dacl);assert.equal(dacl.api,'GetTokenInformation');assert.equal(dacl.infoClass,6);assert.equal(dacl.tokenAccess,8);
  for(const field of ['openCode','sizingCode','neededBytes','returnedBytes'])assert(uint(dacl[field]));
  assert(dacl.neededBytes<=65536&&dacl.returnedBytes<=dacl.neededBytes);
  if(dacl.ok){
    assert.equal(dacl.openCode,0);assert.equal(dacl.sizingCode,122);assert(dacl.returnedBytes>=8);
    assert.equal(typeof dacl.nullDacl,'boolean');assert(uint(dacl.aceCount)&&dacl.aceCount<=128);assert(uint(dacl.aclBytes)&&dacl.aclBytes<=65536);
    assert(typeof dacl.sddl==='string'&&dacl.sddl.startsWith('D:')&&dacl.sddl.length<=16384&&!/[\x00-\x1f]/.test(dacl.sddl));
    if(dacl.nullDacl){assert.equal(dacl.aceCount,0);assert.equal(dacl.aclBytes,0);assert.equal(dacl.sddl,'D:NO_ACCESS_CONTROL');}
    else {assert(dacl.aclBytes>=8&&dacl.aclBytes<=dacl.returnedBytes-8);assert.notEqual(dacl.sddl,'D:NO_ACCESS_CONTROL');if(dacl.aceCount===0)assert.equal(dacl.sddl,'D:');}
  }else{
    for(const field of ['nullDacl','aceCount','aclBytes','sddl'])assert.equal(dacl[field],null,'Failed query must stay unknown');
    if(dacl.openCode!==0){assert.equal(dacl.code,dacl.openCode);assert.equal(dacl.sizingCode,0);assert.equal(dacl.neededBytes,0);assert.equal(dacl.returnedBytes,0);}
    else if(dacl.sizingCode!==122){assert.equal(dacl.code,dacl.sizingCode);assert.notEqual(dacl.sizingCode,0);assert.equal(dacl.returnedBytes,0);}
    else assert(dacl.neededBytes>=8);
  }
  const policy=one(rows,'resource-policy');outcome(policy);assert.equal(policy.api,'GetProcessMitigationPolicy');assert.equal(policy.policy,'ProcessChildProcessPolicy');assert.equal(policy.bufferBytes,4);
  if(policy.ok){assert(uint(policy.flags));assert.equal(policy.noChildProcessCreation,!!(policy.flags&1));}else {assert.equal(policy.flags,null);assert.equal(policy.noChildProcessCreation,null);}
  const evidence=[token,...reads,dacl,policy,done,finished];assert(rows.indexOf(launch)<rows.indexOf(token));
  for(let i=1;i<evidence.length;i++)assert(rows.indexOf(evidence[i-1])<rows.indexOf(evidence[i]),'Invalid observation order');
  const exit=result.processExitObservation;assert.equal(exit?.allAbsent,true);assert.equal(exit.beforeCleanup,true);assert.deepEqual([...exit.pids].sort((a,b)=>a-b),[...pids].sort((a,b)=>a-b));
  const clean=result.cleanup;for(const flag of ['passed','stopped','profileClean'])assert.equal(clean?.[flag],true);
  assert.deepEqual(clean.errors,[]);assert(!clean.emergency);assert.equal(clean.deletionAttempts?.at(-1)?.removed,true);
  if(restricted){assert.equal(clean.teardown?.code,0);assert.equal(one(clean.teardown.records,'cleanup').hresult,0);}
  return {diagnosticComplete:true,startupAttempted:false,startupVerified:false,networkAttempted:false,isolationVerified:false,
    selfRead:reads[0].ok,selfExecute:reads[1].ok,defaultDaclKnown:dacl.ok,childPolicyKnown:policy.ok,noChildProcessCreation:policy.noChildProcessCreation};
}
