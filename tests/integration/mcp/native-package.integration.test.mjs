// Explicit compile-package integration. No helper, broker or worker is executed.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const runtime=process.env.TAHTIAPURI_NATIVE_MCP_PACKAGE_ROOT;
const expected=process.env.TAHTIAPURI_NATIVE_MCP_DESCRIPTOR_SHA256;
const enabled=process.platform==='win32'&&!!runtime&&!!expected;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function descriptor(){
  assert.match(expected,/^[a-f0-9]{64}$/);
  const bytes=await fs.readFile(join(runtime,'runtime-descriptor.json'));
  assert.equal(hash(bytes),expected,'Externally pinned native descriptor differs');
  const value=JSON.parse(bytes);
  assert.equal(value.schema,1);assert.equal(value.id,'tahtiapuri-native-mcp-v1');
  return value;
}
let attempts=0,loadHelpers;
const previous=new Map();
before(async()=>{
  if(!enabled)return;
  for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){
    previous.set(name,childProcess[name]);
    childProcess[name]=()=>{++attempts;throw Error('Unexpected executable launch');};
  }
  syncBuiltinESMExports();
  // One counter also covers promisified launcher references kept in the ESM
  // cache after the first test. A rejection test cannot hide a later launch.
  const module=await import(pathToFileURL(join(project,'apps/desktop/dist/main/native-mcp-helpers.js')).href);
  loadHelpers=module.loadNativeMcpHelpers;
});
after(()=>{
  for(const [name,value] of previous)childProcess[name]=value;
  syncBuiltinESMExports();
  assert.equal(attempts,0,'Package inspection attempted to execute a helper');
});
async function noLaunch(action){await action(loadHelpers);assert.equal(attempts,0);}
async function fixture(t){
  const parent=join(project,'.artifacts/tests/mcp-native-helper-package');
  await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(join(parent,'case-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const helpers=join(root,'helpers');await fs.mkdir(helpers);
  for(const name of ['main-bootstrap.exe','main-identity.exe'])await fs.copyFile(join(runtime,'helpers',name),join(helpers,name));
  return {root,helpers,pins:(await descriptor()).helpers};
}
test('compiled helper directory loads with externally pinned descriptor and no process execution',{skip:!enabled},async()=>{
  const value=await descriptor(),receipt=JSON.parse(await fs.readFile(join(runtime,'result.json'),'utf8'));
  assert.equal(receipt.passed,true);assert.equal(receipt.helpersExecuted,false);assert.equal(receipt.brokerExecuted,false);
  assert.equal(receipt.inspectorBuilt,false);assert.equal(receipt.descriptorSha256,expected);
  await noLaunch(async load=>{
    const helpers=await load(join(runtime,'helpers'),value.helpers);
    assert(Object.isFrozen(helpers));assert.equal(typeof helpers.identity,'function');assert.equal(typeof helpers.operate,'function');
  });
});
test('compiled helper package rejects extra content without execution',{skip:!enabled},async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.helpers,'extra.txt'),'synthetic');
  await noLaunch(load=>assert.rejects(load(f.helpers,f.pins)));
});
test('compiled helper package rejects a new hardlink without execution',{skip:!enabled},async t=>{
  const f=await fixture(t);await fs.link(join(f.helpers,'main-identity.exe'),join(f.root,'outside-link'));
  await noLaunch(load=>assert.rejects(load(f.helpers,f.pins)));
});
test('compiled helper package rejects substituted trusted pins without execution',{skip:!enabled},async t=>{
  const f=await fixture(t);f.pins['main-identity.exe'].sha256='0'.repeat(64);
  await noLaunch(load=>assert.rejects(load(f.helpers,f.pins)));
});
