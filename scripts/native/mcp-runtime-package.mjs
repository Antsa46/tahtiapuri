import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const NODE = Object.freeze({ version: '24.22.2', archive: 'node-v24.22.2-win-x64.zip',
  archiveSha256: 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
  executableSha256: '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9',
  licenseSha256: 'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9' });
export const PACKAGE_PATHS = Object.freeze(['licenses/mcp-core-LICENSE.txt', 'licenses/mcp-server-LICENSE.txt',
  'licenses/node-LICENSE.txt', 'licenses/zod-LICENSE.txt', 'mcp-worker.mjs', 'node.exe', 'package.json']);
export const PACKAGE_JSON = '{"type":"module","private":true}\n';
export const BUILD_MARKER = 'TAHTIAPURI_MCP_BUILD_V1\n';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => { assert(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function safeRelative(path) {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 240 && /^[A-Za-z0-9@_.+/-]+$/.test(path), 'Unsafe relative path');
  assert(path.split('/').every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Unsafe path component');
  return path;
}
export async function canonicalDirectory(path) {
  path = resolve(path); assert(!path.startsWith('\\\\') && !path.startsWith('//'), 'Network path forbidden');
  let current = path;
  for (;;) {
    const stat = await fs.lstat(current);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Linked or non-directory ancestor');
    assert.equal(resolve(await fs.realpath(current)), current, 'Noncanonical ancestor');
    const parent = dirname(current); if (parent === current) return path; current = parent;
  }
}
export async function readStable(root, relative, { maxBytes = 167772160, hardlinks = false } = {}) {
  safeRelative(relative); root = await canonicalDirectory(root);
  const path = join(root, relative); await canonicalDirectory(dirname(path));
  const beforeName = await fs.lstat(path);
  assert(beforeName.isFile() && !beforeName.isSymbolicLink(), 'Expected regular source file');
  assert.equal(resolve(await fs.realpath(path)), path, 'Redirected file');
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    assert(before.isFile() && (hardlinks || before.nlink === 1), 'Expected single-link file');
    assert(before.size > 0 && before.size <= maxBytes, 'File size outside bound');
    const bytes = await handle.readFile(), after = await handle.stat(), named = await fs.lstat(path);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink']) {
      assert.equal(beforeName[key], before[key], 'Opened source differs');
      assert.equal(before[key], after[key], 'File changed while reading');
      assert.equal(after[key], named[key], 'Named file changed while reading');
    }
    assert(!named.isSymbolicLink()); assert.equal(bytes.length, after.size); return bytes;
  } finally { await handle.close(); }
}
export function validateManifest(value) {
  exact(value, ['schema', 'protocol', 'node', 'entry', 'files']);
  assert.equal(value.schema, 1); assert.equal(value.protocol, 'TMCP/1'); assert.equal(value.entry, 'mcp-worker.mjs');
  assert.deepEqual(value.node, NODE); assert(Array.isArray(value.files));
  assert.deepEqual(value.files.map(file => file.path), PACKAGE_PATHS, 'Package must have the exact sorted file set');
  for (const file of value.files) {
    exact(file, ['path', 'bytes', 'sha256']); safeRelative(file.path);
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= (file.path === 'node.exe' ? 167772160 : 4194304), 'Invalid size');
    assert(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'Invalid digest');
  }
  assert.equal(value.files.find(file => file.path === 'node.exe').sha256, NODE.executableSha256, 'Pinned Node differs');
  assert.equal(value.files.find(file => file.path === 'licenses/node-LICENSE.txt').sha256, NODE.licenseSha256, 'Pinned Node license differs');
  const pkg = value.files.find(file => file.path === 'package.json');
  assert.equal(pkg.sha256, sha256(PACKAGE_JSON)); assert.equal(pkg.bytes, Buffer.byteLength(PACKAGE_JSON));
  return freeze({ schema: 1, protocol: 'TMCP/1', node: { ...NODE }, entry: 'mcp-worker.mjs', files: value.files.map(file => ({ ...file })) });
}
export const manifestBytes = value => Buffer.from(JSON.stringify(validateManifest(value), null, 2) + '\n');
export function generatePins(value) {
  value = validateManifest(value); const bytes = manifestBytes(value), digest = sha256(bytes);
  return ['#pragma once', '#include <cstdint>', 'namespace mcp_runtime {',
    'struct RuntimePin { const wchar_t* path; const char* sha256; uint64_t bytes; };',
    'inline constexpr RuntimePin runtimePins[] = {',
    ...[...value.files, { path: 'runtime-manifest.json', bytes: bytes.length, sha256: digest }].map(p => `    {L"${p.path}", "${p.sha256}", ${p.bytes}ULL},`),
    '};', `inline constexpr char runtimePackageDigest[] = "${digest}";`, '}', ''].join('\n');
}
export async function freshFile(root, relative, bytes) {
  safeRelative(relative); await canonicalDirectory(root);
  let parent = root;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = join(parent, part); try { await fs.mkdir(parent); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await canonicalDirectory(parent);
  }
  const handle = await fs.open(join(root, relative), 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function verifyPackage(root, value) {
  value = validateManifest(value); root = await canonicalDirectory(root);
  const mb = manifestBytes(value), pins = [...value.files, { path: 'runtime-manifest.json', bytes: mb.length, sha256: sha256(mb) }];
  const expected = new Set(pins.map(p => p.path)), found = new Set(); let count = 0;
  async function walk(path, prefix = '') {
    for await (const item of await fs.opendir(path, { bufferSize: 1 })) {
      assert(++count <= 9, 'Package node count exceeded'); const name = prefix + item.name; safeRelative(name);
      const stat = await fs.lstat(join(path, item.name)); assert(!stat.isSymbolicLink(), 'Package link forbidden');
      if (stat.isDirectory()) { assert.equal(name, 'licenses', 'Extra directory'); await walk(join(path, item.name), name + '/'); }
      else { assert(stat.isFile() && stat.nlink === 1, 'Package must contain single-link regular files'); assert(expected.has(name), 'Extra package file'); found.add(name); }
    }
  }
  await walk(root); assert.deepEqual([...found].sort(), [...expected].sort(), 'Missing package file');
  for (const pin of pins) {
    const bytes = await readStable(root, pin.path, { maxBytes: pin.bytes });
    assert.equal(bytes.length, pin.bytes, 'Package length differs'); assert.equal(sha256(bytes), pin.sha256, 'Package digest differs');
  }
}
