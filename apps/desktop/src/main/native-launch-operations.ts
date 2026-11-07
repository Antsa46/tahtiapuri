import type { NativeBootstrapOperation } from "./native-bootstrap-operation.js";
import type { NativeMcpSessionOperation } from "./native-mcp-session-operation.js";
import { decodeNativeBootstrap, NATIVE_BOOTSTRAP_BYTES, type NativeMainIdentity } from "./native-development-bootstrap.js";
import { decodeNativeMainIdentity } from "./native-main-identity-codec.js";
import { nativeLaunchDeadline } from "./native-launch-gate.js";
import type { NativeLaunchRequest, NativeLaunchResult, NativeLaunchSettlement, NativeLaunchSupervisor, NativeLaunchTask } from "./native-launch-supervisor.js";

import { createNativeCallRecord, type NativeCallRecord, type NativeCallObservation } from "./native-launch-call-record.js";

/** no-task means no returned task handle, not proof that no OS process arose. */
export type NativeLaunchTaskBinding = Readonly<{ kind: "no-task" }>
  | Readonly<{ kind: "task"; result: NativeLaunchTask["result"]; settled: NativeLaunchTask["settled"] }>;
export type NativeLaunchCallObservation = NativeCallObservation<NativeLaunchTaskBinding>;
type Owner = Pick<NativeLaunchSupervisor, "start" | "status">;
type Operation = { record: NativeCallRecord<NativeLaunchTaskBinding>; task: NativeLaunchTask | undefined; result: NativeLaunchResult | undefined;
  settlement: NativeLaunchSettlement | undefined; settled: Promise<NativeLaunchSettlement> | undefined; returned: boolean };
export class NativeLaunchSemanticError extends Error {
  constructor(readonly exitVerified: boolean, readonly authorityCommitted: boolean) {
    super("Native launch receipt or original owner deadline rejected"); this.name = "NativeLaunchSemanticError";
  }
}
/** Trusted, unwired semantic bridge. No path, program, argv, environment or
 * Worker selection. Future resource composition must start its owner deadline
 * BEFORE revalidation IO, then pass that same absolute deadline here. */
