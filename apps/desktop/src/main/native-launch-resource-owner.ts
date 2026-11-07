import { decodeNativeBootstrap, NATIVE_BOOTSTRAP_BYTES, type NativeMainIdentity } from "./native-development-bootstrap.js";
import { NATIVE_LAUNCH_MAX_BUDGET_NS } from "./native-launch-gate.js";
import { NativeLaunchSemanticError, type NativeLaunchOperations, type NativeLaunchCallObservation } from "./native-launch-operations.js";
import type { NativeBootstrapOperation } from "./native-bootstrap-operation.js";
import type { NativeMcpSessionOperation } from "./native-mcp-session-operation.js";

import { createNativeCallRecord, type NativeCallRecord, type NativeCallObservation } from "./native-launch-call-record.js";

export type NativeResourceOperationObservation = Readonly<{ state: "none" }>
  | Readonly<{ state: "bound"; observation: NativeLaunchCallObservation }>
  | Readonly<{ state: "unavailable"; reason: unknown }>;
export interface NativeLaunchResourceBinding {
  readonly verification: Promise<void> | null;
  readonly operation: Promise<unknown> | null;
  readonly native: NativeResourceOperationObservation;
}
export type NativeLaunchResourceObservation = NativeCallObservation<NativeLaunchResourceBinding>;
type Operations = Pick<NativeLaunchOperations, "identity" | "bootstrap" | "session" | "status" | "observeCall">;
/** Internal test seam. Production factory constructs both members from ONE
 * externally pinned package binding; public config never selects either. */
export interface NativeLaunchResourceCohort {
  readonly verify: (signal: AbortSignal) => Promise<void>;
  readonly operations: Operations;
}
export interface NativeLaunchResourceClock { hrtime(): bigint; performance(): number }
const clock: NativeLaunchResourceClock = { hrtime: process.hrtime.bigint, performance: performance.now.bind(performance) };
/** Capture once BEFORE verification. Reading hrtime first makes the intervening
 * clock-read gap conservative, rather than granting it as extra time. */
export function captureNativeLaunchResourceDeadline(ownerDeadline: number, time: NativeLaunchResourceClock): bigint {
  const hr = time.hrtime(), perf = time.performance();
  const remaining = ownerDeadline - perf;
  if (typeof hr !== "bigint" || hr < 0n || !Number.isFinite(ownerDeadline) || !Number.isFinite(perf) || perf < 0 || ownerDeadline <= 0 || remaining <= 0)
    throw new NativeLaunchSemanticError(true, false);
  const ns = Math.floor(Math.min(remaining, Number(NATIVE_LAUNCH_MAX_BUDGET_NS) / 1e6) * 1e6);
  if (!Number.isSafeInteger(ns) || ns < 1) throw new NativeLaunchSemanticError(true, false);
  return hr + BigInt(ns);
}
type Work = { record: NativeCallRecord<NativeLaunchResourceBinding>; native: NativeResourceOperationObservation; originalVerification: Promise<void> | undefined; verification: Promise<void> | undefined; verificationSettled: boolean; returned: boolean;
  originalOperation: Promise<NativeMainIdentity | void> | undefined; operation: Promise<unknown> | undefined; operationSettled: boolean; phase: "verification" | "dispatch" };
/** Internal core; no executable/path/URL/env choice. Retains its original
 * cohort forever, including failed verification and Operations uncertainty.
 * Main composition uses the package-bound factory, not this test seam. */
