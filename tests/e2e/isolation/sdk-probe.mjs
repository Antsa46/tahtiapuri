import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { observeSdkChild } from './sdk-child-observer.mjs';
const root = process.argv[2], life = process.argv[8];
assert(root && ['once','hold','missing-binary'].includes(life));
const emit = row => process.stdout.write(`${JSON.stringify(row)}\n`);
const profile = JSON.parse(await fs.readFile(join(root, 'package/sdk-profile.json'), 'utf8'));
assert.equal(profile.version, '3.22.2'); assert(/^[a-f0-9]{32}$/.test(profile.nonce));
const sdkRoot = join(root, 'package/node_modules/node-llama-cpp');
const helper = join(sdkRoot, 'dist/bindings/utils/testBindingBinary.js');
const binding = join(root, 'package/node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node');
async function hash(file) { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
let llama, observer; let phase = 'integrity';
try {
  assert.equal(await hash(helper), profile.helperSha256); assert.equal(await hash(binding), profile.bindingSha256);
  emit({ type: 'sdk-phase', phase, passed: true });
  phase = 'electron-resolution'; const resolvedElectron = import.meta.resolve('electron'); assert.equal(resolvedElectron, 'electron:electron', 'Only the Electron ESM builtin is allowed; npm installer wrappers are excluded.');
  emit({ type: 'sdk-phase', phase, passed: true, resolved: resolvedElectron, electron: process.versions.electron, node: process.versions.node, uv: process.versions.uv }); phase = 'import';
  const { getLlama, getModuleVersion } = await import('node-llama-cpp');
  phase = 'import-contract'; assert.equal(await getModuleVersion(), profile.version); emit({ type: 'sdk-phase', phase: 'import', passed: true });
  phase = 'public-cpu';
  llama = await getLlama({ gpu: false, build: 'never', skipDownload: true, usePrebuiltBinaries: true, progressLogs: false, logLevel: 'error', maxThreads: 2, tempDir: join(root, 'scratch/sdk') });
  phase = 'public-cpu-contract'; assert.equal(llama.gpu, false); assert.equal(llama.buildType, 'prebuilt');
  emit({ type: 'sdk-phase', phase: 'public-cpu', passed: true, gpu: llama.gpu, buildType: llama.buildType });
  phase = 'public-dispose'; emit({ type: 'sdk-phase', phase, started: true }); await llama.dispose(); llama = undefined; emit({ type: 'sdk-phase', phase, passed: true });
  phase = 'instrumentation-setup'; emit({ type: 'sdk-phase', phase, started: true });
  observer = observeSdkChild({ helper, preload: join(root, 'package/child-policy-preload.cjs'), nonce: profile.nonce, emit, hold: life === 'hold' });
  emit({ type: 'sdk-phase', phase, passed: true }); phase = 'helper-import'; emit({ type: 'sdk-phase', phase, started: true });
  const { testBindingBinary } = await import(pathToFileURL(helper).href); emit({ type: 'sdk-phase', phase, passed: true });
  phase = 'instrumented-binary-test'; emit({ type: 'sdk-phase', phase, started: true });
  const result = await testBindingBinary(life === 'missing-binary' ? join(root, 'package/missing-addon.node') : binding, undefined, false, 12000, false);
  assert(Number.isSafeInteger(observer.pid));
  if (life === 'missing-binary') {
    assert.equal(result, false); emit({ type: 'sdk-expected-failure', phase, reason: 'missing-native-binary' }); process.exitCode = 17;
  } else if (result === false) { emit({ type: 'sdk-error', phase, name: 'BinaryTestFailure', code: 'BINARY_TEST_FAILED', message: 'Original SDK binary test returned false.' }); process.exitCode = 1; }
  else { assert.equal(result, true); emit({ type: 'sdk-phase', phase, passed: true }); emit({ type: 'sdk-ready' }); }
} catch (error) {
  emit({ type: 'sdk-error', phase, name: error.name, code: error.code ?? null, message: String(error.message).slice(0,4096) }); process.exitCode = 1;
} finally { observer?.close(); process.stdin.destroy(); await llama?.dispose(); }
