import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registryReadSid,validateCapabilityPolicy} from './capability-policy.mjs';
import {startupFixture} from './startup-results.fixture.mjs';
import {validateStartupCase} from './startup-results.mjs';
const options={capabilityPolicy:'registryRead'};
function fixture(kind='startup-child',code=0){
 const f=startupFixture('lpac',kind,code);f.capabilityPolicy='registryRead';
 for(const row of f.records.filter(r=>['launched','token'].includes(r.type))){row.capabilities=1;row.capabilitySids=[{sid:registryReadSid,attributes:4}];if(row.type==='launched')row.capabilityPolicy='registryRead';}
 return f;
}
for(const kind of ['startup-child','startup-no-inherit','startup-winsock'])test(`exact capability set retained through ${kind}`,()=>{
 const f=fixture(kind),original=structuredClone(f),r=validateStartupCase(f,options);assert.equal(r.compatible,true);assert.equal(r.networkCapabilityCount,0);assert.equal(r.isolationVerified,false);assert.deepEqual(f,original);
});
test('failed capability variant remains incompatible',()=>{const r=validateStartupCase(fixture('startup-winsock',10107),options);assert.equal(r.diagnosticComplete,true);assert.equal(r.compatible,false);assert.equal(r.code,10107);});
for(const phase of ['launched','primary','descendant'])for(const [name,mutate] of [
 ['wrong SID',r=>{r.capabilitySids[0].sid='S-1-15-3-1';}],
 ['extra SID',r=>{r.capabilitySids.push({sid:'S-1-15-3-2',attributes:4});r.capabilities=2;}],
 ['wrong attributes',r=>{r.capabilitySids[0].attributes=0;}],
 ['missing set',r=>{delete r.capabilitySids;}],
 ['zero count',r=>{r.capabilities=0;}],
])test(`${phase}: rejects ${name}`,()=>{const f=fixture(),row=f.records.find(r=>phase==='launched'?r.type==='launched':r.type==='token'&&r.phase===phase);mutate(row);assert.throws(()=>validateStartupCase(f,options));});
test('capability comparison is not accepted as baseline',()=>assert.throws(()=>validateStartupCase(fixture())));
test('policy disagreement fails',()=>{const f=fixture();f.capabilityPolicy='none';assert.throws(()=>validateStartupCase(f,options));});
test('baseline count cannot hide an extra SID',()=>assert.throws(()=>validateCapabilityPolicy({capabilities:0,capabilitySids:[{sid:registryReadSid,attributes:4}]},'lpac','none')));
test('capability is not allowed in an AC/control variant',()=>{for(const mode of ['ac','control','control-inherit'])assert.throws(()=>validateCapabilityPolicy({capabilities:1,capabilitySids:[{sid:registryReadSid,attributes:4}]},mode,'registryRead'));});
