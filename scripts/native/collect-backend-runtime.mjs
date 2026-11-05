import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE = Object.freeze({ version: '24.22.2', archive: 'node-v24.22.2-win-x64.zip',
  archiveSha256: 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
  executableSha256: '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9' });
export const BUILD_MARKER = 'TAHTIAPURI_BACKEND_BUILD_V1\n';
const astro = 'node_modules/.pnpm/astronomy-engine@2.1.19/node_modules/astronomy-engine';
const backend = ['runtime/stdio-backend', 'composition/create-backend', 'composition/create-observing', 'composition/create-sky', 'ipc/endpoint',
  'modules/assistant/adapters/parent-model-engine', 'modules/assistant/application/assistant-service',
  'modules/development/application/development-service', 'modules/observing/adapters/json-places-repository',
  'modules/observing/application/places-service', 'modules/observing/ports/places-repository',
  'modules/runtime/application/get-runtime-status', 'modules/sky/adapters/astronomy-calculator',
  'modules/sky/adapters/local-star-catalog', 'modules/sky/application/sky-queries', 'modules/sky/application/sky-service'];
const domain = ['index', 'observing/places', 'sky/horizon', 'sky/time', 'sky/types'];
const validation = ['assistant', 'backend-protocol', 'development', 'development-framing', 'model-wire', 'observing', 'public-api', 'sky'];
const fixed = [
  ...backend.map(name => [`backend/dist/${name}.js`, `apps/backend/dist/${name}.js`]),
  ...domain.map(name => [`node_modules/@tahtiapuri/domain/dist/${name}.js`, `packages/domain/dist/${name}.js`]),
  ...validation.map(name => [`node_modules/@tahtiapuri/validation/dist/${name}.js`, `packages/validation/dist/${name}.js`]),
  ['node_modules/@tahtiapuri/backend-transport/dist/index.js', 'packages/backend-transport/dist/index.js'],
  ...['domain', 'validation', 'backend-transport'].map(name => [`node_modules/@tahtiapuri/${name}/package.json`, `packages/${name}/package.json`]),
  ...['package.json', 'esm/astronomy.js'].map(name => [`node_modules/astronomy-engine/${name}`, `${astro}/${name}`]),
  ...['manifest.json', 'stars.json'].map(name => [`resources/catalogs/${name}`, `resources/catalogs/${name}`]),
  ['node.exe', '.local/toolchain/node-v24.22.2-win-x64/node.exe'],
  ['licenses/node-LICENSE.txt', '.local/toolchain/node-v24.22.2-win-x64/LICENSE'],
];
const generated = { 'package.json': '{"type":"module","private":true}\n' };
export const RUNTIME_PATHS = Object.freeze([...fixed.map(([path]) => path), ...Object.keys(generated)].sort());
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const exactKeys = (value, keys) => { assert(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected metadata fields'); };

export function safeRelativePath(path) {
  assert.equal(typeof path, 'string');
  assert(path.length > 0 && path.length <= 240 && /^[A-Za-z0-9@_.\/-]+$/.test(path), 'Unsafe package path');
  assert(path.split('/').every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe path component');
  return path;
}

/** Canonical ancestors are checked up to the volume root, including the supplied root. */
async function canonicalDirectory(path) {
  path = resolve(path); assert(!path.startsWith('\\\\') && !path.startsWith('//'), 'Network path forbidden');
  let current = path;
  while (true) {
    const stat = await fs.lstat(current);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Linked or non-directory ancestor');
    assert.equal(resolve(await fs.realpath(current)), current, 'Noncanonical ancestor');
    const parent = dirname(current); if (current === parent) break; current = parent;
  }
  return path;
}
async function safePath(root, path, { file = false, allowHardlinks = false } = {}) {
  safeRelativePath(path); root = await canonicalDirectory(root);
  let current = root; const components = path.split('/');
  for (let i = 0; i < components.length; ++i) {
    current = join(current, components[i]); const stat = await fs.lstat(current);
    assert(!stat.isSymbolicLink(), 'Linked resource');
    assert.equal(resolve(await fs.realpath(current)), current, 'Redirected resource');
    if (i < components.length - 1 || !file) assert(stat.isDirectory(), 'Resource ancestor must be a directory');
    else assert(stat.isFile() && (allowHardlinks || stat.nlink === 1), 'Resource must be a regular single-link file');
  }
  return current;
}
async function readSource(projectRoot, source) {
  const allowHardlinks = source === `${astro}/package.json` || source === `${astro}/esm/astronomy.js`;
  const path = await safePath(projectRoot, source, { file: true, allowHardlinks });
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    assert(before.isFile() && (allowHardlinks || before.nlink === 1) && before.size <= 167772160, 'Invalid source file');
    const bytes = await handle.readFile(), after = await handle.stat();
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink']) assert.equal(after[key], before[key], 'Source changed while reading');
    const named = await fs.lstat(await safePath(projectRoot, source, { file: true, allowHardlinks }));
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink']) assert.equal(named[key], after[key], 'Source path changed while reading');
    assert.equal(bytes.length, after.size); return bytes;
  } finally { await handle.close(); }
}

/** Pure metadata validation: the file set and Node provenance are closed constants. */
export function validateRuntimeManifest(manifest) {
  exactKeys(manifest, ['schema', 'protocol', 'node', 'files']);
  assert.equal(manifest.schema, 1); assert.equal(manifest.protocol, 2); assert.deepEqual(manifest.node, NODE);
  assert(Array.isArray(manifest.files) && manifest.files.length === RUNTIME_PATHS.length, 'Runtime file count differs');
  const seen = new Set();
  for (const file of manifest.files) {
    exactKeys(file, ['path', 'sha256', 'bytes']); safeRelativePath(file.path);
    const folded = file.path.toLowerCase(); assert(!seen.has(folded), 'Duplicate runtime path'); seen.add(folded);
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 167772160, 'Invalid runtime length');
    assert(/^[a-f0-9]{64}$/.test(file.sha256), 'Invalid runtime digest');
  }
  assert.deepEqual(manifest.files.map(file => file.path), RUNTIME_PATHS, 'Runtime files must match the sorted fixed closure');
  assert.equal(manifest.files.find(file => file.path === 'node.exe').sha256, NODE.executableSha256, 'Pinned Node differs');
  // Return a fresh canonical value: callers cannot alter ordering or inject JSON fields.
  return freeze({ schema: 1, protocol: 2, node: { ...NODE }, files: manifest.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) });
}
export function runtimeManifestBytes(manifest) { return Buffer.from(`${JSON.stringify(validateRuntimeManifest(manifest), null, 2)}\n`, 'utf8'); }
export function runtimePackageDigest(manifest) { return sha256(runtimeManifestBytes(manifest)); }
export function generateRuntimePins(manifest) {
  const value = validateRuntimeManifest(manifest), bytes = runtimeManifestBytes(value), digest = sha256(bytes);
  const pins = [...value.files, { path: 'runtime-manifest.json', sha256: digest, bytes: bytes.length }];
  return ['#pragma once', '#include <cstdint>', 'namespace backend_runtime {',
    'struct RuntimePin { const wchar_t* path; const char* sha256; uint64_t bytes; };',
    'inline constexpr RuntimePin runtimePins[] = {',
    ...pins.map(pin => `    {L"${pin.path}", "${pin.sha256}", ${pin.bytes}ULL},`), '};',
    `inline constexpr char runtimePackageDigest[] = "${digest}";`, '}', ''].join('\n');
}

