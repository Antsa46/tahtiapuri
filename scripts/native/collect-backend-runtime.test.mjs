import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { NODE, RUNTIME_PATHS, safeRelativePath, validateRuntimeManifest, runtimeManifestBytes,
  runtimePackageDigest, generateRuntimePins, verifyStagedPackage, createBuildRoot } from './collect-backend-runtime.mjs';

const fakeHash = 'a'.repeat(64);
const manifest = () => ({ schema: 1, protocol: 2, node: { ...NODE },
  files: RUNTIME_PATHS.map(path => ({ path, sha256: path === 'node.exe' ? NODE.executableSha256 : fakeHash, bytes: 1 })) });
const clone = value => JSON.parse(JSON.stringify(value));

test('closed runtime contains production entry/transport/resources and no probe, SDK or model worker', () => {
  const files = RUNTIME_PATHS;
  for (const path of ['backend/dist/runtime/stdio-backend.js', 'node_modules/@tahtiapuri/backend-transport/dist/index.js',
    'node_modules/@tahtiapuri/backend-transport/package.json', 'node_modules/@tahtiapuri/validation/dist/development-framing.js',
    'resources/catalogs/stars.json', 'resources/catalogs/manifest.json', 'licenses/node-LICENSE.txt']) assert(files.includes(path));
  for (const path of files) assert(!/(?:tests\/|probe|backend-worker|backend-codec|allowed\.txt|code\.txt|node-llama-cpp|model-worker|native-engine|private\/|aap\/)/.test(path));
  assert(!files.includes('runtime-manifest.json'));
  assert.deepEqual(validateRuntimeManifest(manifest()).files.map(file => file.path), files);
});

test('closed metadata rejects missing, duplicate, reordered and extra files', () => {
  const missing = manifest(); missing.files.pop(); assert.throws(() => validateRuntimeManifest(missing));
  const duplicate = manifest(); duplicate.files[1] = { ...duplicate.files[0] }; assert.throws(() => validateRuntimeManifest(duplicate));
  const reordered = manifest(); [reordered.files[0], reordered.files[1]] = [reordered.files[1], reordered.files[0]]; assert.throws(() => validateRuntimeManifest(reordered));
  const extra = manifest(); extra.files.push({ path: 'extra.js', sha256: fakeHash, bytes: 1 }); assert.throws(() => validateRuntimeManifest(extra));
  const unknownField = manifest(); unknownField.files[0].source = 'arbitrary/path'; assert.throws(() => validateRuntimeManifest(unknownField));
  const selfPin = manifest(); selfPin.files[0].path = 'runtime-manifest.json'; assert.throws(() => validateRuntimeManifest(selfPin));
});

test('Windows path aliases, escapes, reserved devices and noncanonical components are forbidden', () => {
  for (const path of ['', '/root', 'C:/root', '../escape', 'a/../b', 'a\\b', 'a//b', 'a/./b', 'a/.', 'a/trailing.', 'AUX', 'folder/COM1.js', 'a\0b', 'a\nb'])
    assert.throws(() => safeRelativePath(path), path);
  assert.equal(safeRelativePath('node_modules/@tahtiapuri/backend-transport/package.json'), 'node_modules/@tahtiapuri/backend-transport/package.json');
});

test('manifest enforces protocol, pinned Node provenance and bounded hash/size fields', () => {
  const changes = [value => { value.protocol = 1; }, value => { value.schema = 2; },
    value => { value.node.version = '24.22.3'; }, value => { value.node.archiveSha256 = fakeHash; },
    value => { value.files.find(file => file.path === 'node.exe').sha256 = fakeHash; },
    value => { value.files[0].bytes = 0; }, value => { value.files[0].bytes = 167772161; },
    value => { value.files[0].bytes = 1.5; }, value => { value.files[0].sha256 = 'A'.repeat(64); },
    value => { value.unexpected = true; }];
  for (const change of changes) { const value = manifest(); change(value); assert.throws(() => validateRuntimeManifest(value)); }
});

