import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resourceFixture as fixture} from './resource-results.fixture.mjs';
import {validateResourceCase} from './resource-results.mjs';
const field=(f,t)=>f.records.find(r=>r.type===t);
for(const mode of ['control','ac','lpac','control-inherit'])test(`${mode}: completed reads do not prove startup or isolation`,()=>{
 const f=fixture(mode),original=structuredClone(f),r=validateResourceCase(f);assert.equal(r.diagnosticComplete,true);for(const k of ['startupAttempted','startupVerified','networkAttempted','isolationVerified'])assert.equal(r[k],false);assert.deepEqual(f,original);
});
test('a denied executable access is an observation, not a missing experiment',()=>{const f=fixture();Object.assign(field(f,'resource-open'),{ok:false,code:5});const r=validateResourceCase(f);assert.equal(r.selfRead,false);assert.equal(r.diagnosticComplete,true);});
test('a measured child restriction remains visible',()=>{const f=fixture();Object.assign(field(f,'resource-policy'),{flags:1,noChildProcessCreation:true});assert.equal(validateResourceCase(f).noChildProcessCreation,true);});
test('failed policy query stays unknown',()=>{const f=fixture();Object.assign(field(f,'resource-policy'),{ok:false,code:87,flags:null,noChildProcessCreation:null});const r=validateResourceCase(f);assert.equal(r.childPolicyKnown,false);assert.equal(r.noChildProcessCreation,null);});
for(const stage of ['open','size','query'])test(`failed DACL ${stage} query stays unknown`,()=>{
 const f=fixture(),d=field(f,'resource-dacl');Object.assign(d,{ok:false,code:5,nullDacl:null,aceCount:null,aclBytes:null,sddl:null,returnedBytes:0});
 if(stage==='open')Object.assign(d,{openCode:5,sizingCode:0,neededBytes:0});if(stage==='size')Object.assign(d,{sizingCode:5,neededBytes:0});assert.equal(validateResourceCase(f).defaultDaclKnown,false);
});
for(const empty of [true,false])test(`${empty?'empty':'null'} DACL is distinct from failed metadata`,()=>{const f=fixture();Object.assign(field(f,'resource-dacl'),{neededBytes:empty?16:8,returnedBytes:empty?16:8,nullDacl:!empty,aceCount:0,aclBytes:empty?8:0,sddl:empty?'D:':'D:NO_ACCESS_CONTROL'});assert.equal(validateResourceCase(f).defaultDaclKnown,true);});
for(const [name,mutate] of [
 ['missing read',f=>f.records.splice(f.records.findIndex(r=>r.type==='resource-open'),1)],
 ['extra request',f=>f.records.push({...field(f,'resource-open')})],
 ['wrong permission',f=>{field(f,'resource-open').mask=0x10000000;}],
 ['writing disposition',f=>{field(f,'resource-open').disposition=2;}],
 ['contradictory error',f=>{field(f,'resource-open').code=5;}],
 ['child created',f=>f.records.push({type:'descendant',pid:200})],
 ['network attempt',f=>f.records.push({type:'network-detail'})],
 ['native error',f=>f.records.push({type:'probe-error',code:5})],
 ['lost identity',f=>{field(f,'token').sid+='-1';}],
 ['extra capability',f=>{field(f,'token').capabilities=1;}],
 ['outside Job',f=>{field(f,'token').job=false;}],
 ['reused PID',f=>{f.driverPid=f.launchedChildPid;}],
 ['policy failure guessed as zero',f=>{Object.assign(field(f,'resource-policy'),{ok:false,code:87});}],
 ['policy flag contradiction',f=>{field(f,'resource-policy').flags=1;}],
 ['DACL failure guessed as empty',f=>{Object.assign(field(f,'resource-dacl'),{ok:false,code:5});}],
 ['DACL null with ACEs',f=>{field(f,'resource-dacl').nullDacl=true;}],
 ['DACL empty with nonempty descriptor',f=>{field(f,'resource-dacl').aceCount=0;}],
 ['DACL oversized',f=>{field(f,'resource-dacl').neededBytes=65537;}],
 ['DACL returned beyond buffer',f=>{field(f,'resource-dacl').returnedBytes=100;}],
 ['wrong token query',f=>{field(f,'resource-dacl').infoClass=1;}],
 ['wrong token rights',f=>{field(f,'resource-dacl').tokenAccess=0x20;}],
 ['premature complete',f=>{const i=f.records.findIndex(r=>r.type==='resource-complete');f.records.unshift(f.records.splice(i,1)[0]);}],
 ['missing finish',f=>{f.records=f.records.filter(r=>r.type!=='resource-complete');}],
 ['process alive',f=>{f.processExitObservation.allAbsent=false;}],
 ['post-recovery exit',f=>{f.processExitObservation.beforeCleanup=false;}],
 ['missing PID',f=>f.processExitObservation.pids.pop()],
 ['emergency cleanup',f=>{f.cleanup.emergency=[];}],
 ['profile remains',f=>{f.cleanup.profileClean=false;}],
 ['staged remains',f=>{f.cleanup.deletionAttempts[0].removed=false;}],
])test(`rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>validateResourceCase(f));});
