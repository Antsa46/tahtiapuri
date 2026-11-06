import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUILD_MARKER, NODE, PACKAGE_PATHS, PACKAGE_JSON, manifestBytes, generatePins, sha256 } from './mcp-runtime-package.mjs';
import { validateWorkerSelection, prepareNativeWorker, verifyNativeOutput } from './prepare-mcp-native.mjs';
const build='build-'+'a'.repeat(32), digest='b'.repeat(64);
test('worker build is a fixed local identifier and its digest comes from the caller', () => {
  assert.deepEqual(validateWorkerSelection(build,digest),{build,digest});
  for(const value of ['', '../'+build, '/'+build, build+'/package', 'build-'+'A'.repeat(32), 'build-'+'a'.repeat(31), {}, null])
    assert.throws(()=>validateWorkerSelection(value,digest));
  for(const value of ['', 'B'.repeat(64), 'b'.repeat(63), {}, null])
    assert.throws(()=>validateWorkerSelection(build,value));
});
async function fixture(t){
  const parent=resolve('.artifacts/tests/mcp-native-package');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(join(parent,'case-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const output=join(root,'out'),donor=join(root,'.artifacts/native/mcp-runtime/builds',build);
  await fs.mkdir(output);await fs.mkdir(join(donor,'package'),{recursive:true});
  await fs.writeFile(join(output,'owner.marker'),'TAHTIAPURI_MCP_NATIVE_BUILD_V1\n');
  await fs.writeFile(join(donor,'owner.marker'),BUILD_MARKER);
  return {root,output,donor};
}
const options=f=>({projectRoot:f.root,buildRoot:f.output,workerBuild:build,expectedDigest:digest});
test('unowned native output cannot receive an accepted worker',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.output,'owner.marker'),'other\n');
  await assert.rejects(prepareNativeWorker(options(f)),/ownership/);
  await assert.rejects(fs.stat(join(f.output,'package')), {code:'ENOENT'});
});
test('unowned worker build is rejected before destination creation',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.donor,'owner.marker'),'other\n');
  await assert.rejects(prepareNativeWorker(options(f)),/owner marker/);
  await assert.rejects(fs.stat(join(f.output,'package')), {code:'ENOENT'});
});
test('a donor cannot substitute its own manifest for the externally pinned digest',async t=>{
  const f=await fixture(t);
  await fs.writeFile(join(f.donor,'package/runtime-manifest.json'),'{}\n');
  await assert.rejects(prepareNativeWorker(options(f)),/External worker manifest digest/);
  await assert.rejects(fs.stat(join(f.output,'package')), {code:'ENOENT'});
});
test('matching bytes still require the strict fixed package schema',async t=>{
  const f=await fixture(t),bytes=Buffer.from('{"schema":1,"arbitrary":"not a worker manifest"}\n');
  await fs.writeFile(join(f.donor,'package/runtime-manifest.json'),bytes);
  await assert.rejects(prepareNativeWorker({...options(f),expectedDigest:sha256(bytes)}));
  await assert.rejects(fs.stat(join(f.output,'mcp-runtime-pins.h')), {code:'ENOENT'});
});
test('redirected donor is rejected',async t=>{
  const f=await fixture(t);await fs.rename(join(f.donor,'package'),join(f.donor,'actual'));
  await fs.symlink(join(f.donor,'actual'),join(f.donor,'package'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareNativeWorker(options(f)),/Linked|Noncanonical/);
});
test('hardlinked trust input is rejected',async t=>{
  const f=await fixture(t);
  await fs.writeFile(join(f.root,'manifest'),'{}\n');
  await fs.link(join(f.root,'manifest'),join(f.donor,'package/runtime-manifest.json'));
  await assert.rejects(prepareNativeWorker(options(f)),/single-link/);
});

async function finalFixture(t){
  const f=await fixture(t),pins={};
  for(const name of ['bin/mcp-broker.exe','helpers/main-bootstrap.exe','helpers/main-identity.exe']){
    const bytes=Buffer.from('synthetic test bytes; never executed');
    await fs.mkdir(join(f.output,name.split('/')[0]),{recursive:true});
    await fs.writeFile(join(f.output,name),bytes);pins[name]={bytes:bytes.length,sha256:sha256(bytes)};
  }
  const raw=Buffer.from(JSON.stringify(pins,null,2)+'\n');await fs.writeFile(join(f.output,'binary-pins.json'),raw);
  return {...f,pins,finalOptions:{buildRoot:f.output,expectedDigest:digest,binaryPinsDigest:sha256(raw)}};
}
test('final gate rejects extra helper content before any runtime admission',async t=>{
  const f=await finalFixture(t);await fs.writeFile(join(f.output,'helpers/extra.txt'),'x');
  await assert.rejects(verifyNativeOutput(f.finalOptions),/Binary directory boundary/);
  await assert.rejects(fs.stat(join(f.output,'runtime-descriptor.json')),{code:'ENOENT'});
});
test('final gate rejects a new hardlink even when binary names, bytes and digests match',async t=>{
  const f=await finalFixture(t);await fs.link(join(f.output,'helpers/main-bootstrap.exe'),join(f.root,'outside-link'));
  await assert.rejects(verifyNativeOutput(f.finalOptions),/single-link/);
});
test('final gate rejects changed compiled bytes against the externally pinned candidate',async t=>{
  const f=await finalFixture(t);const count=f.pins['bin/mcp-broker.exe'].bytes;
  await fs.writeFile(join(f.output,'bin/mcp-broker.exe'),Buffer.alloc(count,'x'));
  await assert.rejects(verifyNativeOutput(f.finalOptions),/Final binary hash/);
});
test('final gate rejects extra staged worker content after successful binary checks',async t=>{
  const f=await finalFixture(t),packageRoot=join(f.output,'package');
  const manifest={schema:1,protocol:'TMCP/1',node:{...NODE},entry:'mcp-worker.mjs',files:PACKAGE_PATHS.map(path=>({
    path,bytes:path==='package.json'?Buffer.byteLength(PACKAGE_JSON):1,
    sha256:path==='node.exe'?NODE.executableSha256:path==='licenses/node-LICENSE.txt'?NODE.licenseSha256:sha256(path==='package.json'?PACKAGE_JSON:'x')
  }))};
  for(const pin of manifest.files){await fs.mkdir(join(packageRoot,...pin.path.split('/').slice(0,-1)),{recursive:true});await fs.writeFile(join(packageRoot,pin.path),pin.path==='package.json'?PACKAGE_JSON:'x');}
  const raw=manifestBytes(manifest);await fs.writeFile(join(packageRoot,'runtime-manifest.json'),raw);
  await fs.writeFile(join(f.output,'mcp-runtime-pins.h'),generatePins(manifest));
  await fs.writeFile(join(packageRoot,'unexpected.txt'),'extra');
  await assert.rejects(verifyNativeOutput({...f.finalOptions,expectedDigest:sha256(raw)}),/Extra|Package node count exceeded/);
});
