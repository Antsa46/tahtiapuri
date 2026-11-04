import assert from 'node:assert/strict';
import {promises as fs,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {verifyRuntimeIdentity} from './sdk-runtime.mjs';
import {modelProfile,modelOptions,validateModelProfile} from './model-contract.mjs';
const root=process.argv[2],life=process.argv[8];
assert(root&&['once','hold','missing-model'].includes(life));assert.equal(process.argv[10],'primary-model-candidate');
const profile=JSON.parse(await fs.readFile(join(root,'package/model-profile.json'),'utf8'));
assert.deepEqual(Object.keys(profile).sort(),['bindingSha256','model','runtime','version']);
validateModelProfile(profile.model);assert.equal(profile.version,'3.22.2');
assert.equal(profile.runtime.kind,'node');assert.equal(profile.runtime.variant,'local-patched');
const emit=row=>process.stdout.write(JSON.stringify(row)+'\n');
async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
const weights=join(root,'package/model.gguf');
let llama,model,phase='integrity';
try {
 const binding=join(root,'package/node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node');
 assert.equal(await hash(binding),profile.bindingSha256);
 const identity=verifyRuntimeIdentity(profile.runtime,{platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron,uv:process.versions.uv,execPath:process.execPath,expectedExecPath:join(root,'package/node.exe'),sha256:await hash(process.execPath),runAsNode:process.env.ELECTRON_RUN_AS_NODE,nodeOptions:process.env.NODE_OPTIONS,nodePath:process.env.NODE_PATH});
 emit({type:'model-phase',phase:'runtime',passed:true,...identity});
 const operations=[];
 async function operation(name,action){try{await action();operations.push({name,ok:true});}catch(error){operations.push({name,ok:false,code:error.code});}}
 await operation('package-read',async()=>assert.equal(await fs.readFile(join(root,'package/allowed.txt'),'utf8'),'SYNTHETIC ALLOWED\n'));
 await operation('scratch-write',()=>fs.writeFile(join(root,'scratch/model.txt'),'SYNTHETIC\n',{flag:'wx'}));
 await operation('outside-read',()=>fs.readFile(join(root,'private/secret.txt')));
 await operation('outside-write',()=>fs.writeFile(join(root,'private/model.txt'),'SYNTHETIC\n',{flag:'wx'}));
 for(const [name,file] of [['code-write','module.mjs'],['weights-fixture-write','weights-write.fixture']])await operation(name,async()=>{const h=await fs.open(join(root,'package',file),'r+');try{await h.write('X');}finally{await h.close();}});
 await operation('aap-read',async()=>assert.equal(await fs.readFile(join(root,'package/legacy.fixture'),'utf8'),'SYNTHETIC AAP ONLY\n'));
 emit({type:'model-policy',pid:process.pid,operations});
 phase='weights';
 if(life==='missing-model')await assert.rejects(fs.lstat(weights),{code:'ENOENT'});
 else {
  const stat=await fs.lstat(weights);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1);assert.equal(stat.size,modelProfile.bytes);
  assert.equal(await hash(weights),modelProfile.sha256);
  emit({type:'model-phase',phase,passed:true,bytes:stat.size,sha256:modelProfile.sha256});
 }
 phase='cpu';
 const {getLlama,getModuleVersion}=await import('node-llama-cpp');assert.equal(await getModuleVersion(),profile.version);
 llama=await getLlama({gpu:false,build:'never',skipDownload:true,usePrebuiltBinaries:true,progressLogs:false,logLevel:'error',maxThreads:1,tempDir:join(root,'scratch/sdk')});
 assert.equal(llama.gpu,false);assert.equal(llama.buildType,'prebuilt');
 emit({type:'model-phase',phase,passed:true,gpu:false,buildType:llama.buildType,maxThreads:1});
 phase='load';
 const options={...modelOptions,modelPath:weights,loadSignal:AbortSignal.timeout(90000)};
 if(life==='missing-model'){
  let failure;try{model=await llama.loadModel(options);}catch(error){failure=error;}
  assert.equal(model,undefined);assert.equal(failure?.code,'ENOENT');
  emit({type:'model-expected-failure',phase,code:'ENOENT'});process.exitCode=17;
 }else{
  model=await llama.loadModel(options);assert.equal(model.disposed,false);assert.equal(model.gpuLayers,0);assert.equal(model.useMmap,true);
  const template=model.fileInfo.metadata.tokenizer?.chat_template;assert.equal(typeof template,'string');
  const templateSha256=createHash('sha256').update(template).digest('hex');assert.equal(templateSha256,modelProfile.templateSha256);
  assert(Number.isFinite(model.size)&&model.size>0);
  emit({type:'model-phase',phase:'loaded',passed:true,id:modelProfile.id,gpuLayers:model.gpuLayers,useMmap:model.useMmap,size:model.size,templateSha256,options:modelOptions,contextCreated:false,generation:false,rssBytes:process.memoryUsage().rss});
  if(life==='hold'){emit({type:'model-held',pid:process.pid});process.stdin.resume();await new Promise(()=>{});}
 }
 phase='dispose';
 if(model){await model.dispose();assert.equal(model.disposed,true);emit({type:'model-phase',phase:'model-disposed',passed:true,disposed:model.disposed});model=undefined;}
 await llama.dispose();assert.equal(llama.disposed,true);emit({type:'model-phase',phase:'llama-disposed',passed:true,disposed:llama.disposed});llama=undefined;
}catch(error){emit({type:'model-error',phase,name:error.name,code:error.code??null,message:String(error.message).slice(0,4096)});process.exitCode=1;}
finally{await model?.dispose();await llama?.dispose();process.stdin.destroy();}
