import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {freemem} from 'node:os';
import {promises as fs,constants,createReadStream} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collect,bounded,until,alive,helper} from './process-harness.mjs';
import {verifyPreparationLimits} from './model-load-limits.mjs';
import {modelCases,validateLaunch,validateResult,validateFailedCreationCleanup} from './native-model-results.mjs';
const flags=process.argv.slice(2);
assert(new Set(flags).size===flags.length&&flags.every(x=>['--smoke','--check-limits','--control-only','--lpac-only','--load-check'].includes(x)));
function preparationGate() {
  const limits=verifyPreparationLimits(),availableBytes=freemem();
  assert(availableBytes>=6*1024**3,'Insufficient available memory; no further model work started.');
  return {...limits,availableBytes};
}
assert(!(flags.includes('--control-only')&&flags.includes('--lpac-only')));
const preparationLimits=preparationGate();
if(flags.includes('--check-limits')) {console.log(JSON.stringify({passed:true,preparationLimits}));process.exit(0);}
const source=dirname(fileURLToPath(import.meta.url)),root=resolve(source,'../../..');
const output=join(root,'.artifacts/tests/isolation/native-model'),bin=join(output,'native/bin');
const runRoot=join(output,'runs',randomUUID());
const hash=async path=>{const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');};
const runtimeRoot=join(root,'.local/native/llama-v0.9.0-source-cpu');
const runtime=JSON.parse(await fs.readFile(join(root,'.artifacts/tests/isolation/native-source-runtime/runtime-manifest.json'),'utf8'));
const model=JSON.parse(await fs.readFile(join(root,'resources/models/qwen3-4b.json'),'utf8'));
const modelFile=join(root,'.local/models',model.file);
const dlls=['ggml-base.dll','ggml.dll','llama.dll','ggml-cpu.dll'];
async function regular(path,bytes) {const info=await fs.lstat(path);assert(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1);if(bytes!==undefined)assert.equal(info.size,bytes);}
const matrix=(flags.includes('--control-only')?['control']:flags.includes('--lpac-only')?['lpac']:['control','lpac']).flatMap(mode=>(flags.includes('--smoke')?['normal']:flags.includes('--load-check')?['missing-model']:modelCases).map(kind=>({mode,kind})));
const summary={schema:1,scope:'native-cpu-fixed-prompt',model:true,gpu:false,networkVerified:false,preparationLimits,cases:[],passed:false,unrun:matrix};
await fs.mkdir(runRoot,{recursive:true});
const summaryPath=join(runRoot,'summary.json');
const save=()=>fs.writeFile(summaryPath,JSON.stringify(summary,null,2)+'\n');
let originalModel;
async function checkBuild() {
  summary.initialLimits=preparationGate();
  const build=JSON.parse(await fs.readFile(join(output,'native/build-manifest.json'),'utf8'));
  assert.equal(build.schema,1);assert.equal(build.affinity,1);assert.equal(build.priority,'BelowNormal');
  const expected=['common.h','isolated-launcher.h','transport-wire.h','transport-resources.h','native-model-protocol.h','native-model-pins.h',
    'native-model-fixture.h','native-model-engine.h','native-model-host.cpp','native-model-worker.cpp'].map(x=>'tests/e2e/isolation/native/'+x)
    .concat(['host','worker'].map(x=>'.artifacts/tests/isolation/native-model/native/bin/native-model-'+x+'.exe'),
      ['.artifacts/tests/isolation/native-source-runtime/runtime-manifest.json','resources/runtimes/llama-cpp-source-cpu.json','resources/models/qwen3-4b.json','tests/fixtures/native-cpu-prompt.json','tests/e2e/isolation/build-native-model.ps1','tests/e2e/isolation/build-native-runtime.ps1','tests/e2e/isolation/prepare-native-runtime.ps1','.artifacts/tests/isolation/native-model/native/native-model-runtime-pins.h']);
  assert.deepEqual(build.files.map(x=>x.path).sort(),expected.sort());
  for(const entry of build.files)assert.equal(await hash(join(root,entry.path)),entry.sha256,'Build input/output changed.');
  assert.equal(runtime.id,'llama-cpp-v0.9.0-source-cpu');
  assert.equal(await hash(join(root,'resources/runtimes/llama-cpp-source-cpu.json')),runtime.sourceProfileSha256);
  assert.equal(await hash(join(source,'build-native-runtime.ps1')),runtime.recipeSha256);
  assert.equal(await hash(join(source,'prepare-native-runtime.ps1')),runtime.prepareSha256);
  assert.deepEqual(build.runtimeFiles.map(x=>x.path).sort(),Object.keys(runtime.files).sort());
  for(const entry of build.runtimeFiles) {
    assert.equal(entry.sha256,runtime.files[entry.path].sha256);const path=join(runtimeRoot,entry.path);
    await regular(path,runtime.files[entry.path].bytes);assert.equal(await hash(path),entry.sha256);
  }
  if(matrix.some(x=>x.kind!=='missing-model')) {
    await regular(modelFile,model.bytes);originalModel=await fs.lstat(modelFile);assert.equal(await hash(modelFile),model.sha256);
  }
  summary.modelSha256=model.sha256;summary.runtimeRevision=runtime.revision;
  summary.build=build;
  summary.scriptHashes={};
  for(const name of ['run-native-model.mjs','run-native-model-limited.ps1','build-native-model.ps1','build-native-runtime.ps1','prepare-native-runtime.ps1','native-model-results.mjs','transport-results.mjs','process-harness.mjs','model-load-limits.mjs'])
    summary.scriptHashes[name]=await hash(join(source,name));
}
async function runCase({mode,kind}) {
  const caseLimits=preparationGate();
  const id=randomUUID(),staged=join(runRoot,id),profile='tahtiapuri.t09i.'+id.replaceAll('-','');
  const reportFile=join(runRoot,id+'.json');
  const evidence={mode,kind,profile,staged,caseLimits,passed:false,records:[],cleanup:{passed:false}};
  let child,report,owned=false,validated=false,stopped=false,deleted=mode==='control',brokerExited=false;
  const host=join(staged,'launcher/native-model-host.exe');
  try {
  await fs.mkdir(staged);owned=true;
  for(const dir of ['package','launcher','private','scratch']) await fs.mkdir(join(staged,dir));
  await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09I_NATIVE_MODEL',{flag:'wx'});
  await fs.writeFile(join(staged,'private/secret.txt'),'synthetic handle inheritance sentinel',{flag:'wx'});
  for(const name of ['host','worker']) {
    const destination=join(staged,name==='host'?'launcher':'package','native-model-'+name+'.exe');
    await fs.copyFile(join(bin,'native-model-'+name+'.exe'),destination,constants.COPYFILE_EXCL);
    assert.equal(await hash(destination),await hash(join(bin,'native-model-'+name+'.exe')));
  }
  await fs.writeFile(join(staged,'package/readonly.txt'),'synthetic readonly probe',{flag:'wx'});
  for(const file of dlls) {
    if(kind==='missing-library'&&file==='ggml-cpu.dll')continue;
    const target=join(staged,'package',file);
    await fs.copyFile(join(runtimeRoot,'bin',file),target,constants.COPYFILE_EXCL);
    await regular(target,runtime.files['bin/'+file].bytes);assert.equal(await hash(target),runtime.files['bin/'+file].sha256);
  }
  if(kind!=='missing-model') {
    await fs.copyFile(modelFile,join(staged,'package/model.gguf'),constants.COPYFILE_EXCL);
    await regular(join(staged,'package/model.gguf'),model.bytes);
    // Full hash is performed by the native owner AFTER its read-only pin is held,
    // before starting the worker. The driver also validates the identity event.
  }
  child=spawn(host,['run',mode,profile,staged,kind],{cwd:staged,stdio:['pipe','pipe','pipe'],windowsHide:true});
  report=collect(child);
    if(kind==='owner-loss') {
      await until(()=>{report.check();return report.records.some(x=>x.type==='await-owner');},170000);
      validateLaunch(report.records,mode);
      assert.equal(report.records.find(x=>x.type==='await-owner').pid,report.records.find(x=>x.type==='launched').pid);
      child.stdin.end();
    }
    evidence.exit=await bounded(report.exited,190000,'Native CPU broker deadline exceeded.');brokerExited=true;
    report.checkComplete();assert.equal(report.stderr,'');
    evidence.validation=validateResult(report.records,mode,kind,evidence.exit);validated=true;
    const launch=validateLaunch(report.records,mode);
    await until(()=>!alive(launch.pid),5000);stopped=true;
    deleted=mode==='control'||report.records.at(-1).profileDeleted===true;
    assert(deleted);evidence.passed=true;
  } catch(error) {
    evidence.failure=String(error.message);
  } finally {
    if(child&&report) {
    if(child.exitCode===null&&child.signalCode===null) child.kill();
    try {await bounded(report.exited,5000,'Broker did not exit during cleanup.');brokerExited=true;}
    catch(error){evidence.cleanup.error=error.message;}
    evidence.records=report.records;evidence.stderr=report.stderr;evidence.rejectedOutput=report.rejectedOutput;
    const pids=report.records.filter(x=>x.type==='launched').map(x=>x.pid);
    if(!stopped&&brokerExited&&pids.length===1) {
      try{await until(()=>pids.every(pid=>!alive(pid)),5000);stopped=true;}
      catch(error){evidence.cleanup.error=error.message;}
    }
    if(!stopped&&brokerExited&&pids.length===0) {
      try {report.checkComplete();assert.equal(report.stderr,'');validateFailedCreationCleanup(report.records,kind,evidence.exit);stopped=true;deleted=true;evidence.cleanup.failedBeforeChild=true;}
      catch { /* Absence of a launch report alone never proves worker absence. */ }
    }
    if(stopped&&brokerExited) {
      const results=report.records.filter(x=>x.type==='result');
      if(results.length===1&&results[0].case===kind&&results[0].jobEmpty===true&&results[0].profileDeleted===true)deleted=true;
    }
    if(stopped&&brokerExited&&!deleted) {
      try {
        if(await fs.readFile(join(staged,'profile.receipt'),'utf8')===profile) {
          const repair=await helper(host,['cleanup',profile,staged]);evidence.cleanup.repair=repair;deleted=repair.code===0;
        }
      } catch(error){evidence.cleanup.profileError=error.message;}
    }
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    if(stopped&&brokerExited&&deleted) {
      try{await fs.rm(staged,{recursive:true});evidence.cleanup.removed=true;}
      catch(error){evidence.cleanup.removeError=error.message;}
    }
    evidence.cleanup.stopped=stopped;evidence.cleanup.profileDeleted=deleted;
    evidence.cleanup.brokerExited=brokerExited;
    evidence.cleanup.passed=brokerExited&&stopped&&deleted&&evidence.cleanup.removed===true&&!evidence.cleanup.error&&!evidence.cleanup.observerError;
    } else if(!child&&owned) {
      try{await fs.rm(staged,{recursive:true});evidence.cleanup={passed:true,preparationOnly:true,removed:true};}
      catch(error){evidence.cleanup.error=error.message;}
    }
    evidence.passed=validated&&evidence.passed&&evidence.cleanup.passed;
    await fs.writeFile(reportFile,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  }
  summary.cases.push({mode,kind,passed:evidence.passed,report:reportFile});
  if(!evidence.passed) throw new Error('Native CPU case failed: '+mode+'/'+kind+'. Read retained private evidence.');
  console.log(JSON.stringify({mode,kind,passed:true}));
}
try {
  await checkBuild();await save();
  for(let index=0;index<matrix.length;index++) {
    summary.unrun=matrix.slice(index+1);summary.attempting=matrix[index];await save();
    await runCase(matrix[index]);delete summary.attempting;await save();
  }
  for(const [name,expected] of Object.entries(summary.scriptHashes)) assert.equal(await hash(join(source,name)),expected,'Driver source changed during run.');
  summary.finalLimits=preparationGate();
  if(originalModel) {
    const finalModel=await fs.lstat(modelFile);
    for(const key of ['ino','size','mtimeMs'])assert.equal(finalModel[key],originalModel[key]);
    assert.equal(await hash(modelFile),model.sha256);summary.sourceUnchanged=true;
  }
  summary.passed=true;
} catch(error){summary.failure=error.message;process.exitCode=1;}
finally{await save();console.log(JSON.stringify({passed:summary.passed,report:summaryPath}));}
