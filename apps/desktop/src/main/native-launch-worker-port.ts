import { Worker } from "node:worker_threads";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { NativeLaunchSupervisor, type NativeLaunchPort } from "./native-launch-supervisor.js";
import { launchKeys, launchRecord, nativeLaunchWorkerConfig, type NativeLaunchWorkerConfig } from "./native-launch-worker-config.js";

export const NATIVE_LAUNCH_WORKER_FILES = Object.freeze(["native-launch-worker.js", "native-launch-worker-core.js",
  "native-launch-worker-config.js", "native-launch-gate.js", "native-recovery-grant.js", "native-directory-grant.js"] as const);
type FilePin = Readonly<{ bytes: number; sha256: string }>;
export interface NativeLaunchBinding {
  readonly config: NativeLaunchWorkerConfig;
  /** Independently trusted build approval, including the proved grant protocol;
   * a colocated, worker-supplied or user-selected manifest is not this trust. */
  readonly recoverProtocol: "THREC001";
  readonly programs: Readonly<Record<"identity" | "bootstrap" | "broker", FilePin>>;
  readonly compiled: Readonly<Record<typeof NATIVE_LAUNCH_WORKER_FILES[number], FilePin>>;
}
let claimed = false; // One binding/owner in this Main module's lifetime; never reset.
function pins<T extends string>(value: unknown, names: readonly T[], maximum: number): Readonly<Record<T, FilePin>> {
  if (!launchRecord(value) || !launchKeys(value, names)) throw new Error("Invalid native launch build pins");
  const result = {} as Record<T, FilePin>;
  for (const name of names) {
    const pin = value[name];
    if (!launchRecord(pin) || !launchKeys(pin, ["bytes", "sha256"]) || !Number.isSafeInteger(pin.bytes)
      || typeof pin.bytes !== "number" || pin.bytes < 1 || pin.bytes > maximum
      || typeof pin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error("Invalid native launch file pin");
    result[name] = Object.freeze({ bytes: pin.bytes, sha256: pin.sha256 });
  }
  return Object.freeze(result);
}
async function directory(path: string, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted(); const stat = await lstat(path); signal.throwIfAborted();
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(path, await realpath(path)) !== "")
      throw new Error("Redirected native launch directory");
    signal.throwIfAborted(); const parent = dirname(path); if (parent === path) return; path = parent;
  }
}
async function verifyFile(path: string, pin: FilePin, signal: AbortSignal) {
  await directory(dirname(path), signal); signal.throwIfAborted();
  const named = await lstat(path); signal.throwIfAborted();
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size !== pin.bytes
    || relative(path, await realpath(path)) !== "") throw new Error("Native launch pinned file differs");
  signal.throwIfAborted(); const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    signal.throwIfAborted(); const before = await file.stat(); signal.throwIfAborted();
    const bytes = Buffer.alloc(pin.bytes + 1); let used = 0;
    while (used < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, used, bytes.length - used, used); signal.throwIfAborted();
      if (!read.bytesRead) break; used += read.bytesRead;
    }
    const after = await file.stat(); signal.throwIfAborted(); const current = await lstat(path); signal.throwIfAborted();
    for (const key of ["dev", "ino", "size", "nlink", "mtimeMs", "ctimeMs"] as const)
      if (named[key] !== before[key] || before[key] !== after[key] || after[key] !== current[key])
        throw new Error("Native launch pinned file changed during verification");
    if (!current.isFile() || current.isSymbolicLink() || used !== pin.bytes
      || createHash("sha256").update(bytes.subarray(0, used)).digest("hex") !== pin.sha256)
      throw new Error("Native launch bytes differ from approved build");
  } finally { await file.close(); }
}
/** These compiled, fixed URLs never resolve a source/eval/fallback entry.
 * Same-user/admin program mutation is trusted, as for Main's own application
 * code. Verification is not a native write/delete-excluding executable pin. */
function port(config: NativeLaunchWorkerConfig): NativeLaunchPort {
  const worker = new Worker(new URL("./native-launch-worker.js", import.meta.url), {
    workerData: config, execArgv: [], argv: [], env: {}, stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    trackUnmanagedFds: true,
  });
  let failed = false, errorListener: (() => void) | undefined;
  const error = () => { if (failed) return; failed = true; errorListener?.(); };
  worker.on("error", error); worker.on("messageerror", error);
  // Drain, collect no text, and fail on any unstructured worker output.
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.on("data", error); stream.on("error", error);
  }
  return Object.freeze({
    onMessage(listener) { worker.on("message", listener); },
    onError(listener) { errorListener = listener; if (failed) queueMicrotask(listener); },
    onExit(listener) { worker.once("exit", listener); },
    postMessage(value, transfer) { worker.postMessage(value, transfer); },
  } satisfies NativeLaunchPort);
}
/** Call exactly once from trusted Main composition, before constructing a Host.
 * The immediate control parent already exists and is Main-trusted/private;
 * only its control leaf may be absent. The same resource owner must prepare
 * that leaf before other operations. Retain this returned
 * supervisor through failure/shutdown; never call this loader to reset it.
 * Caller owns the in-flight preparation promise even when its UI times out.
 * No application resource loader or default runtime selects this adapter yet. */
export async function loadNativeLaunchWorkerSupervisor(binding: NativeLaunchBinding, signal: AbortSignal) {
  if (claimed) throw new Error("Native Main launch lifetime already claimed");
  claimed = true; // Before validation, asynchronous IO or re-entrant callbacks.
  if (process.platform !== "win32" || !launchRecord(binding)
    || !launchKeys(binding, ["config", "recoverProtocol", "programs", "compiled"]) || binding.recoverProtocol !== "THREC001")
    throw new Error("Native launch binding lacks approved recovery protocol");
  const config = nativeLaunchWorkerConfig(binding.config);
  const programs = pins(binding.programs, ["identity", "bootstrap", "broker"] as const, 4 * 1024 ** 2);
  const compiled = pins(binding.compiled, NATIVE_LAUNCH_WORKER_FILES, 128 * 1024);
  // Only the control leaf may be absent. Its existing immediate parent and
  // every ancestor remain mandatory; only true ENOENT means an absent leaf.
  const controlDirectory = dirname(config.controlFile);
  signal.throwIfAborted(); await directory(dirname(controlDirectory), signal); signal.throwIfAborted();
  let existingLeaf = true;
  try { await lstat(controlDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; existingLeaf = false; }
  signal.throwIfAborted();
  if (existingLeaf) await directory(controlDirectory, signal);
  signal.throwIfAborted();
  for (const name of ["identity", "bootstrap", "broker"] as const) await verifyFile(config[name], programs[name], signal);
  const root = dirname(fileURLToPath(import.meta.url));
  for (const name of NATIVE_LAUNCH_WORKER_FILES) await verifyFile(join(root, name), compiled[name], signal);
  signal.throwIfAborted();
  return new NativeLaunchSupervisor(() => port(config));
}
