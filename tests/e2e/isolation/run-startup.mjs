import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, bounded, until, alive, cleanupOwnedRun } from './process-harness.mjs';
import { startupKinds, decodeStartupChild, validateStartupCase } from './startup-results.mjs';

assert(process.platform==='win32' && process.argv.length===2,'Use native Windows Node without additional arguments.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const output=join(root,'.artifacts/tests/isolation'),host=join(output,'native/bin/host.exe'),probe=join(output,'native/bin/startup-probe.exe');
const runRoot=join(output,'startup-runs',randomUUID());await fs.mkdir(runRoot,{recursive:true});
const summary={schema:1,scope:'native-startup-diagnosis',cases:[],diagnosticComplete:false,compatible:false,passed:false,networkAttempted:false,isolationVerified:false,originalMatrixRun:false};
async function runCase(mode,kind){
  const caseRoot=join(runRoot,`${mode}-${kind}`),staged=join(caseRoot,'staged');
  const profile=`tahtiapuri.t09a.${randomUUID().replaceAll('-','')}`;
  for(const name of ['package','private','scratch','launcher'])await fs.mkdir(join(staged,name),{recursive:true});
  await fs.writeFile(join(staged,'owner.marker'),'TAHTIAPURI_T09A_SYNTHETIC_ONLY',{flag:'wx'});
  const caseHost=join(staged,'launcher/host.exe');await fs.copyFile(host,caseHost);await fs.copyFile(probe,join(staged,'package/probe.exe'));
  for(const [name,text] of Object.entries({'package/allowed.txt':'SYNTHETIC ALLOWED\n','package/weights.fixture':'SYNTHETIC WEIGHTS\n','package/legacy.fixture':'SYNTHETIC AAP\n','package/module.mjs':'export const synthetic = true;\n','private/secret.txt':'SYNTHETIC PRIVATE\n'}))await fs.writeFile(join(staged,name),text,{flag:'wx'});
  for(const name of ['package/probe.exe','launcher/host.exe','package/allowed.txt','package/weights.fixture','package/legacy.fixture','package/module.mjs','private/secret.txt'])assert.equal((await fs.stat(join(staged,name))).nlink,1);
  const probeSha256=createHash('sha256').update(await fs.readFile(join(staged,'package/probe.exe'))).digest('hex');
  // Host's reserved ports are validated but never used by this separate binary.
  const child=spawn(caseHost,['run',mode,profile,staged,'1','1','1','1','1',kind],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const report=collect(child),result={mode,kind,probeSha256,driverPid:process.pid,launchedChildPid:child.pid,startedAt:new Date().toISOString(),records:[],passed:false,diagnosticComplete:false};
  try{
    result.exit=await bounded(report.exited,20000,'Startup host did not finish.');report.checkComplete();
    result.records=report.records.map(row=>({...row,source:'pipe'}));
    const receipt=join(staged,'scratch/child-result.jsonl');
    const stat=await fs.lstat(receipt).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const made=report.records.some(row=>row.type==='descendant');
    if(kind==='startup-no-inherit'&&made){
      assert(stat?.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=16384,'Invalid child receipt file.');
      result.childReceipt=await fs.readFile(receipt,'utf8');result.records.push(...decodeStartupChild(result.childReceipt));
    }else assert.equal(stat,null,'Unexpected child receipt.');
    const pids=[...new Set([child.pid,...report.records.filter(row=>['launched','token','descendant'].includes(row.type)).map(row=>row.pid)])];
    await until(()=>pids.every(pid=>!alive(pid)),7000);result.processExitObservation={pids,allAbsent:true,beforeCleanup:true};
  }catch(error){result.error=error.stack;result.records=report.records.map(row=>({...row,source:'pipe'}));}
  finally{
    result.cleanup=await cleanupOwnedRun({child,report,host,staged,profile,restricted:['ac','lpac'].includes(mode)});
    result.stderr=report.stderr;result.finishedAt=new Date().toISOString();
    try{result.validation=validateStartupCase(result);result.diagnosticComplete=true;result.passed=result.validation.compatible;}
    catch(error){result.validationError=error.message;}
    await fs.writeFile(join(caseRoot,'result.json'),JSON.stringify(result,null,2)+'\n');
    summary.cases.push({mode,kind,probeSha256,diagnosticComplete:result.diagnosticComplete,compatible:result.validation?.compatible??false,api:result.validation?.api,code:result.validation?.code,cleanupPassed:result.cleanup.passed,error:result.error??result.validationError});
  }
  console.log(`${mode}/${kind}: ${result.diagnosticComplete?(result.passed?'API PASS':`diagnosed API failure ${result.validation.code}; compatibility unresolved`):'INCOMPLETE'}`);
  assert(result.diagnosticComplete&&result.cleanup.passed,'Incomplete diagnosis or cleanup failure; stopped.');
  if(mode!=='lpac')assert(result.passed,'Reference startup failed; stopped.');
}
try{
  for(const kind of startupKinds)for(const mode of ['control','ac','lpac','control-inherit'])await runCase(mode,kind);
  assert.equal(new Set(summary.cases.map(c=>c.probeSha256)).size,1,'Probe changed between cases.');
  summary.diagnosticComplete=summary.cases.length===12&&summary.cases.every(c=>c.diagnosticComplete);
  summary.compatible=summary.diagnosticComplete&&summary.cases.every(c=>c.compatible);summary.passed=summary.compatible;
  if(!summary.passed)process.exitCode=1;
}finally{await fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(`Local startup evidence: ${runRoot}`);}
