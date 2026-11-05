import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyBuild,verifyBuildFiles} from './run-backend-probe.mjs';
import {prepareBackendResources,verifyDataTree,verifyBackendManifest} from './backend-resources.mjs';
import {BackendProbePort,validateBoundaries} from './backend-port.mjs';
import {BackendLifecycleOwner} from './backend-lifecycle-owner.mjs';
import {validateNegativeCase} from './backend-lifecycle-results.mjs';

const project=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const output=join(project,'.artifacts/tests/isolation/backend-probe/lifecycle');
const requiredRuntimeFiles=Object.freeze(['backend-lifecycle-owner.mjs','backend-lifecycle-results.mjs','run-backend-lifecycle-probe.mjs','run-backend-lifecycle-limited.ps1'].map(name=>'tests/e2e/isolation/'+name));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
function absent(pid){assert(Number.isSafeInteger(pid)&&pid>0);try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}}
async function processesAbsent(childPid,brokerPid){
  const deadline=Date.now()+3000;
  while(!absent(childPid)||!absent(brokerPid)){assert(Date.now()<deadline,'Owned process remains alive');await delay(25);}
  return true;
}
function launch(resources,mode){
  const child=spawn(resources.hostPath,['run',mode,resources.profile,resources.workerRoot,resources.ownerNonce],{cwd:resources.workerRoot,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:join(process.env.SystemRoot,'System32')}});
  const state={child,closed:false};state.close=new Promise(resolve=>child.once('close',(code,signal)=>{state.closed=true;resolve({code,signal});}));return state;
}
async function rescue(state,{controller,port,owner}={}){
  const observations={};
  if(controller)try{await bounded(controller.stop(),4000,'Controller stop deadline');}catch(error){observations.controllerStopFailure=error.message;}
  if(!state)return observations;
  if(!state.closed){
    if(port)port.kill();if(owner)try{await bounded(owner.abort(),1000,'Raw owner abort deadline');}catch(error){observations.abortFailure=error.message;}
    try{await bounded(state.close,5000,'Native cleanup deadline');}
    catch{
      state.child.stdin.end();
      try{await bounded(state.close,3000,'Owner EOF cleanup deadline');}
      catch{state.child.kill();try{await bounded(state.close,3000,'Emergency broker close deadline');}catch(error){observations.brokerCloseFailure=error.message;}}
    }
  }
  if(state.closed){state.child.stdin.destroy();state.child.stdout.destroy();state.child.stderr.destroy();}
  return observations;
}

export function requireLifecycleRuntimeFiles(build){
  const paths=new Set(build.files.map(file=>file.path));for(const path of requiredRuntimeFiles)assert(paths.has(path),'Lifecycle build provenance missing '+path);
}
async function recheckInputs(inputs){
  const pin=inputs.sourceBoundProvenance.buildManifest;
  const bytes=await fs.readFile(join(project,...pin.path.split('/')));assert.equal(bytes.length,pin.bytes);assert.equal(hash(bytes),pin.sha256,'Build manifest changed during lifecycle probe');
  await verifyBuildFiles(project,inputs.build);requireLifecycleRuntimeFiles(inputs.build);
  await verifyBackendManifest(project,inputs.manifest);
}
async function removeWorker(resources){
  await verifyDataTree(resources.dataRoot);await fs.rm(resources.workerRoot,{recursive:true});await assert.rejects(fs.lstat(resources.workerRoot),{code:'ENOENT'});
  assert.deepEqual((await fs.readdir(resources.caseRoot)).sort(),['data','owner.marker']);
}

