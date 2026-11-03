import assert from 'node:assert/strict';
import { promises as fs, createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function sha256(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function contained(root, path) { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`); }
function packageName(name) {
  assert(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) && !name.split('/').some(part => part === '.' || part === '..'), 'Invalid package name.');
  return name;
}
async function metadataFile(directory) {
  const file = join(directory, 'package.json'); const info = await fs.lstat(file);
  assert(info.isFile() && !info.isSymbolicLink(), 'Package metadata must be a regular file.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function resolveInstalledPackage(fromPackage, name, sourceRoot) {
  packageName(name);
  const require = createRequire(pathToFileURL(join(fromPackage, 'package.json')));
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = join(base, name, 'package.json');
    try { await fs.lstat(candidate); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    const actual = await fs.realpath(dirname(candidate));
    assert(contained(sourceRoot, actual), 'A dependency resolves outside the approved node_modules tree.');
    return actual;
  }
  const error = new Error(`Installed dependency missing: ${name}`); error.code = 'DEPENDENCY_MISSING'; throw error;
}

// Copy installed package bytes, never their pnpm hardlinks/junctions or install scripts.
export async function materializePackages({ sourceRoot, destination, roots, maxFiles = 20000, maxBytes = 1024 * 1024 * 1024 }) {
  const approved = await fs.realpath(sourceRoot);
  const target = resolve(destination);
  assert(!contained(approved, target), 'Staged packages must be outside source node_modules.');
  await fs.mkdir(target, { recursive: false });
  const manifest = { schema: 1, packages: [], files: [], omittedOptional: [], fileCount: 0, bytes: 0 };
  const installations = new Map(); const rootModules = target;
  async function copyTree(source, dest, packageRoot) {
    const info = await fs.lstat(source);
    assert(!info.isSymbolicLink(), 'A package contains a reparse/symlink entry.');
    if (info.isDirectory()) {
      await fs.mkdir(dest, { recursive: true });
      for (const name of (await fs.readdir(source)).sort()) {
        if (name === '.git' || (source === packageRoot && name === 'node_modules')) continue;
        const local = relative(packageRoot, join(source, name)).split(sep).join('/');
        if (packageRoot.endsWith(`${sep}node-llama-cpp`) && (local === 'bins' || local === 'llama/localBuilds' || local === '.temp')) continue;
        await copyTree(join(source, name), join(dest, name), packageRoot);
      }
      return;
    }
    assert(info.isFile() && !/\.(gguf|ggml|safetensors)$/i.test(source), 'Only code/resources, no model weights, may be staged.');
    manifest.fileCount++; manifest.bytes += info.size;
    assert(manifest.fileCount <= maxFiles && manifest.bytes <= maxBytes, 'Staged dependency budget exceeded.');
    await fs.mkdir(dirname(dest), { recursive: true });
    const before = await sha256(source);
    await fs.copyFile(source, dest, constants.COPYFILE_EXCL);
    const copied = await fs.lstat(dest); assert(copied.isFile() && !copied.isSymbolicLink() && copied.nlink === 1 && copied.size === info.size);
    assert.equal(await sha256(dest), before, 'Copied dependency bytes differ.');
    manifest.files.push({ path: relative(target, dest).split(sep).join('/'), bytes: info.size, sha256: before });
  }
  function visible(from, name) {
    let here = from;
    while (contained(dirname(rootModules), here)) {
      const found = installations.get(join(here, 'node_modules', name)); if (found) return found;
      if (here === dirname(rootModules)) break;
      here = dirname(here);
    }
    return installations.get(join(rootModules, name));
  }
  async function install(source, name, requester, depth = 0) {
    packageName(name); assert(depth < 64 && manifest.packages.length < 500, 'Dependency graph cannot be materialized within bounds.');
    const actual = await fs.realpath(source); assert(contained(approved, actual));
    const metadata = await metadataFile(actual);
    assert(typeof metadata.name === 'string' && typeof metadata.version === 'string');
    const existing = visible(requester, name); if (existing?.source === actual) return existing.destination;
    const globalPath = join(rootModules, name);
    const dest = installations.has(globalPath) ? join(requester, 'node_modules', name) : globalPath;
    assert(!installations.has(dest), 'Conflicting dependency resolution at one module path.');
    const registration = { source: actual, destination: dest }; installations.set(dest, registration);
    manifest.packages.push({ path: relative(target, dest).split(sep).join('/'), name, declaredName: metadata.name, version: metadata.version });
    await copyTree(actual, dest, actual);
    const optional = metadata.optionalDependencies ?? {};
    const dependencies = { ...(metadata.dependencies ?? {}), ...optional };
    for (const dep of Object.keys(dependencies).sort()) {
      if (dep.startsWith('@node-llama-cpp/') && dep !== '@node-llama-cpp/win-x64') { manifest.omittedOptional.push({ parent: name, name: dep, reason: 'CPU-only probe' }); continue; }
      let dependency;
      try { dependency = await resolveInstalledPackage(actual, dep, approved); }
      catch (error) {
        if (error.code === 'DEPENDENCY_MISSING' && Object.hasOwn(optional, dep)) { manifest.omittedOptional.push({ parent: name, name: dep, reason: 'Not installed on this platform' }); continue; }
        throw error;
      }
      await install(dependency, dep, dest, depth + 1);
    }
    return dest;
  }
  for (const entry of roots) await install(entry.source, entry.name, dirname(rootModules));
  // Verify every original dependency edge resolves to exactly the installed source selected above.
  for (const [dest, entry] of installations) {
    const metadata = await metadataFile(entry.source);
    for (const dep of Object.keys({ ...(metadata.dependencies ?? {}), ...(metadata.optionalDependencies ?? {}) })) {
      if (dep.startsWith('@node-llama-cpp/') && dep !== '@node-llama-cpp/win-x64') continue;
      let original; try { original = await resolveInstalledPackage(entry.source, dep, approved); }
      catch (error) { if (error.code === 'DEPENDENCY_MISSING' && Object.hasOwn(metadata.optionalDependencies ?? {}, dep)) continue; throw error; }
      assert.equal(visible(dest, dep)?.source, original, 'Hoisting changed an original dependency edge.');
    }
  }
  return manifest;
}
