import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {collectBackendPins,verifyBackendManifest,prepareBackendResources,verifyDataTree,safeRelativePath} from './backend-resources.mjs';
import {BackendProbePort,validateBoundaries} from './backend-port.mjs';

const project=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const output=join(project,'.artifacts/tests/isolation/backend-probe');
const native=join(output,'native');
const buildManifestPath='.artifacts/tests/isolation/backend-probe/native/build-manifest.json';
const sourceBoundPaths=Object.freeze([
  'apps/desktop/src/main/backend-controller.ts','apps/desktop/dist/main/backend-controller.js',
  'apps/backend/src/runtime/backend.ts','apps/backend/dist/runtime/backend.js',
]);
const hash=async path=>createHash('sha256').update(await fs.readFile(path)).digest('hex');
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
function absent(pid){try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}}

export async function preparePins(destination){
  const manifest=await collectBackendPins(project),text=JSON.stringify(manifest,null,2)+'\n';
  if(destination){const path=resolve(destination),rel=relative(join(project,'.artifacts/tests'),path);assert(rel&&!rel.startsWith('..'));await fs.mkdir(join(path,'..'),{recursive:true});await fs.writeFile(path,text,{flag:'wx'});}
  else process.stdout.write(text);
  return manifest;
}

export async function verifyBuildFiles(projectRoot,build){
  assert(Array.isArray(build.files)&&build.files.length>0);const declared=new Map();
  for(const file of build.files){safeRelativePath(file.path);assert(/^[a-f0-9]{64}$/.test(file.sha256));assert(!declared.has(file.path));declared.set(file.path,file);}
  for(const path of [...sourceBoundPaths,...['resources-manifest.json','backend-probe-pins.h','bin/backend-probe-host.exe'].map(name=>`.artifacts/tests/isolation/backend-probe/native/${name}`)])assert(declared.has(path),'Build provenance missing '+path);
  for(const file of build.files)assert.equal(await hash(join(projectRoot,...file.path.split('/'))),file.sha256,'Build input/output changed: '+file.path);
  return sourceBoundPaths.map(path=>({...declared.get(path)}));
}

export async function verifyBuild(){
  const buildBytes=await fs.readFile(join(project,...buildManifestPath.split('/'))),build=JSON.parse(buildBytes.toString('utf8'));
  const manifest=JSON.parse(await fs.readFile(join(native,'resources-manifest.json'),'utf8'));
  assert.equal(build.schema,1);assert.equal(build.creationMode,'detached-backend-probe');assert.equal(build.affinity,1);assert.equal(build.priority,'BelowNormal');
  await verifyBackendManifest(project,manifest);assert.equal(build.nodeSha256,manifest.nodeSha256);assert.equal(build.archiveSha256,manifest.archiveSha256);
  const sourceBoundFiles=await verifyBuildFiles(project,build);
  const sourceBoundProvenance={schema:1,buildManifest:{path:buildManifestPath,bytes:buildBytes.length,sha256:createHash('sha256').update(buildBytes).digest('hex')},files:sourceBoundFiles,rechecked:false};
  const hostPath=join(native,'bin/backend-probe-host.exe'),hostSha256=await hash(hostPath);
  const driverHashes={};
  for(const name of ['run-backend-probe.mjs','backend-port.mjs','backend-resources.mjs','backend-codec.mjs','backend-worker.mjs'])driverHashes[name]=await hash(join(project,'tests/e2e/isolation',name));
  return {build,manifest,hostPath,hostSha256,driverHashes,sourceBoundProvenance};
}

function mockModel(){
  const pending=new Map(),events=[];
  const info={backend:'cpu',gpuLayers:0,loadMs:0,generationMs:0,contextSize:4096,engineVersion:'llama.cpp-v0.9.0-cpu',modelId:'qwen3-4b-q4-k-m'};
  return {events,run(id,input,progress){
    events.push({type:'run',id,prompt:input.prompt});progress();events.push({type:'progress',id});
    if(input.prompt==='synthetic-cancel')return new Promise(resolve=>pending.set(id,resolve));
    return Promise.resolve(input.prompt==='synthetic-error'?{text:'',error:'MODEL_INVALID',info:null}:{text:'SYNTHETIC MODEL RESPONSE',error:null,info});
  },cancel(id){events.push({type:'cancel',id});pending.get(id)?.({text:'',error:'CANCELLED',info:null});pending.delete(id);}};
}

