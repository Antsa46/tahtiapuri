import { randomBytes } from "node:crypto";
import { createNativeDirectoryGrant } from "./native-directory-grant.js";
import { createNativeRecoveryGrant } from "./native-recovery-grant.js";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { NATIVE_LAUNCH_MAX_BUDGET_NS, cancelNativeLaunchGate, createNativeLaunchGate, nativeLaunchGateState } from "./native-launch-gate.js";

type BootstrapMode = "publish" | "consume" | "recover";
type SessionMode = "prepare" | "seal" | "publish" | "release-pristine" | "release-clean";
export type NativeLaunchMetadata = Readonly<{ kind: "identity" }> | Readonly<{ kind: "directory" }>
  | Readonly<{ kind: "bootstrap"; operation: BootstrapMode }>
  | Readonly<{ kind: "session"; operation: SessionMode }>;
export type NativeLaunchRequest = Readonly<{ kind: "identity" }> | Readonly<{ kind: "directory" }>
  | Readonly<{ kind: "bootstrap"; operation: "recover" }>
  | Readonly<{ kind: "bootstrap"; operation: "publish" | "consume"; input: Uint8Array }>
  | Readonly<{ kind: "session"; operation: SessionMode; input: Uint8Array }>;
export type NativeLaunchCommand =
  | { type: "start"; version: 1; id: string; request: NativeLaunchMetadata; deadline: bigint; gate: SharedArrayBuffer }
  | { type: "authorize"; id: string; input: ArrayBuffer }
  | { type: "cancel"; id: string };
/** Only trusted, package-bound composition constructs this port. It must not
 * start a native child before the start message. No terminate/reset API. */
export interface NativeLaunchPort {
  onMessage(listener: (value: unknown) => void): void;
  onError(listener: () => void): void;
  onExit(listener: (code: number) => void): void;
  postMessage(value: NativeLaunchCommand, transfer?: ArrayBuffer[]): void;
}
export interface NativeLaunchSettlement {
  readonly childCloseObserved: boolean;
  readonly workerExited: boolean;
  readonly workerExitCode: number | null;
  readonly authorityCommitted: boolean;
  readonly uncertain: boolean;
}
/** Transport result only; the caller must verify its exact native receipt. */
export interface NativeLaunchResult { readonly stdout: Buffer; readonly authorityCommitted: boolean }
export interface NativeLaunchTask {
  readonly result: Promise<NativeLaunchResult>;
  /** A terminal supervision record can explicitly report uncertain ownership. */
  readonly settled: Promise<NativeLaunchSettlement>;
}
export class NativeLaunchFailure extends Error {
  constructor(readonly exitVerified: boolean, readonly authorityCommitted: boolean) {
    super("Native launch failed or did not settle within its original deadline.");
  }
}
type Closed = { code: number | null; signal: string | null; stdout: Buffer; stderrBytes: number; failed: boolean };

function snapshot(request: NativeLaunchRequest) {
  if (!isRecord(request)) throw new Error("Invalid native launch request");
  let metadata: NativeLaunchMetadata, length = 0;
  if ((request.kind === "identity" || request.kind === "directory") && exactKeys(request, ["kind"])) metadata = { kind: request.kind };
  else if (request.kind === "bootstrap" && ["publish", "consume", "recover"].includes(request.operation)) {
    if (!exactKeys(request, request.operation === "recover" ? ["kind", "operation"] : ["kind", "operation", "input"]))
      throw new Error("Invalid native launch request");
    metadata = { kind: "bootstrap", operation: request.operation }; length = request.operation === "recover" ? 0 : 96;
  } else if (request.kind === "session" && ["prepare", "seal", "publish", "release-pristine", "release-clean"].includes(request.operation)
    && exactKeys(request, ["kind", "operation", "input"])) {
    metadata = { kind: "session", operation: request.operation }; length = 96;
  } else throw new Error("Invalid native launch request");
  let input = metadata.kind === "directory" ? createNativeDirectoryGrant()
    : metadata.kind === "bootstrap" && metadata.operation === "recover" ? createNativeRecoveryGrant() : Buffer.alloc(0);
  if (length) {
    if (!("input" in request) || !(request.input instanceof Uint8Array) || request.input.byteLength !== length
      || request.input.buffer instanceof SharedArrayBuffer) throw new Error("Invalid native launch input");
    input = Buffer.from(request.input); // Copy before factory, callbacks or awaits.
  }
  return { metadata: Object.freeze(metadata), input, needsAuthority: metadata.kind !== "identity" };
}

/** Main-side state machine; not yet wired to real worker/process composition.
 * A per-Main lifetime owner must retain this instance, including uncertainty.
 * The worker owns the child until actual close; Main never terminates a worker
 * merely because result timed out. No executable/argv/env/URL in public requests. */