export class NativeLaunchOperations {
  private active: Operation | undefined;
  private failed = false;
  private last: NativeLaunchSettlement | undefined;
  private returned: NativeCallRecord<NativeLaunchTaskBinding> | undefined;
  private readonly observations = new WeakMap<Promise<unknown>, NativeLaunchCallObservation>();
  observeCall(original: Promise<unknown>): NativeLaunchCallObservation {
    const observation = this.observations.get(original);
    if (!observation) throw new Error("Unknown native semantic call promise");
    return observation;
  }
  /** Snapshot only; Resource binds by original Promise, never by a later lookup. */
  observeCurrentCall(): NativeLaunchCallObservation | undefined { return this.active?.record.observation ?? this.returned?.observation; }
  private tracked<T>(start: (record: NativeCallRecord<NativeLaunchTaskBinding>) => Promise<T>): Promise<T> {
    const record = createNativeCallRecord<NativeLaunchTaskBinding>(Object.freeze({ kind: "no-task" }));
    const original = start(record); record.attach(original);
    this.observations.set(original, record.observation);
    return original; // This exact identity is the observer key.
  }
  constructor(private readonly owner: Owner, private readonly now: () => bigint = process.hrtime.bigint) {}
  status() {
    const status = this.owner.status();
    return Object.freeze({ pending: !!this.active || status.pending, failed: this.failed || status.uncertain,
      lastSettlement: this.last ?? null });
  }
  identity(ownerDeadline: bigint, signal: AbortSignal): Promise<NativeMainIdentity> {
    return this.tracked(record => this.invoke(record, "identity", undefined, undefined, ownerDeadline, signal, bytes => decodeNativeMainIdentity(bytes, process.pid)));
  }
  bootstrap(operation: NativeBootstrapOperation, bytes: Uint8Array | undefined, ownerDeadline: bigint, signal: AbortSignal): Promise<void> {
    return this.tracked(record => this.invoke(record, "bootstrap", operation, bytes, ownerDeadline, signal, output => {
      const expected = operation === "publish" ? "published\n" : operation === "consume" ? "consumed\n" : "descriptor-absent\n";
      if (!output.equals(Buffer.from(expected))) throw new Error("Unexpected bootstrap receipt");
    }));
  }
  session(operation: NativeMcpSessionOperation, bytes: Uint8Array, ownerDeadline: bigint, signal: AbortSignal): Promise<void> {
    return this.tracked(record => this.invoke(record, "session", operation, bytes, ownerDeadline, signal, output => {
      const expected = operation === "prepare" ? "session-prepared\n" : operation === "seal" ? "session-sealed\n"
        : operation === "publish" ? "published\n" : operation === "release-pristine" ? "session-released\n" : "session-clean-released\n";
      if (!output.equals(Buffer.from(expected))) throw new Error("Unexpected session receipt");
    }));
  }
  private check(deadline: bigint, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.failed || this.now() >= deadline) throw new Error("Native semantic owner fenced");
  }
  private async invoke<T>(record: NativeCallRecord<NativeLaunchTaskBinding>, kind: "identity" | "bootstrap" | "session", operation: string | undefined,
    bytes: Uint8Array | undefined, ownerDeadline: bigint, signal: AbortSignal, decode: (output: Buffer) => T): Promise<T> {
    if (this.active || this.failed) throw new NativeLaunchSemanticError(false, kind !== "identity");
    const context: Operation = { record, task: undefined, result: undefined, settlement: undefined, settled: undefined, returned: false };
    this.active = context; // Before clocks, callbacks or awaits.
    let input: Buffer | undefined;
    try {
      const deadline = nativeLaunchDeadline(ownerDeadline, this.now);
      this.check(deadline, signal);
      const status = this.owner.status();
      if (status.pending || status.uncertain) throw new NativeLaunchSemanticError(false, kind !== "identity");
      const bootstrap = kind === "bootstrap";
      if (kind !== "identity" && (typeof operation !== "string" || !(bootstrap
        ? ["publish", "consume", "recover"] : ["prepare", "seal", "publish", "release-pristine", "release-clean"]).includes(operation)))
        throw new Error("Invalid native semantic operation");
      const needsDescriptor = kind === "session" || bootstrap && operation !== "recover";
      if (needsDescriptor) {
        if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer || bytes.byteLength !== NATIVE_BOOTSTRAP_BYTES)
          throw new Error("Invalid native semantic descriptor");
        input = Buffer.from(bytes); // Copy BEFORE decoding or any asynchronous work.
        if (decodeNativeBootstrap(input).main.pid !== process.pid) throw new Error("Foreign native Main descriptor");
      } else if (bytes !== undefined) throw new Error("Unexpected native semantic descriptor");
      const request = kind === "identity" ? { kind: "identity" as const }
        : kind === "bootstrap" && operation === "recover" ? { kind: "bootstrap" as const, operation: "recover" as const }
        : { kind, operation, input: input! } as NativeLaunchRequest;
      this.check(deadline, signal);
      const task = this.owner.start(request, deadline, signal);
      context.task = task; // Original promises retained even after result failure.
      record.bind(Object.freeze({ kind: "task", result: task.result, settled: task.settled }));
      context.settled = task.settled.then(value => {
        context.settlement = Object.freeze({ ...value }); this.last = context.settlement;
        if (value.uncertain || !value.childCloseObserved || !value.workerExited || value.workerExitCode !== 0) this.failed = true;
        if (context.returned && this.active === context) this.active = undefined;
        return context.settlement;
      }, error => { this.failed = true; throw error; });
      void context.settled.catch(() => {});
      context.result = await task.result;
      const settled = await context.settled;
      this.check(deadline, signal);
      const authority = kind !== "identity";
      if (!settled.childCloseObserved || !settled.workerExited || settled.workerExitCode !== 0 || settled.uncertain
        || context.result.authorityCommitted !== authority || settled.authorityCommitted !== authority
        || !Buffer.isBuffer(context.result.stdout) || context.result.stdout.length > 128)
        throw new Error("Invalid native semantic settlement");
      const value = decode(context.result.stdout);
      this.check(deadline, signal); // Deadline/abort also fences the semantic handoff.
      return value;
    } catch (error) {
      this.failed = true;
      // Preserve original transport error metadata. A later close never turns
      // its exitVerified:false into true or changes authorityCommitted.
      if (error && typeof error === "object" && "exitVerified" in error) throw error;
      const settled = context.settlement;
      const exitVerified = !context.task || !!settled && settled.childCloseObserved && settled.workerExited
        && settled.workerExitCode === 0 && !settled.uncertain;
      const authority = context.result?.authorityCommitted === true || settled?.authorityCommitted === true
        || (!!context.task && kind !== "identity" && (!context.result || !settled));
      throw new NativeLaunchSemanticError(exitVerified, authority);
    } finally {
      input?.fill(0); const output = context.result?.stdout; if (Buffer.isBuffer(output)) output.fill(0); context.returned = true; record.finish(); this.returned = record;
      if ((!context.task || context.settlement) && this.active === context) this.active = undefined;
    }
  }
}
