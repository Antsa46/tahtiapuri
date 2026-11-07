import { NativeOperationDeadlineError, requireNativeOperationDeadline } from "./native-operation-deadline.js";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { loadNativeMcpHelpers, type NativeMcpHelpers, type NativeMcpHelperPins } from "./native-mcp-helpers.js";

import { runNativeMcpSessionOperation, type NativeMcpSessionOperation } from "./native-mcp-session-operation.js";
import { NATIVE_BOOTSTRAP_BYTES } from "./native-development-bootstrap.js";

const NODE = Object.freeze({ version: "24.22.2", archive: "node-v24.22.2-win-x64.zip",
  archiveSha256: "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2",
  executableSha256: "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9",
  licenseSha256: "ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9" });
const workerNames = ["licenses/mcp-core-LICENSE.txt", "licenses/mcp-server-LICENSE.txt", "licenses/node-LICENSE.txt",
  "licenses/zod-LICENSE.txt", "mcp-worker.mjs", "node.exe", "package.json"] as const;
const packageJson = Buffer.from('{"type":"module","private":true}\n');
type Pin = Readonly<{ bytes: number; sha256: string }>;
type FilePin = Pin & Readonly<{ path: string }>;
type Descriptor = { schema: 1; id: "tahtiapuri-native-mcp-v1"; protocols: ["TMCT/1", "TMCP/1"];
  broker: Pin; helpers: NativeMcpHelperPins; package: { path: "package"; manifest: "runtime-manifest.json"; digest: string }; buildManifestSha256: string };
/** Trusted Main composition supplies the digest independently of the package. */
export interface NativeMcpResourceConfig { readonly runtimeRoot: string; readonly descriptorSha256: string }
export interface NativeMcpHostResources {
  readonly helpers: NativeMcpHelpers;
  /** Fixed native preparation/publication; no worker-selected operation. */
  session(operation: NativeMcpSessionOperation, file: string, bytes: Buffer, signal: AbortSignal, deadline?: number): Promise<void>;
  /** Only a fresh Main-owned fixed reservation; never starts or repairs a process. */
  prepareWorker(reservation: string, signal: AbortSignal): Promise<void>;
}
export interface NativeMcpRuntime extends NativeMcpHostResources { readonly broker: string; readonly packageDigest: string }
/** Trusted-Main capabilities from one externally pinned descriptor. Loading
 * and revalidation are read-only; explicit staging writes only the fixed file
 * cohort. Neither capability starts a helper. The launch factory binds both
 * to one control root and its package-derived Worker. */
export interface NativeMcpLaunchPackage {
  readonly runtimeRoot: string;
  readonly descriptorSha256: string;
  readonly programs: Readonly<Record<"identity" | "bootstrap" | "broker", Pin>>;
  verifyLaunch(signal: AbortSignal): Promise<void>;
  /** Internal trusted-Main staging capability. The factory binds reservation
   * once; no execution, ACL grant, deletion or recovery. Original hrtime cap
   * is mandatory and never replaced by a fresh timeout here. */
  stageWorker(reservation: string, signal: AbortSignal, deadline: bigint): Promise<void>;
}

