import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile,writeFile,mkdir,lstat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {NativeModelHost} from '../../../apps/desktop/dist/main/native-model-host.js';
import {prepareNativeResources} from '../../../apps/desktop/dist/main/native-model-resources.js';
import {childEnvironment} from '../../../apps/desktop/dist/main/child-environment.js';
import {verifyPreparationLimits} from './model-load-limits.mjs';
import {validateLaunch} from './transport-results.mjs';
import {collect} from './process-harness.mjs';
const cancelOnComputing=process.argv.includes('--cancel-on-computing');
assert(process.argv.slice(2).every(x=>x==='--cancel-on-computing'));
const root=resolve('.'),runRoot=resolve('.artifacts/tests/isolation/native-application/runs',randomUUID());
const reportFile=join(runRoot,'summary.json');await mkdir(runRoot,{recursive:true});
const summary={schema:1,scope:cancelOnComputing?'application-native-host-cooperative-cancel':'application-native-host-single-cpu-inference',model:true,gpu:false,networkVerified:false,passed:false,records:[]};
const save=()=>writeFile(reportFile,JSON.stringify(summary,null,2)+'\n');
let raw,broker,host,stage,closed=false;
const watchdog=setTimeout(async()=>{summary.failure='Outer experiment deadline';summary.exitUnconfirmed=true;await save();process.exit(1);},230000);
const hash=async path=>{const h=createHash('sha256');for await(const c of createReadStream(path))h.update(c);return h.digest('hex');};
function gate(){const limits=verifyPreparationLimits();assert(freemem()>=6*1024**3,'Insufficient memory');return limits;}
try{
  summary.limits=gate();
  const codeFiles=['native-model-host','native-model-resources','native-model-exchange','native-model-protocol','private-directory','child-environment']
    .flatMap(name=>['apps/desktop/src/main/'+name+'.ts','apps/desktop/dist/main/'+name+'.js']);
  codeFiles.push(...['assistant','model-wire','public-api'].flatMap(name=>['packages/validation/src/'+name+'.ts','packages/validation/dist/'+name+'.js']),
    'tests/e2e/isolation/run-native-application.mjs','tests/e2e/isolation/run-native-application-limited.ps1','tests/e2e/isolation/model-load-limits.mjs','tests/e2e/isolation/process-harness.mjs');
  summary.codeHashes={};for(const path of codeFiles)summary.codeHashes[path]=await hash(path);

  const runtimeRoot=join(root,'.local/native/tahtiapuri-model');
  const build=JSON.parse(await readFile(join(runtimeRoot,'build-manifest.json'),'utf8'));
  assert.equal(build.schema,1);assert.equal(build.affinity,1);assert.equal(build.priority,'BelowNormal');
  for(const file of build.files)assert.equal(await hash(file.path),file.sha256,'Build receipt differs');
  summary.build=build;
  const delivery=JSON.parse(await readFile(join(runtimeRoot,'runtime.json'),'utf8'));
  assert.equal(delivery.id,'tahtiapuri-native-cpu-v1');assert.equal(Object.keys(delivery.files).length,6);
  for(const [name,file]of Object.entries(delivery.files)){
    assert.equal((await lstat(join(runtimeRoot,'bin',name))).size,file.bytes);assert.equal(await hash(join(runtimeRoot,'bin',name)),file.sha256);
  }
  summary.delivery=delivery;
  const profile=JSON.parse(await readFile('resources/models/qwen3-4b.json','utf8'));
  const model={file:join(root,'.local/models',profile.file),bytes:profile.bytes,sha256:profile.sha256,templateSha256:profile.expectedChatTemplateSha256};
  const before=await lstat(model.file);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1);assert.equal(before.size,model.bytes);assert.equal(await hash(model.file),model.sha256);
  const config={runtimeRoot,workRoot:join(runRoot,'work'),model};
  host=new NativeModelHost({prepare:async signal=>{
    gate();stage=await prepareNativeResources(config,signal);summary.stage=stage.root;await save();
    return {...stage,cleanup:async()=>{assert.equal(closed,true,'Cleanup before broker close');try{await stage.cleanup();}catch(error){summary.cleanupFailure={code:error.code,syscall:error.syscall,message:error.message};await save();throw error;}
      await assert.rejects(lstat(stage.root),{code:'ENOENT'});summary.stageDeleted=true;}};
  },launch:(prepared,session,budget)=>{
    summary.ownerBudgetMs=budget;
    broker=spawn(prepared.broker,['run','lpac',prepared.profile,prepared.root,'desktop',session,String(budget)],{
      cwd:prepared.root,stdio:['pipe','pipe','pipe'],windowsHide:true,
      env:{...childEnvironment(process.env),PATH:join(process.env.SystemRoot,'System32')}});
    // The report collector sets string encoding on its inputs. Mirror bytes so
    // observation cannot change the production host's binary stream contract.
    const observed=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>broker.kill()});
    raw=collect(observed);
    broker.stdout.on('data',bytes=>observed.stdout.write(bytes));broker.stdout.once('end',()=>observed.stdout.end());
    broker.stderr.on('data',bytes=>observed.stderr.write(bytes));broker.stderr.once('end',()=>observed.stderr.end());
    broker.once('error',error=>observed.emit('error',error));
    broker.once('close',(code,signal)=>{closed=true;observed.emit('close',code,signal);});return broker;
  }});
  const result=await host.run('00000000-0000-4000-8000-000000000001',{
    backend:'cpu',prompt:'Vastaa vain yhdellä sanalla: Jupiter'},()=>{summary.computing=true;if(cancelOnComputing)host.cancel('00000000-0000-4000-8000-000000000001');});
  summary.reply=result;
  if(raw){raw.checkComplete();summary.records=raw.records;summary.stderr=raw.stderr;summary.exit=await raw.exited;}
  if(cancelOnComputing){assert.equal(result.error,'CANCELLED');assert.equal(result.text,'');}
  else{assert.equal(result.error,null);assert.match(result.text.trim(),/^Jupiter\.?$/u);assert.equal(result.info.engineVersion,'llama.cpp-v0.9.0-cpu');
    assert.equal(result.info.contextSize,4096);assert.equal(result.info.backend,'cpu');assert.equal(result.info.gpuLayers,0);}
  const launch=validateLaunch(raw.records,'lpac',6*1024**3);summary.launch=launch;
  assert.deepEqual(summary.exit,{code:0,signal:null});assert.equal(raw.stderr,'');assert.equal(summary.computing,true);assert.equal(summary.stageDeleted,true);
  const last=raw.records.at(-1);assert.equal(last.type,'result');assert.equal(last.passed,true);assert.equal(last.jobEmpty,true);assert.equal(last.profileDeleted,true);
  assert.deepEqual(await readdir(config.workRoot),[]);await host.stop();summary.hostStopped=true;
  const after=await lstat(model.file);for(const key of ['ino','size','mtimeMs'])assert.equal(after[key],before[key]);assert.equal(await hash(model.file),model.sha256);
  summary.sourceUnchanged=true;
  for(const [path,expected]of Object.entries(summary.codeHashes))assert.equal(await hash(path),expected,'Application/probe source changed during run');
  summary.passed=true;
}catch(error){summary.failure=error.message;process.exitCode=1;if(raw){summary.records=raw.records;summary.stderr=raw.stderr;summary.rejectedOutput=raw.rejectedOutput;}try{await host?.stop();}catch{summary.hostStopUnconfirmed=true;}}
finally{clearTimeout(watchdog);await save();console.log(JSON.stringify({passed:summary.passed,report:reportFile}));}