test('canonical UTF-8 manifest digest binds metadata and appends its own pin only in C++', () => {
  const value = manifest(), bytes = runtimeManifestBytes(value), digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(runtimePackageDigest(value), digest);
  assert.equal(bytes.at(-1), 10);
  assert.deepEqual(JSON.parse(bytes), value);
  assert.equal(runtimePackageDigest(clone(value)), digest);
  const changed = clone(value); changed.files[0].bytes++; assert.notEqual(runtimePackageDigest(changed), digest);
  const header = generateRuntimePins(value);
  assert(header.includes('namespace backend_runtime {'));
  assert(header.includes('struct RuntimePin { const wchar_t* path; const char* sha256; uint64_t bytes; };'));
  assert(header.includes('inline constexpr RuntimePin runtimePins[]'));
  assert(header.includes(`{L"runtime-manifest.json", "${digest}", ${bytes.length}ULL}`));
  assert(header.includes(`inline constexpr char runtimePackageDigest[] = "${digest}";`));
  assert.equal((header.match(/\{L"/g) ?? []).length, value.files.length + 1);
  const frozen = validateRuntimeManifest(value); assert(Object.isFrozen(frozen.files[0]));
  value.files[0].bytes = 2; assert.equal(frozen.files[0].bytes, 1);
});

async function fixture(t) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const parent = join(project, '.artifacts/tests/backend-runtime-collector');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('staged package refuses a hardlinked expected resource before reading it', async t => {
  const root = await fixture(t), packageRoot = join(root, 'package'), first = RUNTIME_PATHS[0], path = join(packageRoot, ...first.split('/'));
  await fs.mkdir(dirname(path), { recursive: true });
  const external = join(root, 'original'); await fs.writeFile(external, 'x'); await fs.link(external, path);
  await assert.rejects(verifyStagedPackage(packageRoot, manifest()), /single-link/);
});

test('staged package rejects a changed expected resource by hash', async t => {
  const root = await fixture(t);
  for (const file of RUNTIME_PATHS) { const path = join(root, ...file.split('/')); await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'x'); }
  await fs.writeFile(join(root, 'runtime-manifest.json'), runtimeManifestBytes(manifest()));
  await assert.rejects(verifyStagedPackage(root, manifest()), /Staged resource differs/);
});

test('staged package refuses a symlink ancestor', async t => {
  const root = await fixture(t), target = join(root, 'target'), linked = join(root, 'linked');
  await fs.mkdir(target); await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyStagedPackage(linked, manifest()), /Linked|Noncanonical/);
});

test('build root cannot be chosen outside the private build subtree', async () => {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  await assert.rejects(createBuildRoot(project, join(project, '.artifacts/tests/build-' + 'a'.repeat(32))), /fixed private root/);
  await assert.rejects(createBuildRoot(project, join(project, '.artifacts/native/backend-runtime/builds/old-build')), /Invalid build directory/);
});


test('closed staged tree rejects extra files/directories and missing files before hashing', async t => {
  const root = await fixture(t);
  await fs.writeFile(join(root, 'extra.js'), 'x');
  await assert.rejects(verifyStagedPackage(root, manifest()), /Extra/);
  await fs.unlink(join(root, 'extra.js')); await fs.mkdir(join(root, 'unexpected'));
  await assert.rejects(verifyStagedPackage(root, manifest()), /Extra staged directory/);
  await fs.rmdir(join(root, 'unexpected'));
  await assert.rejects(verifyStagedPackage(root, manifest()), /Missing staged resource/);
});


test('Windows cannot create a build root with POSIX mode bits instead of the protected ACL', { skip: process.platform !== 'win32' }, async () => {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const requested = join(project, '.artifacts/native/backend-runtime/builds/build-' + 'b'.repeat(32));
  await assert.rejects(createBuildRoot(project, requested), /protected-ACL PowerShell builder/);
});
