import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { NATIVE_BACKEND_RUNTIME_PATHS, loadNativeBackendRuntime, nativeBackendSpawnOptions, prepareNativeBackendResources } from "./native-backend-resources.js";

// Entirely in memory: no filesystem, private-directory helper or process launch.
const files = new Map<string, Buffer>(), directories = new Set<string>(), links = new Set<string>(), hardlinks = new Set<string>();
const mkdir = vi.fn(async (path: string) => { if (directories.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); directories.add(path); });
const remove = vi.fn(async (root: string) => { for (const path of [...files.keys()]) if (path === root || path.startsWith(root + sep)) files.delete(path); for (const path of [...directories]) if (path === root || path.startsWith(root + sep)) directories.delete(path); });
const secure = vi.fn(async (path: string) => { addDirectory(path); });
const copy = vi.fn(async (source: string, destination: string) => put(destination, files.get(source)!));
const launch = vi.fn((..._args: unknown[]) => { throw new Error("Unexpected process launch."); });
function stat(path: string) {
  if (!files.has(path) && !directories.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return { dev: 1, ino: path, nlink: hardlinks.has(path) ? 2 : 1, mtimeMs: 0, ctimeMs: 0, size: files.get(path)?.length ?? 0,
    isDirectory: () => directories.has(path), isFile: () => files.has(path), isSymbolicLink: () => links.has(path) };
}
function addDirectory(path: string) { for (;;) { directories.add(path); const parent = dirname(path); if (parent === path) return; path = parent; } }
function put(path: string, value: Buffer | string) { addDirectory(dirname(path)); files.set(path, Buffer.from(value)); }
function children(path: string) { return [...new Set([...files.keys(), ...directories].filter(name => name !== path && dirname(name) === path))].map(name => ({ name: basename(name) })); }
vi.mock("node:fs/promises", () => ({
  lstat: async (path: string) => stat(path), realpath: async (path: string) => path,
  readFile: async (path: string, encoding?: string) => encoding ? files.get(path)!.toString(encoding as BufferEncoding) : Buffer.from(files.get(path)!),
  open: async (path: string) => ({ stat: async () => stat(path), readFile: async () => Buffer.from(files.get(path)!), close: async () => {} }),
  opendir: async (path: string) => ({ async *[Symbol.asyncIterator]() { for (const entry of children(path)) yield entry; } }),
  mkdir: (...args: [string]) => mkdir(...args), rm: (...args: [string]) => remove(...args),
  writeFile: async (path: string, value: string | Buffer) => put(path, value),
  copyFile: (...args: [string, string]) => copy(...args),
}));
vi.mock("./private-directory.js", () => ({ securePrivateDirectory: (...args: [string]) => secure(...args) }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => launch(...args) }));
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let descriptor: Record<string, unknown>, manifest: Record<string, unknown>;
// Use canonical host paths even though every filesystem operation is mocked.
const config = { runtimeRoot: resolve("/trusted"), userDataRoot: resolve("/userdata") };
const runtimePath = (path: string) => join(config.runtimeRoot, path);
const userPath = (path: string) => join(config.userDataRoot, path);
const signal = () => new AbortController().signal;
function saveManifest() {
  const text = JSON.stringify(manifest, null, 2) + "\n"; put(runtimePath("package/runtime-manifest.json"), text);
  (descriptor.package as Record<string, unknown>).digest = sha(text); saveDescriptor();
}
function saveDescriptor() { put(runtimePath("runtime-descriptor.json"), JSON.stringify(descriptor)); }
beforeEach(() => {
  files.clear(); directories.clear(); links.clear(); hardlinks.clear(); vi.clearAllMocks(); addDirectory(config.userDataRoot); addDirectory(config.runtimeRoot);
  const pins = NATIVE_BACKEND_RUNTIME_PATHS.map(path => {
    const content = "synthetic " + path; put(runtimePath("package/" + path), content);
    return { path, bytes: Buffer.byteLength(content), sha256: path === "node.exe" ? "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9" : sha(content) };
  });
  manifest = { schema: 1, protocol: 2, node: { version: "24.22.2", archive: "node-v24.22.2-win-x64.zip", archiveSha256: "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2", executableSha256: "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9" }, files: pins };
  put(runtimePath("bin/backend-broker.exe"), "synthetic broker"); put(runtimePath("build-manifest.json"), "synthetic build manifest");
  descriptor = { schema: 1, protocol: 2, id: "tahtiapuri-native-backend-v2", broker: { path: "bin/backend-broker.exe", bytes: 16, sha256: sha("synthetic broker") },
    package: { path: "package", manifest: "runtime-manifest.json", digest: "" }, buildManifest: { path: "build-manifest.json", sha256: sha("synthetic build manifest") } };
  (descriptor.broker as Record<string, unknown>).bytes = Buffer.byteLength("synthetic broker"); saveManifest();
});
it("derives the fixed state root and original pinned broker solely from trusted composition", async () => {
  const runtime = await loadNativeBackendRuntime(config, signal());
  expect(runtime.stateRoot).toBe(userPath("backend-state")); expect(runtime.broker).toBe(runtimePath("bin/backend-broker.exe"));
  expect(runtime.files).toHaveLength(41); expect(runtime.files.at(-1)?.path).toBe("runtime-manifest.json"); expect(mkdir).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
});
it("rejects a descriptor that introduces a different executable, state path, or arguments", async () => {
  descriptor.arguments = ["untrusted"]; saveDescriptor(); await expect(loadNativeBackendRuntime(config, signal())).rejects.toThrow("rejected");
  delete descriptor.arguments; (descriptor.broker as Record<string, unknown>).path = "bin/other.exe"; saveDescriptor(); await expect(loadNativeBackendRuntime(config, signal())).rejects.toThrow("rejected");
});
it("rejects a changed pinned broker before staging or launch", async () => {
  put(runtimePath("bin/backend-broker.exe"), "modified broker!"); await expect(loadNativeBackendRuntime(config, signal())).rejects.toThrow("rejected"); expect(secure).not.toHaveBeenCalled();
});
it("rechecks the same broker identity and digest immediately before later ownership", async () => {
  const runtime = await loadNativeBackendRuntime(config, signal()); put(runtime.broker, "modified broker!");
  await expect(runtime.verifyBroker(signal())).rejects.toThrow("rejected");
});
it("rejects additional files/directories and a manifest that extends the closed closure", async () => {
  put(runtimePath("package/extra.js"), "extra"); await expect(loadNativeBackendRuntime(config, signal())).rejects.toThrow("rejected"); files.delete(runtimePath("package/extra.js"));
  (manifest.files as unknown[]).push({ path: "extra.js", bytes: 5, sha256: sha("extra") }); saveManifest(); await expect(loadNativeBackendRuntime(config, signal())).rejects.toThrow("rejected");
});
it("rejects package hardlinks and redirected ancestors", async () => {
  hardlinks.add(runtimePath("package/node.exe")); await expect(loadNativeBackendRuntime(config, signal())).rejects.toThrow("rejected"); hardlinks.clear();
  links.add(runtimePath("package/node_modules")); await expect(loadNativeBackendRuntime(config, signal())).rejects.toThrow("rejected");
});
it("rejects a manifest changed without updating the trusted descriptor digest", async () => {
  put(runtimePath("package/runtime-manifest.json"), "{}"); await expect(loadNativeBackendRuntime(config, signal())).rejects.toThrow("rejected");
});
it("keeps backend-state uncreated while a failed preparation cleans only its own marked session", async () => {
  const runtime = await loadNativeBackendRuntime(config, signal());
  // Synthetic node cannot match the actual official Node pin: fail during staging.
  const preparing = signal();
  await expect(prepareNativeBackendResources(runtime, preparing)).rejects.toThrow("rejected");
  const sessions = userPath("native-backend/sessions");
  expect(secure).toHaveBeenCalledWith(sessions, preparing); expect(directories.has(runtime.stateRoot)).toBe(false);
  expect(remove).toHaveBeenCalledOnce(); const removedRoot = remove.mock.calls[0]![0];
  expect(dirname(removedRoot)).toBe(sessions); expect(basename(removedRoot)).toMatch(/^run-[a-f0-9]{32}$/);
  expect(files.has(runtimePath("package/node.exe"))).toBe(true); expect(launch).not.toHaveBeenCalled();
});
it("does not begin preparation or private-directory changes for a cancelled caller", async () => {
  const runtime = await loadNativeBackendRuntime(config, signal()), abort = new AbortController(); abort.abort();
  await expect(prepareNativeBackendResources(runtime, abort.signal)).rejects.toThrow(); expect(secure).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
});
it("uses fixed hidden pipe launch options and excludes inherited Node/proxy options", async () => {
  const runtime = await loadNativeBackendRuntime(config, signal()), systemRoot = resolve("/windows"); vi.stubEnv("SystemRoot", systemRoot); vi.stubEnv("NODE_OPTIONS", "untrusted");
  try { expect(nativeBackendSpawnOptions(runtime)).toEqual({ cwd: config.runtimeRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32") } }); }
  finally { vi.unstubAllEnvs(); }
});

// Keep every synthetic component below Windows' component limit while varying
// the complete normal path length. No real directory is created.
function sizedPath(length: number): string {
  let path = resolve("/path-fixture");
  while (length - path.length > 100) path = join(path, "s".repeat(80));
  return join(path, "s".repeat(length - path.length - 1));
}
it.each([251, 259])("rejects package process paths of length %i before private staging", async packageLength => {
  const runtime = await loadNativeBackendRuntime(config, signal());
  const suffix = join("native-backend/sessions", `run-${"0".repeat(32)}`, "package");
  const userDataRoot = sizedPath(packageLength - suffix.length - 1);
  addDirectory(userDataRoot);
  await expect(prepareNativeBackendResources({ ...runtime, userDataRoot }, signal())).rejects.toThrow("rejected");
  expect(secure).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
});
it("stages long package descendants when the Node executable is exactly 259 characters", async () => {
  const loaded = await loadNativeBackendRuntime(config, signal());
  const suffix = join("native-backend/sessions", `run-${"0".repeat(32)}`, "package");
  const userDataRoot = sizedPath(250 - suffix.length - 1); addDirectory(userDataRoot);
  // This test exercises staging, using synthetic bytes instead of an installed
  // official Node executable. The loaded production closure remains unchanged.
  const runtime = { ...loaded, userDataRoot, files: loaded.files.map(pin => pin.path === "node.exe" ? { ...pin, sha256: sha(files.get(runtimePath("package/node.exe"))!) } : pin) };
  const resources = await prepareNativeBackendResources(runtime, signal());
  expect(join(resources.root, "package/node.exe")).toHaveLength(259);
  expect(copy).toHaveBeenCalledTimes(runtime.files.length);
  const destinations = copy.mock.calls.map(([, destination]) => destination);
  expect(destinations.some(path => path.length > 260 && dirname(path).length > 260)).toBe(true);
  expect(destinations.every(path => files.has(path))).toBe(true);
  expect(secure).toHaveBeenCalledOnce(); expect(launch).not.toHaveBeenCalled();
  await resources.discardBeforeLaunch(); expect(remove).toHaveBeenCalledWith(resources.root, { recursive: true });
});
it("admits the normal process path boundaries and rejects either overflow before launch", async () => {
  const runtime = await loadNativeBackendRuntime(config, signal()); vi.stubEnv("SystemRoot", resolve("/windows"));
  try {
    const bounded = { ...runtime, runtimeRoot: sizedPath(258), broker: sizedPath(259) };
    expect(nativeBackendSpawnOptions(bounded).cwd).toHaveLength(258);
    expect(() => nativeBackendSpawnOptions({ ...bounded, runtimeRoot: sizedPath(259) })).toThrow("rejected");
    expect(() => nativeBackendSpawnOptions({ ...bounded, broker: sizedPath(260) })).toThrow("rejected");
    await expect(prepareNativeBackendResources({ ...runtime, runtimeRoot: sizedPath(259) }, signal())).rejects.toThrow("rejected");
    await expect(prepareNativeBackendResources({ ...runtime, broker: sizedPath(260) }, signal())).rejects.toThrow("rejected");
    expect(secure).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});