const denied = (): never => { throw new Error("Native MCP runtime package rejected."); };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function canonical(path: string): void {
  if (process.platform !== "win32" || !/^[A-Z]:\\/.test(path) || win32.normalize(path) !== path || resolve(path) !== path
    || path.length < 4 || path.length > 1800 || path.includes("/") || path === win32.parse(path).root) denied();
  for (const part of path.slice(3).split("\\")) {
    if (!part || /[. ]$/.test(part) || /[\x00-\x1f"<>|?*:]/.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *$/i.test(part.split(".")[0]!)) denied();
  }
}
async function directory(path: string, signal: AbortSignal): Promise<void> {
  canonical(path);
  for (;;) {
    signal.throwIfAborted(); const info = await lstat(path); signal.throwIfAborted();
    if (!info.isDirectory() || info.isSymbolicLink() || relative(path, await realpath(path)) !== "") denied();
    signal.throwIfAborted(); const parent = dirname(path); if (parent === path) return; path = parent;
  }
}
async function read(path: string, signal: AbortSignal, limit: number, expected?: Pin): Promise<Buffer> {
  await directory(dirname(path), signal); signal.throwIfAborted();
  const named = await lstat(path); signal.throwIfAborted();
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > limit
    || expected && named.size !== expected.bytes || relative(path, await realpath(path)) !== "") denied();
  signal.throwIfAborted(); const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    signal.throwIfAborted(); const before = await handle.stat(); signal.throwIfAborted();
    for (const field of ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"] as const)
      if (named[field] !== before[field]) denied();
    const storage = Buffer.allocUnsafe(before.size + 1); let used = 0;
    while (used < storage.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(storage, used, storage.length - used, used); signal.throwIfAborted();
      if (!bytesRead) break; used += bytesRead;
    }
    if (used !== before.size) denied(); const content = storage.subarray(0, used);
    const after = await handle.stat(); signal.throwIfAborted(); const current = await lstat(path); signal.throwIfAborted();
    for (const field of ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"] as const)
      if (named[field] !== before[field] || before[field] !== after[field] || after[field] !== current[field]) denied();
    if (!current.isFile() || current.isSymbolicLink() || content.length !== before.size || expected && sha(content) !== expected.sha256) denied();
    return content;
  } finally { await handle.close(); }
}
function decode(bytes: Buffer): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function pin(value: unknown, limit: number): value is Pin {
  return isRecord(value) && exactKeys(value, ["bytes", "sha256"]) && Number.isSafeInteger(value.bytes)
    && typeof value.bytes === "number" && value.bytes > 0 && value.bytes <= limit && hash(value.sha256);
}
function descriptor(value: unknown): Descriptor {
  if (!isRecord(value) || !exactKeys(value, ["schema", "id", "protocols", "broker", "helpers", "package", "buildManifestSha256"])
    || value.schema !== 1 || value.id !== "tahtiapuri-native-mcp-v1" || !Array.isArray(value.protocols)
    || value.protocols.length !== 2 || value.protocols[0] !== "TMCT/1" || value.protocols[1] !== "TMCP/1"
    || !pin(value.broker, 4194304) || !isRecord(value.helpers) || !exactKeys(value.helpers, ["main-bootstrap.exe", "main-identity.exe"])
    || !pin(value.helpers["main-bootstrap.exe"], 4194304) || !pin(value.helpers["main-identity.exe"], 4194304)
    || !isRecord(value.package) || !exactKeys(value.package, ["path", "manifest", "digest"])
    || value.package.path !== "package" || value.package.manifest !== "runtime-manifest.json" || !hash(value.package.digest)
    || !hash(value.buildManifestSha256)) return denied();
  return value as unknown as Descriptor;
}
function manifest(value: unknown): readonly FilePin[] {
  if (!isRecord(value) || !exactKeys(value, ["schema", "protocol", "node", "entry", "files"])
    || value.schema !== 1 || value.protocol !== "TMCP/1" || value.entry !== "mcp-worker.mjs" || !isRecord(value.node)
    || !exactKeys(value.node, Object.keys(NODE)) || Object.entries(NODE).some(([key, data]) => (value.node as Record<string, unknown>)[key] !== data)
    || !Array.isArray(value.files) || value.files.length !== workerNames.length) return denied();
  const files: FilePin[] = [];
  for (let i = 0; i < workerNames.length; ++i) {
    const file: unknown = value.files[i];
    if (!isRecord(file) || !exactKeys(file, ["path", "bytes", "sha256"]) || typeof file.path !== "string" || file.path !== workerNames[i]
      || !pin({ bytes: file.bytes, sha256: file.sha256 }, file.path === "node.exe" ? 167772160 : 4194304)) return denied();
    files.push(Object.freeze({ path: file.path, bytes: file.bytes as number, sha256: file.sha256 as string }));
  }
  if (files.find(file => file.path === "node.exe")!.sha256 !== NODE.executableSha256
    || files.find(file => file.path === "licenses/node-LICENSE.txt")!.sha256 !== NODE.licenseSha256
    || files.find(file => file.path === "package.json")!.sha256 !== sha(packageJson)
    || files.find(file => file.path === "package.json")!.bytes !== packageJson.length) return denied();
  return Object.freeze(files);
}
async function children(path: string, expectedNames: readonly string[], signal: AbortSignal): Promise<void> {
  await directory(path, signal); const expected = new Set(expectedNames);
  signal.throwIfAborted(); const entries = await opendir(path, { bufferSize: 1 });
  try {
    signal.throwIfAborted();
    for await (const entry of entries) {
      signal.throwIfAborted(); if (!expected.delete(entry.name)) denied();
    }
  } finally {
    try { await entries.close(); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ERR_DIR_CLOSED")) throw error; }
  }
  signal.throwIfAborted(); if (expected.size) denied();
}
async function verifyPackage(root: string, files: readonly FilePin[], signal: AbortSignal): Promise<void> {
  await children(root, ["licenses", "mcp-worker.mjs", "node.exe", "package.json", "runtime-manifest.json"], signal);
  await children(join(root, "licenses"), workerNames.filter(name => name.startsWith("licenses/")).map(name => basename(name)), signal);
  for (const file of files) { signal.throwIfAborted(); await read(join(root, file.path), signal, file.bytes, file); signal.throwIfAborted(); }
}
function overlaps(a: string, b: string): boolean {
  const below = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep); };
  return below(a, b) || below(b, a);
}
/** Loading and worker staging never start a process. The explicit session port
 * starts only the reverified fixed broker's owner modes. No network, ACL grant,
 * deletion or recovery lives here. Ordinary owner/admin mutation is trusted;
 * byte/identity checks are not native write/delete-excluding executable pins. */
async function loadNativeMcpPackage(config: NativeMcpResourceConfig, signal: AbortSignal): Promise<{
  readonly runtime: NativeMcpRuntime; readonly launch: NativeMcpLaunchPackage;
}> {
  const root = config.runtimeRoot, descriptorSha256 = config.descriptorSha256;
  canonical(root); if (join(root, "helpers").length > 220 || !hash(descriptorSha256)) denied(); signal.throwIfAborted();
  const descriptorBytes = await read(join(root, "runtime-descriptor.json"), signal, 16384);
  if (sha(descriptorBytes) !== descriptorSha256) denied(); const metadata = descriptor(decode(descriptorBytes));
  const manifestBytes = await read(join(root, "package/runtime-manifest.json"), signal, 16384);
  if (sha(manifestBytes) !== metadata.package.digest) denied();
  const parsedFiles = manifest(decode(manifestBytes));
  const canonicalManifest = Buffer.from(JSON.stringify({ schema: 1, protocol: "TMCP/1", node: NODE, entry: "mcp-worker.mjs", files: parsedFiles }, null, 2) + "\n");
  if (!canonicalManifest.equals(manifestBytes)) denied();
  const files = Object.freeze([...parsedFiles, Object.freeze({ path: "runtime-manifest.json", bytes: manifestBytes.length, sha256: metadata.package.digest })]);
  const broker = join(root, "bin/mcp-broker.exe");
  const verifyBroker = async (operationSignal: AbortSignal) => {
    operationSignal.throwIfAborted();
    const current = await read(join(root, "runtime-descriptor.json"), operationSignal, 16384);
    if (sha(current) !== descriptorSha256) denied();
    const build = await read(join(root, "build-manifest.json"), operationSignal, 65536);
    if (sha(build) !== metadata.buildManifestSha256) denied();
    operationSignal.throwIfAborted(); await children(join(root, "bin"), ["mcp-broker.exe"], operationSignal);
    await read(broker, operationSignal, 4194304, metadata.broker); operationSignal.throwIfAborted();
  };
  const verify = async (operationSignal: AbortSignal) => {
    await verifyBroker(operationSignal); operationSignal.throwIfAborted();
    // Loading the helpers only verifies them. It cannot start either helper.
    await loadNativeMcpHelpers(join(root, "helpers"), metadata.helpers); operationSignal.throwIfAborted();
    await verifyPackage(join(root, "package"), files, operationSignal); operationSignal.throwIfAborted();
  };
  await verify(signal); signal.throwIfAborted();
  const helpers = await loadNativeMcpHelpers(join(root, "helpers"), metadata.helpers); signal.throwIfAborted();
  const stageWorker = async (reservation: string, operationSignal: AbortSignal, check: () => void): Promise<void> => {
    check(); canonical(reservation);
    const stage = join(reservation, "worker"), target = join(stage, "package");
    if (basename(reservation) !== "native-session-reserved" || overlaps(root, reservation) || target.length > 258 || join(target, "node.exe").length > 259) denied();
    check(); await verify(operationSignal); check();
    await children(reservation, [], operationSignal); check();
    for (const path of [stage, target, join(target, "licenses"), join(stage, "scratch")]) {
      check(); await mkdir(path); check(); await directory(path, operationSignal); check();
    }
    for (const file of files) {
      check(); const source = join(root, "package", file.path), destination = join(target, file.path);
      await read(source, operationSignal, file.bytes, file); check();
      await copyFile(source, destination, constants.COPYFILE_EXCL); check();
      await read(destination, operationSignal, file.bytes, file); check();
    }
    await children(reservation, ["worker"], operationSignal); check();
    await children(stage, ["package", "scratch"], operationSignal); check();
    await children(join(stage, "scratch"), [], operationSignal); check();
    await verifyPackage(target, files, operationSignal); check();
    await verify(operationSignal); check();
  };
  const runtime: NativeMcpRuntime = Object.freeze({ broker, packageDigest: metadata.package.digest, helpers,
    async session(operation: NativeMcpSessionOperation, file: string, bytes: Buffer, operationSignal: AbortSignal, deadline?: number) {
      if (!Buffer.isBuffer(bytes) || bytes.length !== NATIVE_BOOTSTRAP_BYTES) denied();
      const input = Buffer.from(bytes);
      try {
        operationSignal.throwIfAborted(); requireNativeOperationDeadline(deadline);
        await verifyBroker(operationSignal); operationSignal.throwIfAborted(); requireNativeOperationDeadline(deadline);
        await runNativeMcpSessionOperation(broker, operation, file, input, operationSignal, deadline);
      } finally { input.fill(0); }
    }, async prepareWorker(reservation: string, callerSignal: AbortSignal) {
    // Legacy entry retains its existing signal/30s policy. New resource owners
    // call the same package's explicit-deadline staging capability below.
    const operationSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(30000)]);
    await stageWorker(reservation, operationSignal, () => operationSignal.throwIfAborted());
  } });
  const launch: NativeMcpLaunchPackage = Object.freeze({ runtimeRoot: root, descriptorSha256,
    programs: Object.freeze({ identity: Object.freeze({ ...metadata.helpers["main-identity.exe"] }),
      bootstrap: Object.freeze({ ...metadata.helpers["main-bootstrap.exe"] }), broker: Object.freeze({ ...metadata.broker }) }),
    async verifyLaunch(operationSignal: AbortSignal) {
      await verifyBroker(operationSignal); operationSignal.throwIfAborted();
      await loadNativeMcpHelpers(join(root, "helpers"), metadata.helpers); operationSignal.throwIfAborted();
    },
    stageWorker(reservation: string, operationSignal: AbortSignal, deadline: bigint) {
      const check = () => {
        operationSignal.throwIfAborted();
        if (typeof deadline !== "bigint" || deadline <= 0n || process.hrtime.bigint() >= deadline)
          throw new NativeOperationDeadlineError();
      };
      return stageWorker(reservation, operationSignal, check);
    },
  });
  return Object.freeze({ runtime, launch });
}
/** Legacy runtime shape and existing timeout policy are retained. */
export async function loadNativeMcpRuntime(config: NativeMcpResourceConfig, signal: AbortSignal): Promise<NativeMcpRuntime> {
  return (await loadNativeMcpPackage(config, signal)).runtime;
}
/** Same-package launch/staging capabilities. Package paths/pins are captured
 * together; no separate verifier injection or legacy helper execution is
 * exposed by the factory. Loading itself never stages or executes. */
export async function loadNativeMcpLaunchPackage(config: NativeMcpResourceConfig, signal: AbortSignal): Promise<NativeMcpLaunchPackage> {
  return (await loadNativeMcpPackage(config, signal)).launch;
}