export class NativeLaunchResourceOwner {
  private active: Work | undefined;
  private failed = false;
  private returned: NativeCallRecord<NativeLaunchResourceBinding> | undefined;
  private readonly observations = new WeakMap<Promise<unknown>, NativeLaunchResourceObservation>();
  observeCall(original: Promise<unknown>): NativeLaunchResourceObservation {
    const observation = this.observations.get(original);
    if (!observation) throw new Error("Unknown native resource call promise");
    return observation;
  }
  observeCurrentCall(): NativeLaunchResourceObservation | undefined { return this.active?.record.observation ?? this.returned?.observation; }
  private tracked<T>(start: (record: NativeCallRecord<NativeLaunchResourceBinding>) => Promise<T>): Promise<T> {
    const empty: NativeLaunchResourceBinding = Object.freeze({ verification: null, operation: null, native: Object.freeze({ state: "none" }) });
    const record = createNativeCallRecord(empty), original = start(record);
    record.attach(original); this.observations.set(original, record.observation);
    return original; // Never add an async wrapper that changes this identity.
  }
  constructor(private readonly cohort: NativeLaunchResourceCohort, private readonly time: NativeLaunchResourceClock = clock) {}
  status() {
    const operation = this.cohort.operations.status();
    return Object.freeze({ pending: !!this.active || operation.pending, failed: this.failed || operation.failed,
      verificationPending: !!this.active && !this.active.verificationSettled, lastSettlement: operation.lastSettlement });
  }
  identity(ownerDeadline: number, signal: AbortSignal): Promise<NativeMainIdentity> {
    return this.tracked(record => this.run(record, "identity", undefined, undefined, ownerDeadline, signal)) as Promise<NativeMainIdentity>;
  }
  bootstrap(operation: NativeBootstrapOperation, bytes: Uint8Array | undefined, ownerDeadline: number, signal: AbortSignal): Promise<void> {
    return this.tracked(record => this.run(record, "bootstrap", operation, bytes, ownerDeadline, signal)) as Promise<void>;
  }
  session(operation: NativeMcpSessionOperation, bytes: Uint8Array, ownerDeadline: number, signal: AbortSignal): Promise<void> {
    return this.tracked(record => this.run(record, "session", operation, bytes, ownerDeadline, signal)) as Promise<void>;
  }
  private release(work: Work) {
    if (work.returned && work.verificationSettled && work.operationSettled && this.active === work) this.active = undefined;
  }
  private async run(record: NativeCallRecord<NativeLaunchResourceBinding>, kind: "identity" | "bootstrap" | "session", operation: string | undefined,
    bytes: Uint8Array | undefined, ownerDeadline: number, callerSignal: AbortSignal): Promise<NativeMainIdentity | void> {
    if (this.active || this.failed) throw new NativeLaunchSemanticError(false, kind !== "identity");
    const work: Work = { record, native: Object.freeze({ state: "none" }), originalVerification: undefined, verification: undefined, verificationSettled: true, originalOperation: undefined, operation: undefined, operationSettled: true,
      returned: false, phase: "verification" };
    this.active = work; // Before clocks, validation or callbacks.
    let input: Buffer | undefined, timer: NodeJS.Timeout | undefined, rejectBoundary: ((error: Error) => void) | undefined;
    const abort = new AbortController();
    const onAbort = () => {
      this.failed = true; abort.abort();
      // After dispatch, real Operations/Supervisor preserve transport metadata.
      if (work.phase === "verification") rejectBoundary?.(new NativeLaunchSemanticError(true, false));
    };
    const check = (deadline: bigint) => {
      callerSignal.throwIfAborted(); abort.signal.throwIfAborted();
      if (this.failed || this.time.hrtime() >= deadline) throw new NativeLaunchSemanticError(true, false);
    };
    try {
      const deadline = captureNativeLaunchResourceDeadline(ownerDeadline, this.time);
      check(deadline);
      const status = this.cohort.operations.status();
      if (status.pending || status.failed) throw new NativeLaunchSemanticError(false, kind !== "identity");
      if (kind !== "identity" && (typeof operation !== "string" || !(kind === "bootstrap"
        ? ["publish", "consume", "recover"] : ["prepare", "seal", "publish", "release-pristine", "release-clean"]).includes(operation)))
        throw new Error("Invalid native resource operation");
      const descriptor = kind === "session" || kind === "bootstrap" && operation !== "recover";
      if (descriptor) {
        if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer || bytes.byteLength !== NATIVE_BOOTSTRAP_BYTES)
          throw new Error("Invalid native resource descriptor");
        input = Buffer.from(bytes); // Before validation AND the verification await.
        if (decodeNativeBootstrap(input).main.pid !== process.pid) throw new Error("Foreign native resource Main");
      } else if (bytes !== undefined) throw new Error("Unexpected native resource input");
      const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
      void boundary.catch(() => {});
      callerSignal.addEventListener("abort", onAbort, { once: true }); check(deadline);
      timer = setTimeout(onAbort, Math.max(0, Number((deadline - this.time.hrtime() + 999_999n) / 1_000_000n)));
      work.verificationSettled = false;
      let original: Promise<void>;
      try { check(deadline); original = this.cohort.verify(abort.signal); }
      catch (error) { work.verificationSettled = true; throw error; }
      work.originalVerification = original;
      work.verification = Promise.resolve(original).then(() => {
        work.verificationSettled = true; this.release(work);
      }, error => { work.verificationSettled = true; this.failed = true; this.release(work); throw error; });
      void work.verification.catch(() => {});
      await Promise.race([work.verification, boundary]);
      clearTimeout(timer); timer = undefined;
      check(deadline); // No timer dispatch is needed to withhold a late launch.
      work.phase = "dispatch"; work.operationSettled = false;
      // Real Operations snapshots again before callbacks, preserves original
      // result/settled metadata and owns the native deadline after dispatch.
      let operationWork: Promise<NativeMainIdentity | void>;
      try {
        check(deadline);
        operationWork = kind === "identity" ? this.cohort.operations.identity(deadline, abort.signal)
          : kind === "bootstrap" ? this.cohort.operations.bootstrap(operation as NativeBootstrapOperation, input, deadline, abort.signal)
          : this.cohort.operations.session(operation as NativeMcpSessionOperation, input!, deadline, abort.signal);
      } catch (error) { work.operationSettled = true; throw error; }
      work.originalOperation = operationWork;
      work.operation = operationWork.then(value => { work.operationSettled = true; this.release(work); return value; },
        error => { work.operationSettled = true; this.failed = true; this.release(work); throw error; });
      void work.operation.catch(() => {}); // Even a later observation lookup failure retains this work.
      try {
        // Bind THIS original call immediately, never its then-current successor.
        work.native = Object.freeze({ state: "bound", observation: this.cohort.operations.observeCall(operationWork) });
      } catch (error) { work.native = Object.freeze({ state: "unavailable", reason: error }); throw error; }
      const value = await work.operation;
      // Real Operations already checks the original deadline/abort before its
      // semantic return. A caller abort in this final microtask must also fail.
      if (callerSignal.aborted || abort.signal.aborted || this.time.hrtime() >= deadline) {
        const settled = this.cohort.operations.status().lastSettlement;
        throw new NativeLaunchSemanticError(!!settled && settled.childCloseObserved && settled.workerExited
          && settled.workerExitCode === 0 && !settled.uncertain, settled?.authorityCommitted ?? kind !== "identity");
      }
      return value as NativeMainIdentity | void;
    } catch (error) {
      this.failed = true; abort.abort();
      if (error && typeof error === "object" && "exitVerified" in error) throw error;
      throw new NativeLaunchSemanticError(work.phase !== "dispatch", work.phase === "dispatch" && kind !== "identity");
    } finally {
      clearTimeout(timer); callerSignal.removeEventListener("abort", onAbort); rejectBoundary = undefined;
      input?.fill(0); work.returned = true; this.returned = record;
      record.bind(Object.freeze({ verification: work.originalVerification ?? null,
        operation: work.originalOperation ?? null, native: work.native }));
      this.release(work);
    }
  }
}
