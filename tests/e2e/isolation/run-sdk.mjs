import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializePackages, resolveInstalledPackage, sha256 } from './package-stager.mjs';
import { validateSdkEvidence, classifySdkFailure } from './sdk-results.mjs';
import { validateRuntimeProfile, validateRuntimeEvidence, validateConsoleEvidence } from './sdk-runtime.mjs';
import { prepareElectronFixture } from './electron-fixture.mjs';
import { collect, bounded, until, cleanupOwnedRun } from './process-harness.mjs';
if (process.platform !== 'win32') throw new Error('Native Windows Node is required.');
const selection = process.argv[2] ?? 'electron';
assert(process.argv.length <= 3 && ['electron', 'official', 'local-unpatched', 'local-patched'].includes(selection));
const directory = dirname(fileURLToPath(import.meta.url)), root = resolve(directory, '../../..');
const output = join(root, '.artifacts/tests/isolation'); const host = join(output, 'native/bin/host.exe');
const runRoot = join(output, 'sdk-runs', randomUUID()); await fs.mkdir(runRoot, { recursive: true });
const template = join(runRoot, 'template');
const summary = { schema: 1, scope: 'sdk-cpu-and-instrumented-child-only', cases: [], passed: false, unrunCases: [] };
let helperSha256, bindingSha256, runtime;
async function prepare() {
  if (selection === 'electron') {
    summary.electron = await prepareElectronFixture(root, template);
    runtime = { kind: 'electron', variant: 'official', version: summary.electron.version, sha256: await sha256(join(template, 'electron.exe')) };
  } else {
    const manifests = JSON.parse(await fs.readFile(join(root, '.artifacts/tests/t09c-node/runtimes.json'), 'utf8'));
    assert.equal(manifests.schema, 1); runtime = manifests.variants[selection];
    validateRuntimeProfile(runtime); assert.equal(runtime.kind, 'node'); assert.equal(runtime.variant, selection);
    const source = selection === 'official'
      ? join(root, '.local/toolchain/node-v24.22.2-win-x64/node.exe')
      : join(root, '.local/toolchain/node-comparison', selection, 'node.exe');
    assert.equal(await sha256(source), runtime.sha256);
    await fs.mkdir(template, { recursive: true }); await fs.copyFile(source, join(template, 'node.exe'));
    assert.equal(await sha256(join(template, 'node.exe')), runtime.sha256);
  }
  validateRuntimeProfile(runtime); summary.runtime = runtime; summary.hostSha256 = await sha256(host);
  // Bound Node package-scope discovery to the owned fixture, not the enclosing checkout.
  await fs.writeFile(join(template, 'package.json'), JSON.stringify({ name: 'tahtiapuri-sdk-isolation-fixture', private: true, type: 'module' }) + '\n', { flag: 'wx' });
  summary.fixturePackageSha256 = await sha256(join(template, 'package.json'));
  const sourceRoot = await fs.realpath(join(root, 'node_modules')); const sdk = await fs.realpath(join(sourceRoot, 'node-llama-cpp'));
  const cpu = await resolveInstalledPackage(sdk, '@node-llama-cpp/win-x64', sourceRoot);
  for (const source of [sdk,cpu]) assert.equal(JSON.parse(await fs.readFile(join(source, 'package.json'), 'utf8')).version, '3.22.2');
  const manifest = await materializePackages({ sourceRoot, destination: join(template, 'node_modules'), roots: [{name:'node-llama-cpp',source:sdk},{name:'@node-llama-cpp/win-x64',source:cpu}] });
  await fs.writeFile(join(runRoot, 'packages.json'), JSON.stringify(manifest,null,2)+'\n');
  summary.packages = { count: manifest.packages.length, files: manifest.fileCount, bytes: manifest.bytes, manifestSha256: await sha256(join(runRoot, 'packages.json')) };
  helperSha256 = await sha256(join(template, 'node_modules/node-llama-cpp/dist/bindings/utils/testBindingBinary.js'));
  bindingSha256 = await sha256(join(template, 'node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node'));
  for (const name of ['sdk-probe.mjs','sdk-child-observer.mjs','child-policy-preload.cjs','sdk-runtime.mjs']) await fs.copyFile(join(directory,name), join(template,name));
  summary.scriptHashes = Object.fromEntries(await Promise.all(['sdk-probe.mjs','sdk-child-observer.mjs','child-policy-preload.cjs','sdk-runtime.mjs'].map(async name => [name, await sha256(join(template,name))])));
}
function validate(records, mode, kind) {
  const {child}=validateSdkEvidence(records,mode,{requireChild:true});
  for(const phase of ['integrity','runtime-contract','import','public-cpu'])assert(records.some(r=>r.type==='sdk-phase'&&r.phase===phase&&r.passed===true),`Missing ${phase}`);
  validateRuntimeEvidence(records,runtime);
  const cpu=records.find(r=>r.type==='sdk-phase'&&r.phase==='public-cpu');assert.equal(cpu.gpu,false);assert.equal(cpu.buildType,'prebuilt');
  const messages=records.filter(r=>r.type==='sdk-child-message'&&r.pid===child.pid).map(r=>r.message);
  const exit=records.find(r=>r.type==='sdk-child-exit'&&r.pid===child.pid);
  if(kind==='owner-child'){assert.deepEqual(messages,['ready']);assert(records.some(r=>r.type==='sdk-held'&&r.pid===child.pid));}
  else if(kind==='missing-binary'){assert.deepEqual(messages,['ready']);assert.equal(exit?.code,1);assert(records.some(r=>r.type==='sdk-expected-failure'));}
  else {assert.deepEqual(messages,['ready','loaded','done']);assert.equal(exit?.code,0);assert(records.some(r=>r.type==='sdk-phase'&&r.phase==='instrumented-binary-test'&&r.passed));assert(records.some(r=>r.type==='sdk-ready'));}
  assert(!records.some(r=>r.type==='sdk-error'));
}
async function runCase(mode,kind,attempt=1) {
  const nonce=randomUUID().replaceAll('-',''),profile=`tahtiapuri.t09c.${nonce}`;
  const caseRoot=join(runRoot,`${mode}-${kind}-${attempt}`),staged=join(caseRoot,'staged');
  for(const dir of ['private','scratch','launcher'])await fs.mkdir(join(staged,dir),{recursive:true});
  await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY',{flag:'wx'});
  await fs.cp(template,join(staged,'package'),{recursive:true,dereference:false});
  await fs.writeFile(join(staged,'package/sdk-profile.json'),JSON.stringify({version:'3.22.2',nonce,helperSha256,bindingSha256,runtime}));
  await fs.writeFile(join(staged,'package/allowed.txt'),'SYNTHETIC ALLOWED\n');await fs.writeFile(join(staged,'package/module.mjs'),'export const synthetic = true;\n');await fs.writeFile(join(staged,'private/secret.txt'),'SYNTHETIC PRIVATE\n');
  const caseHost=join(staged,'launcher/host.exe');await fs.copyFile(host,caseHost);
  const args=[runtime.kind==='node'?'run-sdk-node':'run-sdk',mode,profile,staged,'1','1','1','1','1',kind==='normal'?'once':kind==='owner-child'?'hold':'missing-binary'];
  const owner=kind==='owner-child';const child=spawn(owner?process.execPath:caseHost,owner?[join(directory,'owner.mjs'),caseHost,...args]:args,{stdio:['pipe','pipe','pipe'],windowsHide:true});const report=collect(child,{workerEnvelope:true});
  const result={mode,kind,attempt,profileIntent:profile,passed:false,records:report.records};
  try {
    if(owner){await until(()=>{report.check();return report.records.some(r=>['sdk-held','sdk-error','error','finished'].includes(r.type));},30000);validate(report.records,mode,kind);validateConsoleEvidence(report.records,runtime,{ownerLoss:true});assert(child.kill());}
    result.exit=await bounded(report.exited,70000,'SDK launcher timeout.');report.checkComplete(); validateConsoleEvidence(report.records,runtime,{ownerLoss:owner});validate(report.records,mode,kind);
    if(!owner){assert.equal(result.exit.code,kind==='missing-binary'?1:0);assert.equal(report.records.find(r=>r.type==='finished')?.exitCode,kind==='missing-binary'?17:0);assert.equal(report.records.find(r=>r.type==='finished')?.activeProcesses,0);}
    result.observationsVerified=true;
  }catch(error){result.error=error.stack;
    if(kind==='normal')try{report.checkComplete(); validateConsoleEvidence(report.records,runtime,{ownerLoss:owner});result.sdkFailure=classifySdkFailure(report.records,mode,result.exit,runtime);}catch{}
  }finally{
    result.cleanup=await cleanupOwnedRun({child,report,host,staged,profile,restricted:mode==='ac'});result.stderr=report.stderr;result.passed=result.observationsVerified===true&&result.cleanup.passed&&(runtime.kind!=='node'||result.cleanup.consoleStopped===true);
    await fs.writeFile(join(caseRoot,'result.json'),JSON.stringify(result,null,2)+'\n');summary.cases.push({mode,kind,attempt,passed:result.passed,cleanupPassed:result.cleanup.passed,sdkFailure:result.sdkFailure,error:result.error});
  }
  console.log(`${mode}/${kind}/${attempt}: ${result.passed?'PASS':'FAILED (preserved diagnostic result)'}`);assert(result.cleanup.passed,'SDK cleanup failed; matrix stopped.');assert(result.passed||result.sdkFailure,'Unexpected SDK identity, protocol, or permission result; matrix stopped.');return result;
}
try {
  await prepare();
  for(const kind of ['normal','missing-binary','owner-child'])assert((await runCase('control',kind)).passed,'SDK control failed.');
  const normal=await runCase('ac','normal');
  if(normal.passed){assert((await runCase('ac','missing-binary')).passed);assert((await runCase('ac','owner-child')).passed);}
  else{const repeated=await runCase('ac','normal',2);assert.deepEqual({...repeated.sdkFailure,message:undefined},{...normal.sdkFailure,message:undefined});summary.unrunCases.push('ac/missing-binary','ac/owner-child');}
  summary.passed=summary.cases.every(r=>r.passed);if(!summary.passed)process.exitCode=1;
}catch(error){summary.error=error.stack;process.exitCode=1;}finally{
  summary.unrunCases=['control','ac'].flatMap(mode=>['normal','missing-binary','owner-child'].filter(kind=>!summary.cases.some(row=>row.mode===mode&&row.kind===kind)).map(kind=>`${mode}/${kind}`));
  try{await fs.rm(template,{recursive:true,force:true});}catch(error){summary.templateCleanupError=error.code;summary.passed=false;process.exitCode=1;}
  await fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');
}
