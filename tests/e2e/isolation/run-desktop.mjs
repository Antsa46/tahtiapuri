import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs,constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareElectronFixture} from './electron-fixture.mjs';
import {verifyPreparationLimits} from './model-load-limits.mjs';
import {collect,bounded,until,alive,cleanupOwnedRun} from './process-harness.mjs';
import {validateDesktopProgress} from './desktop-results.mjs';
import {sha256} from './package-stager.mjs';
import {readDesktopLog} from './desktop-diagnostics.mjs';
const flags=process.argv.slice(2);assert(process.platform==='win32'&&flags.length<=1&&flags.every(x=>['--check-limits','--debug-startup'].includes(x)));
const diagnostic=flags.includes('--debug-startup');
const preparationLimits=verifyPreparationLimits();
if(flags.includes('--check-limits')){console.log(JSON.stringify({passed:true,preparationLimits}));process.exit(0);}
const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'../../..');
const output=join(root,'.artifacts/tests/isolation'),host=join(output,'native/bin/host.exe');
const runRoot=join(output,'desktop-runs',randomUUID()),template=join(runRoot,'template');
const summary={schema:1,scope:diagnostic?'electron-gui-startup-diagnostic-only':'electron-gui-bootstrap-only',diagnostic,preparationLimits,cases:[],passed:false,unrunCases:[],model:false,cuda:false,networkBoundary:false};
await fs.mkdir(runRoot,{recursive:true});
try {
 const prepared=await prepareElectronFixture(root,template);Object.assign(summary,prepared);
 summary.hostSha256=await sha256(host);summary.scriptHashes={};
 for(const name of ['desktop-probe.cjs','desktop-preload.cjs','desktop-probe.html']){
  await fs.copyFile(join(directory,name),join(template,name),constants.COPYFILE_EXCL);summary.scriptHashes[name]=await sha256(join(template,name));
 }
 for(const mode of ['control','ac']){
  const limits=verifyPreparationLimits(),profile=`tahtiapuri.t09g.${randomUUID().replaceAll('-','')}`;
  const caseRoot=join(runRoot,mode),staged=join(caseRoot,'staged');
  await fs.mkdir(caseRoot);
  let child;
  try {
   await fs.mkdir(staged);await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY',{flag:'wx'});
   for(const name of ['private','scratch','launcher'])await fs.mkdir(join(staged,name));
   await fs.cp(template,join(staged,'package'),{recursive:true,dereference:false});
   for(const [name,value] of [['package/allowed.txt','SYNTHETIC ALLOWED\n'],['package/module.mjs','export const synthetic=true;\n'],['private/secret.txt','SYNTHETIC PRIVATE\n']])await fs.writeFile(join(staged,name),value,{flag:'wx'});
   await fs.copyFile(host,join(staged,'launcher/host.exe'),constants.COPYFILE_EXCL);
   child=spawn(join(staged,'launcher/host.exe'),[diagnostic?'run-desktop-debug':'run-desktop-candidate',mode,profile,staged,'1','1','1','1','1','window-once'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  } catch(error) {
   let removed=false,cleanupError;
   try {
    const stat=await fs.lstat(staged);assert(stat.isDirectory()&&!stat.isSymbolicLink());
    assert.equal(await fs.readFile(join(staged,'owner.marker'),'utf8'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY');
    await fs.rm(staged,{recursive:true,force:true});removed=true;
   }catch(failure){cleanupError=failure.stack;}
   const result={mode,kind:'normal',phase:'preparation',passed:false,error:error.stack,cleanup:{passed:removed,error:cleanupError}};
   await fs.writeFile(join(caseRoot,'result.json'),JSON.stringify(result,null,2)+'\n');summary.cases.push({mode,passed:false,preparationFailed:true,cleanupPassed:removed});
   throw error;
  }
  const report=collect(child,{workerEnvelope:true}),result={mode,kind:diagnostic?'debug-startup':'normal',profileIntent:profile,preparationLimits:limits,launchedChildPid:child.pid,records:report.records,passed:false};
  let hostExited=false; void report.exited.then(()=>{hostExited=true;});
  try{
   result.exit=await bounded(report.exited,40000,'Desktop host deadline.');report.checkComplete();
   let observed;
   if(diagnostic){
    const starts=report.records.filter(x=>x.type==='desktop-debug'&&x.kind==='start'&&x.source==='host');
    const exits=report.records.filter(x=>x.type==='desktop-debug'&&x.kind==='exit'&&x.source==='host');
    assert.equal(starts.length,1);assert.equal(exits.length,1);assert.equal(starts[0].pid,exits[0].pid);
    assert.equal(starts[0].ownMainOnly,true);assert.equal(starts[0].killOnDebuggerExit,true);
    const finished=report.records.filter(x=>x.type==='finished'&&x.source==='host');assert.equal(finished.length,1);
    assert.equal(finished[0].exitCode,exits[0].exitCode);assert.equal(finished[0].activeProcesses,0);assert.equal(finished[0].ownerGone,false);
    const exceptions=report.records.filter(x=>x.type==='desktop-debug'&&x.kind==='exception');
    assert.equal(exceptions.filter(x=>x.loaderCandidate===true).length,1);
    assert(exceptions.every(x=>x.pid===starts[0].pid&&x.handled===x.loaderCandidate));
    if(mode==='control'){assert.equal(exits[0].exitCode,0);assert(report.records.some(x=>x.type==='desktop-phase'&&x.phase==='complete'&&x.source==='worker'));}
    assert(!report.records.some(x=>x.type==='error'));
    assert([0,1].includes(result.exit.code));
    observed=report.records.filter(x=>['launched','inspected-child','console-host'].includes(x.type)&&x.source==='host').map(x=>x.pid);
   }else{observed=validateDesktopProgress(report.records,mode,prepared.version,profile);assert.equal(result.exit.code,0);}
   const pids=[...new Set([child.pid,...observed])];assert.equal(result.exit.signal,null);
   await until(()=>pids.every(pid=>!alive(pid)),7000);
   result.processExitObservation={pids,allAbsent:true,beforeCleanup:true};if(diagnostic)result.diagnosticsCollected=true;else result.observationsVerified=true;
  }catch(error){result.error=error.stack;}
  finally{
   try { result.chromiumLog=hostExited?await readDesktopLog(staged):{state:'skipped-active-host'}; }
   catch(error) { result.chromiumLog={state:'unavailable',code:error.code??'UNKNOWN'}; }
   finally { result.cleanup=await cleanupOwnedRun({child,report,host,staged,profile,restricted:mode==='ac'}); }
   result.stderr=report.stderr;result.rejectedOutput=report.rejectedOutput;result.workerWhitespaceLines=report.workerWhitespaceLines;result.passed=result.observationsVerified===true&&result.cleanup.passed&&result.cleanup.consoleStopped===true;
   await fs.writeFile(join(caseRoot,'result.json'),JSON.stringify(result,null,2)+'\n');summary.cases.push({mode,passed:result.passed,diagnosticCollectionComplete:result.diagnosticsCollected===true&&result.cleanup.passed&&result.cleanup.consoleStopped===true,error:result.error,cleanupPassed:result.cleanup.passed});
  }
  const complete=diagnostic?summary.cases.at(-1).diagnosticCollectionComplete:result.passed;
  console.log(`${mode}: ${diagnostic?'DIAGNOSTIC ':''}${complete?'COMPLETE':'FAILED (original evidence retained)'}`);
  assert(complete,'GUI case failed; matrix stopped.');
 }
 if(diagnostic)summary.diagnosticCollectionComplete=true;else summary.passed=true;
}catch(error){summary.error=error.stack;process.exitCode=1;}
finally{
 summary.unrunCases=['control','ac'].filter(mode=>!summary.cases.some(row=>row.mode===mode));
 try{await fs.rm(template,{recursive:true,force:true});}catch(error){summary.templateCleanupError=error.stack;summary.passed=false;if(diagnostic)summary.diagnosticCollectionComplete=false;process.exitCode=1;}
 await fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');
}
