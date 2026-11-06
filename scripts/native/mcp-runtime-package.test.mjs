import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NODE, PACKAGE_PATHS, PACKAGE_JSON, sha256, safeRelative, readStable, validateManifest, manifestBytes, generatePins, verifyPackage } from './mcp-runtime-package.mjs';
import { permittedInput, SOURCE_PATHS, DEPENDENCIES, validateChunk, resolveMcpImport, validateBundleAst } from './collect-mcp-runtime.mjs';
const manifest = () => ({ schema: 1, protocol: 'TMCP/1', node: { ...NODE }, entry: 'mcp-worker.mjs',
  files: PACKAGE_PATHS.map(path => ({ path, bytes: path === 'package.json' ? Buffer.byteLength(PACKAGE_JSON) : 1,
    sha256: path === 'node.exe' ? NODE.executableSha256 : path === 'licenses/node-LICENSE.txt' ? NODE.licenseSha256 : sha256(path === 'package.json' ? PACKAGE_JSON : 'x') })) });
const chunk = () => ({ type: 'chunk', fileName: 'mcp-worker.mjs', code: 'export {};', imports: ['node:stream'], dynamicImports: [] });
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function fixture(t) {
  const parent = join(project, '.artifacts/tests/mcp-runtime-package'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, 'case-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
test('manifest binds the fixed worker, Node, licenses and package boundary, without data or credentials', () => {
  const value = validateManifest(manifest()); assert.equal(value.files.length, 7); assert(Object.isFrozen(value.files[0]));
  assert.equal(value.files.some(f => /backend|connection|gguf|probe|node_modules/.test(f.path)), false);
  const bytes = manifestBytes(value), header = generatePins(value);
  assert(header.includes('namespace mcp_runtime {')); assert(header.includes(sha256(bytes)));
  assert.equal((header.match(/\{L"/g) ?? []).length, 8);
});
test('manifest rejects alternate entry/protocol/Node, changed package boundary and extensible metadata', () => {
  for (const change of [v => { v.entry = 'other.mjs'; }, v => { v.protocol = 'TMCP/2'; }, v => { v.schema = 2; },
    v => { v.node.version = '1'; }, v => { v.arbitrary = true; }, v => { v.files[0].extra = true; },
    v => { v.files.find(f => f.path === 'node.exe').sha256 = 'a'.repeat(64); },
    v => { v.files.find(f => f.path === 'package.json').sha256 = 'a'.repeat(64); }]) {
    const value = manifest(); change(value); assert.throws(() => validateManifest(value));
  }
});
test('manifest rejects missing, duplicate, reordered, added and oversized resources', () => {
  for (const change of [v => v.files.pop(), v => v.files.push(v.files[0]), v => v.files.reverse(),
    v => { v.files[1] = v.files[0]; }, v => { v.files[0].bytes = 4194305; }, v => { v.files[0].bytes = 0; },
    v => { v.files[0].sha256 = 'A'.repeat(64); }]) { const v = manifest(); change(v); assert.throws(() => validateManifest(v)); }
});
test('path aliases, traversal, devices, backslashes and ADS are rejected', () => {
  for (const path of ['', '/x', '../x', 'x/../a', 'x//a', 'x\\a', 'x:stream', 'x.', 'AUX', 'x/COM1.js', 'x\0y']) assert.throws(() => safeRelative(path));
});
test('bundle cannot fall back to stale dist, test files, another project or unapproved dependency', () => {
  for (const path of SOURCE_PATHS) assert(permittedInput(path));
  for (const path of ['apps/mcp/dist/native-worker-entry.js', 'apps/mcp/src/server.ts', 'apps/mcp/src/mcp-mux-wire.test.ts',
    'apps/backend/src/runtime/stdio-backend.ts', 'node_modules/other/index.js', DEPENDENCIES[0].root + 'extra/index.js']) assert.equal(permittedInput(path), false);
  assert.throws(() => permittedInput('../escape.js'));
});
test('output rejects assets, chunks, dynamic and unexpected external imports', () => {
  assert.equal(validateChunk([chunk()]).fileName, 'mcp-worker.mjs');
  for (const output of [[], [chunk(), chunk()], [{ ...chunk(), type: 'asset' }], [{ ...chunk(), fileName: 'extra.mjs' }],
    [{ ...chunk(), imports: ['node:net'] }], [{ ...chunk(), imports: ['zod'] }], [{ ...chunk(), dynamicImports: ['node:fs'] }]]) assert.throws(() => validateChunk(output));
});
test('package rejects extras, nested directories and missing resources', async t => {
  const root = await fixture(t); await fs.writeFile(join(root, 'unknown'), 'x'); await assert.rejects(verifyPackage(root, manifest()), /Extra/);
  await fs.unlink(join(root, 'unknown')); await fs.mkdir(join(root, 'unexpected')); await assert.rejects(verifyPackage(root, manifest()), /Extra/);
  await fs.rmdir(join(root, 'unexpected')); await assert.rejects(verifyPackage(root, manifest()), /Missing/);
});
test('stable reads reject hardlinks and redirected ancestors, even when bytes match', async t => {
  const root = await fixture(t); await fs.writeFile(join(root, 'original'), 'x'); await fs.link(join(root, 'original'), join(root, 'linked'));
  await assert.rejects(readStable(root, 'linked'), /single-link/);
  await fs.mkdir(join(root, 'target')); await fs.symlink(join(root, 'target'), join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readStable(root, 'redirect/file'), /Linked|Noncanonical/);
});
test('package checks actual staged bytes against supplied immutable digest, not its own declarations', async t => {
  const root = await fixture(t), value = manifest();
  for (const f of value.files) { await fs.mkdir(dirname(join(root, f.path)), { recursive: true }); await fs.writeFile(join(root, f.path), f.path === 'package.json' ? PACKAGE_JSON : 'x'); }
  await fs.writeFile(join(root, 'runtime-manifest.json'), manifestBytes(value));
  // First license changed; reject before the deliberately synthetic Node fixture.
  await fs.writeFile(join(root, value.files[0].path), 'y'); await assert.rejects(verifyPackage(root, value), /digest differs/);
});

test('resolver uses only fixed source/export routes and rejects inherited package search', () => {
  const importer = join(project, 'apps/mcp/src/stream-server.ts');
  assert.equal(resolveMcpImport('./server-core.js', importer, project), join(project, 'apps/mcp/src/server-core.ts'));
  assert.equal(resolveMcpImport('@tahtiapuri/validation/public', importer, project), join(project, 'packages/validation/src/public-api.ts'));
  assert.equal(resolveMcpImport('@modelcontextprotocol/server/_shims', importer, project), join(project, DEPENDENCIES[0].root, 'dist/shimsNode.mjs'));
  for (const name of ['node:net', 'node:fs', 'other', '@modelcontextprotocol/server/ext/skills', '../dist/server.js', '../../backend/src/index.js'])
    assert.throws(() => resolveMcpImport(name, importer, project));
});

test('parsed emitted code rejects forbidden static and nested dynamic imports and runtime require', () => {
  const program = body => ({ type: 'Program', sourceType: 'module', body });
  const imp = value => ({ type: 'ImportDeclaration', source: { value } });
  assert.deepEqual(validateBundleAst(program([imp('node:crypto'), imp('node:stream')])), ['node:crypto', 'node:stream']);
  for (const body of [[imp('node:module')], [{ type: 'FunctionDeclaration', body: { type: 'ImportExpression' } }],
    [{ type: 'CallExpression', callee: { type: 'Identifier', name: 'require' } }],
    [{ type: 'CallExpression', callee: { type: 'MemberExpression', object: { name: 'module' }, property: { name: 'require' } } }]])
    assert.throws(() => validateBundleAst(program(body)));
});

test('actual emitted-code parser rejects dynamic imports and re-exports, including nested expressions', async () => {
  const { parseAst } = await import(pathToFileURL(join(project, 'node_modules/.pnpm/rolldown@1.2.16/node_modules/rolldown/dist/parse-ast-index.mjs')).href);
  const parse = code => parseAst(code, { sourceType: 'module' });
  assert.deepEqual(validateBundleAst(parse('import {randomUUID} from "node:crypto"; randomUUID();')), ['node:crypto']);
  for (const code of ['export * from "node:fs";', 'export {createRequire} from "node:module";',
    'async function f(){ return import("node:stream"); }', 'const f = () => require("node:stream");'])
    assert.throws(() => validateBundleAst(parse(code)));
});