export async function collectBackendRuntime(projectRoot) {
  projectRoot = await canonicalDirectory(projectRoot);
  const tools = JSON.parse((await readSource(projectRoot, 'scripts/dev/toolchain.json')).toString('utf8'));
  assert.equal(tools.node.version, NODE.version); assert.equal(tools.node.archive, NODE.archive); assert.equal(tools.node.sha256, NODE.archiveSha256);
  const archive = await readSource(projectRoot, `.local/cache/downloads/${NODE.archive}`);
  assert.equal(sha256(archive), NODE.archiveSha256, 'Official archive digest differs');
  const files = [], inputs = [{ path: 'scripts/dev/toolchain.json', sha256: sha256(await readSource(projectRoot, 'scripts/dev/toolchain.json')) },
    { path: `.local/cache/downloads/${NODE.archive}`, sha256: NODE.archiveSha256 }];
  for (const [path, source] of fixed) {
    const bytes = await readSource(projectRoot, source);
    if (source === `${astro}/package.json`) { const pkg = JSON.parse(bytes); assert.equal(pkg.name, 'astronomy-engine'); assert.equal(pkg.version, '2.1.19'); assert.equal(pkg.exports['.'].import, './esm/astronomy.js'); }
    if (source === `${astro}/esm/astronomy.js`) assert(bytes.subarray(0, 2200).toString('utf8').includes('MIT License'), 'Astronomy embedded license absent');
    files.push({ path, sha256: sha256(bytes), bytes: bytes.length }); inputs.push({ path: source, sha256: sha256(bytes) });
  }
  for (const [path, content] of Object.entries(generated)) { const bytes = Buffer.from(content); files.push({ path, sha256: sha256(bytes), bytes: bytes.length }); }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return freeze({ manifest: validateRuntimeManifest({ schema: 1, protocol: 2, node: { ...NODE }, files }), inputs });
}

