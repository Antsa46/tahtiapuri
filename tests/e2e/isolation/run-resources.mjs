import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, bounded, until, alive, cleanupOwnedRun } from './process-harness.mjs';
import { validateResourceCase } from './resource-results.mjs';
import { validateRegistryCase } from './registry-results.mjs';

assert(process.platform==='win32' && (process.argv.length===2 || (process.argv.length===3 && ['registry','registry-read'].includes(process.argv[2]))),'Use native Windows Node with optional registry or registry-read comparison only.');
const comparison=process.argv[2]==='registry-read';
const registry=comparison||process.argv[2]==='registry', validateCase=registry?validateRegistryCase:validateResourceCase;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const output=join(root,'.artifacts/tests/isolation'),host=join(output,'native/bin/host.exe'),probe=join(output,'native/bin/resource-probe.exe');
const runRoot=join(output,comparison?'registry-capability-runs':registry?'registry-runs':'resource-runs',randomUUID());await fs.mkdir(runRoot,{recursive:true});
const summary={schema:1,scope:comparison?'native-registry-capability-comparison':registry?'native-registry-open-diagnosis':'native-resource-diagnosis',cases:[],diagnosticComplete:false,startupAttempted:false,startupVerified:false,networkAttempted:false,isolationVerified:false};
async function runCase(mode,kind,capabilityPolicy='none'){
  const caseRoot=join(runRoot,`${mode}${capabilityPolicy==='registryRead'?'-registry-read':''}-${kind}`),staged=join(caseRoot,'staged');
  const profile=`tahtiapuri.t09a.${randomUUID().replaceAll('-','')}`;
  for(const name of ['package','private','scratch','launcher'])await fs.mkdir(join(staged,name),{recursive:true});
  await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY',{flag:'wx'});
  const caseHost=join(staged,'launcher/host.exe');await fs.copyFile(host,caseHost);await fs.copyFile(probe,join(staged,'package/probe.exe'));
  for(const [name,text] of Object.entries({'package/allowed.txt':'SYNTHETIC ALLOWED\n','package/weights.fixture':'SYNTHETIC WEIGHTS\n','package/legacy.fixture':'SYNTHETIC AAP\n','package/module.mjs':'export const synthetic = true;\n','private/secret.txt':'SYNTHETIC PRIVATE\n'}))await fs.writeFile(join(staged,name),text,{flag:'wx'});
  for(const name of ['package/probe.exe','launcher/host.exe','package/allowed.txt','package/weights.fixture','package/legacy.fixture','package/module.mjs','private/secret.txt'])assert.equal((await fs.stat(join(staged,name))).nlink,1);
  const hostSha256=createHash('sha256').update(await fs.readFile(caseHost)).digest('hex');
  const probeSha256=createHash('sha256').update(await fs.readFile(join(staged,'package/probe.exe'))).digest('hex');
  // Host's reserved ports are validated but never used by this separate binary.
  const child=spawn(caseHost,[capabilityPolicy==='registryRead'?'run-registry-read':'run',mode,profile,staged,'1','1','1','1','1',kind],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const report=collect(child),result={mode,kind,capabilityPolicy,probeSha256,hostSha256,driverPid:process.pid,launchedChildPid:child.pid,startedAt:new Date().toISOString(),records:[],diagnosticComplete:false};
  try{
    result.exit=await bounded(report.exited,20000,'Resource host did not finish.');report.checkComplete();
    result.records=report.records.map(row=>({...row}));
    const pids=[...new Set([child.pid,...report.records.filter(row=>['launched','token'].includes(row.type)).map(row=>row.pid)])];
    await until(()=>pids.every(pid=>!alive(pid)),7000);result.processExitObservation={pids,allAbsent:true,beforeCleanup:true};
  }catch(error){result.error=error.stack;result.records=report.records.map(row=>({...row}));}
  finally{
    result.cleanup=await cleanupOwnedRun({child,report,host,staged,profile,restricted:['ac','lpac'].includes(mode)});
    result.stderr=report.stderr;result.finishedAt=new Date().toISOString();
    try{result.validation=validateCase(result,{capabilityPolicy});result.diagnosticComplete=true;}
    catch(error){result.validationError=error.message;}
    await fs.writeFile(join(caseRoot,'result.json'),JSON.stringify(result,null,2)+'\n');
    summary.cases.push({mode,kind,capabilityPolicy,probeSha256,hostSha256,diagnosticComplete:result.diagnosticComplete,observations:result.validation,cleanupPassed:result.cleanup.passed,error:result.error??result.validationError});
  }
  console.log(`${mode}/${capabilityPolicy}: ${registry?'registry':'resource'} diagnosis ${result.diagnosticComplete?'COMPLETE':'INCOMPLETE'}`);
  assert(result.diagnosticComplete&&result.cleanup.passed,'Incomplete resource diagnosis or cleanup failure; stopped.');
  if(registry&&!['ac','lpac'].includes(mode))assert(result.validation.allRegistryOpensSucceeded,'Reference registry opens failed; stopped.');
  if(!['ac','lpac'].includes(mode))assert(result.validation.selfRead&&result.validation.selfExecute&&result.validation.defaultDaclKnown&&result.validation.childPolicyKnown,'Reference resource query failed; stopped.');
}
try{
  for(const mode of ['control','ac','lpac','control-inherit']){
    await runCase(mode,registry?'registry-once':'resource-once');
    if(comparison&&mode==='lpac')await runCase('lpac','registry-once','registryRead');
  }
  assert.equal(new Set(summary.cases.map(c=>c.probeSha256)).size,1,'Probe changed between cases.');
  assert.equal(new Set(summary.cases.map(c=>c.hostSha256)).size,1,'Host changed between cases.');
  summary.diagnosticComplete=summary.cases.length===(comparison?5:4)&&summary.cases.every(c=>c.diagnosticComplete);
  if(!summary.diagnosticComplete)process.exitCode=1;
}finally{await fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(`Local ${registry?'registry':'resource'} evidence: ${runRoot}`);}