async function exercise(controller,port,model){
  const boundary=await bounded(port.boundaries,2500,'Boundary receipt timeout');validateBoundaries(boundary,port.mode,port.session);
  const status=await controller.getStatus();assert.deepEqual(status,{state:'ready',model:'managed-separately',protocolVersion:1});
  const read=await controller.observing('observing.read');assert.deepEqual(read,{ok:true,state:{revision:0,places:[],activePlaceId:null}});
  const observer={latitudeDeg:0,longitudeDeg:0,elevationMeters:0};
  const saved=await controller.observing('observing.save',{expectedRevision:0,id:null,place:{name:'Synthetic observation site',observer,timeZone:'UTC'}});
  assert(saved.ok);assert.equal(saved.state.revision,1);assert.equal(saved.state.places.length,1);const id=saved.state.places[0].id;
  const stale=await controller.observing('observing.activate',{expectedRevision:0,id});assert.deepEqual(stale,{ok:false,code:'CONFLICT'});
  const active=await controller.observing('observing.activate',{expectedRevision:1,id});assert(active.ok);assert.equal(active.state.revision,2);
  const removed=await controller.observing('observing.remove',{expectedRevision:2,id});assert.deepEqual(removed,{ok:true,state:{revision:3,places:[],activePlaceId:null}});
  const observation={atUtc:'2026-01-01T00:00:00.000Z',timeZone:'UTC',observer};
  const snapshot=await controller.sky('sky.snapshot',observation);assert(snapshot.ok,'Full sky query failed');assert.equal(snapshot.snapshot.objects.length,5079);
  const {isSkyResult,isSkySelectionResult}=await import(pathToFileURL(join(project,'packages/validation/dist/sky.js')).href);
  assert(isSkyResult(snapshot),'Owner rejected full sky result');
  const cached=await controller.sky('sky.snapshot',observation);assert(isSkyResult(cached));assert.deepEqual(cached,snapshot);
  const selection=await controller.sky('sky.select',{observation,objectId:'Moon'});assert(isSkySelectionResult(selection)&&selection.ok);assert.equal(selection.selection.object.id,'Moon');
  const successful=await controller.assistant('assistant.submit',{prompt:'synthetic-success',backend:'cpu'});assert(successful.ok);
  async function waitJob(jobId,state){for(let i=0;i<100;i++){const value=await controller.assistant('assistant.get',jobId);if(value.ok&&value.job.state===state)return value;await delay(10);}throw new Error('Mock model terminal state missing');}
  const completed=await waitJob(successful.job.id,'completed');assert.equal(completed.job.text,'SYNTHETIC MODEL RESPONSE');
  const cancellable=await controller.assistant('assistant.submit',{prompt:'synthetic-cancel',backend:'cpu'});assert(cancellable.ok);
  await bounded((async()=>{while(!model.events.some(event=>event.type==='run'&&event.id===cancellable.job.id))await delay(10);})(),1000,'Mock cancel run missing');
  const cancelled=await controller.assistant('assistant.cancel',cancellable.job.id);assert(cancelled.ok&&cancelled.job.state==='cancelled');
  const failed=await controller.assistant('assistant.submit',{prompt:'synthetic-error',backend:'cpu'});assert(failed.ok);const failedJob=await waitJob(failed.job.id,'error');assert.equal(failedJob.job.error,'MODEL_INVALID');
  assert(model.events.some(event=>event.type==='cancel'&&event.id===cancellable.job.id));
  return {status,boundary,observing:{savedRevision:1,activeRevision:2,removedRevision:3,staleRejected:true},sky:{objects:snapshot.snapshot.objects.length,bytes:Buffer.byteLength(JSON.stringify(snapshot)),sha256:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),cachedEqual:true,selection:'Moon'},mockModel:model.events};
}

