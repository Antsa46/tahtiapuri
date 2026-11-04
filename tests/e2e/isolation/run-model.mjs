import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs,constants} from 'node:fs';
import {freemem} from 'node:os';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {materializePackages,resolveInstalledPackage,sha256} from './package-stager.mjs';
import {validateRuntimeProfile} from './sdk-runtime.mjs';
import {modelProfile} from './model-contract.mjs';
import {validateModelProgress,modelProcessIds,validateModelLifecycle} from './model-results.mjs';
import {collect,bounded,until,alive,cleanupOwnedRun} from './process-harness.mjs';
import {verifyPreparationLimits} from './model-load-limits.mjs';
assert(process.platform==='win32'&&(process.argv.length===2||(process.argv.length===3&&process.argv[2]==='--check-limits')));
const preparationLimits=verifyPreparationLimits();
if(process.argv[2]==='--check-limits'){console.log(JSON.stringify({passed:true,preparationLimits}));process.exit(0);}
const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'../../..');
const output=join(root,'.artifacts/tests/isolation'),host=join(output,'native/bin/host.exe');
const runRoot=join(output,'model-runs',randomUUID()),template=join(runRoot,'template');
const source=join(root,'.local/models/Qwen3-4B-Q4_K_M.gguf');
const summary={schema:1,scope:'4b-cpu-load-only',preparationLimits,cases:[],passed:false,unrunCases:[],generation:false,gpu:false};
const matrix=['control','lpac'].flatMap(mode=>['normal','missing-model','owner-loaded'].map(kind=>({mode,kind})));
let runtime,bindingSha256,original;
async function prepare(){
 assert(freemem()>=6*1024**3,'Insufficient available memory for this bounded experiment.');
 const publicProfile=JSON.parse(await fs.readFile(join(root,'resources/models/qwen3-4b.json'),'utf8'));
 assert.equal(publicProfile.id,modelProfile.id);assert.equal(publicProfile.sha256,modelProfile.sha256);assert.equal(publicProfile.bytes,modelProfile.bytes);assert.equal(publicProfile.expectedChatTemplateSha256,modelProfile.templateSha256);
 original=await fs.lstat(source);assert(original.isFile()&&!original.isSymbolicLink()&&original.nlink===1);assert.equal(original.size,modelProfile.bytes);
 assert.equal(await sha256(source),modelProfile.sha256);summary.sourceBefore={bytes:original.size,sha256:modelProfile.sha256,ino:original.ino,mtimeMs:original.mtimeMs};
 await fs.mkdir(template,{recursive:true});
 const manifests=JSON.parse(await fs.readFile(join(root,'.artifacts/tests/t09c-node/runtimes.json'),'utf8'));assert.equal(manifests.schema,1);runtime=manifests.variants['local-patched'];validateRuntimeProfile(runtime);assert.equal(runtime.kind,'node');assert.equal(runtime.variant,'local-patched');
 const node=join(root,'.local/toolchain/node-comparison/local-patched/node.exe');assert.equal(await sha256(node),runtime.sha256);
 await fs.copyFile(node,join(template,'node.exe'),constants.COPYFILE_EXCL);assert.equal(await sha256(join(template,'node.exe')),runtime.sha256);
 summary.runtime=runtime;summary.hostSha256=await sha256(host);
 await fs.writeFile(join(template,'package.json'),JSON.stringify({name:'tahtiapuri-model-isolation-fixture',private:true,type:'module'})+'\n',{flag:'wx'});
 const sourceRoot=await fs.realpath(join(root,'node_modules')),sdk=await fs.realpath(join(sourceRoot,'node-llama-cpp'));
 const cpu=await resolveInstalledPackage(sdk,'@node-llama-cpp/win-x64',sourceRoot);
 for(const path of [sdk,cpu])assert.equal(JSON.parse(await fs.readFile(join(path,'package.json'),'utf8')).version,'3.22.2');
 const packages=await materializePackages({sourceRoot,destination:join(template,'node_modules'),roots:[{name:'node-llama-cpp',source:sdk},{name:'@node-llama-cpp/win-x64',source:cpu}]});
 await fs.writeFile(join(runRoot,'packages.json'),JSON.stringify(packages,null,2)+'\n');summary.packagesSha256=await sha256(join(runRoot,'packages.json'));
 bindingSha256=await sha256(join(template,'node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node'));
 summary.scriptHashes={};for(const name of ['model-probe.mjs','model-contract.mjs','sdk-runtime.mjs']){await fs.copyFile(join(directory,name),join(template,name),constants.COPYFILE_EXCL);summary.scriptHashes[name]=await sha256(join(template,name));}
}
async function runCase(mode,kind){
 const caseLimits=verifyPreparationLimits();
 assert(freemem()>=6*1024**3,'Insufficient available memory; no further model launched.');
 const profile=`tahtiapuri.t09e.${randomUUID().replaceAll('-','')}`,caseRoot=join(runRoot,`${mode}-${kind}`),staged=join(caseRoot,'staged');
 await fs.mkdir(caseRoot);await fs.mkdir(staged);
 await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY',{flag:'wx'});
 try {
 for(const name of ['package','private','scratch','launcher'])await fs.mkdir(join(staged,name));
 await fs.cp(template,join(staged,'package'),{recursive:true,dereference:false});
 await fs.writeFile(join(staged,'package/model-profile.json'),JSON.stringify({version:'3.22.2',runtime,model:modelProfile,bindingSha256}),{flag:'wx'});
 for(const [name,text] of [['package/allowed.txt','SYNTHETIC ALLOWED\n'],['package/module.mjs','export const synthetic = true;\n'],['package/weights-write.fixture','SYNTHETIC WEIGHTS ACL\n'],['package/legacy.fixture','SYNTHETIC AAP ONLY\n'],['private/secret.txt','SYNTHETIC PRIVATE\n']])await fs.writeFile(join(staged,name),text,{flag:'wx'});
 if(kind!=='missing-model'){
  await fs.copyFile(source,join(staged,'package/model.gguf'),constants.COPYFILE_EXCL);
  const copy=await fs.lstat(join(staged,'package/model.gguf'));assert(copy.isFile()&&!copy.isSymbolicLink()&&copy.nlink===1&&copy.size===modelProfile.bytes&&copy.ino!==original.ino);
 }
 await fs.copyFile(host,join(staged,'launcher/host.exe'),constants.COPYFILE_EXCL);
 }catch(error){
  const stat=await fs.lstat(staged);assert(stat.isDirectory()&&!stat.isSymbolicLink());
  assert.equal(await fs.readFile(join(staged,'owner.marker'),'utf8'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY');
  await fs.rm(staged,{recursive:true,force:true});throw error;
 }
 const caseHost=join(staged,'launcher/host.exe');
 const args=['run-model-candidate',mode,profile,staged,'1','1','1','1','1',kind==='normal'?'once':kind==='owner-loaded'?'hold':'missing-model'];
 const owner=kind==='owner-loaded',child=spawn(owner?process.execPath:caseHost,owner?[join(directory,'owner.mjs'),caseHost,...args]:args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
 const report=collect(child,{workerEnvelope:true});const result={mode,kind,preparationLimits:caseLimits,profileIntent:profile,driverPid:process.pid,launchedChildPid:child.pid,startedAtMs:Date.now(),records:report.records,passed:false};
 try{
  if(owner){
   await until(()=>{report.check();return report.records.some(x=>['model-held','model-error','error','finished'].includes(x.type));},115000);
   validateModelProgress(report.records,mode,kind,runtime,{held:true});
   result.termination={targetPid:child.pid,targetRole:'owner',signal:'SIGTERM',targetAliveBeforeRequest:alive(child.pid),requestedAtMs:Date.now()};result.termination.succeeded=child.kill();assert.equal(result.termination.succeeded,true);
  }
  result.exit=await bounded(report.exited,130000,'Model host deadline.');report.checkComplete();validateModelProgress(report.records,mode,kind,runtime);
  const pids=modelProcessIds(result);await until(()=>pids.every(pid=>!alive(pid)),7000);result.processExitObservation={pids,allAbsent:true,beforeCleanup:true,checkedAtMs:Date.now()};validateModelLifecycle(result);result.observationsVerified=true;
 }catch(error){result.error=error.stack;}
 finally{
  result.cleanup=await cleanupOwnedRun({child,report,host,staged,profile,restricted:mode==='lpac'});result.stderr=report.stderr;
  result.passed=result.observationsVerified===true&&result.cleanup.passed&&result.cleanup.consoleStopped===true;
  await fs.writeFile(join(caseRoot,'result.json'),JSON.stringify(result,null,2)+'\n');summary.cases.push({mode,kind,passed:result.passed,cleanupPassed:result.cleanup.passed,error:result.error});
 }
 console.log(`${mode}/${kind}: ${result.passed?'PASS':'FAILED (original evidence retained)'}`);assert(result.passed,'Model case failed; matrix stopped.');
}
await fs.mkdir(runRoot,{recursive:true});
try{await prepare();for(const c of matrix)await runCase(c.mode,c.kind);summary.passed=true;}
catch(error){summary.error=error.stack;process.exitCode=1;}
finally{
 summary.unrunCases=matrix.filter(c=>!summary.cases.some(r=>r.mode===c.mode&&r.kind===c.kind));
 try{
  if(original){verifyPreparationLimits();const after=await fs.lstat(source);const digest=await sha256(source);assert.equal(digest,modelProfile.sha256);assert.equal(after.ino,original.ino);assert.equal(after.size,original.size);assert.equal(after.mtimeMs,original.mtimeMs);summary.sourceUnchanged=true;}
 }catch(error){summary.finalizationError=error.stack;summary.passed=false;process.exitCode=1;}
 try{await fs.rm(template,{recursive:true,force:true});}
 catch(error){summary.templateCleanupError=error.stack;summary.passed=false;process.exitCode=1;}
 await fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');
}
