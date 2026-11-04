import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startupKinds,validateStartupCase,decodeStartupChild} from './startup-results.mjs';
import {startupFixture} from './startup-results.fixture.mjs';
for(const mode of ['control','ac','lpac','control-inherit'])for(const kind of startupKinds)test(`${mode}/${kind}: completed API success is not isolation acceptance`,()=>{
  const f=startupFixture(mode,kind),original=structuredClone(f),r=validateStartupCase(f);
  assert.equal(r.diagnosticComplete,true);assert.equal(r.compatible,true);assert.equal(r.isolationVerified,false);assert.equal(r.networkAttempted,false);assert.deepEqual(f,original);
});
for(const [kind,code] of [['startup-child',5],['startup-no-inherit',5],['startup-winsock',10107]])test(`${kind}: API failure remains incompatible despite complete diagnosis`,()=>{
  const r=validateStartupCase(startupFixture('lpac',kind,code));assert.equal(r.diagnosticComplete,true);assert.equal(r.operationSucceeded,false);assert.equal(r.compatible,false);assert.equal(r.code,code);
});
for(const [name,mutate] of [
  ['primary completion before API',f=>{const i=f.records.findIndex(r=>r.type==='startup-complete'&&r.phase==='primary');f.records.unshift(f.records.splice(i,1)[0]);}],
  ['operation before begin',f=>{const i=f.records.findIndex(r=>r.type==='startup-result');f.records.unshift(f.records.splice(i,1)[0]);}],
  ['LPAC query was not made',f=>{f.records.find(r=>r.type==='token').lpacQueryAttempted=false;}],
  ['absent child terminal',f=>{f.records=f.records.filter(r=>!(r.type==='startup-complete'&&r.phase==='descendant'));}],
  ['child failed after successful create',f=>{f.records.find(r=>r.type==='startup-child-exit').exitCode=1;}],
  ['wrong child PID',f=>{f.records.find(r=>r.type==='token'&&r.phase==='descendant').pid=999;}],
  ['duplicate child',f=>f.records.push({type:'descendant',pid:999,source:'pipe'})],
  ['child identity escaped',f=>{f.records.find(r=>r.type==='token'&&r.phase==='descendant').sid+='-1';}],
  ['child outside Job',f=>{f.records.find(r=>r.type==='token'&&r.phase==='descendant').job=false;}],
  ['extra capability',f=>{f.records.find(r=>r.type==='token').capabilities=1;}],
  ['LPAC flag guessed from failed query',f=>{f.records.find(r=>r.type==='token').lpac=true;}],
  ['unknown token query failure',f=>{f.records.find(r=>r.type==='token').lpacQueryError=5;}],
  ['unperformed API',f=>{f.records=f.records.filter(r=>r.type!=='startup-result');}],
  ['API result/code contradiction',f=>{f.records.find(r=>r.type==='startup-result').code=5;}],
  ['Winsock preceded child attempt',f=>{f.records.find(r=>r.type==='startup-begin').winsockCallsBefore=1;}],
  ['unexpected network operation',f=>f.records.push({type:'network-detail',source:'pipe'})],
  ['wrong inheritance',f=>{f.records.find(r=>r.type==='startup-result').inheritHandles=false;}],
  ['non-inheritable stdout',f=>{f.records.find(r=>r.type==='startup-handles').handles[1].flags=0;}],
  ['unknown stdin type',f=>{f.records.find(r=>r.type==='startup-handles').handles[0].type=0;}],
  ['unexpected AAP access',f=>{f.records.find(r=>r.type==='startup-read'&&r.name==='aap').ok=true;}],
  ['wrong reference privilege',f=>{f.records.find(r=>r.type==='launched').integrity=12288;}],
  ['missing process exit',f=>f.processExitObservation.pids.pop()],
  ['extra PID',f=>f.processExitObservation.pids.push(555)],
  ['post-recovery exit check',f=>{f.processExitObservation.beforeCleanup=false;}],
  ['reused driver PID',f=>{f.driverPid=f.launchedChildPid;}],
  ['emergency cleanup',f=>{f.cleanup.emergency=[];}],
  ['failed profile removal',f=>{f.cleanup.teardown.code=1;}],
  ['staged files remain',f=>{f.cleanup.deletionAttempts[0].removed=false;}],
  ['native error',f=>f.records.push({type:'probe-error',source:'pipe'})],
  ['unexpected host termination',f=>{f.exit.signal='SIGTERM';}],
])test(`rejects ${name}`,()=>{const f=startupFixture();mutate(f);assert.throws(()=>validateStartupCase(f));});
test('failed startup cannot emit cleanup or child evidence',()=>{
  const f=startupFixture('lpac','startup-winsock',10107);f.records.push({type:'startup-winsock-cleanup',ok:true,code:0,source:'pipe'});assert.throws(()=>validateStartupCase(f));
  const g=startupFixture('lpac','startup-child',5);g.records.push({type:'descendant',pid:102,source:'pipe'});assert.throws(()=>validateStartupCase(g));
});
test('failed WSACleanup does not complete the diagnosis',()=>{const f=startupFixture('ac','startup-winsock');f.records.find(r=>r.type==='startup-winsock-cleanup').ok=false;assert.throws(()=>validateStartupCase(f));});
test('no-inherit needs the file reporting channel and consistent stdio handles',()=>{
  const f=startupFixture('lpac','startup-no-inherit');f.records.find(r=>r.phase==='descendant').source='pipe';assert.throws(()=>validateStartupCase(f));
  const g=startupFixture('lpac','startup-no-inherit');g.records.find(r=>r.type==='startup-handles'&&r.phase==='descendant').validStdio=3;assert.throws(()=>validateStartupCase(g));
});
const fileRows=()=>startupFixture('lpac','startup-no-inherit').records.filter(r=>r.source==='child-file');
const encode=rows=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
test('bounded child file preserves its distinct provenance',()=>{const rows=fileRows();assert.deepEqual(decodeStartupChild(encode(rows)),rows);});
for(const [name,text] of [
  ['missing newline',()=>encode(fileRows()).trimEnd()],
  ['oversized',()=> ' '.repeat(16385)+'\n'],
  ['truncated JSON',()=> '{\n'],
  ['host record',()=>encode([...fileRows().slice(0,5),{type:'finished',phase:'descendant'}])],
  ['wrong phase',()=>encode(fileRows().map(r=>({...r,phase:'primary'})))],
  ['terminal in middle',()=>encode(fileRows().reverse())],
])test(`child receipt rejects ${name}`,()=>assert.throws(()=>decodeStartupChild(text())));

function withCharacterHandles(){
  const f=startupFixture('control','startup-no-inherit');
  const h=f.records.find(r=>r.type==='startup-handles'&&r.phase==='descendant');
  h.validStdio=3;for(const entry of h.handles)Object.assign(entry,{queryOk:true,flags:1,error:0,type:2,typeError:0});
  return f;
}
test('no-inherit accepts observed character devices without claiming object identity',()=>assert.equal(validateStartupCase(withCharacterHandles()).compatible,true));
test('no-inherit rejects parent-style pipe handles',()=>{const f=withCharacterHandles();f.records.find(r=>r.type==='startup-handles'&&r.phase==='descendant').handles[1].type=3;assert.throws(()=>validateStartupCase(f));});
test('no-inherit rejects mixed missing and present stdio',()=>{const f=withCharacterHandles();const h=f.records.find(r=>r.type==='startup-handles'&&r.phase==='descendant');h.validStdio=2;assert.throws(()=>validateStartupCase(f));});