export async function runNormal(){
  assert.equal(process.platform,'win32','Native Windows Node is required');
  const inputs=await verifyBuild();
  const runRoot=join(output,'runs',randomBytes(16).toString('hex'));await fs.mkdir(runRoot,{recursive:true});
  const summary={schema:1,scope:'test-only-actual-backend',creationMode:'detached-backend-probe',model:false,gpu:false,networkVerified:false,passed:false,cases:[],unrun:['control','lpac'],build:inputs.build,driverHashes:inputs.driverHashes,sourceBoundProvenance:inputs.sourceBoundProvenance};
  const save=()=>fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  try{
    const {BackendController}=await import(pathToFileURL(join(project,'apps/desktop/dist/main/backend-controller.js')).href);
    for(const mode of ['control','lpac']){
      summary.unrun=summary.unrun.filter(value=>value!==mode);summary.attempting=mode;await save();
      const caseRoot=join(runRoot,`case-${randomBytes(16).toString('hex')}`),evidence={mode,kind:'normal',passed:false,caseRoot};
      let port,child,controller,unexpected=false,resources;
      try{
        resources=await prepareBackendResources({projectRoot:project,caseRoot,...inputs});evidence.resources=resources;
        child=spawn(resources.hostPath,['run',mode,resources.profile,resources.workerRoot,resources.ownerNonce],{cwd:resources.workerRoot,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:join(process.env.SystemRoot,'System32')}});
        port=new BackendProbePort(child,{mode,ownerNonce:resources.ownerNonce});
        await bounded(port.prepared,12000,'Native preparation timeout');
        const model=mockModel();controller=new BackendController(()=>{void port.activate().catch(error=>port._fail(error));return port;},()=>{unexpected=true;},model);
        const guard=promise=>Promise.race([promise,port.fatal.then(error=>{throw error;})]);
        await guard(controller.start());evidence.functional=await guard(exercise(controller,port,model));assert(!unexpected,'Unexpected backend exit');
        await guard(controller.stop());evidence.nativeResult=await bounded(port.completion,5000,'Native complete close timeout');
        assert(absent(port.pid)&&absent(child.pid),'Owned process still exists');
        await verifyDataTree(resources.dataRoot);const entries=await fs.readdir(join(resources.dataRoot,'observing'));assert.deepEqual(entries,['places.json'],'Atomic observing temp file remained');
        const persisted=JSON.parse(await fs.readFile(join(resources.dataRoot,'observing/places.json'),'utf8'));assert.deepEqual(persisted.state,{revision:3,places:[],activePlaceId:null});
        evidence.persistedState=persisted.state;evidence.snapshot=port.snapshot();
        await fs.rm(resources.workerRoot,{recursive:true});await assert.rejects(fs.lstat(resources.workerRoot),{code:'ENOENT'});
        await fs.rm(caseRoot,{recursive:true});await assert.rejects(fs.lstat(caseRoot),{code:'ENOENT'});
        evidence.cleanup={passed:true,processesAbsent:true,jobEmpty:true,profileDeleted:true,persistentAclRestored:true,workerRootRemoved:true,caseRootRemoved:true};evidence.passed=true;
      }catch(error){
        evidence.failure=String(error.stack??error);
        if(controller){try{await bounded(controller.stop(),4000,'Controller stop deadline');}catch(stopError){evidence.controllerStopFailure=stopError.message;}}
        if(port){port.kill();try{await bounded(port.completion,5000,'Failed probe cleanup unconfirmed');}catch(cleanupError){evidence.cleanupFailure=cleanupError.message;}evidence.snapshot=port.snapshot();}
        if(child&&port?._state!=='closed'){
          child.stdin.end();try{await bounded(new Promise(resolve=>child.once('close',resolve)),3000,'Broker owner-loss cleanup timeout');}
          catch{
            child.kill();try{await bounded(new Promise(resolve=>child.once('close',resolve)),3000,'Broker emergency close timeout');}catch{evidence.brokerCloseUnconfirmed=true;}
          }
        }
      }finally{
        if(child&&child.exitCode!==null){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();}
        await fs.writeFile(join(runRoot,`${mode}.json`),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
        summary.cases.push({mode,kind:'normal',passed:evidence.passed,report:join(runRoot,`${mode}.json`)});await save();
      }
      assert(evidence.passed,'Actual backend case failed; private evidence and case root retained');
      console.log(JSON.stringify({mode,kind:'normal',passed:true}));
    }
    for(const [name,sha]of Object.entries(inputs.driverHashes))assert.equal(await hash(join(project,'tests/e2e/isolation',name)),sha,'Driver changed during probe');
    await verifyBackendManifest(project,inputs.manifest);summary.passed=true;delete summary.attempting;
  }catch(error){summary.failure=String(error.stack??error);process.exitCode=1;}
  finally{
    try{
      assert.equal(await hash(join(project,...buildManifestPath.split('/'))),inputs.sourceBoundProvenance.buildManifest.sha256,'Build manifest changed during probe');
      await verifyBuildFiles(project,inputs.build);summary.sourceBoundProvenance.rechecked=true;
    }catch(error){summary.sourceBoundProvenance.failure=String(error.stack??error);summary.passed=false;process.exitCode=1;}
    await save();console.log(JSON.stringify({passed:summary.passed,cases:summary.cases.length,report:join(runRoot,'summary.json')}));
  }
  return summary;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const flags=process.argv.slice(2);
  if(flags[0]==='--prepare-pins'&&flags.length<=2)await preparePins(flags[1]);
  else{assert.deepEqual(flags,['--normal']);await runNormal();}
}
