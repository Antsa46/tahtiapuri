import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLaunch,validateResult,transportCases,validateFailedCreationCleanup} from './transport-results.mjs';
const launched=(mode='lpac')=>({type:'launched',requestedPolicy:mode,pid:123,appContainer:mode!=='control',
  lpac:mode==='control'?false:null,lpacQueryError:mode==='control'?0:87,lpacQueryBytes:0,capabilities:0,integrity:mode==='control'?8192:4096,
  sid:mode==='control'?'':'S-1-15-2-1-2-3-4-5-6-7',job:true,activeProcessLimit:1,affinity:1,priority:'BelowNormal',jobCommitBytes:268435456,
  sentinelInherited:false,aclsVerified:true,networkVerified:false});
const result=(kind='normal')=>({type:'result',case:kind,passed:true,jobEmpty:true,profileDeleted:true,
  watchdogReason:kind==='owner-loss'?1:kind==='stalled-reader'?2:0,failure:'',error:0});
const rows=(kind='normal')=>[launched(),...(['owner-loss','broker-loss'].includes(kind)?[{type:'await-owner',pid:123}]:[]),
  ...(kind==='broker-loss'?[]:[result(kind)])];
test('unknown LPAC token status stays unknown and never proves network isolation',()=>{
  assert.deepEqual(validateResult(rows(),'lpac','normal',{code:0,signal:null}),
    {transportCompatible:true,networkVerified:false,lpacTokenReported:null});
});
for(const mode of ['control','ac','lpac']) test('validates exact launch policy '+mode,()=>validateLaunch([launched(mode)],mode));
for(const kind of transportCases) test('accepts completed synthetic scenario '+kind,()=>{
  validateResult(rows(kind),'lpac',kind,kind==='broker-loss'?{code:null,signal:'SIGTERM'}:{code:0,signal:null});
});
for(const [name,mutate] of [
  ['forged log',r=>r.splice(1,0,{type:'launched',verified:true})],
  ['duplicate launch',r=>r.splice(1,0,{...r[0]})],
  ['unexpected field',r=>r[0].verified=true],
  ['network overclaim',r=>r[0].networkVerified=true],
  ['capability granted',r=>r[0].capabilities=1],
  ['missing job',r=>r[0].job=false],
  ['handle leaked',r=>r[0].sentinelInherited=true],
  ['wrong affinity',r=>r[0].affinity=3],
  ['wrong priority',r=>r[0].priority='Normal'],
  ['invalid pid',r=>r[0].pid=0],
  ['wrong requested mode',r=>r[0].requestedPolicy='ac'],
  ['wrong token',r=>r[0].appContainer=false],
  ['wrong integrity',r=>r[0].integrity=8192],
  ['fabricated LPAC success',r=>r[0].lpac=true],
  ['unexpected query failure',r=>r[0].lpacQueryError=5],
  ['unknown query length',r=>r[0].lpacQueryBytes=4],
  ['incorrect profile SID',r=>r[0].sid='S-1-5-18'],
  ['missing result',r=>r.pop()],
  ['wrong case',r=>r[1].case='crash'],
  ['failed test',r=>r[1].passed=false],
  ['remaining child',r=>r[1].jobEmpty=false],
  ['profile retained',r=>r[1].profileDeleted=false],
  ['unexpected timeout',r=>r[1].watchdogReason=2],
  ['nonempty failure',r=>r[1].failure='timeout'],
  ['error ignored',r=>r[1].error=5],
]) test('rejects '+name,()=>{const r=rows();mutate(r);assert.throws(()=>validateResult(r,'lpac','normal',{code:0,signal:null}));});
test('broker-loss cannot pass with unknown or successful broker exit',()=>{
  for(const exit of [{code:null,signal:null},{code:0,signal:null},{code:null,signal:'made-up'}])
    assert.throws(()=>validateResult(rows('broker-loss'),'lpac','broker-loss',exit));
});
test('owner event must identify the inspected process',()=>{
  const r=rows('owner-loss');r[1].pid=124;
  assert.throws(()=>validateResult(r,'lpac','owner-loss',{code:0,signal:null}));
});

test('positive creation failure can be cleaned but never passes runtime validation',()=>{
  const row={...result(),passed:false,failure:'create-child',error:203};
  assert(validateFailedCreationCleanup([row],'normal',{code:1,signal:null}));
  assert.throws(()=>validateResult([row],'lpac','normal',{code:1,signal:null}));
  for(const r of [[],[{...row,jobEmpty:false}],[{...row,profileDeleted:false}],[{...row,failure:'unknown'}],[{...row,passed:true}]])
    assert.throws(()=>validateFailedCreationCleanup(r,'normal',{code:1,signal:null}));
});
