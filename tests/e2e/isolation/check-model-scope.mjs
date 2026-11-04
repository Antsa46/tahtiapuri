// Explicit post-build rejection check. Never launches a model or reads GGUF bytes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
assert(process.platform==='win32'&&process.argv.length===2);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),output=join(root,'.artifacts/tests/isolation');
const host=join(output,'native/bin/host.exe'),staged=join(output,'scope-checks',randomUUID());
await fs.mkdir(staged,{recursive:true});await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY',{flag:'wx'});
const cases=[['run-model-candidate','ac','t09e','once','model-candidate-scope'],['run-model-candidate','control-inherit','t09e','once','sdk-policy'],['run-model-candidate','lpac','t09d','once','profile-purpose'],
 ...['run-sdk','run-sdk-node','run-sdk-node-candidate'].map(verb=>[verb,'control',verb==='run-sdk-node-candidate'?'t09d':'t09c','missing-model',verb==='run-sdk-node-candidate'?'sdk-candidate-scope':'lifetime']),
 ...['control','lpac'].flatMap(mode=>['fail','missing-binary','network-once','registry-once','startup-child','primary-once'].map(life=>['run-model-candidate',mode,'t09e',life,'model-candidate-scope']))];
const results=[];
try{for(const [verb,mode,purpose,life,stage]of cases){const profile=`tahtiapuri.${purpose}.${randomUUID().replaceAll('-','')}`;const p=spawnSync(host,[verb,mode,profile,staged,'1','1','1','1','1',life],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:32768});assert.ifError(p.error);assert.equal(p.status,1);assert.equal(p.signal,null);assert.equal(p.stderr,'');assert.deepEqual(p.stdout.trim().split('\n').map(JSON.parse),[{type:'error',stage,code:87}]);assert.deepEqual(await fs.readdir(staged),['owner.marker']);results.push({verb,mode,life,rejectedBeforeProfile:true});}console.log(JSON.stringify({passed:true,scopeChecks:results}));}
finally{assert.deepEqual(await fs.readdir(staged),['owner.marker']);await fs.unlink(join(staged,'owner.marker'));await fs.rmdir(staged);}
