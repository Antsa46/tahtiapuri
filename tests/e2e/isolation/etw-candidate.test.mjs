import {test} from 'node:test';
import assert from 'node:assert/strict';
import {correlationFixture} from './etw-correlation.fixture.mjs';
import {candidateFixture as fixture} from './etw-candidate.fixture.mjs';
import {etwProfile} from './etw-profiles.mjs';
import {correlateEtwNetwork} from './etw-correlation.mjs';
import {finalizeEtwRun} from './etw-finalization.mjs';
const options={profile:'lpac-registry-read'};
const evaluate=f=>correlateEtwNetwork(f.cases,f.evidence,options);
test('candidate requires its own three exact identities and all eight drops',()=>{
 const f=fixture(),original=structuredClone(f),r=evaluate(f);assert.equal(r.networkVerified,true);assert.equal(r.fullIsolationVerified,false);assert.equal(r.networkCapabilityCount,0);assert.equal(r.scope,'native-lpac-registry-read-bound-loopback-receive-v2');assert.equal(r.attemptCount,8);assert.equal(r.eventCount,12);assert.deepEqual(f,original);
});
test('candidate save uses its own fixed case path and retains profile',async()=>{
 const f=fixture();let saved;const r=await finalizeEtwRun(f.cases,f.evidence,async(value,label)=>{saved={value,label};},options);
 assert.equal(saved.label,'lpac-registry-read-normal');assert.equal(saved.value.capabilityPolicy,'registryRead');assert.equal(r.cases[1].caseLabel,saved.label);assert.equal(r.cases[1].experimentProfile,'lpac-registry-read');
});
test('candidate persistence failure cannot report success',async()=>{const f=fixture();await assert.rejects(finalizeEtwRun(f.cases,f.evidence,async()=>{throw Error('disk failure');},options),/disk failure/);});
test('AC raw evidence cannot stand in for candidate',()=>assert.throws(()=>evaluate(correlationFixture())));
test('candidate cannot be accepted by the original AC profile',()=>{const f=fixture();assert.throws(()=>correlateEtwNetwork(f.cases,f.evidence));});
for(const kind of ['error','launcher-kill','owner-kill'])test(`candidate ${kind} is not yet enabled`,()=>assert.throws(()=>etwProfile('lpac-registry-read',kind)));
test('profile name cannot choose an arbitrary policy',()=>assert.throws(()=>etwProfile('custom')));
for(const i of [0,1,2])for(const [name,mutate] of [
 ['missing process observation',c=>{delete c.processExitObservation;}],
 ['omitted descendant',c=>{c.processExitObservation.pids.pop();}],
 ['PID checked after cleanup',c=>{c.processExitObservation.beforeCleanup=false;}],
 ['outside check window',c=>{c.processExitObservation.checkedAtMs=1;}],
 ['still alive',c=>{c.processExitObservation.allAbsent=false;}],
 ['emergency recovery',c=>{c.cleanup.emergency=[];}],
 ['wrong case label',c=>{c.caseLabel='ac-normal';}],
 ['missing host capability set',c=>{delete c.records.find(r=>r.type==='launched').capabilitySids;}],
])test(`case ${i} rejects ${name}`,()=>{const f=fixture();mutate(f.cases[i]);assert.throws(()=>evaluate(f));});
for(const phase of ['host','primary','descendant'])for(const [name,mutate] of [
 ['wrong SID',r=>{r.capabilitySids[0].sid='S-1-15-3-1';}],
 ['extra SID',r=>{r.capabilitySids.push({sid:'S-1-15-3-2',attributes:4});r.capabilities=2;}],
 ['wrong attributes',r=>{r.capabilitySids[0].attributes=0;}],
])test(`${phase} rejects ${name}`,()=>{const f=fixture(),row=f.cases[1].records.find(r=>phase==='host'?r.type==='launched':r.type==='token'&&r.phase===phase);mutate(row);assert.throws(()=>evaluate(f));});
for(const [name,mutate] of [
 ['wrong capability policy',f=>{f.cases[1].capabilityPolicy='none';}],
 ['wrong AppId case',f=>{f.cases[1].records.find(r=>r.type==='network-identity').appIdHex=f.cases[0].records.find(r=>r.type==='network-identity').appIdHex;}],
 ['changed host',f=>{f.cases[2].hostSha256='c'.repeat(64);}],
 ['missing child',f=>{f.cases[1].records=f.cases[1].records.filter(r=>r.type!=='descendant');}],
 ['missing final control',f=>f.cases.pop()],
 ['missing attempt',f=>{f.cases[1].records.splice(f.cases[1].records.findIndex(r=>r.type==='network-detail'),1);}],
 ['ambiguous attempt',f=>{const a=f.cases[1].records.filter(r=>r.type==='network-detail');Object.assign(a[4],{localPort:a[0].localPort,startedAtMs:a[0].startedAtMs,finishedAtMs:a[0].finishedAtMs});}],
 ['unknown filter',f=>{f.evidence.records.find(r=>r.kind==='event').filter.sublayer='unknown';}],
 ['lost events',f=>{f.evidence.records.at(-1).eventsLost=1;}],
])test(`candidate rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>evaluate(f));});
