import {test} from 'node:test';
import assert from 'node:assert/strict';
import {socketDenialFixture} from './etw-socket-denial.fixture.mjs';
import {candidateFixture} from './etw-candidate.fixture.mjs';
import {verifyObservedNetwork} from './etw-correlation.mjs';
import {finalizeEtwRun} from './etw-finalization.mjs';
const options={profile:'lpac-registry-read',method:'socket-access-denied'};
const verify=f=>verifyObservedNetwork(f.cases,f.evidence,options);
test('eight socket denials are distinct from packet drops and do not mutate evidence',()=>{
  const f=socketDenialFixture(),before=structuredClone(f),r=verify(f);
  assert.equal(r.scope,'native-lpac-registry-read-socket-access-denied');assert.equal(r.verificationMethod,'socket-access-denied');
  assert.equal(r.socketAttemptCount,8);assert.equal(r.networkVerified,true);assert.equal(r.socketCreationBlocked,true);
  for(const key of ['connectionAttempted','packetDropVerified','policyCauseVerified','fullIsolationVerified'])assert.equal(r[key],false);
  assert.equal(r.eventCount,0);assert.equal(r.networkCapabilityCount,0);assert.deepEqual(f,before);
});
test('socket denial is not an automatic fallback from the ETW method',()=>{
 const f=socketDenialFixture();assert.throws(()=>verifyObservedNetwork(f.cases,f.evidence,{profile:'lpac-registry-read'}));
});
test('packet drops cannot be relabelled as socket creation denial',()=>assert.throws(()=>verify(candidateFixture())));
test('method requires explicit reviewed profile',()=>{
 const f=socketDenialFixture();assert.throws(()=>verifyObservedNetwork(f.cases,f.evidence,{method:'socket-access-denied'}));
 assert.throws(()=>verifyObservedNetwork(f.cases,f.evidence,{...options,method:'auto'}));
});
test('finalization persists only after all direct-denial evidence passes',async()=>{
 const f=socketDenialFixture();let saved;
 const result=await finalizeEtwRun(f.cases,f.evidence,async(value,label)=>{saved={value,label};},options);
 assert.equal(saved.label,'lpac-registry-read-normal');assert.equal(saved.value.networkEvidence.packetDropVerified,false);
 assert.equal(result.passed,true);assert(result.cases.every(c=>c.passed));
 await assert.rejects(finalizeEtwRun(f.cases,f.evidence,async()=>{throw Error('disk');},options),/disk/);
});
for(const [name,mutate] of [
 ['timeout',f=>{f.cases[1].records.find(r=>r.type==='network-detail').code=10060;}],
 ['bind access error',f=>{f.cases[1].records.find(r=>r.type==='network-detail').stage='bind';}],
 ['connect access error',f=>{f.cases[1].records.find(r=>r.type==='network-detail').stage='connect';}],
 ['startup failure',f=>{f.cases[1].records.push({type:'network-startup',phase:'primary',code:10107});}],
 ['unattempted operation',f=>{f.cases[1].records.find(r=>r.type==='operation'&&r.name==='tcp4').attempted=false;}],
 ['operation code mismatch',f=>{f.cases[1].records.find(r=>r.type==='operation'&&r.name==='tcp4').code=10060;}],
 ['missing socket result',f=>{f.cases[1].records.splice(f.cases[1].records.findIndex(r=>r.type==='network-detail'),1);}],
 ['duplicate socket result',f=>{f.cases[1].records.push(structuredClone(f.cases[1].records.find(r=>r.type==='network-detail')));}],
 ['claimed local endpoint',f=>{f.cases[1].records.find(r=>r.type==='network-detail').localPort=1234;}],
 ['claimed local address',f=>{f.cases[1].records.find(r=>r.type==='network-detail').localAddress='127.0.0.1';}],
 ['missing invalid-socket sentinel',f=>{f.cases[1].records.find(r=>r.type==='network-detail').localEndpointError=0;}],
 ['wrong planned endpoint',f=>{f.cases[1].records.find(r=>r.type==='network-detail').remotePort=1;}],
 ['wrong protocol',f=>{f.cases[1].records.find(r=>r.type==='network-detail').protocol=17;}],
 ['unexplained event',f=>{const e=candidateFixture().evidence.records.find(r=>r.kind==='event');f.evidence.records.splice(2,0,e);Object.assign(f.evidence.records.at(-1),{received:1,matchedEvents:1,ntMatches:1});}],
 ['missing final control',f=>{f.cases.pop();}],
 ['failed control echo',f=>{f.cases[0].records.find(r=>r.type==='network-detail').code=10013;}],
 ['missing process exit proof',f=>{delete f.cases[1].processExitObservation;}],
 ['missing host capability proof',f=>{delete f.cases[1].records.find(r=>r.type==='launched').capabilitySids;}],
 ['extra child capability',f=>{f.cases[1].records.find(r=>r.type==='token'&&r.phase==='descendant').capabilitySids.push({sid:'S-1-15-3-1',attributes:4});}],
 ['collector cleanup failure',f=>{f.evidence.guard.sessionAbsent=false;}],
 ['event loss',f=>{f.evidence.records.at(-1).eventsLost=1;}],
 ['changed global collection setting',f=>{f.evidence.records.at(-1).optionsUnchanged=false;}],
])test(`socket evidence rejects ${name}`,()=>{const f=socketDenialFixture();mutate(f);assert.throws(()=>verify(f));});
