import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyBuild,verifyBuildFiles} from './run-backend-probe.mjs';
import {prepareBackendResources,verifyDataTree,verifyBackendManifest} from './backend-resources.mjs';
import {BackendAdverseOwner} from './backend-adverse-owner.mjs';
import {validateAdverseCase} from './backend-adverse-results.mjs';
import {ADVERSE_CASE_IDS,CHILD_ABSENCE_BUDGET_MS} from './backend-adverse-contract.mjs';

const project=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const output=join(project,'.artifacts/tests/isolation/backend-probe/adverse');
const requiredRuntimeFiles=Object.freeze(['backend-adverse-contract.mjs','backend-adverse-owner.mjs','backend-adverse-results.mjs',
  'run-backend-adverse-probe.mjs','run-backend-adverse-limited.ps1'].map(name=>'tests/e2e/isolation/'+name));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
function absent(pid){assert(Number.isSafeInteger(pid)&&pid>0);try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}}
async function waitChildAbsent(pid,budgetMs){
  assert.equal(budgetMs,CHILD_ABSENCE_BUDGET_MS);const deadline=performance.now()+budgetMs;
  while(!absent(pid)){assert(performance.now()<deadline,'Child remains alive while stdout is paused');await delay(Math.min(10,Math.max(1,deadline-performance.now())));}
  assert(performance.now()<=deadline,'Child absence observation exceeded the pause budget');return true;
}
async function processesAbsent(childPid,brokerPid){
  const deadline=performance.now()+3000;
  while(!absent(childPid)||!absent(brokerPid)){assert(performance.now()<deadline,'Owned process remains alive');await delay(25);}
  return true;
}
function launch(resources,mode){
  const child=spawn(resources.hostPath,['run',mode,resources.profile,resources.workerRoot,resources.ownerNonce],{cwd:resources.workerRoot,
    stdio:['pipe','pipe','pipe'],windowsHide:true,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:join(process.env.SystemRoot,'System32')}});
  const state={child,closed:false};state.close=new Promise(resolve=>child.once('close',(code,signal)=>{state.closed=true;resolve({code,signal});}));return state;
}
function resumeOutputFirst(state,owner){
  let failure;try{owner?.resumeOutput();}catch(error){failure=error.message;}
  try{state?.child.stdout.resume();}catch(error){failure??=error.message;}return failure;
}
async function rescue(state,owner){
  // Every exception releases receiver backpressure before any asynchronous cleanup wait.
  const resumeFailure=resumeOutputFirst(state,owner),observations={...(resumeFailure?{resumeFailure}:{})};if(!state)return observations;
  if(!state.closed){
    if(owner)try{await bounded(owner.abort(),1000,'Raw owner abort deadline');}catch(error){observations.abortFailure=error.message;}
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
export function requireAdverseRuntimeFiles(build){
  assert(Array.isArray(build.files));const paths=new Set(build.files.map(file=>file.path));
  for(const path of requiredRuntimeFiles)assert(paths.has(path),'Adverse build provenance missing '+path);
}
async function recheckInputs(inputs){
  const pin=inputs.sourceBoundProvenance.buildManifest,bytes=await fs.readFile(join(project,...pin.path.split('/')));
  assert.equal(bytes.length,pin.bytes);assert.equal(hash(bytes),pin.sha256,'Build manifest changed during adverse probe');
  await verifyBuildFiles(project,inputs.build);requireAdverseRuntimeFiles(inputs.build);await verifyBackendManifest(project,inputs.manifest);
}
async function removeCase(resources){
  await verifyDataTree(resources.dataRoot);await fs.rm(resources.workerRoot,{recursive:true});await assert.rejects(fs.lstat(resources.workerRoot),{code:'ENOENT'});
  assert.deepEqual((await fs.readdir(resources.caseRoot)).sort(),['data','owner.marker']);
  await fs.rm(resources.caseRoot,{recursive:true});await assert.rejects(fs.lstat(resources.caseRoot),{code:'ENOENT'});
}

export async function runBatchB(){
  assert.equal(process.platform,'win32','Native Windows Node is required');
  const inputs=await verifyBuild();requireAdverseRuntimeFiles(inputs.build);
  const runRoot=join(output,'runs',randomBytes(16).toString('hex'));await fs.mkdir(runRoot,{recursive:true});
  const labels=ADVERSE_CASE_IDS.flatMap(caseId=>['control','lpac'].map(mode=>`${mode}-${caseId}`));assert.equal(labels.length,8);
  const summary={schema:1,scope:'test-only-backend-adverse-batch-b',passed:false,networkVerified:false,model:false,gpu:false,
    build:inputs.build,sourceBoundProvenance:inputs.sourceBoundProvenance,cases:[],unrun:[...labels]};
  const save=()=>fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  const identities={workerRoot:new Set(),profile:new Set(),ownerNonce:new Set(),childNonce:new Set(),session:new Set()};
  function freshIdentities(resources,owner){
    for(const [name,value]of Object.entries({...resources,childNonce:owner.receipt.childNonce,session:owner.session})){
      if(!identities[name])continue;assert(!identities[name].has(value),'Reused '+name);identities[name].add(value);
    }
  }
  try{
    for(const caseId of ADVERSE_CASE_IDS)for(const mode of ['control','lpac']){
      const label=`${mode}-${caseId}`,caseRoot=join(runRoot,`case-${randomBytes(16).toString('hex')}`);
      summary.attempting=label;summary.unrun=summary.unrun.filter(value=>value!==label);await save();
      const report={schema:1,label,caseId,mode,passed:false,caseRoot};let state,owner;
      try{
        await recheckInputs(inputs);
        const resources=await prepareBackendResources({projectRoot:project,caseRoot,...inputs});report.resources=resources;state=launch(resources,mode);
        owner=new BackendAdverseOwner(state.child,{caseId,mode,ownerNonce:resources.ownerNonce,session:randomBytes(32).toString('hex'),waitChildAbsent});
        const guard=promise=>Promise.race([promise,owner.fatal.then(error=>{throw error;})]);
        await guard(bounded(owner.prepared,12000,'Adverse native preparation deadline'));freshIdentities(resources,owner);
        await guard(bounded(owner.execute(),6500,'Adverse terminal action deadline'));
        const evidence=await guard(bounded(owner.completion,8000,'Adverse native completion deadline'));assert(!owner.error,owner.error?.message);
        evidence.processesAbsent=await processesAbsent(owner.pid,state.child.pid);report.adverseEvidence=evidence;
        report.validation=validateAdverseCase(evidence);report.audit=owner.audit();
        await recheckInputs(inputs);report.provenanceRecheckedBeforeCleanup=true;
        await removeCase(resources);report.workerRootRemoved=true;report.caseRootRemoved=true;report.passed=true;
      }catch(error){
        const resumeFailure=resumeOutputFirst(state,owner);if(resumeFailure)report.resumeFailure=resumeFailure;
        report.failure=String(error.stack??error);report.rescue=await rescue(state,owner);
        if(owner){report.adverseEvidence=owner.snapshot();report.audit=owner.audit();}
      }finally{
        // Also covers a preparation failure and the first unexpected terminal error.
        try{await recheckInputs(inputs);report.provenanceRechecked=true;}catch(error){report.provenanceFailure=String(error.stack??error);report.passed=false;}
        if(state?.closed){state.child.stdin.destroy();state.child.stdout.destroy();state.child.stderr.destroy();}
        await fs.writeFile(join(runRoot,label+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
        summary.cases.push({label,caseId,mode,passed:report.passed,report:join(runRoot,label+'.json')});await save();
      }
      assert(report.passed,'Adverse case failed; private evidence and uncertain roots retained');console.log(JSON.stringify({label,passed:true}));
    }
    assert.equal(summary.cases.length,8);summary.passed=true;delete summary.attempting;
  }catch(error){summary.failure=String(error.stack??error);process.exitCode=1;}
  finally{
    try{await recheckInputs(inputs);summary.sourceBoundProvenance.rechecked=true;}catch(error){summary.sourceBoundProvenance.failure=String(error.stack??error);summary.passed=false;process.exitCode=1;}
    await save();console.log(JSON.stringify({passed:summary.passed,lifetimes:summary.cases.length,report:join(runRoot,'summary.json')}));
  }
  return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.deepEqual(process.argv.slice(2),['--batch-b']);await runBatchB();}
