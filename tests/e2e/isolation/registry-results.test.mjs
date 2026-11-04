import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resourceFixture} from './resource-results.fixture.mjs';
import {validateRegistryCase} from './registry-results.mjs';
function fixture(mode='lpac',code=5){
 const f=resourceFixture(mode);f.kind='registry-once';
 const rows=['parameters','protocol-catalog','protocol-entries64','namespace-catalog','namespace-entries64'].flatMap(name=>[1,0x20019].map(mask=>({type:'registry-open',name,mask,api:'RegOpenKeyExW',hive:'HKLM',view:'native-x64',options:0,ok:code===0,code,closeAttempted:code===0,closeCode:code===0?0:null})));
 rows.push({type:'registry-complete',phase:'primary',observations:10,valuesRead:0});
 f.records.splice(f.records.findIndex(r=>r.type==='finished'),0,...rows);return f;
}
const open=f=>f.records.find(r=>r.type==='registry-open');
for(const mode of ['control','ac','lpac','control-inherit'])test(`${mode}: registry observations retain diagnosis boundary`,()=>{
 const f=fixture(mode,mode==='lpac'?5:0),before=structuredClone(f),r=validateRegistryCase(f);
 assert.equal(r.registryOpenComplete,true);assert.equal(r.allRegistryOpensSucceeded,mode!=='lpac');
 for(const flag of ['startupAttempted','startupVerified','networkAttempted','isolationVerified'])assert.equal(r[flag],false);
 assert.deepEqual(f,before);
});
test('missing registry key stays distinct from permission denial',()=>{const r=validateRegistryCase(fixture('lpac',2));assert.equal(r.registryOpens[0].code,2);assert.equal(r.allRegistryOpensSucceeded,false);});
for(const [name,mutate] of [
 ['wrong mode',f=>{f.kind='resource-once';}],
 ['missing open',f=>{f.records.splice(f.records.indexOf(open(f)),1);}],
 ['extra open',f=>{f.records.push({...open(f)});}],
 ['different key',f=>{open(f).name='arbitrary';}],
 ['write access',f=>{open(f).mask=2;}],
 ['different hive',f=>{open(f).hive='HKCU';}],
 ['different view',f=>{open(f).view='32bit';}],
 ['open-link option',f=>{open(f).options=8;}],
 ['guessed success',f=>{open(f).ok=true;}],
 ['negative status',f=>{open(f).code=-1;}],
 ['close of failed open',f=>{open(f).closeAttempted=true;}],
 ['guessed close success',f=>{open(f).closeCode=0;}],
 ['close failure',f=>{Object.assign(open(f),{ok:true,code:0,closeAttempted:true,closeCode:6});}],
 ['early receipt',f=>{const i=f.records.findIndex(r=>r.type==='registry-complete');f.records.unshift(f.records.splice(i,1)[0]);}],
 ['missing receipt',f=>{f.records=f.records.filter(r=>r.type!=='registry-complete');}],
 ['value read',f=>{f.records.find(r=>r.type==='registry-complete').valuesRead=1;}],
 ['unplanned operation',f=>{f.records.push({type:'registry-write'});}],
 ['child spawn',f=>{f.records.push({type:'descendant',pid:200});}],
 ['lost identity',f=>{f.records.find(r=>r.type==='token').capabilities=1;}],
 ['cleanup failure',f=>{f.cleanup.passed=false;}],
 ['emergency cleanup',f=>{f.cleanup.emergency=[];}],
])test(`rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>validateRegistryCase(f));});

test('explicit registryRead comparison uses the same resource and registry checks',async()=>{
 const {registryReadSid}=await import('./capability-policy.mjs');const f=fixture('lpac',0);f.capabilityPolicy='registryRead';
 for(const row of f.records.filter(r=>['launched','token'].includes(r.type))){if(row.type==='launched')row.capabilityPolicy='registryRead';row.capabilities=1;row.capabilitySids=[{sid:registryReadSid,attributes:4}];}
 const r=validateRegistryCase(f,{capabilityPolicy:'registryRead'});assert.equal(r.allRegistryOpensSucceeded,true);assert.equal(r.networkCapabilityCount,0);assert.equal(r.startupVerified,false);
 assert.throws(()=>validateRegistryCase(f));
 f.records.find(r=>r.type==='token').capabilitySids[0].sid='S-1-15-3-1';assert.throws(()=>validateRegistryCase(f,{capabilityPolicy:'registryRead'}));
});
