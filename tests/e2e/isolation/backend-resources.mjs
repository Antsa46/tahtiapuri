import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {promises as fs, constants} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';

export const CASE_MARKER='TAHTIAPURI_BACKEND_CASE';
export const WORKER_MARKER='TAHTIAPURI_BACKEND_PROBE';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const astro='node_modules/.pnpm/astronomy-engine@2.1.19/node_modules/astronomy-engine';
const backend=[
  'composition/create-backend','composition/create-observing','composition/create-sky','ipc/endpoint',
  'modules/assistant/adapters/parent-model-engine','modules/assistant/application/assistant-service',
  'modules/development/application/development-service','modules/observing/adapters/json-places-repository',
  'modules/observing/application/places-service','modules/observing/ports/places-repository',
  'modules/runtime/application/get-runtime-status','modules/sky/adapters/astronomy-calculator',
  'modules/sky/adapters/local-star-catalog','modules/sky/application/sky-queries','modules/sky/application/sky-service',
];
const domain=['index','observing/places','sky/horizon','sky/time','sky/types'];
const validation=['assistant','backend-protocol','development','model-wire','observing','public-api','sky'];
const generated={
  'package.json':'{"type":"module","private":true}',
  'allowed.txt':'SYNTHETIC ALLOWED\n',
  'code.txt':'SYNTHETIC CODE\n',
};
const fixedFiles=[
  ...backend.map(name=>[`backend/dist/${name}.js`,`apps/backend/dist/${name}.js`]),
  ...domain.map(name=>[`node_modules/@tahtiapuri/domain/dist/${name}.js`,`packages/domain/dist/${name}.js`]),
  ...validation.map(name=>[`node_modules/@tahtiapuri/validation/dist/${name}.js`,`packages/validation/dist/${name}.js`]),
  ...['domain','validation'].map(name=>[`node_modules/@tahtiapuri/${name}/package.json`,`packages/${name}/package.json`]),
  ...['package.json','esm/astronomy.js'].map(name=>[`node_modules/astronomy-engine/${name}`,`${astro}/${name}`]),
  ...['manifest.json','stars.json'].map(name=>[`resources/catalogs/${name}`,`resources/catalogs/${name}`]),
  ...['backend-worker.mjs','backend-codec.mjs'].map(name=>[name,`tests/e2e/isolation/${name}`]),
];
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

export function safeRelativePath(path){
  assert.equal(typeof path,'string');
  assert(path.length>0&&path.length<512&&!path.includes('\\')&&!path.includes(':')&&!path.startsWith('/')&&!/[\x00-\x1f\x7f]/.test(path),'Unsafe relative path');
  assert(path.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Unsafe path segment');
  return path;
}

async function safePath(root,path,{file=false,allowHardlinks=false}={}){
  safeRelativePath(path);
  let current=resolve(root);
  for(const part of path.split('/')){
    current=join(current,part);
    const stat=await fs.lstat(current);
    assert(!stat.isSymbolicLink(),'Link in resource path');
    if(current!==join(resolve(root),...path.split('/')))assert(stat.isDirectory(),'Resource ancestor is not a directory');
    else if(file){assert(stat.isFile(),'Resource is not a regular file');assert(allowHardlinks||stat.nlink===1,'Unexpected hard link');}
  }
  return current;
}

async function readSource(projectRoot,source){
  const allowHardlinks=source===`${astro}/package.json`||source===`${astro}/esm/astronomy.js`;
  const path=await safePath(projectRoot,source,{file:true,allowHardlinks});
  const handle=await fs.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const before=await handle.stat();assert(before.isFile()&&(allowHardlinks||before.nlink===1));
    const bytes=await handle.readFile();const after=await handle.stat();
    assert.equal(before.ino,after.ino);assert.equal(before.dev,after.dev);assert.equal(before.size,after.size);assert.equal(before.mtimeMs,after.mtimeMs);assert.equal(bytes.length,after.size);
    return bytes;
  }finally{await handle.close();}
}

export async function collectBackendPins(projectRoot){
  projectRoot=resolve(projectRoot);
  const tools=JSON.parse((await readSource(projectRoot,'scripts/dev/toolchain.json')).toString('utf8'));
  assert.equal(tools.node.version,'24.22.2');
  assert.equal(tools.node.sha256,'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2');
  const declared=[...fixedFiles,['node.exe',`.local/toolchain/node-v${tools.node.version}-win-x64/node.exe`]];
  const files=[];
  for(const [path,source]of declared){const bytes=await readSource(projectRoot,source);files.push({path,source,bytes:bytes.length,sha256:digest(bytes)});}
  for(const [path,content]of Object.entries(generated)){const bytes=Buffer.from(content);files.push({path,source:null,bytes:bytes.length,sha256:digest(bytes),content});}
  files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return freeze({schema:1,nodeSha256:files.find(file=>file.path==='node.exe').sha256,archiveSha256:tools.node.sha256,files});
}

export async function verifyBackendManifest(projectRoot,manifest){
  const actual=await collectBackendPins(projectRoot);
  assert.deepEqual(manifest,actual,'Backend resource manifest differs from fixed current inputs');
  return actual;
}

