import assert from 'node:assert/strict';
import {validateResourceCase} from './resource-results.mjs';
const names=['parameters','protocol-catalog','protocol-entries64','namespace-catalog','namespace-entries64'];
export function validateRegistryCase(result,{capabilityPolicy='none'}={}){
  assert.equal(result.kind,'registry-once');
  const rows=result.records;
  assert(Array.isArray(rows)&&rows.length<=31);
  const isRegistry=r=>['registry-open','registry-complete'].includes(r.type);
  // This projection reuses the unchanged resource/identity/cleanup contract.
  // Only the two explicitly validated registry record types are removed.
  const base=validateResourceCase({...result,kind:'resource-once',records:rows.filter(r=>!isRegistry(r))},{capabilityPolicy});
  const opens=rows.filter(r=>r.type==='registry-open'),done=rows.filter(r=>r.type==='registry-complete');
  assert.equal(opens.length,10);assert.equal(done.length,1);
  assert.deepEqual(opens.map(r=>[r.name,r.mask]),names.flatMap(name=>[1,0x20019].map(mask=>[name,mask])));
  for(const r of opens){
    assert.equal(r.api,'RegOpenKeyExW');assert.equal(r.hive,'HKLM');assert.equal(r.view,'native-x64');assert.equal(r.options,0);
    assert.equal(typeof r.ok,'boolean');assert(Number.isSafeInteger(r.code)&&r.code>=0&&r.code<=0xffffffff);assert.equal(r.ok,r.code===0);
    assert.equal(r.closeAttempted,r.ok);assert.equal(r.closeCode,r.ok?0:null);
  }
  assert.equal(done[0].phase,'primary');assert.equal(done[0].observations,10);assert.equal(done[0].valuesRead,0);
  const sequence=[rows.find(r=>r.type==='resource-complete'),...opens,done[0],rows.find(r=>r.type==='finished')];
  for(let i=1;i<sequence.length;i++)assert(rows.indexOf(sequence[i-1])<rows.indexOf(sequence[i]),'Invalid registry observation order');
  return {...base,capabilityPolicy,networkCapabilityCount:0,registryOpenComplete:true,allRegistryOpensSucceeded:opens.every(r=>r.ok),
    registryOpens:opens.map(({name,mask,ok,code})=>({name,mask,ok,code})),valuesRead:0};
}
