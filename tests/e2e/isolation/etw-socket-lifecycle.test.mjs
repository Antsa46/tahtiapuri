import {test} from 'node:test';
import assert from 'node:assert/strict';
import {socketDenialFixture} from './etw-socket-denial.fixture.mjs';
import {verifyObservedNetwork} from './etw-correlation.mjs';
import {finalizeEtwRun} from './etw-finalization.mjs';
const options={profile:'lpac-registry-read',method:'socket-access-denied'};
const verify=f=>verifyObservedNetwork(f.cases,f.evidence,options);
for(const kind of ['error','launcher-kill','owner-kill']) {
 test(`${kind}: exact socket-denial lifecycle completes and saves to its own path`,async()=>{
  const f=socketDenialFixture(kind),original=structuredClone(f),r=verify(f);assert.equal(r.lifecycleVerified,true);assert.equal(r.lifecycleKind,kind);assert.equal(r.socketAttemptCount,8);assert.equal(r.packetDropVerified,false);
  let saved;await finalizeEtwRun(f.cases,f.evidence,async(value,label)=>{saved={value,label};},options);assert.equal(saved.label,`lpac-registry-read-${kind}`);assert.equal(saved.value.kind,kind);assert.deepEqual(f,original);
 });
 for(const [name,mutate] of [
  ['missing exit proof',c=>{delete c.processExitObservation;}],
  ['incomplete PID set',c=>{c.processExitObservation.pids.pop();}],
  ['post-cleanup observation',c=>{c.processExitObservation.beforeCleanup=false;}],
  ['emergency cleanup',c=>{c.cleanup.emergency=[];}],
  ['wrong case path',c=>{c.caseLabel='lpac-registry-read-normal';}],
  ['failed profile cleanup',c=>{c.cleanup.teardown.records[0].hresult=5;}],
 ])test(`${kind}: rejects ${name}`,()=>{const f=socketDenialFixture(kind);mutate(f.cases[1]);assert.throws(()=>verify(f));});
}
for(const kind of ['launcher-kill','owner-kill'])for(const [name,mutate] of [
 ['wrong killed process',c=>{c.termination.targetPid=c.records.find(r=>r.type==='descendant').pid;}],
 ['already exited target',c=>{c.termination.targetAliveBeforeRequest=false;}],
 ['kill before socket attempts finish',c=>{c.termination.requestedAtMs=Date.parse(c.startedAt)+1;}],
 ['wrong close signal',c=>{c.exit.signal='SIGKILL';}],
 ['missing readiness',c=>{c.records=c.records.filter(r=>r.type!=='ready');}],
])test(`${kind}: rejects ${name}`,()=>{const f=socketDenialFixture(kind);mutate(f.cases[1]);assert.throws(()=>verify(f));});
test('owner loss requires the intermediate host in the exited process set',()=>{const f=socketDenialFixture('owner-kill');f.cases[1].records=f.cases[1].records.filter(r=>r.type!=='owner-host');assert.throws(()=>verify(f));});
test('deliberate error needs its precise exit code',()=>{const f=socketDenialFixture('error');f.cases[1].records.find(r=>r.type==='finished').exitCode=18;assert.throws(()=>verify(f));});
