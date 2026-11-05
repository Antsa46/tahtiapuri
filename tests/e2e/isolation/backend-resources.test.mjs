import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CASE_MARKER,safeRelativePath,verifyStagedPackage,verifyDataTree,collectBackendPins,verifyBackendManifest,prepareBackendResources} from './backend-resources.mjs';
import {verifyBuildFiles} from './run-backend-probe.mjs';

const project=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(action){
  const root=join(project,'.artifacts/tests/backend-resources-unit',randomBytes(16).toString('hex'));await fs.mkdir(root,{recursive:true});
  const packageRoot=join(root,'package');await fs.mkdir(packageRoot);const bytes=Buffer.from('SYNTHETIC\n');
  await fs.mkdir(join(packageRoot,'nested'));await fs.writeFile(join(packageRoot,'nested/data.txt'),bytes,{flag:'wx'});
  const manifest={schema:1,files:[{path:'nested/data.txt',source:null,bytes:bytes.length,sha256:sha(bytes),content:bytes.toString()}]};
  try{await action({root,packageRoot,manifest});}finally{await fs.rm(root,{recursive:true,force:true});}
}

test('staged package accepts exact bytes and rejects added or changed resources',async()=>{
  await fixture(async({packageRoot,manifest})=>{
    await verifyStagedPackage(packageRoot,manifest);
    await fs.writeFile(join(packageRoot,'extra.txt'),'extra',{flag:'wx'});await assert.rejects(verifyStagedPackage(packageRoot,manifest),/Unexpected staged file/);
    await fs.unlink(join(packageRoot,'extra.txt'));await fs.writeFile(join(packageRoot,'nested/data.txt'),'changed');await assert.rejects(verifyStagedPackage(packageRoot,manifest));
  });
});

test('staged package rejects hard links and directory junctions',async()=>{
  await fixture(async({root,packageRoot,manifest})=>{
    await fs.link(join(packageRoot,'nested/data.txt'),join(root,'hardlink.txt'));await assert.rejects(verifyStagedPackage(packageRoot,manifest),/hard link/);
    await fs.unlink(join(root,'hardlink.txt'));await fs.rename(join(packageRoot,'nested'),join(root,'outside'));
    await fs.symlink(join(root,'outside'),join(packageRoot,'nested'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(verifyStagedPackage(packageRoot,manifest),/Link/);
  });
});

test('data tree rejects linked persistence and bounded traversal overflow',async()=>{
  await fixture(async({root})=>{
    const data=join(root,'data');await fs.mkdir(data);await fs.writeFile(join(data,'places.json'),'{}');await verifyDataTree(data);
    await fs.link(join(data,'places.json'),join(root,'alias.json'));await assert.rejects(verifyDataTree(data),/single regular file/);await fs.unlink(join(root,'alias.json'));
    for(let i=0;i<128;i++)await fs.writeFile(join(data,`file-${i}`),'x',{flag:'wx'});
    await assert.rejects(verifyDataTree(data),/exceeds bounds/);
  });
});

test('existing case junction is rejected before touching its external fixture',async()=>{
  await fixture(async({root})=>{
    const external=join(root,'external'),data=join(external,'data');await fs.mkdir(data,{recursive:true});
    const marker=Buffer.from(CASE_MARKER),sentinel=Buffer.from('SYNTHETIC EXTERNAL DATA\n');
    await fs.writeFile(join(external,'owner.marker'),marker,{flag:'wx'});await fs.writeFile(join(data,'preserve.json'),sentinel,{flag:'wx'});
    const caseRoot=join(root,`case-${randomBytes(16).toString('hex')}`);await fs.symlink(external,caseRoot,process.platform==='win32'?'junction':'dir');
    await assert.rejects(prepareBackendResources({projectRoot:project,caseRoot,manifest:null,hostPath:'unused',hostSha256:'0'.repeat(64)}),/Case root/);
    assert.deepEqual((await fs.readdir(external)).sort(),['data','owner.marker']);assert.deepEqual(await fs.readdir(data),['preserve.json']);
    assert.deepEqual(await fs.readFile(join(external,'owner.marker')),marker);assert.deepEqual(await fs.readFile(join(data,'preserve.json')),sentinel);
  });
});

test('build provenance requires controller and runtime source plus compiled files and detects later changes',async()=>{
  await fixture(async({root})=>{
    const paths=['apps/desktop/src/main/backend-controller.ts','apps/desktop/dist/main/backend-controller.js','apps/backend/src/runtime/backend.ts','apps/backend/dist/runtime/backend.js',...['resources-manifest.json','backend-probe-pins.h','bin/backend-probe-host.exe'].map(name=>`.artifacts/tests/isolation/backend-probe/native/${name}`)];
    const bytes=Buffer.from('SYNTHETIC BUILD INPUT\n'),build={files:paths.map(path=>({path,sha256:sha(bytes)}))};
    for(const path of paths){const target=join(root,...path.split('/'));await fs.mkdir(join(target,'..'),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
    assert.equal((await verifyBuildFiles(root,build)).length,4);
    await assert.rejects(verifyBuildFiles(root,{files:build.files.filter(file=>file.path!=='apps/desktop/dist/main/backend-controller.js')}),/Build provenance missing/);
    await fs.writeFile(join(root,'apps/desktop/dist/main/backend-controller.js'),'SYNTHETIC CHANGED BUILD INPUT\n');
    await assert.rejects(verifyBuildFiles(root,build),/Build input\/output changed/);
  });
});

test('fixed resource manifest rejects changed authority and exposes no SDK graph',async()=>{
  const manifest=await collectBackendPins(project);assert(Object.isFrozen(manifest)&&Object.isFrozen(manifest.files)&&manifest.files.every(Object.isFrozen));
  assert.equal(manifest.files.length,39);assert(!manifest.files.some(file=>/llama|electron|\.pnpm/.test(file.path)));
  assert(manifest.files.some(file=>file.path==='node_modules/astronomy-engine/esm/astronomy.js'));
  const changed=structuredClone(manifest);changed.files[0].sha256='0'.repeat(64);await assert.rejects(verifyBackendManifest(project,changed),/manifest differs/);
});

test('resource paths reject traversal, drive paths and alternate separators',()=>{
  for(const path of ['../secret','/root','C:/data','safe\\data','safe/../data','safe//data','safe\0data'])assert.throws(()=>safeRelativePath(path));
  assert.equal(safeRelativePath('node_modules/@tahtiapuri/domain/dist/index.js'),'node_modules/@tahtiapuri/domain/dist/index.js');
});
