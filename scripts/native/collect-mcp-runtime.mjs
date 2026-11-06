// Fixed, offline build recipe. This does not launch the worker or select a runtime.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NODE, PACKAGE_PATHS, PACKAGE_JSON, BUILD_MARKER, sha256, safeRelative, canonicalDirectory,
  readStable, validateManifest, manifestBytes, generatePins, freshFile, verifyPackage } from './mcp-runtime-package.mjs';

const ownModules = ['native-worker-entry', 'mcp-mux-worker', 'mcp-mux-wire', 'mcp-mux-writer', 'mcp-mux-channel',
  'stream-server', 'server-core', 'connected-development-client', 'mcp-input-gate', 'bounded-mcp-transport'];
const validationModules = ['development', 'development-framing', 'public-api', 'assistant'];
export const SOURCE_PATHS = Object.freeze([...ownModules.map(n => `apps/mcp/src/${n}.ts`),
  ...validationModules.map(n => `packages/validation/src/${n}.ts`)].sort());
export const DEPENDENCIES = Object.freeze([
  { name: '@modelcontextprotocol/server', version: '2.4.0', root: 'node_modules/.pnpm/@modelcontextprotocol+server@2.4.0/node_modules/@modelcontextprotocol/server', notice: 'licenses/mcp-server-LICENSE.txt', license: 'Apache-2.0' },
  { name: '@modelcontextprotocol/core', version: '2.4.0', root: 'node_modules/.pnpm/@modelcontextprotocol+core@2.4.0/node_modules/@modelcontextprotocol/core', notice: 'licenses/mcp-core-LICENSE.txt', license: 'Apache-2.0' },
  { name: 'zod', version: '4.6.7', root: 'node_modules/.pnpm/zod@4.6.7/node_modules/zod', notice: 'licenses/zod-LICENSE.txt', license: 'MIT' },
]);
const bundlerRoot = 'node_modules/.pnpm/rolldown@1.2.16/node_modules/rolldown';
const bindingRoot = 'node_modules/.pnpm/@rolldown+binding-win32-x64-msvc@1.2.16/node_modules/@rolldown/binding-win32-x64-msvc';
const pluginRoot = 'node_modules/.pnpm/@rolldown+pluginutils@1.0.1/node_modules/@rolldown/pluginutils';
const builtinImports = new Set(['node:stream', 'node:process', 'node:crypto']);
// Rolldown may resolve its CJS helper before removing unused code. The final
// chunk must still contain only builtinImports; node:module cannot ship.
const buildImports = new Set([...builtinImports, 'node:module']);

export function permittedInput(path) {
  safeRelative(path);
  return SOURCE_PATHS.includes(path) || DEPENDENCIES.some(dep => path.startsWith(dep.root + '/') && /\.(m?js)$/.test(path));
}
export function resolveMcpImport(source, importer, projectRoot) {
  if (buildImports.has(source)) return { id: source, external: true };
  const aliases = new Map([
    ...['development', 'development-framing', 'public'].map(n =>
      [`@tahtiapuri/validation/${n}`, `packages/validation/src/${n === 'public' ? 'public-api' : n}.ts`]),
    ['@modelcontextprotocol/server', DEPENDENCIES[0].root + '/dist/index.mjs'],
    ['@modelcontextprotocol/server/stdio', DEPENDENCIES[0].root + '/dist/stdio.mjs'],
    ['@modelcontextprotocol/server/_shims', DEPENDENCIES[0].root + '/dist/shimsNode.mjs'],
    ['@modelcontextprotocol/core/internal', DEPENDENCIES[1].root + '/dist/internal.mjs'],
    ['zod/v4', DEPENDENCIES[2].root + '/v4/index.js'],
  ]);
  let path;
  if (aliases.has(source)) path = join(projectRoot, aliases.get(source));
  else if (importer && source.startsWith('.')) {
    path = resolve(dirname(importer), source);
    if (importer.endsWith('.ts') && path.endsWith('.js')) path = path.slice(0, -3) + '.ts';
  } else {
    assert(!importer && source === join(projectRoot, 'apps/mcp/src/native-worker-entry.ts'), 'Unknown runtime import: ' + source);
    path = source;
  }
  assert(permittedInput(relative(projectRoot, path).replaceAll('\\', '/')), 'Import outside fixed runtime roots');
  return path;
}
export function validateChunk(output) {
  assert(Array.isArray(output) && output.length === 1 && output[0].type === 'chunk', 'Expected a single ESM chunk');
  const chunk = output[0]; assert.equal(chunk.fileName, 'mcp-worker.mjs');
  assert(chunk.dynamicImports.length === 0, 'Dynamic imports forbidden');
  assert(chunk.imports.every(name => buildImports.has(name)), 'Unexpected external import');
  assert(Buffer.byteLength(chunk.code) > 0 && Buffer.byteLength(chunk.code) <= 4194304, 'Bundle size exceeded');
  return chunk;
}

