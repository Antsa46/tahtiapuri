// Fixed, synthetic Node endpoint. It never spawns children or opens a network.
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {Reader,encode,utf8,MAX_BYTES,MAX_FRAMES} from './node-stdio-wire.mjs';
const [root,kind,sessionText]=process.argv.slice(2);
const cases=['normal','fail','owner-loss','owner-early','stalled-reader','startup-fail','invalid-utf8'];
if(!root||!cases.includes(kind)||!/^[a-f0-9]{64}$/.test(sessionText??'')||process.execArgv.join('|')!=='--preserve-symlinks|--preserve-symlinks-main'||process.versions.node!=='24.22.2'||process.versions.electron||process.arch!=='x64')process.exit(64);
if(Object.keys(process.env).some(k=>/^(NODE_|ELECTRON_|UV_|OPENSSL_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/i.test(k)))process.exit(64);
if(kind==='startup-fail')process.exit(19);
const session=Buffer.from(sessionText,'hex'),reader=new Reader(session);let hello=false,closing=false,terminalId=0,stalled=false,chain=Promise.resolve(),outBytes=0,outFrames=0;
const keep=setInterval(()=>{},1000);
async function send(op,id,value=Buffer.alloc(0)){
  const b=encode(op,id,session,value);outBytes+=b.length;if(outBytes>MAX_BYTES||++outFrames>MAX_FRAMES)throw new Error('output-budget');
  await new Promise((resolve,reject)=>process.stdout.write(b,e=>e?reject(e):resolve()));
}
async function policy(){const operations=[];
  for(const [name,action] of [
    ['package-read',async()=>{if(await fs.readFile(join(root,'package/allowed.txt'),'utf8')!=='SYNTHETIC ALLOWED\n')throw new Error('fixture');}],
    ['scratch-write',()=>fs.writeFile(join(root,'scratch/written.txt'),'synthetic',{flag:'wx'})],
    ['private-read',()=>fs.readFile(join(root,'private/secret.txt'))],
    ['private-write',()=>fs.writeFile(join(root,'private/written.txt'),'synthetic',{flag:'wx'})],
    ['code-write',async()=>{const f=await fs.open(join(root,'package/code.txt'),'r+');try{await f.write('X');}finally{await f.close();}}],
    ['aap-read',()=>fs.readFile(join(root,'aap/read.txt'))]
  ]){try{await action();operations.push({name,ok:true});}catch(e){operations.push({name,ok:false,code:e.code??'UNEXPECTED'});}}
  return Buffer.from(JSON.stringify({node:process.versions.node,pid:process.pid,execArgv:process.execArgv,operations}));
}
async function handle(f){
  if(closing||stalled)throw new Error('order');
  if(!hello){if(f.op!==1||f.id!==1||f.body.length)throw new Error('hello');hello=true;await send(129,f.id,await policy());return;}
  if(f.op===2){utf8(f.body);await send(130,f.id,f.body);}
  else if(f.op===6&&f.body.length===0){reader.finish();closing=true;terminalId=f.id;}
  else if(f.op===10&&kind==='fail'&&f.body.length===0){process.stderr.write('SYNTHETIC JS FAILURE\n',()=>process.exit(17));}
  else if(f.op===7&&kind==='stalled-reader'&&f.body.length===0){stalled=true;process.stdin.pause();await send(131,f.id);}
  else throw new Error('operation');
}
// This branch never initializes process.stdin or starts an OS pipe read.
if(kind==='stalled-reader'){await send(129,1,await policy());await send(131,2);}
else {
process.stdin.on('data',chunk=>{process.stdin.pause();chain=chain.then(async()=>{const frames=reader.push(chunk);for(let i=0;i<frames.length;i++){if(frames[i].op===6&&i!==frames.length-1)throw new Error('terminal-tail');await handle(frames[i]);}if(!stalled)process.stdin.resume();}).catch(()=>process.exit(65));});
process.stdin.on('end',()=>{chain=chain.then(async()=>{reader.finish();if(!closing)process.exit(67);await send(134,terminalId);clearInterval(keep);process.exitCode=0;}).catch(()=>process.exit(65));});
process.stdin.on('error',()=>process.exit(65));process.stdout.on('error',()=>process.exit(65));

}