export async function runBatchA(){
  assert.equal(process.platform,'win32','Native Windows Node is required');
  const inputs=await verifyBuild();requireLifecycleRuntimeFiles(inputs.build);
  const runRoot=join(output,'runs',randomBytes(16).toString('hex'));await fs.mkdir(runRoot,{recursive:true});
  const labels=['control-restart-first','control-restart-second','lpac-restart-first','lpac-restart-second',...['owner-before-start','early-close','invalid-utf8'].flatMap(kind=>['control','lpac'].map(mode=>`${mode}-${kind}`))];
  const summary={schema:1,scope:'test-only-backend-lifecycle-batch-a',passed:false,networkVerified:false,model:false,gpu:false,build:inputs.build,sourceBoundProvenance:inputs.sourceBoundProvenance,cases:[],unrun:[...labels]};
  const save=()=>fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  const identities={workerRoot:new Set(),profile:new Set(),ownerNonce:new Set(),childNonce:new Set(),session:new Set()};
  function freshIdentities(resources,receipt,session){for(const [name,value]of Object.entries({...resources,childNonce:receipt.childNonce,session})){if(!identities[name])continue;assert(!identities[name].has(value),'Reused '+name);identities[name].add(value);}}
  async function lifetime(label,mode,caseRoot,action){
    summary.attempting=label;summary.unrun=summary.unrun.filter(value=>value!==label);await save();
    const report={schema:1,label,mode,passed:false,caseRoot};let controls;
    try{await recheckInputs(inputs);controls=await action(report);report.passed=true;}
    catch(error){report.failure=String(error.stack??error);}
    finally{
      try{await recheckInputs(inputs);report.provenanceRechecked=true;}catch(error){report.provenanceFailure=String(error.stack??error);report.passed=false;}
      await fs.writeFile(join(runRoot,label+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      summary.cases.push({label,mode,passed:report.passed,report:join(runRoot,label+'.json')});await save();
    }
    assert(report.passed,'Lifecycle case failed; private evidence and uncertain roots retained');console.log(JSON.stringify({label,passed:true}));return controls;
  }
  try{
    const {BackendController}=await import(pathToFileURL(join(project,'apps/desktop/dist/main/backend-controller.js')).href);
    const {isResponse}=await import(pathToFileURL(join(project,'packages/validation/dist/backend-protocol.js')).href);
    const {isSkyResult}=await import(pathToFileURL(join(project,'packages/validation/dist/sky.js')).href);
    for(const mode of ['control','lpac']){
      const caseRoot=join(runRoot,`case-${randomBytes(16).toString('hex')}`);let expectedState,firstDataRoot;
      for(const phase of ['first','second'])await lifetime(`${mode}-restart-${phase}`,mode,caseRoot,async report=>{
        let state,port,controller,capture,unexpected=false,resources;
        try{
          resources=await prepareBackendResources({projectRoot:project,caseRoot,...inputs});report.resources=resources;
          if(phase==='first')firstDataRoot=resources.dataRoot;else assert.equal(resources.dataRoot,firstDataRoot);
          state=launch(resources,mode);
          const captureEnabled=phase==='first';
          port=new BackendProbePort(state.child,{mode,ownerNonce:resources.ownerNonce,...(captureEnabled?{captureSky:value=>{assert.equal(capture,undefined);capture=value;}}:{})});
          await bounded(port.prepared,12000,'Native preparation timeout');
          controller=new BackendController(()=>{void port.activate().catch(error=>port._fail(error));return port;},()=>{unexpected=true;});
          const guard=promise=>Promise.race([promise,port.fatal.then(error=>{throw error;})]);
          await guard(controller.start());validateBoundaries(await guard(bounded(port.boundaries,2500,'Positive boundary deadline')),mode,port.session);freshIdentities(resources,port.receipt,port.session);report.session=port.session;
          const initial=await guard(controller.observing('observing.read'));assert(initial.ok);
          if(phase==='first'){
            assert.deepEqual(initial.state,{revision:0,places:[],activePlaceId:null});
            const saved=await guard(controller.observing('observing.save',{expectedRevision:0,id:null,place:{name:'Synthetic persisted site',observer:{latitudeDeg:0,longitudeDeg:0,elevationMeters:0},timeZone:'UTC'}}));
            assert(saved.ok&&saved.state.revision===1&&saved.state.places.length===1);
            const activated=await guard(controller.observing('observing.activate',{expectedRevision:1,id:saved.state.places[0].id}));assert(activated.ok);assert.deepEqual(activated.state,{revision:2,places:saved.state.places,activePlaceId:saved.state.places[0].id});expectedState=activated.state;
            if(captureEnabled){
              const sky=await guard(controller.sky('sky.snapshot',{atUtc:'2026-01-01T00:00:00.000Z',timeZone:'UTC',observer:{latitudeDeg:0,longitudeDeg:0,elevationMeters:0}}));
              assert(sky.ok&&isSkyResult(sky)&&sky.snapshot.objects.length===5079);assert(capture&&capture.bytes<=16777216);
              const parsed=JSON.parse(capture.body.toString('utf8'));assert(isResponse(parsed,port.session)&&parsed.id===capture.requestId&&parsed.operation==='sky.snapshot');assert.deepEqual(parsed.result,sky);
              const path=join(runRoot,labelForSky(mode,phase));await fs.writeFile(path,capture.body,{flag:'wx'});assert.equal(hash(await fs.readFile(path)),capture.sha256);
              report.skyCapture={path,sequence:capture.sequence,session:capture.session,requestId:capture.requestId,bytes:capture.bytes,sha256:capture.sha256,objects:5079};capture=undefined;
            }
          }else{
            assert.deepEqual(initial.state,expectedState,'Fresh worker did not read the acknowledged persisted state');report.restartRead=initial.state;
            const updated=await guard(controller.observing('observing.save',{expectedRevision:expectedState.revision,id:expectedState.activePlaceId,place:{name:'Synthetic persisted site updated',observer:expectedState.places[0].observer,timeZone:expectedState.places[0].timeZone}}));
            assert(updated.ok&&updated.state.revision===3&&updated.state.activePlaceId===expectedState.activePlaceId);expectedState=updated.state;
            assert.deepEqual(await guard(controller.observing('observing.read')),{ok:true,state:expectedState});
          }
          assert(!unexpected);await guard(controller.stop());report.nativeResult=await bounded(port.completion,5000,'Positive native close deadline');
          assert(await processesAbsent(port.pid,state.child.pid));report.port=port.snapshot();
          const persisted=JSON.parse(await fs.readFile(join(resources.dataRoot,'observing/places.json'),'utf8'));assert.deepEqual(persisted.state,expectedState);report.persistedState=persisted.state;
          assert.deepEqual(await fs.readdir(join(resources.dataRoot,'observing')),['places.json'],'Atomic observing temporary file remained');
          await removeWorker(resources);report.cleanup={processesAbsent:true,jobEmpty:true,persistentAclRestored:true,profileDeleted:true,workerRootRemoved:true};
          if(phase==='second'){await fs.rm(caseRoot,{recursive:true});await assert.rejects(fs.lstat(caseRoot),{code:'ENOENT'});report.cleanup.caseRootRemoved=true;}
        }catch(error){report.rescue=await rescue(state,{controller,port});if(port)report.port=port.snapshot();throw error;}
        finally{if(state?.closed){state.child.stdin.destroy();state.child.stdout.destroy();state.child.stderr.destroy();}}
      });
    }
    for(const kind of ['owner-before-start','early-close','invalid-utf8'])for(const mode of ['control','lpac']){
      const label=`${mode}-${kind}`,caseRoot=join(runRoot,`case-${randomBytes(16).toString('hex')}`);
      await lifetime(label,mode,caseRoot,async report=>{
        let state,owner;
        try{
          const resources=await prepareBackendResources({projectRoot:project,caseRoot,...inputs});report.resources=resources;state=launch(resources,mode);
          owner=new BackendLifecycleOwner(state.child,{mode,ownerNonce:resources.ownerNonce,session:randomBytes(32).toString('hex')});
          const guard=promise=>Promise.race([promise,owner.fatal.then(error=>{throw error;})]);
          await guard(bounded(owner.prepared,12000,'Negative native preparation deadline'));freshIdentities(resources,owner.receipt,owner.session);
          if(kind!=='owner-before-start')await guard(bounded(owner.start(),5000,'Negative validated readiness deadline'));
          await guard(owner.terminate(kind));
          const evidence=await bounded(owner.completion,8000,'Negative native completion deadline');assert(!owner.error,owner.error?.message);
          evidence.processesAbsent=await processesAbsent(owner.pid,state.child.pid);report.negativeEvidence=evidence;report.validation=validateNegativeCase(evidence);report.audit=owner.audit();
          await removeWorker(resources);await fs.rm(caseRoot,{recursive:true});await assert.rejects(fs.lstat(caseRoot),{code:'ENOENT'});report.workerRootRemoved=true;report.caseRootRemoved=true;
        }catch(error){report.rescue=await rescue(state,{owner});if(owner){report.negativeEvidence=owner.snapshot();report.audit=owner.audit();}throw error;}
        finally{if(state?.closed){state.child.stdin.destroy();state.child.stdout.destroy();state.child.stderr.destroy();}}
      });
    }
    assert.equal(summary.cases.length,10);summary.passed=true;delete summary.attempting;
  }catch(error){summary.failure=String(error.stack??error);process.exitCode=1;}
  finally{
    try{await recheckInputs(inputs);summary.sourceBoundProvenance.rechecked=true;}catch(error){summary.sourceBoundProvenance.failure=String(error.stack??error);summary.passed=false;process.exitCode=1;}
    await save();console.log(JSON.stringify({passed:summary.passed,lifetimes:summary.cases.length,report:join(runRoot,'summary.json')}));
  }
  return summary;
}
function labelForSky(mode,phase){return `${mode}-restart-${phase}-sky-response.bin`;}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.deepEqual(process.argv.slice(2),['--batch-a']);await runBatchA();}