async function freshFile(root, path, bytes) {
  safeRelativePath(path); let parent = root;
  for (const part of path.split('/').slice(0, -1)) {
    parent = join(parent, part); try { await fs.mkdir(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await canonicalDirectory(parent);
  }
  const handle = await fs.open(join(root, ...path.split('/')), 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const file = await safePath(root, path, { file: true }); assert.equal((await fs.lstat(file)).nlink, 1);
}
export async function verifyStagedPackage(packageRoot, manifest) {
  manifest = validateRuntimeManifest(manifest); packageRoot = await canonicalDirectory(packageRoot);
  const manifestBytes = runtimeManifestBytes(manifest);
  const pins = [...manifest.files, { path: 'runtime-manifest.json', sha256: sha256(manifestBytes), bytes: manifestBytes.length }];
  const expected = new Set(pins.map(file => file.path)), directories = new Set(['']), found = new Set();
  for (const pin of pins) {
    const components = pin.path.split('/'); for (let i = 1; i < components.length; ++i) directories.add(components.slice(0, i).join('/'));
  }
  let count = 0;
  async function walk(path, prefix = '', depth = 0) {
    assert(depth <= 12, 'Package depth exceeded');
    const directory = await fs.opendir(path, { bufferSize: 1 });
    // for-await closes the directory, including when a closed-shape check throws.
    for await (const entry of directory) {
      assert(++count <= 192, 'Package node bound exceeded'); const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelativePath(name); const stat = await fs.lstat(join(path, entry.name)); assert(!stat.isSymbolicLink(), 'Staged link');
      if (stat.isDirectory()) { assert(directories.has(name), 'Extra staged directory'); await walk(join(path, entry.name), name, depth + 1); }
      else {
        assert(stat.isFile() && stat.nlink === 1, 'Staged resource must be a regular single-link file');
        assert(expected.has(name) && !found.has(name), 'Extra or duplicate staged resource'); found.add(name);
      }
    }
  }
  await walk(packageRoot);
  assert.deepEqual([...found].sort(), [...expected].sort(), 'Missing staged resource');
  for (const pin of pins) {
    const path = await safePath(packageRoot, pin.path, { file: true });
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const before = await handle.stat(); assert(before.isFile()); assert.equal(before.size, pin.bytes); assert.equal(before.nlink, 1);
      const bytes = await handle.readFile(), after = await handle.stat();
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink']) assert.equal(after[key], before[key]);
      const named = await fs.lstat(await safePath(packageRoot, pin.path, { file: true }));
      for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink']) assert.equal(named[key], after[key], 'Staged path changed while reading');
      assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Staged resource differs');
    } finally { await handle.close(); }
  }
}

/** Non-Windows helper: Windows roots must be born with the PS builder's protected DACL. */
export async function createBuildRoot(projectRoot, requested) {
  projectRoot = await canonicalDirectory(projectRoot);
  const root = join(projectRoot, '.artifacts/native/backend-runtime/builds');
  const buildRoot = requested === undefined ? join(root, `build-${randomBytes(16).toString('hex')}`) : resolve(requested);
  assert.equal(dirname(buildRoot), root, 'Build output must stay in the fixed private root');
  assert(/^build-[a-f0-9]{32}$/.test(relative(root, buildRoot)), 'Invalid build directory name');
  assert(process.platform !== 'win32', 'Windows build roots require the protected-ACL PowerShell builder');
  let current = projectRoot;
  for (const part of ['.artifacts', 'native', 'backend-runtime', 'builds']) {
    current = join(current, part); try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await canonicalDirectory(current);
  }
  await fs.mkdir(buildRoot, { mode: 0o700 }); await freshFile(buildRoot, 'owner.marker', Buffer.from(BUILD_MARKER));
  return buildRoot;
}
export async function prepareBackendRuntime({ projectRoot, buildRoot }) {
  projectRoot = await canonicalDirectory(projectRoot); buildRoot = resolve(buildRoot);
  const root = join(projectRoot, '.artifacts/native/backend-runtime/builds');
  assert.equal(dirname(buildRoot), root); assert(/^build-[a-f0-9]{32}$/.test(relative(root, buildRoot)));
  await canonicalDirectory(buildRoot);
  assert.equal((await readSource(buildRoot, 'owner.marker')).toString('utf8'), BUILD_MARKER);
  const entries = [];
  const directory = await fs.opendir(buildRoot, { bufferSize: 1 });
  for await (const entry of directory) { assert(entries.length < 2, 'Too many reserved build entries'); entries.push(entry.name); }
  assert(entries.every(name => name === 'owner.marker' || name === 'logs'), 'Build was already prepared or contains unknown output');
  if (entries.includes('logs')) await canonicalDirectory(join(buildRoot, 'logs'));
  const { manifest, inputs } = await collectBackendRuntime(projectRoot), packageRoot = join(buildRoot, 'package');
  await fs.mkdir(packageRoot, { mode: 0o700 });
  for (const pin of manifest.files) {
    const source = fixed.find(([path]) => path === pin.path)?.[1];
    const bytes = source ? await readSource(projectRoot, source) : Buffer.from(generated[pin.path]);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Source changed before staging');
    await freshFile(packageRoot, pin.path, bytes);
  }
  await freshFile(packageRoot, 'runtime-manifest.json', runtimeManifestBytes(manifest));
  await verifyStagedPackage(packageRoot, manifest);
  await freshFile(buildRoot, 'backend-runtime-pins.h', Buffer.from(generateRuntimePins(manifest)));
  await freshFile(buildRoot, 'runtime-inputs.json', Buffer.from(`${JSON.stringify({ schema: 1, protocol: 2, node: NODE,
    astronomyLicense: 'node_modules/astronomy-engine/esm/astronomy.js (embedded MIT notice)', runtimePackageDigest: runtimePackageDigest(manifest), files: inputs }, null, 2)}\n`));
  return freeze({ buildRoot, packageRoot, runtimePackageDigest: runtimePackageDigest(manifest) });
}

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  const projectRoot = resolve(dirname(ownPath), '../..');
  try {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 2 && args[0] === '--build-root'), 'Only --build-root is accepted');
    // On Windows only the PS builder may reserve roots: Node mkdir cannot set the DACL.
    const buildRoot = args.length ? resolve(args[1]) : await createBuildRoot(projectRoot);
    process.stdout.write(`${JSON.stringify(await prepareBackendRuntime({ projectRoot, buildRoot }))}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
