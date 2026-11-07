import { win32 } from "node:path";
import { childEnvironment } from "./child-environment.js";
import { loadNativeMcpLaunchPackage } from "./native-mcp-resources.js";
import { NativeLaunchOperations, NativeLaunchSemanticError } from "./native-launch-operations.js";
import { captureNativeLaunchResourceDeadline, NativeLaunchResourceOwner } from "./native-launch-resource-owner.js";
import { launchKeys, launchRecord, nativeLaunchWorkerConfig } from "./native-launch-worker-config.js";
import { loadNativeLaunchWorkerSupervisor, NATIVE_LAUNCH_WORKER_FILES, type NativeLaunchBinding } from "./native-launch-worker-port.js";

export interface NativeLaunchMcpResourceConfig {
  readonly runtimeRoot: string;
  readonly descriptorSha256: string;
  readonly controlFile: string;
  readonly compiled: NativeLaunchBinding["compiled"];
  /** Independent trusted Main build approval, explicitly tied to this digest.
   * Never infer THREC001 support from a colocated package's own claim. */
  readonly recoveryApproval: Readonly<{ descriptorSha256: string; protocol: "THREC001" }>;
}
/** Bound metadata is immutable; the owner's private lifecycle remains mutable. */
export type NativeLaunchMcpResources = NativeLaunchResourceOwner & Readonly<{ controlFile: string }>;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
let claimed = false;
let preparation: Promise<NativeLaunchMcpResources> | undefined;
let preparationResult: Promise<NativeLaunchMcpResources> | undefined;
function snapshot(value: unknown) {
  if (!launchRecord(value) || !launchKeys(value, ["runtimeRoot", "descriptorSha256", "controlFile", "compiled", "recoveryApproval"])
    || typeof value.runtimeRoot !== "string" || !hash(value.descriptorSha256) || typeof value.controlFile !== "string"
    || !launchRecord(value.compiled) || !launchKeys(value.compiled, NATIVE_LAUNCH_WORKER_FILES)
    || !launchRecord(value.recoveryApproval) || !launchKeys(value.recoveryApproval, ["descriptorSha256", "protocol"])
    || value.recoveryApproval.descriptorSha256 !== value.descriptorSha256 || value.recoveryApproval.protocol !== "THREC001")
    throw new Error("Invalid package-bound native launch resource approval");
  const compiled = {} as Record<typeof NATIVE_LAUNCH_WORKER_FILES[number], Readonly<{ bytes: number; sha256: string }>>;
  for (const name of NATIVE_LAUNCH_WORKER_FILES) {
    const item = value.compiled[name];
    if (!launchRecord(item) || !launchKeys(item, ["bytes", "sha256"]) || typeof item.bytes !== "number"
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 128 * 1024 || !hash(item.sha256))
      throw new Error("Invalid compiled native launch resource approval");
    compiled[name] = Object.freeze({ bytes: item.bytes, sha256: item.sha256 });
  }
  const worker = nativeLaunchWorkerConfig({ schema: 1, pid: process.pid, controlFile: value.controlFile,
    identity: win32.join(value.runtimeRoot, "helpers/main-identity.exe"), bootstrap: win32.join(value.runtimeRoot, "helpers/main-bootstrap.exe"),
    broker: win32.join(value.runtimeRoot, "bin/mcp-broker.exe"), env: childEnvironment(process.env) });
  return Object.freeze({ runtimeRoot: value.runtimeRoot, descriptorSha256: value.descriptorSha256,
    worker, compiled: Object.freeze(compiled) });
}
async function prepare(approved: ReturnType<typeof snapshot>, signal: AbortSignal, check: () => void) {
  check();
  const source = await loadNativeMcpLaunchPackage({ runtimeRoot: approved.runtimeRoot,
    descriptorSha256: approved.descriptorSha256 }, signal);
  check();
  if (source.runtimeRoot !== approved.runtimeRoot || source.descriptorSha256 !== approved.descriptorSha256)
    throw new Error("Native resource package binding changed");
  // All native program pins and the verifier come from this ONE verified source.
  // Neither one is a public configuration choice independent of the other.
  const owner = await loadNativeLaunchWorkerSupervisor({ config: approved.worker, recoverProtocol: "THREC001",
    programs: source.programs, compiled: approved.compiled }, signal);
  check();
  const operations = new NativeLaunchOperations(owner);
  const reservation = win32.join(win32.dirname(approved.worker.controlFile), "native-session-reserved");
  const resources = new NativeLaunchResourceOwner(Object.freeze({
    verify: (operationSignal: AbortSignal) => source.verifyLaunch(operationSignal),
    stage: (operationSignal: AbortSignal, deadline: bigint) => source.stageWorker(reservation, operationSignal, deadline),
    operations,
  }));
  return Object.defineProperty(resources, "controlFile", { value: approved.worker.controlFile,
    enumerable: true, writable: false, configurable: false }) as NativeLaunchMcpResources;
}
/** Unwired trusted-Main factory. Claim precedes IO/config callbacks. The
 * original preparation promise and resulting owner are retained for this Main
 * module lifetime; failure has no replacement/root-alias/reset route.
 * Staging and native calls share that owner; no legacy execution methods or
 * selectable reservation are exposed. Default Host composition is still separate. */
export function loadNativeLaunchMcpResources(config: NativeLaunchMcpResourceConfig, ownerDeadline: number,
  signal: AbortSignal): Promise<NativeLaunchMcpResources> {
  if (claimed) return Promise.reject(new Error("Native launch resource lifetime already claimed"));
  claimed = true;
  let resolve!: (owner: NativeLaunchMcpResources) => void, reject!: (error: unknown) => void;
  let done = false, failed = false, timer: NodeJS.Timeout | undefined;
  const abort = new AbortController(), validSignal = signal instanceof AbortSignal;
  preparationResult = new Promise<NativeLaunchMcpResources>((yes, no) => { resolve = yes; reject = no; });
  const cleanup = () => { clearTimeout(timer); if (validSignal) signal.removeEventListener("abort", onAbort); };
  const fail = (error: unknown) => {
    failed = true;
    if (!done) { done = true; cleanup(); reject(error); }
    abort.abort(); // Requests cancellation; original preparation stays retained.
  };
  const onAbort = () => fail(new NativeLaunchSemanticError(true, false));
  try {
    if (!validSignal) throw new NativeLaunchSemanticError(true, false);
    const deadline = captureNativeLaunchResourceDeadline(ownerDeadline,
      { hrtime: process.hrtime.bigint, performance: performance.now.bind(performance) });
    const check = () => {
      signal.throwIfAborted(); abort.signal.throwIfAborted();
      if (failed || process.hrtime.bigint() >= deadline) throw new NativeLaunchSemanticError(true, false);
    };
    check(); const approved = snapshot(config); check();
    signal.addEventListener("abort", onAbort, { once: true }); check();
    timer = setTimeout(onAbort, Math.max(0, Number((deadline - process.hrtime.bigint() + 999_999n) / 1_000_000n)));
    check();
    preparation = prepare(approved, abort.signal, check);
    void preparation.then(owner => {
      try {
        check(); // Also rejects late success without timer dispatch.
        if (done) throw new NativeLaunchSemanticError(true, false);
        done = true; cleanup(); resolve(owner);
      } catch (error) { fail(error); }
    }, fail);
    void preparation.catch(() => {});
  } catch (error) { fail(error); }
  void preparationResult.catch(() => {});
  return preparationResult;
}
