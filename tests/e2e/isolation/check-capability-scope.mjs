// Explicit post-build Windows check: invalid requests must fail before profiles,
// ACL grants or child launch. No successful capability launch is made here.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
assert(process.platform==='win32'&&process.argv.length===2);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const output=join(root,'.artifacts/tests/isolation'),host=join(output,'native/bin/host.exe');
const staged=join(output,'scope-checks',randomUUID());
await fs.mkdir(staged,{recursive:true});await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY',{flag:'wx'});
const registryCases=[['control','registry-once'],['ac','registry-once'],['control-inherit','startup-winsock'],...['resource-once','once','hold','fail','network-once','primary-once','missing-binary'].map(kind=>['lpac',kind])];
const candidateCases=[['control','network-once'],['ac','network-once'],['control-inherit','network-once'],...['resource-once','registry-once','startup-child','startup-no-inherit','startup-winsock','once','hold','fail','primary-once','missing-binary'].map(kind=>['lpac',kind])];
const cases=[...registryCases.map(([mode,kind])=>['run-registry-read',mode,kind,'registry-comparison-scope']),...candidateCases.map(([mode,kind])=>['run-lpac-candidate',mode,kind,'candidate-comparison-scope'])];
const results=[];
try{
 for(const [verb,mode,kind,stage] of cases){
  const profile=`tahtiapuri.t09a.${randomUUID().replaceAll('-','')}`;
  const p=spawnSync(host,[verb,mode,profile,staged,'1','1','1','1','1',kind],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:32768});
  assert.ifError(p.error);assert.equal(p.signal,null);assert.equal(p.status,1);assert.equal(p.stderr,'');
  const rows=p.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(rows,[{type:'error',stage,code:87}]);
  assert.deepEqual(await fs.readdir(staged),['owner.marker']);results.push({verb,mode,kind,rejectedBeforeProfile:true});
 }
 console.log(JSON.stringify({scopeChecks:results,passed:true}));
}finally{
 const stat=await fs.lstat(staged);assert(stat.isDirectory()&&!stat.isSymbolicLink());
 assert.deepEqual(await fs.readdir(staged),['owner.marker']);
 await fs.unlink(join(staged,'owner.marker'));await fs.rmdir(staged);
}