async function freshFile(path,bytes){
  await fs.mkdir(dirname(path),{recursive:true});
  const handle=await fs.open(path,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  assert.equal((await fs.lstat(path)).nlink,1);
}

export async function verifyStagedPackage(packageRoot,manifest){
  assert.equal(manifest.schema,1);assert(Array.isArray(manifest.files)&&manifest.files.length>0&&manifest.files.length<=64);
  const expected=new Set(),dirs=new Set(['']);
  for(const file of manifest.files){
    safeRelativePath(file.path);assert(!expected.has(file.path),'Duplicate package path');expected.add(file.path);
    let parent=dirname(file.path);while(parent!=='.'){dirs.add(parent.split(sep).join('/'));parent=dirname(parent);}
    assert(Number.isSafeInteger(file.bytes)&&file.bytes>=0&&/^[a-f0-9]{64}$/.test(file.sha256));
    const path=await safePath(packageRoot,file.path,{file:true}),bytes=await fs.readFile(path);
    assert.equal(bytes.length,file.bytes,'Staged byte count changed');assert.equal(digest(bytes),file.sha256,'Staged hash changed');
  }
  async function walk(directory,rel=''){
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const path=rel?`${rel}/${entry.name}`:entry.name,info=await fs.lstat(join(directory,entry.name));
      assert(!info.isSymbolicLink(),'Staged link');
      if(info.isDirectory()){assert(dirs.has(path),'Unexpected staged directory');await walk(join(directory,entry.name),path);}
      else assert(info.isFile()&&info.nlink===1&&expected.has(path),'Unexpected staged file');
    }
  }
  await walk(packageRoot);
}

export async function stageBackendPackage({projectRoot,packageRoot,manifest}){
  manifest=await verifyBackendManifest(projectRoot,manifest);
  await fs.mkdir(packageRoot);
  for(const file of manifest.files){
    const bytes=file.source===null?Buffer.from(file.content):await readSource(projectRoot,file.source);
    assert.equal(bytes.length,file.bytes);assert.equal(digest(bytes),file.sha256,'Resource changed while staging');
    await freshFile(join(packageRoot,...file.path.split('/')),bytes);
  }
  await verifyStagedPackage(packageRoot,manifest);
}

export async function verifyDataTree(dataRoot){
  let nodes=0;
  async function visit(path,depth){
    assert(depth<=8&&++nodes<=128,'Synthetic data tree exceeds bounds');
    const stat=await fs.lstat(path);assert(!stat.isSymbolicLink(),'Synthetic data link');
    if(stat.isDirectory()){
      const directory=await fs.opendir(path,{bufferSize:1});
      try{let entry;while((entry=await directory.read())!==null)await visit(join(path,entry.name),depth+1);}
      finally{await directory.close();}
    }
    else assert(stat.isFile()&&stat.nlink===1,'Synthetic data is not a single regular file');
  }
  await visit(dataRoot,0);
}

async function verifyCaseRootAnchor(caseRoot){
  const stat=await fs.lstat(caseRoot);
  assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Case root must be a regular directory without links');
  assert.equal(relative(caseRoot,await fs.realpath(caseRoot)),'','Case root is not its canonical directory');
}

export async function prepareBackendResources({projectRoot,caseRoot,manifest,hostPath,hostSha256}){
  projectRoot=resolve(projectRoot);caseRoot=resolve(caseRoot);
  const artifactRoot=join(projectRoot,'.artifacts','tests');
  const rel=relative(artifactRoot,caseRoot);assert(rel&&!rel.startsWith('..')&&!resolve(caseRoot).startsWith('\\\\'),'Case root must stay under private test artifacts');
  assert(/^case-[a-f0-9]{32}$/.test(caseRoot.split(sep).at(-1)),'Invalid case root');
  await safePath(projectRoot,relative(projectRoot,dirname(caseRoot)).split(sep).join('/'));
  let existing=false;
  try{await verifyCaseRootAnchor(caseRoot);existing=true;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  manifest=await verifyBackendManifest(projectRoot,manifest);
  if(!existing){
    await fs.mkdir(caseRoot);
    await verifyCaseRootAnchor(caseRoot);
    await freshFile(join(caseRoot,'owner.marker'),Buffer.from(CASE_MARKER));await fs.mkdir(join(caseRoot,'data'));
  }else{
    await verifyCaseRootAnchor(caseRoot);
    const marker=await safePath(caseRoot,'owner.marker',{file:true});assert.equal(await fs.readFile(marker,'utf8'),CASE_MARKER);
    assert.deepEqual((await fs.readdir(caseRoot)).sort(),['data','owner.marker'],'Previous worker is still present');
  }
  await verifyDataTree(join(caseRoot,'data'));
  const id=randomBytes(16).toString('hex'),workerRoot=join(caseRoot,`worker-${id}`);
  await fs.mkdir(workerRoot);await freshFile(join(workerRoot,'owner.marker'),Buffer.from(WORKER_MARKER));
  for(const directory of ['launcher','scratch','private','aap'])await fs.mkdir(join(workerRoot,directory));
  await stageBackendPackage({projectRoot,packageRoot:join(workerRoot,'package'),manifest});
  await freshFile(join(workerRoot,'private/secret.txt'),Buffer.from('SYNTHETIC PRIVATE\n'));
  await freshFile(join(workerRoot,'aap/read.txt'),Buffer.from('SYNTHETIC AAP\n'));
  const sourceRel=relative(projectRoot,resolve(hostPath)).split(sep).join('/');
  const host=await readSource(projectRoot,sourceRel);assert.equal(digest(host),hostSha256,'Native host changed');
  const stagedHost=join(workerRoot,'launcher/backend-probe-host.exe');await freshFile(stagedHost,host);
  return freeze({caseRoot,workerRoot,dataRoot:join(caseRoot,'data'),packageRoot:join(workerRoot,'package'),hostPath:stagedHost,profile:`tahtiapuri.backend.${id}`,ownerNonce:randomBytes(32).toString('hex')});
}
