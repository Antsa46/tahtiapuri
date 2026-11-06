// Copies an already accepted worker package. Never runs a broker or worker.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_MARKER, NODE, sha256, canonicalDirectory, readStable, validateManifest,
  manifestBytes, generatePins, freshFile, verifyPackage } from './mcp-runtime-package.mjs';

export function validateWorkerSelection(build, digest) {
  assert(typeof build === 'string' && /^build-[a-f0-9]{32}$/.test(build), 'Invalid fixed worker build');
  assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'Invalid external worker digest');
  return Object.freeze({ build, digest });
}
export async function prepareNativeWorker({ projectRoot, buildRoot, workerBuild, expectedDigest }) {
  validateWorkerSelection(workerBuild, expectedDigest);
  projectRoot = await canonicalDirectory(projectRoot); buildRoot = await canonicalDirectory(buildRoot);
  const marker = await readStable(buildRoot, 'owner.marker', { maxBytes: 128 });
  assert.equal(marker.toString('utf8'), 'TAHTIAPURI_MCP_NATIVE_BUILD_V1\n', 'Missing native build ownership');
  const donor = join(projectRoot, '.artifacts/native/mcp-runtime/builds', workerBuild);
  await canonicalDirectory(donor);
  const originalMarker = await readStable(donor, 'owner.marker', { maxBytes: 128 });
  assert.equal(originalMarker.toString('utf8'), BUILD_MARKER, 'Unexpected worker build owner marker');
  const source = join(donor, 'package');
  const raw = await readStable(source, 'runtime-manifest.json', { maxBytes: 16384 });
  assert.equal(sha256(raw), expectedDigest, 'External worker manifest digest differs');
  const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  assert(raw.equals(manifestBytes(manifest)), 'Noncanonical worker manifest');
  await verifyPackage(source, manifest);
  const target = join(buildRoot, 'package');
  await fs.mkdir(target); // CREATE_NEW directory: never merge with an old package.
  for (const pin of manifest.files) {
    const bytes = await readStable(source, pin.path);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    await freshFile(target, pin.path, bytes);
  }
  await freshFile(target, 'runtime-manifest.json', raw);
  await verifyPackage(target, manifest);
  await verifyPackage(source, manifest);
  assert(raw.equals(await readStable(source, 'runtime-manifest.json', { maxBytes: 16384 })), 'Donor manifest changed');
  assert(originalMarker.equals(await readStable(donor, 'owner.marker', { maxBytes: 128 })), 'Donor marker changed');
  const header = Buffer.from(generatePins(manifest));
  await freshFile(buildRoot, 'mcp-runtime-pins.h', header);
  const result = { schema: 1, workerBuild, digest: expectedDigest, node: NODE,
    headerSha256: sha256(header), files: [...manifest.files,
      { path: 'runtime-manifest.json', bytes: raw.length, sha256: expectedDigest }] };
  await freshFile(buildRoot, 'prepared-worker.json', Buffer.from(JSON.stringify(result, null, 2) + '\n'));
  return result;
}

// Final build gate. Pin bytes are supplied by the trusted compiler owner via a
// separately hashed candidate file; a directory's own declarations are not trust.
export async function verifyNativeOutput({buildRoot,expectedDigest,binaryPinsDigest}) {
  assert(typeof expectedDigest==='string'&&/^[a-f0-9]{64}$/.test(expectedDigest),'Invalid external worker digest');
  assert(typeof binaryPinsDigest==='string'&&/^[a-f0-9]{64}$/.test(binaryPinsDigest),'Invalid external binary digest');
  buildRoot=await canonicalDirectory(buildRoot);
  assert.equal((await readStable(buildRoot,'owner.marker',{maxBytes:128})).toString('utf8'),'TAHTIAPURI_MCP_NATIVE_BUILD_V1\n');
  const rawPins=await readStable(buildRoot,'binary-pins.json',{maxBytes:16384});
  assert.equal(sha256(rawPins),binaryPinsDigest,'Binary candidate changed');
  const pins=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawPins));
  const names=['bin/mcp-broker.exe','helpers/main-bootstrap.exe','helpers/main-identity.exe'];
  assert(pins&&typeof pins==='object'&&!Array.isArray(pins));
  assert.deepEqual(Object.keys(pins).sort(),names);
  for(const directory of ['bin','helpers']){
    await canonicalDirectory(join(buildRoot,directory));const found=[];
    for await(const item of await fs.opendir(join(buildRoot,directory),{bufferSize:1})){
      assert(found.length<3,'Binary directory count bound');found.push(directory+'/'+item.name);
    }
    assert.deepEqual(found.sort(),names.filter(name=>name.startsWith(directory+'/')),'Binary directory boundary differs');
  }
  for(const name of names){
    const pin=pins[name];
    assert(pin&&typeof pin==='object'&&!Array.isArray(pin));
    assert.deepEqual(Object.keys(pin).sort(),['bytes','sha256']);
    assert(Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=4194304);
    assert(typeof pin.sha256==='string'&&/^[a-f0-9]{64}$/.test(pin.sha256));
    const bytes=await readStable(buildRoot,name,{maxBytes:4194304});
    assert.equal(bytes.length,pin.bytes,'Final binary length differs');assert.equal(sha256(bytes),pin.sha256,'Final binary hash differs');
  }
  const packageRoot=join(buildRoot,'package');
  const raw=await readStable(packageRoot,'runtime-manifest.json',{maxBytes:16384});
  assert.equal(sha256(raw),expectedDigest,'Final worker digest differs');
  const manifest=validateManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
  assert(raw.equals(manifestBytes(manifest)),'Noncanonical final worker manifest');
  await verifyPackage(packageRoot,manifest); // includes single-link file checks
  const header=await readStable(buildRoot,'mcp-runtime-pins.h',{maxBytes:16384});
  assert(header.equals(Buffer.from(generatePins(manifest))),'Final generated worker pins differ');
  assert(rawPins.equals(await readStable(buildRoot,'binary-pins.json',{maxBytes:16384})),'Binary candidate changed');
  return Object.freeze({verified:true,digest:expectedDigest,binaryPinsDigest,headerSha256:sha256(header)});
}

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  try {
    if(process.argv.length===8&&process.argv[2]==='--verify-build-root'&&process.argv[4]==='--worker-digest'&&process.argv[6]==='--binary-pins-digest'){
      process.stdout.write(JSON.stringify(await verifyNativeOutput({buildRoot:process.argv[3],expectedDigest:process.argv[5],binaryPinsDigest:process.argv[7]}))+'\n');
    }else{
    assert(process.argv.length === 8 && process.argv[2] === '--build-root' &&
      process.argv[4] === '--worker-build' && process.argv[6] === '--worker-digest', 'Invalid native preparation arguments');
    const result = await prepareNativeWorker({ projectRoot: resolve(dirname(ownPath), '../..'),
      buildRoot: process.argv[3], workerBuild: process.argv[5], expectedDigest: process.argv[7] });
    process.stdout.write(JSON.stringify({ prepared: true, digest: result.digest, headerSha256: result.headerSha256 }) + '\n');
    }
  } catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
}
