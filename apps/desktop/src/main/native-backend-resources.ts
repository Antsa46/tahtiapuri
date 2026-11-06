import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, opendir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { decodeJson } from "@tahtiapuri/backend-transport";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { securePrivateDirectory } from "./private-directory.js";
import { NativeBackendPort, type NativeBackendProcess, type NativeBackendResult } from "./native-backend-port.js";

const NODE = { version: "24.22.2", archive: "node-v24.22.2-win-x64.zip", archiveSha256: "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2", executableSha256: "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9" };
const SAFETY_POLICY = "process-witness-v1";
const backendFiles = ["runtime/stdio-backend", "composition/create-backend", "composition/create-observing", "composition/create-sky", "ipc/endpoint", "modules/assistant/adapters/parent-model-engine", "modules/assistant/application/assistant-service", "modules/development/application/development-service", "modules/observing/adapters/json-places-repository", "modules/observing/application/places-service", "modules/observing/ports/places-repository", "modules/runtime/application/get-runtime-status", "modules/sky/adapters/astronomy-calculator", "modules/sky/adapters/local-star-catalog", "modules/sky/application/sky-queries", "modules/sky/application/sky-service"];
/** This production closure is deliberately independent of build scripts and test fixtures. */
export const NATIVE_BACKEND_RUNTIME_PATHS: readonly string[] = Object.freeze([
  ...backendFiles.map(path => `backend/dist/${path}.js`),
  ...["index", "observing/places", "sky/horizon", "sky/time", "sky/types"].map(path => `node_modules/@tahtiapuri/domain/dist/${path}.js`),
  ...["assistant", "backend-protocol", "development", "development-framing", "model-wire", "observing", "public-api", "sky"].map(path => `node_modules/@tahtiapuri/validation/dist/${path}.js`),
  "node_modules/@tahtiapuri/backend-transport/dist/index.js",
  ...["domain", "validation", "backend-transport"].map(name => `node_modules/@tahtiapuri/${name}/package.json`),
  "node_modules/astronomy-engine/package.json", "node_modules/astronomy-engine/esm/astronomy.js",
  "resources/catalogs/manifest.json", "resources/catalogs/stars.json", "node.exe", "licenses/node-LICENSE.txt", "package.json",
].sort());
type Pin = { readonly path: string; readonly bytes: number; readonly sha256: string };
type Descriptor = { schema: 1; protocol: 2; id: "tahtiapuri-native-backend-v2"; safetyPolicy: typeof SAFETY_POLICY; broker: Pin; package: { path: "package"; manifest: "runtime-manifest.json"; digest: string }; buildManifest: { path: "build-manifest.json"; sha256: string } };
/** Paths are supplied only by trusted Electron composition, never renderer/MCP input. */
export interface NativeBackendResourceConfig { runtimeRoot: string; userDataRoot: string }
export interface NativeBackendRuntime {
  readonly runtimeRoot: string;
  readonly userDataRoot: string;
  readonly stateRoot: string;
  readonly broker: string;
  readonly digest: string;
  readonly files: readonly Pin[];
  verifyBroker(signal: AbortSignal): Promise<void>;
}
export interface PreparedNativeBackendResources {
  readonly runtime: NativeBackendRuntime;
  readonly runNonce: string;
  readonly ownerNonce: string;
  readonly root: string;
  /** Only before any broker launch; uncertain native ownership must use recover. */
  discardBeforeLaunch(): Promise<void>;
}
const launchedResources = new WeakSet<PreparedNativeBackendResources>();
const denied = (): never => { throw new Error("Native backend resources rejected."); };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && /^[A-Za-z0-9@_./-]+$/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== ".." && !part.endsWith(".") && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function pin(value: unknown): value is Pin {
  return isRecord(value) && exactKeys(value, ["path", "bytes", "sha256"]) && typeof value.path === "string" && safePath(value.path)
    && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 167772160 && hash(value.sha256);
}
function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0") || path.startsWith("\\\\") || path.startsWith("//")) denied();
  if (process.platform === "win32") {
    if (path.length < 4 || path.length > 1800 || !/^[A-Z]:\\/.test(path) || path.includes("/")) denied();
    for (const part of path.slice(3).split("\\")) {
      if (!part || part === "." || part === ".." || /[. ]$/.test(part) || /[\x00-\x1f"<>|?*:]/.test(part)
        || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *$/i.test(part.split(".")[0]!)) denied();
    }
  }
}
function requireProcessPaths(cwd: string, executable: string): void {
  canonical(cwd); canonical(executable);
  if (cwd.length > 258 || executable.length > 259) denied();
}
async function directory(path: string): Promise<void> {
  canonical(path); let component = path;
  for (;;) {
    const info = await lstat(component);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(component, await realpath(component)) !== "") denied();
    const parent = dirname(component); if (parent === component) return; component = parent;
  }
}
async function regular(path: string, expectedBytes?: number) {
  await directory(dirname(path)); const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 167772160 || expectedBytes !== undefined && info.size !== expectedBytes || relative(path, await realpath(path)) !== "") denied();
  return info;
}
async function bytes(path: string, signal: AbortSignal, limit: number, expected?: Pin): Promise<Buffer> {
  signal.throwIfAborted(); const beforePath = await regular(path, expected?.bytes);
  if (beforePath.size > limit) denied();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    for (const key of ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"] as const) if (before[key] !== beforePath[key]) denied();
    const content = await handle.readFile({ signal }), after = await handle.stat();
    for (const key of ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"] as const) if (before[key] !== after[key]) denied();
    const afterPath = await regular(path, expected?.bytes);
    for (const key of ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"] as const) if (afterPath[key] !== after[key]) denied();
    if (content.length !== before.size || expected && digest(content) !== expected.sha256) denied();
    signal.throwIfAborted(); return content;
  } finally { await handle.close(); }
}
function descriptor(value: unknown): Descriptor {
  if (!isRecord(value) || !exactKeys(value, ["schema", "protocol", "id", "safetyPolicy", "broker", "package", "buildManifest"]) || value.schema !== 1 || value.protocol !== 2 || value.id !== "tahtiapuri-native-backend-v2" || value.safetyPolicy !== SAFETY_POLICY
    || !pin(value.broker) || value.broker.path !== "bin/backend-broker.exe" || !isRecord(value.package) || !exactKeys(value.package, ["path", "manifest", "digest"])
    || value.package.path !== "package" || value.package.manifest !== "runtime-manifest.json" || !hash(value.package.digest)
    || !isRecord(value.buildManifest) || !exactKeys(value.buildManifest, ["path", "sha256"]) || value.buildManifest.path !== "build-manifest.json" || !hash(value.buildManifest.sha256)) return denied();
  return value as Descriptor;
}
function buildManifest(value: unknown, metadata: Descriptor): void {
  // Compatibility admission inside the trusted build chain, not a signature.
  if (!isRecord(value) || value.schema !== metadata.schema || value.protocol !== metadata.protocol
    || value.safetyPolicy !== metadata.safetyPolicy || value.runtimePackageDigest !== metadata.package.digest || !Array.isArray(value.files)) return denied();
  const brokerPins = value.files.filter((file: unknown) => isRecord(file) && file.path === metadata.broker.path);
  if (brokerPins.length !== 1 || !isRecord(brokerPins[0]) || brokerPins[0].sha256 !== metadata.broker.sha256) denied();
}
function manifest(value: unknown): readonly Pin[] {
  if (!isRecord(value) || !exactKeys(value, ["schema", "protocol", "node", "files"]) || value.schema !== 1 || value.protocol !== 2
    || !isRecord(value.node) || !exactKeys(value.node, Object.keys(NODE)) || Object.entries(NODE).some(([key, valueAtKey]) => (value.node as Record<string, unknown>)[key] !== valueAtKey)
    || !Array.isArray(value.files) || value.files.length !== NATIVE_BACKEND_RUNTIME_PATHS.length
    || value.files.some((item, i) => !pin(item) || item.path !== NATIVE_BACKEND_RUNTIME_PATHS[i])
    || value.files.find(item => item.path === "node.exe")?.sha256 !== NODE.executableSha256) return denied();
  return Object.freeze((value.files as Pin[]).map(item => Object.freeze({ ...item })));
}
async function closedTree(root: string, files: readonly Pin[], signal: AbortSignal): Promise<void> {
  await directory(root);
  const expected = new Set(files.map(file => file.path)), directories = new Set([""]);
  for (const file of files) { const parts = file.path.split("/"); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/")); }
  let count = 0;
  async function walk(path: string, prefix = "", depth = 0): Promise<void> {
    if (depth > 12) denied(); signal.throwIfAborted();
    const entries = await opendir(path, { bufferSize: 1 });
    for await (const entry of entries) {
      if (++count > 192) denied();
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safePath(name)) denied();
      const full = join(path, entry.name), info = await lstat(full);
      if (info.isSymbolicLink() || relative(full, await realpath(full)) !== "") denied();
      if (info.isDirectory()) { if (!directories.has(name)) denied(); await walk(full, name, depth + 1); }
      else if (!info.isFile() || info.nlink !== 1 || !expected.delete(name)) denied();
    }
  }
  await walk(root); if (expected.size) denied();
}
export async function loadNativeBackendRuntime(config: NativeBackendResourceConfig, signal: AbortSignal): Promise<NativeBackendRuntime> {
  canonical(config.runtimeRoot); canonical(config.userDataRoot); await directory(config.runtimeRoot); await directory(config.userDataRoot);
  if (dirname(config.runtimeRoot) === config.runtimeRoot || dirname(config.userDataRoot) === config.userDataRoot) denied();
  const descriptorBytes = await bytes(join(config.runtimeRoot, "runtime-descriptor.json"), signal, 16384);
  const descriptorDigest = digest(descriptorBytes);
  const metadata = descriptor(decodeJson(descriptorBytes));
  const manifestBytes = await bytes(join(config.runtimeRoot, "package/runtime-manifest.json"), signal, 65536);
  if (digest(manifestBytes) !== metadata.package.digest) denied();
  const files = [...manifest(decodeJson(manifestBytes)), Object.freeze({ path: "runtime-manifest.json", bytes: manifestBytes.length, sha256: metadata.package.digest })];
  await closedTree(join(config.runtimeRoot, "package"), files, signal);
  const broker = join(config.runtimeRoot, metadata.broker.path);
  requireProcessPaths(config.runtimeRoot, broker);
  const verifyBroker = async (operationSignal: AbortSignal) => {
    // Recheck the admitted metadata and binary before staging and each launch.
    const currentDescriptor = await bytes(join(config.runtimeRoot, "runtime-descriptor.json"), operationSignal, 16384);
    if (digest(currentDescriptor) !== descriptorDigest) denied();
    descriptor(decodeJson(currentDescriptor));
    const buildBytes = await bytes(join(config.runtimeRoot, "build-manifest.json"), operationSignal, 65536);
    if (digest(buildBytes) !== metadata.buildManifest.sha256) denied();
    buildManifest(decodeJson(buildBytes), metadata);
    await bytes(broker, operationSignal, 167772160, metadata.broker);
  };
  await verifyBroker(signal);
  return Object.freeze({ runtimeRoot: config.runtimeRoot, userDataRoot: config.userDataRoot, stateRoot: join(config.userDataRoot, "backend-state"), broker, digest: metadata.package.digest, files: Object.freeze(files), verifyBroker });
}
async function ownTree(root: string, marker: string): Promise<void> {
  await directory(root);
  if ((await regular(join(root, "owner.marker"))).size > 256 || await readFile(join(root, "owner.marker"), "utf8") !== marker) denied();
  let count = 0;
  async function walk(path: string, depth = 0): Promise<void> {
    if (depth > 12) denied();
    for await (const entry of await opendir(path, { bufferSize: 1 })) {
      if (++count > 200) denied(); const full = join(path, entry.name), info = await lstat(full);
      if (info.isSymbolicLink() || relative(full, await realpath(full)) !== "") denied();
      if (info.isDirectory()) await walk(full, depth + 1); else if (!info.isFile() || info.nlink !== 1) denied();
    }
  }
  await walk(root);
}
export async function prepareNativeBackendResources(runtime: NativeBackendRuntime, signal: AbortSignal): Promise<PreparedNativeBackendResources> {
  signal.throwIfAborted();
  const parent = join(runtime.userDataRoot, "native-backend/sessions");
  const runNonce = randomBytes(16).toString("hex"), ownerNonce = randomBytes(32).toString("hex"), root = join(parent, `run-${runNonce}`);
  // Admission precedes the private-directory helper and every staging write.
  requireProcessPaths(runtime.runtimeRoot, runtime.broker);
  requireProcessPaths(join(root, "package"), join(root, "package/node.exe"));
  await runtime.verifyBroker(signal);
  // backend-state is exclusively created/validated by the native recovery owner.
  await securePrivateDirectory(parent, signal); await directory(parent);
  const marker = `TAHTIAPURI_BACKEND_SESSION_V1\n${runNonce}\n${runtime.digest}\n`;
  await mkdir(root); let marked = false;
  try {
    await writeFile(join(root, "owner.marker"), marker, { flag: "wx" }); marked = true;
    await mkdir(join(root, "package")); await mkdir(join(root, "scratch"));
    await closedTree(join(runtime.runtimeRoot, "package"), runtime.files, signal);
    for (const file of runtime.files) {
      signal.throwIfAborted();
      const source = join(runtime.runtimeRoot, "package", file.path), destination = join(root, "package", file.path);
      await bytes(source, signal, 167772160, file);
      const parts = file.path.split("/").slice(0, -1); let component = join(root, "package");
      for (const part of parts) { component = join(component, part); try { await mkdir(component); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; } await directory(component); }
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await bytes(destination, signal, 167772160, file);
    }
    await closedTree(join(root, "package"), runtime.files, signal); signal.throwIfAborted();
    const resources: PreparedNativeBackendResources = { runtime, runNonce, ownerNonce, root, discardBeforeLaunch: async () => {
      if (launchedResources.has(resources)) denied(); await ownTree(root, marker); await rm(root, { recursive: true });
    } };
    return resources;
  } catch (error) {
    // No broker exists yet. Never remove an unmarked or redirected tree.
    if (marked) { await ownTree(root, marker); await rm(root, { recursive: true }); }
    throw error;
  }
}
export function nativeBackendSpawnOptions(runtime: NativeBackendRuntime): { cwd: string; windowsHide: true; stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv } {
  requireProcessPaths(runtime.runtimeRoot, runtime.broker);
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return denied();
  return { cwd: runtime.runtimeRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32") } };
}
export async function launchNativeBackend(resources: PreparedNativeBackendResources, signal: AbortSignal): Promise<NativeBackendPort> {
  signal.throwIfAborted(); await resources.runtime.verifyBroker(signal); signal.throwIfAborted();
  if (launchedResources.has(resources)) denied(); launchedResources.add(resources);
  const child = spawn(resources.runtime.broker, ["run", resources.runtime.stateRoot, resources.runNonce, resources.ownerNonce], nativeBackendSpawnOptions(resources.runtime));
  return new NativeBackendPort(child as NativeBackendProcess, { ownerNonce: resources.ownerNonce, runNonce: resources.runNonce });
}
export async function recoverNativeBackend(runtime: NativeBackendRuntime, signal: AbortSignal): Promise<NativeBackendResult> {
  signal.throwIfAborted(); await runtime.verifyBroker(signal); signal.throwIfAborted();
  const ownerNonce = randomBytes(32).toString("hex");
  const child = spawn(runtime.broker, ["recover", runtime.stateRoot, ownerNonce], nativeBackendSpawnOptions(runtime));
  const port = new NativeBackendPort(child as NativeBackendProcess, { ownerNonce, recover: true });
  const abort = () => { port.kill(); }; signal.addEventListener("abort", abort, { once: true });
  try { const result = await port.completion; signal.throwIfAborted(); if (result.sessionOutcome !== "recovered" || result.error !== 0 || result.reason !== "none") denied(); return result; }
  finally { signal.removeEventListener("abort", abort); await port.closure; }
}
