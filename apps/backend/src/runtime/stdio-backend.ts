import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { BoundedWriter, FrameReader, KINDS, TRANSPORT_POLICY, decodeJson, encodeJson } from "@tahtiapuri/backend-transport";
import { isInitialize } from "@tahtiapuri/validation/backend";
import { createBackend } from "../composition/create-backend.js";
import { createObserving } from "../composition/create-observing.js";
import { createSky } from "../composition/create-sky.js";
import { SkyQueries } from "../modules/sky/application/sky-queries.js";
import { ParentModelEngine } from "../modules/assistant/adapters/parent-model-engine.js";
import { AssistantService } from "../modules/assistant/application/assistant-service.js";

const fault = (message: string, exitCode = 65) => Object.assign(new Error(message), { exitCode });
const SHUTDOWN_MS = 2000;
type FailurePhase = "data-root-root-lstat" | "data-root-root-realpath";
const failurePhases = new WeakMap<object, FailurePhase>();
async function diagnoseDataRootOperation<T>(operation: () => Promise<T>, phase: FailurePhase): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (typeof error === "object" && error !== null) failurePhases.set(error, phase);
    throw error;
  }
}
export function packagedCatalogDirectory(entryPath: string): string {
  // The closed staging layout is package/backend/dist/runtime/stdio-backend.js.
  // Three parents reach package/, whose resources/catalogs is pinned by its owner.
  // This entry is not launched from the repository's apps/backend/dist directory.
  return resolve(dirname(entryPath), "../../../resources/catalogs");
}
/** The native owner supplies a dedicated data directory, never the Electron data tree. */
export async function validateBackendDataRoot(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path) || path.includes("\0") || path.startsWith("\\\\") || path.startsWith("//"))
    throw fault("Invalid backend data root.", 64);
  // The native owner validates and pins the data root and its ancestors without
  // delete sharing for the worker lifetime; private ancestor metadata is not granted.
  // Exact root realpath comparison also rejects a redirect in any ancestor.
  const stat = await diagnoseDataRootOperation(() => lstat(path), "data-root-root-lstat");
  if (!stat.isDirectory() || stat.isSymbolicLink() || await diagnoseDataRootOperation(() => realpath(path), "data-root-root-realpath") !== path) throw fault("Noncanonical backend data root.", 64);
  if (path === parse(path).root) throw fault("Backend data root cannot be a volume root.", 64);
  return path;
}
export interface StdioBackendOptions {
  dataRoot: string;
  catalogDirectory: string;
  nonce: string;
  input: Readable;
  output: Writable;
  /** Unix clock for application request expiry. */
  now?: () => number;
  /** Monotonic clock for the owner heartbeat lease. */
  monotonicNow?: () => number;
}

