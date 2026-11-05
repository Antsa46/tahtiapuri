import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs,constants} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collect,bounded,until,alive,helper} from './process-harness.mjs';
import {verifyPreparationLimits} from './model-load-limits.mjs';
import {transportCases,validateLaunch,validateResult,validateFailedCreationCleanup,validatePrepareOwnerLoss} from './transport-results.mjs';
const flags=process.argv.slice(2);
assert(new Set(flags).size===flags.length&&flags.every(x=>['--smoke','--check-limits','--owner-input-only','--prepare-owner-only'].includes(x)));
const preparationLimits=verifyPreparationLimits();
if(flags.includes('--check-limits')) {console.log(JSON.stringify({passed:true,preparationLimits}));process.exit(0);}
const source=dirname(fileURLToPath(import.meta.url)),root=resolve(source,'../../..');
const output=join(root,'.artifacts/tests/isolation/transport'),bin=join(output,'native/bin');
const runRoot=join(output,'runs',randomUUID());
const hash=async path=>createHash('sha256').update(await fs.readFile(path)).digest('hex');
const matrix=(flags.includes('--owner-input-only')?[]:['control','ac','lpac']).flatMap(mode=>(flags.includes('--smoke')?['normal']:flags.includes('--prepare-owner-only')?['owner-loss-prepare']:transportCases).map(kind=>({mode,kind})));
const summary={schema:1,scope:flags.includes('--owner-input-only')?'native-owner-input-only':'native-transport-only',model:false,gpu:false,networkVerified:false,preparationLimits,cases:[],passed:false,unrun:matrix};
await fs.mkdir(runRoot,{recursive:true});
const summaryPath=join(runRoot,'summary.json');
const save=()=>fs.writeFile(summaryPath,JSON.stringify(summary,null,2)+'\n');
async function checkBuild() {
  const build=JSON.parse(await fs.readFile(join(output,'native/build-manifest.json'),'utf8'));
  assert.equal(build.schema,1);assert.equal(build.affinity,1);assert.equal(build.priority,'BelowNormal');
  const expected=['common.h','isolated-launcher.h','transport-wire.h','transport-resources.h','transport-host.cpp','transport-worker.cpp','owner-input-tests.cpp']
    .map(name=>'tests/e2e/isolation/native/'+name).concat(['host','worker'].map(name=>'.artifacts/tests/isolation/transport/native/bin/transport-'+name+'.exe'));
  expected.push(...['common.h','transport-wire.h','transport-resources.h','isolated-launcher.h','owner-input.h'].map(x=>'packages/windows-runtime/native/'+x));
  expected.push('.artifacts/tests/isolation/transport/native/bin/owner-input-tests.exe');
  assert.deepEqual(build.files.map(x=>x.path).sort(),expected.sort());
  for(const entry of build.files) assert.equal(await hash(join(root,entry.path)),entry.sha256.toLowerCase(),'Build input/output changed.');
  summary.build=build;
  summary.scriptHashes={};
  for(const name of ['run-transport.mjs','run-transport-limited.ps1','build-transport.ps1','transport-results.mjs','process-harness.mjs','model-load-limits.mjs'])
    summary.scriptHashes[name]=await hash(join(source,name));
}
async function runOwnerInput() {
  const child=spawn(join(bin,'owner-input-tests.exe'),[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const report=collect(child);
  try {
    const exit=await bounded(report.exited,10000,'Owner input test deadline exceeded.');
    report.checkComplete();assert.deepEqual(exit,{code:0,signal:null});assert.equal(report.stderr,'');
    assert.deepEqual(report.records,['frame-and-owner-eof','partial-frame-deadline','wrong-session','unknown-owner-operation',
      'bounded-owner-queue','queued-shutdown-visible-during-prepare','stop-partial-reader','watchdog-independent-of-owner-read'].map(name=>({type:'owner-input',passed:true,case:name})));
    summary.ownerInput={passed:true,exit,records:report.records};
  } catch(error) {
    summary.ownerInput={passed:false,records:report.records,stderr:report.stderr,rejectedOutput:report.rejectedOutput,failure:error.message};throw error;
  } finally {
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await bounded(report.exited,5000,'Owner input test exit unconfirmed.');
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  }
}
async function runCase({mode,kind}) {
  const id=randomUUID(),staged=join(runRoot,id),profile='tahtiapuri.t09h.'+id.replaceAll('-','');
  const reportFile=join(runRoot,id+'.json');
  const evidence={mode,kind,profile,staged,passed:false,records:[],cleanup:{passed:false}};
  let child,report,owned=false,validated=false,stopped=false,deleted=mode==='control',brokerExited=false,observer,observation;
  const host=join(staged,'launcher/transport-host.exe');
  try {
  await fs.mkdir(staged);owned=true;
  for(const dir of ['package','launcher','private','scratch']) await fs.mkdir(join(staged,dir));
  await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09H_TRANSPORT_ONLY',{flag:'wx'});
  await fs.writeFile(join(staged,'private/secret.txt'),'synthetic handle inheritance sentinel',{flag:'wx'});
  for(const name of ['host','worker']) {
    const destination=join(staged,name==='host'?'launcher':'package','transport-'+name+'.exe');
    await fs.copyFile(join(bin,'transport-'+name+'.exe'),destination,constants.COPYFILE_EXCL);
    assert.equal(await hash(destination),await hash(join(bin,'transport-'+name+'.exe')));
  }
  child=spawn(host,['run',mode,profile,staged,kind],{cwd:staged,stdio:['pipe','pipe','pipe'],windowsHide:true});
  report=collect(child);
    if(kind==='owner-loss-prepare') {
      await until(()=>{report.check();return report.records.some(x=>x.type==='await-prepare-owner');},12000);
      child.stdin.end();
    } else if(kind==='owner-loss'||kind==='broker-loss') {
      await until(()=>{report.check();return report.records.some(x=>x.type==='await-owner');},12000);
      validateLaunch(report.records,mode);
      assert.equal(report.records.find(x=>x.type==='await-owner').pid,report.records.find(x=>x.type==='launched').pid);
      if(kind==='owner-loss') child.stdin.end();
      else {
        const pid=validateLaunch(report.records,mode).pid;
        observer=spawn(host,['observe',String(pid),staged,'worker'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
        observation=collect(observer);
        await until(()=>{observation.check();return observation.records.some(x=>x.type==='observing');},5000);
        assert.deepEqual(observation.records,[{type:'observing',pid,imageVerified:true}]);
        assert(child.kill(),'Owned broker termination failed.');
      }
    }
    evidence.exit=await bounded(report.exited,20000,'Transport broker deadline exceeded.');brokerExited=true;
    report.checkComplete();assert.equal(report.stderr,'');
    if(kind==='owner-loss-prepare') {
      evidence.validation=validatePrepareOwnerLoss(report.records,evidence.exit);
      validated=true;stopped=true;deleted=true;evidence.passed=true;
    } else {
    evidence.validation=validateResult(report.records,mode,kind,evidence.exit);validated=true;
    const launch=validateLaunch(report.records,mode);
    if(observation) {
      const exit=await bounded(observation.exited,5000,'Retained child handle did not signal exit.');
      observation.checkComplete();assert.deepEqual(exit,{code:0,signal:null});assert.equal(observation.stderr,'');
      assert.equal(observation.records.length,2);
      assert.deepEqual(observation.records[0],{type:'observing',pid:launch.pid,imageVerified:true});
      const last=observation.records[1];assert.deepEqual(Object.keys(last).sort(),['exitCode','pid','type']);
      assert.equal(last.type,'observed-exit');assert.equal(last.pid,launch.pid);assert(Number.isInteger(last.exitCode)&&last.exitCode>=0&&last.exitCode<=0xffffffff);
      evidence.observation=observation.records;
    }
    await until(()=>!alive(launch.pid),5000);stopped=true;
    // Broker-loss intentionally requires external profile deletion, only AFTER
    // proving kill-on-close removed the child without emergency cleanup.
    if(kind==='broker-loss'&&mode!=='control') {
      evidence.profileCleanup=await helper(host,['cleanup',profile,staged]);
      assert.equal(evidence.profileCleanup.code,0);
      assert.deepEqual(evidence.profileCleanup.records,[{type:'cleanup',hresult:0}]);deleted=true;
    } else deleted=mode==='control'||report.records.at(-1).profileDeleted===true;
    assert(deleted);evidence.passed=true;
    }
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
    if(stopped&&brokerExited&&!deleted) {
      try {
        if(await fs.readFile(join(staged,'profile.receipt'),'utf8')===profile) {
          const repair=await helper(host,['cleanup',profile,staged]);evidence.cleanup.repair=repair;deleted=repair.code===0;
        }
      } catch(error){evidence.cleanup.profileError=error.message;}
    }
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    if(observer) {
      if(observer.exitCode===null&&observer.signalCode===null) observer.kill();
      try{await bounded(observation.exited,5000,'Observer did not exit.');}catch(error){evidence.cleanup.observerError=error.message;}
      observer.stdin.destroy();observer.stdout.destroy();observer.stderr.destroy();
    }
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
  if(!evidence.passed) throw new Error('Transport case failed: '+mode+'/'+kind+'. Read retained private evidence.');
  console.log(JSON.stringify({mode,kind,passed:true}));
}
try {
  await checkBuild();await runOwnerInput();await save();
  for(let index=0;index<matrix.length;index++) {
    summary.unrun=matrix.slice(index+1);summary.attempting=matrix[index];await save();
    await runCase(matrix[index]);delete summary.attempting;await save();
  }
  for(const [name,expected] of Object.entries(summary.scriptHashes)) assert.equal(await hash(join(source,name)),expected,'Driver source changed during run.');
  summary.passed=true;
} catch(error){summary.failure=error.message;process.exitCode=1;}
finally{await save();console.log(JSON.stringify({passed:summary.passed,report:summaryPath}));}
