import assert from 'node:assert/strict';
import {promises as fs,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {collect,bounded,until,alive} from './process-harness.mjs';
import {verifyPreparationLimits} from './model-load-limits.mjs';
import {validateResult} from './node-stdio-results.mjs';
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url))),source=join(root,'tests/e2e/isolation'),output=join(root,'.artifacts/tests/isolation/node-stdio');
const hash=async path=>createHash('sha256').update(await fs.readFile(path)).digest('hex');
const flags=process.argv.slice(2);assert(flags.length===0||(flags.length===1&&['--smoke','--detached-control-only','--detached-candidate-smoke','--detached-matrix'].includes(flags[0])));
const diagnostic=flags[0]==='--detached-control-only',candidate=flags[0]==='--detached-candidate-smoke',matrixCandidate=flags[0]==='--detached-matrix';
const nativeVariant=diagnostic?'native-detached-control':candidate?'native-detached-candidate':matrixCandidate?'native-detached-matrix':'native',creationMode=diagnostic?'detached-control-diagnostic':candidate?'detached-normal-candidate':matrixCandidate?'detached-matrix-candidate':'no-window-candidate';
const basic=[['control','normal'],['ac','normal'],['lpac','normal'],['control','fail'],['lpac','fail'],['control','owner-loss'],['lpac','owner-loss']];
const extra=['owner-early','stalled-reader','startup-fail','invalid-utf8'].flatMap(kind=>['control','lpac'].map(mode=>[mode,kind]));
const matrix=diagnostic?[['control','normal']]:candidate||flags[0]==='--smoke'?basic.slice(0,3):[...basic,...extra];
const runRoot=join(output,'runs',randomUUID());await fs.mkdir(runRoot,{recursive:true});
const summary={schema:1,scope:'official-node-stdio-only',creationMode,model:false,gpu:false,networkVerified:false,limits:verifyPreparationLimits(),cases:[],unrun:matrix,passed:false};
const save=()=>fs.writeFile(join(runRoot,'summary.json'),JSON.stringify(summary,null,2)+'\n');
let build,tools,node;
async function verify(){
 build=JSON.parse(await fs.readFile(join(output,nativeVariant,'build-manifest.json'),'utf8'));tools=JSON.parse(await fs.readFile(join(root,'scripts/dev/toolchain.json'),'utf8'));
 assert.equal(build.schema,1);assert.equal(build.creationMode,creationMode);assert.equal(build.affinity,1);assert.equal(build.priority,'BelowNormal');assert.equal(build.archiveSha256,tools.node.sha256);
 const expected=['tests/e2e/isolation/native/node-stdio-host.cpp','tests/e2e/isolation/native/capability-diagnostic.h','tests/e2e/isolation/native/common.h','tests/e2e/isolation/node-stdio-probe.mjs','tests/e2e/isolation/node-stdio-wire.mjs','tests/e2e/isolation/build-node-stdio.ps1','scripts/dev/toolchain.json',...['common.h','transport-wire.h','transport-resources.h','isolated-launcher.h','owner-input.h'].map(n=>'packages/windows-runtime/native/'+n),`.artifacts/tests/isolation/node-stdio/${nativeVariant}/bin/node-stdio-host.exe`,`.artifacts/tests/isolation/node-stdio/${nativeVariant}/node-stdio-pins.h`];
 assert.deepEqual(build.files.map(x=>x.path).sort(),expected.sort());
 for(const f of build.files)assert.equal(await hash(join(root,f.path)),f.sha256,'Build input/output changed');
 node=join(root,`.local/toolchain/node-v${tools.node.version}-win-x64/node.exe`);assert.equal(await hash(node),build.nodeSha256);summary.build=build;
 summary.driverHashes={};for(const name of ['run-node-stdio.mjs','run-node-stdio-limited.ps1','process-harness.mjs','model-load-limits.mjs','node-stdio-results.mjs'])summary.driverHashes[name]=await hash(join(source,name));
}
async function run([mode,kind]){
 const id=randomUUID(),stage=join(runRoot,id),profile='tahtiapuri.stdio.'+id.replaceAll('-','');
 const evidence={mode,kind,stage,profile,passed:false,cleanup:{passed:false}};let child,report;
 try{
  await fs.mkdir(stage);for(const dir of ['package','launcher','scratch','private','aap'])await fs.mkdir(join(stage,dir));
  await fs.writeFile(join(stage,'owner.marker'),'TAHTIAPURI_NODE_STDIO_ONLY',{flag:'wx'});
  await fs.writeFile(join(stage,'private/secret.txt'),'SYNTHETIC SECRET',{flag:'wx'});await fs.writeFile(join(stage,'aap/read.txt'),'SYNTHETIC AAP',{flag:'wx'});
  await fs.writeFile(join(stage,'package/code.txt'),'SYNTHETIC CODE',{flag:'wx'});await fs.writeFile(join(stage,'package/allowed.txt'),build.allowedText,{flag:'wx'});await fs.writeFile(join(stage,'package/package.json'),build.packageJson,{flag:'wx'});
  for(const [from,to] of [[node,'package/node.exe'],[join(output,nativeVariant,'bin/node-stdio-host.exe'),'launcher/node-stdio-host.exe'],...['node-stdio-probe.mjs','node-stdio-wire.mjs'].map(n=>[join(source,n),'package/'+n])]){await fs.copyFile(from,join(stage,to),constants.COPYFILE_EXCL);assert.equal(await hash(from),await hash(join(stage,to)));}
  child=spawn(join(stage,'launcher/node-stdio-host.exe'),['run',mode,profile,stage,kind],{cwd:stage,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:join(process.env.SystemRoot,'System32')}});report=collect(child);
  if(kind.startsWith('owner-')){await until(()=>{report.check();return report.records.some(x=>x.type==='await-owner');},12000);child.stdin.end();}
  evidence.exit=await bounded(report.exited,25000,'Node stdio broker deadline');report.checkComplete();assert.equal(report.stderr,'');
  evidence.validation=validateResult(report.records,mode,kind,evidence.exit,{nodeVersion:tools.node.version,creationMode});await until(()=>!alive(evidence.validation.pid),3000);
  await fs.rm(stage,{recursive:true});await assert.rejects(fs.lstat(stage),{code:'ENOENT'});evidence.cleanup={passed:true,removed:true,stopped:true,profileDeleted:true};evidence.passed=true;
 }catch(e){evidence.failure=String(e.stack??e);}
 finally{
  if(child){if(child.exitCode===null&&child.signalCode===null)child.kill();try{await bounded(report.exited,5000,'Broker close unconfirmed');}catch(e){evidence.cleanup.error=e.message;}
   evidence.records=report.records;evidence.stderr=report.stderr;evidence.rejectedOutput=report.rejectedOutput;child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  }
  await fs.writeFile(join(runRoot,id+'.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
 }
 summary.cases.push({mode,kind,passed:evidence.passed,report:join(runRoot,id+'.json')});await save();
 if(!evidence.passed)throw new Error('Node stdio case failed: '+mode+'/'+kind+'; retained private report and stage.');
 console.log(JSON.stringify({mode,kind,passed:true}));
}
try{await verify();await save();for(let i=0;i<matrix.length;i++){summary.attempting=matrix[i];summary.unrun=matrix.slice(i+1);await save();await run(matrix[i]);delete summary.attempting;}
 for(const f of build.files)assert.equal(await hash(join(root,f.path)),f.sha256,'Build source changed during run');for(const [name,value]of Object.entries(summary.driverHashes))assert.equal(await hash(join(source,name)),value);assert.equal(await hash(node),build.nodeSha256);summary.passed=true;
}catch(e){summary.failure=String(e.stack??e);process.exitCode=1;}
finally{await save();console.log(JSON.stringify({passed:summary.passed,cases:summary.cases.length,report:join(runRoot,'summary.json')}));}