/** Production application composition. Stream injection permits tests without a child process. */
export async function runStdioBackend(options: StdioBackendOptions): Promise<void> {
  const dataRoot = await validateBackendDataRoot(options.dataRoot), now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const { input, output } = options;
  let complete!: () => void, abort!: (error: Error) => void;
  const done = new Promise<void>((resolveDone, reject) => { complete = resolveDone; abort = reject; });
  let failure: Error | undefined, shutdownAccepted = false, inputEnded = false, endpointStopped = false;
  let lastParentMessage = monotonicNow(), heartbeat: ReturnType<typeof setInterval> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined, shutdownDeadline: number | undefined;
  let releaseStop!: () => void;
  const stopped = new Promise<void>(resolveStop => { releaseStop = resolveStop; });
  let assistant: AssistantService | undefined;
  let engine: ParentModelEngine | undefined;
  const fail = (error: unknown) => {
    if (failure) return;
    failure = error instanceof Error ? error : fault("Backend stdio failed.");
    clearInterval(heartbeat); clearTimeout(shutdownTimer); input.pause(); assistant?.dispose(); engine?.dispose();
    writer.fail(failure); releaseStop(); abort(failure);
  };
  const writer = new BoundedWriter(output, { nonce: options.nonce, allowedKinds: [KINDS.APP],
    maxPayloadBytes: TRANSPORT_POLICY.childOutputBytes, onFailure: fail });
  const reader = new FrameReader({ nonce: options.nonce, allowedKinds: [KINDS.APP], maxPayloadBytes: TRANSPORT_POLICY.ownerInputBytes });
  const send = (message: unknown) => {
    if (failure || shutdownAccepted) return;
    try { void writer.send(KINDS.APP, encodeJson(message, TRANSPORT_POLICY.childOutputBytes)).catch(fail); }
    catch (error) { fail(error); }
  };
  engine = new ParentModelEngine(send);
  assistant = new AssistantService(engine);
  const endpoint = createBackend({ send, assistant, observing: createObserving(dataRoot),
    sky: new SkyQueries(createSky(options.catalogDirectory)), now,
    stop: () => { endpointStopped = true; assistant!.dispose(); engine!.dispose(); releaseStop(); } });
  const onData = (chunk: Buffer) => {
    if (failure) return;
    try {
      reader.push(chunk, record => {
        if (failure) throw failure;
        if (shutdownAccepted) throw fault("Application message after shutdown.");
        const message = decodeJson(record.body);
        if (engine!.receive(message)) { lastParentMessage = monotonicNow(); return; }
        if (!endpoint.receive(message)) throw fault("Backend rejected application message.");
        if (failure) throw failure;
        if (isInitialize(message)) engine!.initialize(message.session);
        if (typeof message === "object" && message !== null && "operation" in message && message.operation === "runtime.shutdown") {
          shutdownAccepted = true; shutdownDeadline = monotonicNow() + SHUTDOWN_MS;
          // One budget covers owner EOF, pending observing work and output completion.
          shutdownTimer = setTimeout(() => fail(fault("Backend shutdown deadline exceeded.", 69)), SHUTDOWN_MS);
        }
        lastParentMessage = monotonicNow();
      });
    } catch (error) { fail(error); }
  };
  const onEnd = () => {
    inputEnded = true;
    void (async () => {
      if (failure) return;
      reader.finish();
      if (!shutdownAccepted) throw fault("Unexpected owner EOF.", 67);
      await stopped;
      if (!endpointStopped || failure) { if (failure) throw failure; throw fault("Backend stop was not confirmed."); }
      await writer.end();
      if (failure) throw failure;
      if (shutdownDeadline !== undefined && monotonicNow() >= shutdownDeadline) throw fault("Backend shutdown deadline exceeded.", 69);
      clearInterval(heartbeat); clearTimeout(shutdownTimer); input.removeListener("data", onData); complete();
    })().catch(fail);
  };
  input.on("data", onData);
  input.once("end", onEnd);
  // Error listeners intentionally remain attached after terminal states.
  input.on("error", fail);
  input.once("close", () => { if (!inputEnded) fail(fault("Input closed without EOF.")); });
  heartbeat = setInterval(() => { if (monotonicNow() - lastParentMessage > 10_000) fail(fault("Owner heartbeat expired.", 68)); }, 1000);
  input.resume();
  return done;
}

export function validStdioLaunch(runtime: Pick<NodeJS.Process, "argv" | "execArgv" | "versions" | "arch" | "env">): boolean {
  return runtime.argv.length === 4 && runtime.versions.node === "24.22.2" && !runtime.versions.electron && runtime.arch === "x64"
    && runtime.execArgv.join("|") === "--preserve-symlinks|--preserve-symlinks-main"
    && !Object.keys(runtime.env).some(key => /^(NODE_|ELECTRON_|UV_|OPENSSL_|INSPECTOR|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key));
}

/** Untrusted worker stderr: one path-free record, with a bounded best-effort flush. */
export function failStdioBackend(error: unknown, output: Writable, exit: (code: number) => void): void {
  const field = (key: "code" | "syscall" | "exitCode"): unknown => {
    try { return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined; }
    catch { return undefined; }
  };
  const requestedExitCode = field("exitCode");
  // Keep the CLI's numeric Error.exitCode selection; only the printed value is bounded.
  const exitCode = error instanceof Error && typeof requestedExitCode === "number" ? requestedExitCode : 65;
  const rawCode = field("code"), rawSyscall = field("syscall");
  const code = typeof rawCode === "string" && ["EACCES", "EPERM", "ENOENT", "ELOOP", "ENOTDIR", "EINVAL", "EBADF"].includes(rawCode) ? rawCode : "UNKNOWN";
  const syscall = rawSyscall === undefined ? "none"
    : typeof rawSyscall === "string" && ["lstat", "realpath", "open", "read", "write", "none"].includes(rawSyscall) ? rawSyscall : null;
  const phase = typeof error === "object" && error !== null ? failurePhases.get(error) ?? "runtime" : "runtime";
  const record = JSON.stringify({ type: "tahti-backend-failure", exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null, code, syscall, phase }) + "\n";
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true; clearTimeout(timer); exit(exitCode);
  };
  const timer = setTimeout(finish, 200);
  // Keep the error listener after completion, so late stream errors stay consumed.
  output.on("error", finish);
  output.once("close", finish);
  if (output.destroyed || output.writableEnded || !output.writable) { finish(); return; }
  try { output.write(record, finish); }
  catch { finish(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!validStdioLaunch(process)) process.exit(64);
  const dataRoot = process.argv[2]!, nonce = process.argv[3]!;
  const catalogDirectory = packagedCatalogDirectory(fileURLToPath(import.meta.url));
  void runStdioBackend({ dataRoot, nonce, catalogDirectory, input: process.stdin, output: process.stdout })
    .then(() => process.exit(0), (error: unknown) => failStdioBackend(error, process.stderr, code => process.exit(code)));
}