export function validateBundleAst(program) {
  assert(program?.type === 'Program' && program.sourceType === 'module', 'Expected parsed ESM');
  const imports = new Set(), stack = [program]; let nodes = 0;
  while (stack.length) {
    const node = stack.pop(); assert(++nodes <= 1000000, 'Bundle syntax node limit');
    if (!node || typeof node !== 'object') continue;
    assert(node.type !== 'ImportExpression', 'Dynamic runtime import forbidden');
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      assert(builtinImports.has(node.source.value), 'Unexpected emitted import'); imports.add(node.source.value);
    }
    if (node.type === 'CallExpression') {
      const c = node.callee;
      assert(!(c?.type === 'Identifier' && c.name === 'require') &&
        !(c?.type === 'MemberExpression' && c.object?.name === 'module' && c.property?.name === 'require'), 'Runtime require forbidden');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value.filter(v => v && typeof v === 'object'));
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  return [...imports].sort();
}

export async function prepareMcpRuntime({ projectRoot, buildRoot }) {
  assert.equal(process.platform, 'win32', 'MCP package recipe currently targets Windows');
  projectRoot = await canonicalDirectory(projectRoot); buildRoot = await canonicalDirectory(buildRoot);
  assert.equal(dirname(buildRoot), join(projectRoot, '.artifacts/native/mcp-runtime/builds'));
  assert(/^build-[a-f0-9]{32}$/.test(relative(dirname(buildRoot), buildRoot)), 'Unexpected build name');
  assert.equal((await readStable(buildRoot, 'owner.marker')).toString(), BUILD_MARKER);
  const entries = [];
  for await (const item of await fs.opendir(buildRoot, { bufferSize: 1 })) { assert(entries.length < 2); entries.push(item.name); }
  assert(entries.every(name => name === 'owner.marker' || name === 'logs'), 'Build root already used');
  if (entries.includes('logs')) await canonicalDirectory(join(buildRoot, 'logs'));
  const inputs = new Map(), files = new Map(); let moduleBytes = 0, moduleCount = 0;
  async function capture(path, options = {}) {
    const bytes = await readStable(projectRoot, path, options), digest = sha256(bytes);
    const previous = inputs.get(path); if (previous) assert.equal(previous.sha256, digest, 'Input changed during build');
    inputs.set(path, { path, sha256: digest, bytes: bytes.length, hardlinks: !!options.hardlinks }); return bytes;
  }
  for (const path of ['pnpm-lock.yaml', 'package.json', 'apps/mcp/package.json', 'packages/validation/package.json',
    'scripts/native/collect-mcp-runtime.mjs', 'scripts/native/mcp-runtime-package.mjs', 'scripts/native/build-mcp-runtime.ps1']) await capture(path);
  const toolchain = JSON.parse(await capture('scripts/dev/toolchain.json'));
  assert.equal(toolchain.node.version, NODE.version); assert.equal(toolchain.node.archive, NODE.archive); assert.equal(toolchain.node.sha256, NODE.archiveSha256);
  assert.equal(sha256(await capture(`.local/cache/downloads/${NODE.archive}`)), NODE.archiveSha256, 'Node archive differs');
  const node = await capture(`.local/toolchain/node-v${NODE.version}-win-x64/node.exe`);
  assert.equal(sha256(node), NODE.executableSha256, 'Node executable differs'); files.set('node.exe', node);
  files.set('licenses/node-LICENSE.txt', await capture(`.local/toolchain/node-v${NODE.version}-win-x64/LICENSE`));
  for (const dep of DEPENDENCIES) {
    const pkg = JSON.parse(await capture(dep.root + '/package.json', { hardlinks: true }));
    assert.equal(pkg.name, dep.name); assert.equal(pkg.version, dep.version); assert.equal(pkg.license, dep.license);
    // A new upstream notice requires an explicit closure update, never silent omission.
    for await (const item of await fs.opendir(join(projectRoot, dep.root), { bufferSize: 1 }))
      if (/LICENSE|NOTICE|COPYRIGHT/i.test(item.name)) assert.equal(item.name, 'LICENSE', 'Unaccounted dependency notice');
    files.set(dep.notice, await capture(dep.root + '/LICENSE', { hardlinks: true, maxBytes: 4194304 }));
  }
  const builder = JSON.parse(await capture(bundlerRoot + '/package.json', { hardlinks: true }));
  assert.equal(builder.name, 'rolldown'); assert.equal(builder.version, '1.2.16');
  await capture(bundlerRoot + '/dist/index.mjs', { hardlinks: true });
  const binding = JSON.parse(await capture(bindingRoot + '/package.json', { hardlinks: true }));
  assert.equal(binding.name, '@rolldown/binding-win32-x64-msvc'); assert.equal(binding.version, '1.2.16');
  await capture(bindingRoot + '/rolldown-binding.win32-x64-msvc.node', { hardlinks: true });
  // Snapshot executable builder files too; a receipt of index.mjs alone misses
  // the shared transforms. Dependencies remain trusted installed build tools.
  async function captureToolTree(root, depth = 0) {
    assert(depth <= 4, 'Builder tree depth exceeded');
    await canonicalDirectory(join(projectRoot, root));
    for await (const item of await fs.opendir(join(projectRoot, root), { bufferSize: 1 })) {
      const path = root + '/' + item.name, stat = await fs.lstat(join(projectRoot, path));
      assert(!stat.isSymbolicLink(), 'Builder tree link');
      if (stat.isDirectory()) await captureToolTree(path, depth + 1);
      else if (/\.(?:mjs|cjs|js)$/.test(item.name)) {
        assert(inputs.size < 512, 'Builder input count exceeded'); await capture(path, { hardlinks: true, maxBytes: 4194304 });
      }
    }
  }
  const plugin = JSON.parse(await capture(pluginRoot + '/package.json', { hardlinks: true }));
  assert.equal(plugin.name, '@rolldown/pluginutils'); assert.equal(plugin.version, '1.0.1');
  await captureToolTree(bundlerRoot + '/dist'); await captureToolTree(pluginRoot + '/dist');
  // Override the loader's optional environment selectors with the pinned native
  // binary, then confirm the actual CommonJS cache identity before compilation.
  delete process.env.NAPI_RS_FORCE_WASI; delete process.env.NAPI_RS_WASI_FLAVOR;
  const bindingPath = join(projectRoot, bindingRoot, 'rolldown-binding.win32-x64-msvc.node');
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = bindingPath;
  process.env.NAPI_RS_ENFORCE_VERSION_CHECK = '1';
  const require = createRequire(import.meta.url); require(bindingPath);
  assert.equal(require.resolve('@rolldown/pluginutils', { paths: [join(projectRoot, bundlerRoot)] }), join(projectRoot, pluginRoot, 'dist/index.mjs'));
  assert.equal(require.resolve(bindingPath), bindingPath); assert(require.cache[bindingPath]?.loaded, 'Pinned native binding was not loaded');
  const loaded = new Set();
  const { rolldown } = await import(pathToFileURL(join(projectRoot, bundlerRoot, 'dist/index.mjs')).href);
  const build = await rolldown({ cwd: projectRoot, input: join(projectRoot, 'apps/mcp/src/native-worker-entry.ts'), platform: 'node', tsconfig: false,
    external: name => buildImports.has(name),
    onLog(level, log) { if (level === 'warn' || level === 'error') throw new Error(log.code + ': ' + log.message); },
    plugins: [{ name: 'fixed-mcp-source-closure',
      resolveId(source, importer) { return resolveMcpImport(source, importer, projectRoot); },
      async load(id) {
        const path = relative(projectRoot, id).replaceAll('\\', '/'); assert(permittedInput(path), 'Unlisted runtime dependency: ' + path);
        const bytes = await capture(path, { hardlinks: path.startsWith('node_modules/'), maxBytes: 2097152 });
        if (!loaded.has(path)) { loaded.add(path); moduleBytes += bytes.length; assert(++moduleCount <= 256 && moduleBytes <= 33554432, 'Input closure limit'); }
        return { code: new TextDecoder('utf-8', { fatal: true }).decode(bytes), moduleType: path.endsWith('.ts') ? 'ts' : 'js' };
      },
    }],
  });
  const { parseAst } = await import(pathToFileURL(join(projectRoot, bundlerRoot, 'dist/parse-ast-index.mjs')).href);
  let chunk, emittedImports;
  try {
    const output = (await build.generate({ format: 'esm', sourcemap: false, codeSplitting: false, comments: true, entryFileNames: 'mcp-worker.mjs' })).output;
    try { chunk = validateChunk(output); emittedImports = validateBundleAst(parseAst(chunk.code, { sourceType: 'module' })); }
    catch (error) {
      if (output.length === 1 && output[0].type === 'chunk') {
        await freshFile(buildRoot, 'rejected-bundle.mjs', Buffer.from(output[0].code));
        await freshFile(buildRoot, 'rejected-imports.json', Buffer.from(JSON.stringify(output[0].imports)));
      }
      throw error;
    }
  }
  finally { await build.close(); }
  assert(SOURCE_PATHS.every(path => loaded.has(path)), 'Required source omitted');
  files.set('mcp-worker.mjs', Buffer.from(chunk.code)); files.set('package.json', Buffer.from(PACKAGE_JSON));
  assert.deepEqual([...files.keys()].sort(), PACKAGE_PATHS);
  // Inputs are hashed from bytes actually handed to the compiler; rereading catches
  // changes during compilation. This is a trusted build, not same-user isolation.
  for (const input of [...inputs.values()]) await capture(input.path, { hardlinks: input.hardlinks });
  const manifest = validateManifest({ schema: 1, protocol: 'TMCP/1', node: NODE, entry: 'mcp-worker.mjs',
    files: PACKAGE_PATHS.map(path => ({ path, bytes: files.get(path).length, sha256: sha256(files.get(path)) })) });
  const packageRoot = join(buildRoot, 'package'); await fs.mkdir(packageRoot);
  for (const [path, bytes] of files) await freshFile(packageRoot, path, bytes);
  await freshFile(packageRoot, 'runtime-manifest.json', manifestBytes(manifest)); await verifyPackage(packageRoot, manifest);
  await freshFile(buildRoot, 'mcp-runtime-pins.h', Buffer.from(generatePins(manifest)));
  const receipt = { schema: 1, protocol: 'TMCP/1', builder: { name: builder.name, version: builder.version },
    digest: sha256(manifestBytes(manifest)), sourceModules: [...loaded].sort(), imports: emittedImports, bundlerImportMetadata: chunk.imports, dynamicImports: chunk.dynamicImports,
    inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path)),
    scope: 'Fixed runtime package; no native broker, OS isolation, or release-installer acceptance' };
  await freshFile(buildRoot, 'runtime-inputs.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  return { buildRoot, packageRoot, digest: receipt.digest, modules: loaded.size };
}
const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  try {
    assert(process.argv.length === 4 && process.argv[2] === '--build-root', 'Requires reserved --build-root');
    process.stdout.write(JSON.stringify(await prepareMcpRuntime({ projectRoot: resolve(dirname(ownPath), '../..'), buildRoot: process.argv[3] })) + '\n');
  } catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
}
