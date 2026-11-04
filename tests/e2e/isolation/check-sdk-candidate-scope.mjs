// Native rejection probes: no valid launch or profile creation occurs here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
assert(process.platform === 'win32' && process.argv.length === 2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = join(root, '.artifacts/tests/isolation'), host = join(output, 'native/bin/host.exe');
const staged = join(output, 'scope-checks', randomUUID());
await fs.mkdir(staged, {recursive:true}); await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY',{flag:'wx'});
const cases = [
 ['run-sdk-node-candidate','control-inherit','t09d','once','sdk-policy'],
 ['run-sdk-node-candidate','lpac','t09c','once','profile-purpose'],
 ...['run-sdk','run-sdk-node'].map(verb=>[verb,'lpac','t09c','once','sdk-policy']),
 ...['control','ac','lpac'].flatMap(mode=>['fail','network-once','network-hold','registry-once','startup-child','primary-once'].map(life=>['run-sdk-node-candidate',mode,'t09d',life,'sdk-candidate-scope']))
];
const results=[];
try {
 for(const [verb,mode,purpose,life,stage] of cases) {
  const profile=`tahtiapuri.${purpose}.${randomUUID().replaceAll('-','')}`;
  const p=spawnSync(host,[verb,mode,profile,staged,'1','1','1','1','1',life],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:32768});
  assert.ifError(p.error);assert.equal(p.signal,null);assert.equal(p.status,1);assert.equal(p.stderr,'');
  assert.deepEqual(p.stdout.trim().split('\n').map(line=>JSON.parse(line)),[{type:'error',stage,code:87}]);
  assert.deepEqual(await fs.readdir(staged),['owner.marker']);results.push({verb,mode,life,rejectedBeforeProfile:true});
 }
 console.log(JSON.stringify({scopeChecks:results,passed:true}));
} finally {
 assert.deepEqual(await fs.readdir(staged),['owner.marker']);await fs.unlink(join(staged,'owner.marker'));await fs.rmdir(staged);
}
