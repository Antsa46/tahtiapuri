// Explicit post-build rejection check. Never launches Electron, a model, or a network request.
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
const cases=[
 ...['control','ac'].flatMap(mode=>Array.from({length:5},(_,index)=>['run-desktop-candidate',mode,'t09g','window-once','desktop-candidate-scope',Array.from({length:5},(_,at)=>at===index?'2':'1')])),
 ...['lpac','control-inherit'].map(mode=>['run-desktop-candidate',mode,'t09g','window-once','desktop-candidate-scope']),
 ...['control','ac'].map(mode=>['run-desktop-candidate',mode,'t09f','window-once','profile-purpose']),
 ...['control','ac'].flatMap(mode=>['once','hold','fail','generate','cancel','network-once','window-hold'].map(life=>['run-desktop-candidate',mode,'t09g',life,'desktop-candidate-scope'])),
 ['run-inference-candidate','control','t09f','window-once','inference-candidate-scope'],
 ['run-model-candidate','control','t09e','window-once','model-candidate-scope']
];
cases.push(...cases.filter(row=>row[0]==='run-desktop-candidate').map(row=>['run-desktop-debug',...row.slice(1)]));
const results=[];
try{for(const [verb,mode,purpose,life,stage,ports=['1','1','1','1','1']]of cases){const profile=`tahtiapuri.${purpose}.${randomUUID().replaceAll('-','')}`;const p=spawnSync(host,[verb,mode,profile,staged,...ports,life],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:32768});assert.ifError(p.error);assert.equal(p.status,1);assert.equal(p.signal,null);assert.equal(p.stderr,'');assert.deepEqual(p.stdout.trim().split('\n').map(JSON.parse),[{type:'error',stage,code:87}]);assert.deepEqual(await fs.readdir(staged),['owner.marker']);results.push({verb,mode,life,rejectedBeforeProfile:true});}console.log(JSON.stringify({passed:true,scopeChecks:results}));}
finally{assert.deepEqual(await fs.readdir(staged),['owner.marker']);await fs.unlink(join(staged,'owner.marker'));await fs.rmdir(staged);}