export class NativeLaunchSupervisor {
  private busy = false;
  private uncertain = false;
  private active: NativeLaunchPort | undefined;
  constructor(private readonly factory: () => NativeLaunchPort, private readonly now: () => bigint = process.hrtime.bigint) {}
  status() { return Object.freeze({ pending: this.busy || this.active !== undefined, uncertain: this.uncertain }); }
  start(request: NativeLaunchRequest, deadline: bigint, signal?: AbortSignal): NativeLaunchTask {
    const captured = snapshot(request), now = this.now();
    if (this.busy || this.uncertain) { captured.input.fill(0); throw new NativeLaunchFailure(false, false); }
    const cap = NATIVE_LAUNCH_MAX_BUDGET_NS;
    if (typeof deadline !== "bigint" || deadline <= now || deadline - now > cap || signal?.aborted) {
      captured.input.fill(0); throw new NativeLaunchFailure(true, false);
    }
    this.busy = true; // Before a trusted factory can synchronously re-enter.
    const id = randomBytes(16).toString("hex"), gate = createNativeLaunchGate();
    let port: NativeLaunchPort | undefined, phase: "created" | "requested" | "started" | "closed" = "created";
    let closed: Closed | undefined, workerExit: number | undefined, done = false, terminal = false, cancelSent = false;
    let messages = 0;
    let resolveResult!: (value: NativeLaunchResult) => void, rejectResult!: (error: NativeLaunchFailure) => void;
    let resolveSettled!: (value: NativeLaunchSettlement) => void;
    const result = new Promise<NativeLaunchResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const settled = new Promise<NativeLaunchSettlement>(resolve => { resolveSettled = resolve; });
    let timer: NodeJS.Timeout | undefined;
    const committed = () => { try { return nativeLaunchGateState(gate).committed; } catch { return true; } };
    const verified = () => !!closed && workerExit === 0 && !this.uncertain;
    const reject = () => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      captured.input.fill(0); rejectResult(new NativeLaunchFailure(verified(), committed()));
    };
    const cancel = () => {
      cancelNativeLaunchGate(gate); // Linearize before message, result or cleanup.
      if (!verified()) this.uncertain = true;
      reject();
      if (port && !cancelSent) {
        cancelSent = true;
        try { port.postMessage({ type: "cancel", id }); } catch { this.uncertain = true; }
      }
    };
    const abort = () => cancel();
    const failProtocol = () => { if (terminal) return; this.uncertain = true; cancel(); };
    const finish = () => {
      if (terminal || workerExit === undefined) return;
      terminal = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); captured.input.fill(0);
      if (!closed || workerExit !== 0) this.uncertain = true;
      let state: { cancelled: boolean; committed: boolean };
      try { state = nativeLaunchGateState(gate); }
      catch { state = { cancelled: true, committed: true }; this.uncertain = true; }
      if (closed?.code === 0 && !closed.failed && state.committed !== captured.needsAuthority) this.uncertain = true;
      if (!done) {
        if (this.now() >= deadline || state.cancelled || this.uncertain || !closed || closed.failed
          || closed.code !== 0 || closed.signal !== null || closed.stderrBytes !== 0
          || captured.needsAuthority && !state.committed) {
          // No future success can replace this result, even after a late close.
          cancelNativeLaunchGate(gate); reject();
        } else { done = true; resolveResult(Object.freeze({ stdout: closed.stdout, authorityCommitted: state.committed })); }
      }
      this.busy = false; this.active = undefined;
      resolveSettled(Object.freeze({ childCloseObserved: !!closed, workerExited: true, workerExitCode: workerExit,
        authorityCommitted: committed(), uncertain: this.uncertain }));
    };
    const onMessage = (value: unknown) => {
      if (terminal) return;
      if (++messages > 3) { failProtocol(); return; }
      if (!isRecord(value) || value.id !== id) { failProtocol(); return; }
      if (value.type === "started" && exactKeys(value, ["type", "id"])) {
        if (phase !== "requested") { failProtocol(); return; }
        phase = "started";
        let cancelled = false;
        try { cancelled = nativeLaunchGateState(gate).cancelled; } catch { failProtocol(); return; }
        if (done || this.now() >= deadline || cancelled) { cancel(); return; }
        if (captured.needsAuthority) {
          const input = new ArrayBuffer(captured.input.length); new Uint8Array(input).set(captured.input);
          captured.input.fill(0);
          try { port!.postMessage({ type: "authorize", id, input }, [input]); }
          catch { if (input.byteLength) new Uint8Array(input).fill(0); failProtocol(); }
        }
        return;
      }
      if (value.type === "closed" && exactKeys(value, ["type", "id", "code", "signal", "stdout", "stderrBytes", "failed"])
        && phase === "started" && (value.code === null || typeof value.code === "number" && Number.isSafeInteger(value.code))
        && (value.signal === null || typeof value.signal === "string" && /^[A-Z0-9]{1,16}$/.test(value.signal))
        && value.stdout instanceof Uint8Array && !(value.stdout.buffer instanceof SharedArrayBuffer) && value.stdout.byteLength <= 128
        && typeof value.stderrBytes === "number" && Number.isInteger(value.stderrBytes) && value.stderrBytes >= 0 && value.stderrBytes <= 129
        && typeof value.failed === "boolean") {
        phase = "closed";
        closed = { code: value.code, signal: value.signal, stdout: Buffer.from(value.stdout), stderrBytes: value.stderrBytes, failed: value.failed };
        finish(); return;
      }
      failProtocol();
    };
    timer = setTimeout(cancel, Math.max(1, Number((deadline - now + 999_999n) / 1_000_000n)));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      port = this.factory(); this.active = port;
      port.onMessage(onMessage); port.onError(failProtocol);
      port.onExit(code => { if (!terminal) { workerExit = code; finish(); } });
      if (!done && !signal?.aborted && this.now() < deadline) {
        phase = "requested";
        port.postMessage({ type: "start", version: 1, id, request: captured.metadata, deadline, gate });
      } else cancel();
    } catch {
      // No recoverable worker handle or close proof; keep this owner fenced.
      this.uncertain = true; cancel();
      if (!port) {
        terminal = true; this.busy = false;
        resolveSettled(Object.freeze({ childCloseObserved: false, workerExited: false, workerExitCode: null,
          authorityCommitted: committed(), uncertain: true }));
      }
    }
    return Object.freeze({ result, settled });
  }
}
