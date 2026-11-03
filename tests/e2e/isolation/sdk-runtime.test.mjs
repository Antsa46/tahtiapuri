import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntimeIdentity, validateRuntimeEvidence, validateConsoleEvidence } from './sdk-runtime.mjs';
const node = { kind: 'node', variant: 'local-patched', version: '24.22.2', sha256: 'a'.repeat(64) };
const electron = { ...node, kind: 'electron', variant: 'official', version: '45.2.1' };
const actual = () => ({ platform:'win32',arch:'x64',node:'24.22.2',uv:'1.52.1',execPath:'synthetic/node.exe',expectedExecPath:'synthetic/node.exe',sha256:node.sha256 });
test('Node requires its exact image, version and hash without Electron resolution', () => {
  const report = verifyRuntimeIdentity(node, actual());
  validateRuntimeEvidence([{type:'sdk-phase',phase:'runtime-contract',source:'worker',passed:true,...report}],node);
});
for (const [field,value] of [['sha256','b'.repeat(64)],['node','24.22.1'],['execPath','synthetic/other.exe'],['electron','45.2.1'],['runAsNode','1'],['nodeOptions','--require evil'],['nodePath','outside'],['platform','linux'],['arch','arm64'],['resolved','file:///npm/electron/index.js']]) {
  test(`Node rejects mismatched ${field}`, () => assert.throws(() => verifyRuntimeIdentity(node,{...actual(),[field]:value})));
}
test('Electron keeps its ESM builtin guard and embedded Node identity', () => {
  const input = {...actual(),node:'24.22.1',electron:'45.2.1',runAsNode:'1',resolved:'electron:electron'};
  const report = verifyRuntimeIdentity(electron,input);
  validateRuntimeEvidence([{type:'sdk-phase',phase:'runtime-contract',source:'worker',passed:true,...report}],electron);
  assert.throws(() => verifyRuntimeIdentity(electron,{...input,resolved:'file:///npm/electron/index.js'}));
});
test('Evidence from a different binary or runtime cannot authorize an SDK failure', () => {
  const rows = [{type:'sdk-phase',phase:'runtime-contract',source:'worker',passed:true,...verifyRuntimeIdentity(node,actual())}];
  assert.throws(() => validateRuntimeEvidence(rows,electron));
  assert.throws(() => validateRuntimeEvidence(rows,{...node,sha256:'b'.repeat(64)}));
  assert.throws(() => validateRuntimeEvidence([...rows,...rows],node));
});

const consoleRows = () => [
  {type:'console-host',source:'host',pid:101,soleClient:true,hidden:true,imageVerified:true},
  {type:'console-finished',source:'host',detached:true,stopped:true}
];
test('Node requires owned console identity and completed shutdown', () => {
  validateConsoleEvidence(consoleRows(),node);
  for (const rows of [[],consoleRows().slice(0,1),consoleRows().map(r=>({...r,source:'worker'})),[...consoleRows(),consoleRows()[0]]])
    assert.throws(()=>validateConsoleEvidence(rows,node));
  for(const key of ['soleClient','hidden','imageVerified'])assert.throws(()=>validateConsoleEvidence([{...consoleRows()[0],[key]:false},consoleRows()[1]],node));
  assert.throws(()=>validateConsoleEvidence([consoleRows()[0],{...consoleRows()[1],stopped:false}],node));
});
test('Only owner-loss skips its disconnected completion transport, never console identity', () => {
  validateConsoleEvidence(consoleRows().slice(0,1),node,{ownerLoss:true});
  assert.throws(()=>validateConsoleEvidence([],node,{ownerLoss:true}));
  assert.throws(()=>validateConsoleEvidence(consoleRows().slice(0,1),node));
});
