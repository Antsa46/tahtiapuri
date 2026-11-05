// Test-only entry: composes the current backend without Electron, SDK or child processes.
import {readFile,realpath,lstat,open,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {KINDS,HEADER,FrameReader,BoundedWriter,encodeJson,decodeJson} from './backend-codec.mjs';

const MAX_INPUT=65536,MAX_OUTPUT=16*1024*1024,MAX_FRAMES=256;
function fault(message,exitCode=65){const error=new Error(message);error.exitCode=exitCode;return error;}
async function roots(workerRoot,dataRoot){
  for(const path of [workerRoot,dataRoot]){
    if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0')||path.startsWith('\\\\')||path.startsWith('//'))throw fault('Invalid test root.',64);
    const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||relative(resolve(path),await realpath(path))!=='')throw fault('Noncanonical test root.',64);
  }
  workerRoot=resolve(workerRoot);dataRoot=resolve(dataRoot);const caseRoot=dirname(workerRoot);
  if(!/^worker-[a-f0-9]{32}$/.test(workerRoot.slice(caseRoot.length+1))||dataRoot!==join(caseRoot,'data'))throw fault('Invalid owned data layout.',64);
  if(await readFile(join(caseRoot,'owner.marker'),'utf8')!=='TAHTIAPURI_BACKEND_CASE'
    ||await readFile(join(workerRoot,'owner.marker'),'utf8')!=='TAHTIAPURI_BACKEND_PROBE')throw fault('Invalid test ownership marker.',64);
  return {workerRoot,dataRoot};
}
async function boundaries(root,session){
  const operations=[];
  for(const [name,action]of[
    ['package-read',async()=>{if(await readFile(join(root,'package/allowed.txt'),'utf8')!=='SYNTHETIC ALLOWED\n')throw new Error('fixture');}],
    ['scratch-write',()=>writeFile(join(root,'scratch/written.txt'),'synthetic',{flag:'wx'})],
    ['private-read',()=>readFile(join(root,'private/secret.txt'))],
    ['private-write',()=>writeFile(join(root,'private/write-probe.txt'),'synthetic',{flag:'wx'})],
    ['code-write',async()=>{const file=await open(join(root,'package/code.txt'),'r+');try{await file.write('X');}finally{await file.close();}}],
    ['aap-read',()=>readFile(join(root,'aap/read.txt'))]
  ]){
    try{await action();operations.push({name,ok:true});}
    catch(error){operations.push({name,ok:false,code:typeof error.code==='string'&&error.code.length<=64?error.code:'UNEXPECTED'});}
  }
  return {type:'probe.boundaries',session,operations};
}

export async function runBackendWorker({workerRoot,dataRoot,nonce,input=process.stdin,output=process.stdout,now=Date.now}){
  ({workerRoot,dataRoot}=await roots(workerRoot,dataRoot));
  const load=path=>import(pathToFileURL(join(workerRoot,'package',path)).href);
  const [{createBackend},{createObserving},{createSky},{SkyQueries},{AssistantService},{ParentModelEngine},{isInitialize}]=await Promise.all([
    load('backend/dist/composition/create-backend.js'),load('backend/dist/composition/create-observing.js'),
    load('backend/dist/composition/create-sky.js'),load('backend/dist/modules/sky/application/sky-queries.js'),
    load('backend/dist/modules/assistant/application/assistant-service.js'),load('backend/dist/modules/assistant/adapters/parent-model-engine.js'),
    load('node_modules/@tahtiapuri/validation/dist/backend-protocol.js')
  ]);
  let complete,abort;const done=new Promise((resolve,reject)=>{complete=resolve;abort=reject;});
  let failure,session,shutdownAccepted=false,inputEnded=false,endpointStopped=false,lastParentMessage=now(),chain=Promise.resolve();
  let releaseStop;const stopped=new Promise(resolve=>{releaseStop=resolve;});
  let assistant,heartbeat;
  const fail=error=>{
    if(failure)return;failure=error instanceof Error?error:fault('Backend worker failed.');clearInterval(heartbeat);
    input.pause();assistant?.dispose();abort(failure);
  };
  const writer=new BoundedWriter(output,{nonce,allowedKinds:[KINDS.APP],maxPayloadBytes:MAX_OUTPUT,maxFrames:MAX_FRAMES,
    maxTotalBytes:64*1024*1024+MAX_FRAMES*HEADER,maxPendingMessages:32,maxPendingBytes:32*1024*1024,onFailure:fail});
  const send=message=>{
    if(failure)return;
    try{void writer.send(KINDS.APP,encodeJson(message,MAX_OUTPUT)).catch(fail);}catch(error){fail(error);}
  };
  const engine=new ParentModelEngine(send);assistant=new AssistantService(engine);
  const endpoint=createBackend({send,assistant,observing:createObserving(dataRoot),
    sky:new SkyQueries(createSky(join(workerRoot,'package/resources/catalogs'))),now,
    stop:()=>{endpointStopped=true;assistant.dispose();releaseStop();}});
  const reader=new FrameReader({nonce,allowedKinds:[KINDS.APP],maxPayloadBytes:MAX_INPUT,maxFrames:MAX_FRAMES,
    maxTotalBytes:4*1024*1024+MAX_FRAMES*HEADER});
  async function accept(record){
    if(shutdownAccepted)throw fault('Application message after shutdown.');
    const message=decodeJson(record.body);
    if(engine.receive(message)){lastParentMessage=now();return;}
    if(!endpoint.receive(message))throw fault('Backend rejected application message.');
    if(isInitialize(message)){
      session=message.session;engine.initialize(session);
      // createBackend already queued the actual ready; this receipt can never be first.
      send(await boundaries(workerRoot,session));
    }
    if(message.operation==='runtime.shutdown')shutdownAccepted=true;
    lastParentMessage=now();
  }
  input.on('data',chunk=>{
    input.pause();chain=chain.then(async()=>{
      if(failure)return;
      for(const record of reader.push(chunk))await accept(record);
      if(!failure&&!inputEnded)input.resume();
    }).catch(fail);
  });
  input.once('end',()=>{
    inputEnded=true;chain=chain.then(async()=>{
      if(failure)return;reader.finish();
      if(!shutdownAccepted)throw fault('Unexpected owner EOF.',67);
      await stopped;if(!endpointStopped)throw fault('Backend stop was not confirmed.');
      await writer.end();if(failure)return;clearInterval(heartbeat);complete();
    }).catch(fail);
  });
  input.once('error',fail);
  input.once('close',()=>{if(!inputEnded)fail(fault('Input closed without EOF.'));});
  heartbeat=setInterval(()=>{if(now()-lastParentMessage>10000)fail(fault('Owner heartbeat expired.',68));},1000);
  input.resume();return done;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==3||process.versions.node!=='24.22.2'||process.versions.electron||process.arch!=='x64'
    ||process.execArgv.join('|')!=='--preserve-symlinks|--preserve-symlinks-main'
    ||Object.keys(process.env).some(key=>/^(NODE_|ELECTRON_|UV_|OPENSSL_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/i.test(key)))process.exit(64);
  void runBackendWorker({workerRoot:args[0],dataRoot:args[1],nonce:args[2]}).then(()=>process.exit(0),error=>process.exit(error.exitCode??65));
}
