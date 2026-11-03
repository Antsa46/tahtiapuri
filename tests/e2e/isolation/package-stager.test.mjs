import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { materializePackages } from './package-stager.mjs';
const parent = resolve('.artifacts/tests/isolation/stager-unit');
async function fixture(run) {
  const root = join(parent, randomUUID()); const sourceRoot = join(root, 'node_modules'); await fs.mkdir(sourceRoot, { recursive: true });
  async function pkg(path, name, version, dependencies = {}) { const dir = join(sourceRoot, path); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, dependencies, type: 'module', exports: './index.js' })); await fs.writeFile(join(dir, 'index.js'), `export default ${JSON.stringify(version)};\n`); return dir; }
  try { await run({ root, sourceRoot, pkg, destination: join(root, 'staged') }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
test('keeps original package files and materializes cyclic dependencies without links', async () => fixture(async ({ sourceRoot, pkg, destination }) => {
  const a = await pkg('a', 'a', '1.0.0', { b: '*' }); await pkg('b', 'b', '1.0.0', { a: '*' });
  const m = await materializePackages({ sourceRoot, destination, roots: [{ name: 'a', source: a }] }); assert.equal(m.packages.length, 2);
  assert.equal((await fs.stat(join(destination, 'a/index.js'))).nlink, 1); assert.equal(await fs.readFile(join(destination, 'a/index.js'), 'utf8'), 'export default "1.0.0";\n');
}));
test('conflicting versions stay nested and every dependency edge is verified', async () => fixture(async ({ sourceRoot, pkg, destination }) => {
  const a = await pkg('a', 'a', '1.0.0', { x: '*', b: '*' }); await pkg('x', 'x', '1.0.0'); await pkg('b', 'b', '1.0.0', { x: '*' }); await pkg('b/node_modules/x', 'x', '2.0.0');
  const m = await materializePackages({ sourceRoot, destination, roots: [{ name: 'a', source: a }] });
  assert.equal(m.packages.filter(p => p.name === 'x').length, 2); assert.deepEqual(m.packages.filter(p => p.name === 'x').map(p => p.version).sort(), ['1.0.0','2.0.0']);
}));
test('missing required dependency fails rather than silently selecting another tree', async () => fixture(async ({ sourceRoot, pkg, destination }) => {
  const a = await pkg('a', 'a', '1.0.0', { absent_dependency_47614: '*' }); await assert.rejects(materializePackages({ sourceRoot, destination, roots: [{ name: 'a', source: a }] }), /missing/);
}));
test('shared source hardlinks become independent destination files', async () => fixture(async ({ sourceRoot, pkg, destination, root }) => {
  const a = await pkg('a', 'a', '1.0.0'); await fs.link(join(a, 'index.js'), join(root, 'shared.js'));
  await materializePackages({ sourceRoot, destination, roots: [{ name: 'a', source: a }] }); assert.equal((await fs.stat(join(destination, 'a/index.js'))).nlink, 1);
}));
test('internal reparse points are rejected', async () => fixture(async ({ sourceRoot, pkg, destination, root }) => {
  const a = await pkg('a', 'a', '1.0.0'); const outside = join(root, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, join(a, 'linked'), 'junction');
  await assert.rejects(materializePackages({ sourceRoot, destination, roots: [{ name: 'a', source: a }] }), /reparse/);
}));
test('model files and exceeded byte budget are rejected', async () => fixture(async ({ sourceRoot, pkg, destination, root }) => {
  const a = await pkg('a', 'a', '1.0.0'); await fs.writeFile(join(a, 'model.gguf'), 'synthetic');
  await assert.rejects(materializePackages({ sourceRoot, destination, roots: [{ name: 'a', source: a }] }), /model weights/);
  await fs.unlink(join(a, 'model.gguf')); await assert.rejects(materializePackages({ sourceRoot, destination: join(root, 'small'), roots: [{ name: 'a', source: a }], maxBytes: 1 }), /budget/);
}));

test('a dependency junction cannot import an outside source tree', async () => fixture(async ({ sourceRoot, pkg, destination, root }) => {
  const a=await pkg('a','a','1.0.0',{escape:'*'}); const outside=join(root,'outside');await fs.mkdir(outside);await fs.writeFile(join(outside,'package.json'),JSON.stringify({name:'escape',version:'1.0.0'}));await fs.symlink(outside,join(sourceRoot,'escape'),'junction');
  await assert.rejects(materializePackages({sourceRoot,destination,roots:[{name:'a',source:a}]}),/outside/);
}));
