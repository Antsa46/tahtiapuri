import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { NativeLaunchMetadata } from "./native-launch-supervisor.js";
import { NATIVE_LAUNCH_MAX_BUDGET_NS, cancelNativeLaunchGate, commitNativeLaunchGate, nativeLaunchGateState } from "./native-launch-gate.js";
import { createNativeRecoveryGrant } from "./native-recovery-grant.js";
import { createNativeDirectoryGrant, NATIVE_DIRECTORY_SCRIPT } from "./native-directory-grant.js";
import { win32 } from "node:path";
import { launchKeys, launchRecord, nativeLaunchWorkerConfig, type NativeLaunchWorkerConfig } from "./native-launch-worker-config.js";

export interface NativeLaunchWorkerIo {
  spawn(file: string, args: string[], options: { windowsHide: true; stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams;
  post(value: unknown): void;
  /** Called only with no returned child, or after actual child.close. */
  retire(uncertain: boolean): void;
}
type Run = { id: string; metadata: NativeLaunchMetadata; deadline: bigint; gate: SharedArrayBuffer;
  child?: ChildProcessWithoutNullStreams; started: boolean; closed: boolean; authorized: boolean;
  failed: boolean; killed: boolean; input: Buffer | undefined; stdout: Buffer; stderrBytes: number; timer?: NodeJS.Timeout };

/** Trusted worker-side owner. It is not a sandbox. No process starts merely by
 * constructing the owner or loading workerData. Only finite, package-bound ops. */
export class NativeLaunchWorkerCore {
  private readonly config: NativeLaunchWorkerConfig;
  private run: Run | undefined;
  private finished = false;
  private commands = 0;
  constructor(config: unknown, private readonly io: NativeLaunchWorkerIo, private readonly now: () => bigint = process.hrtime.bigint) {
    this.config = nativeLaunchWorkerConfig(config);
  }
  private allowed(run: Run) {
    return !run.failed && this.now() < run.deadline && !nativeLaunchGateState(run.gate).cancelled;
  }
  private stop(run: Run) {
    if (run.closed || this.finished) return;
    run.failed = true;
    try { cancelNativeLaunchGate(run.gate); } catch { /* Unknown state remains failed. */ }
    try { run.child?.stdin.destroy(); } catch { /* Actual close still required. */ }
    if (run.child && !run.closed && !run.killed) {
      run.killed = true; try { run.child.kill(); } catch { /* Keep the child handle until close. */ }
    }
  }
  private fail() {
    if (this.finished) return;
    if (this.run) this.stop(this.run);
    else { this.finished = true; this.io.retire(true); }
  }
  peerFailed() { this.fail(); }
  receive(value: unknown) {
    if (this.finished) return;
    try {
      if (++this.commands > 3 || !launchRecord(value) || typeof value.id !== "string" || !/^[a-f0-9]{32}$/.test(value.id))
        throw new Error("Invalid launch command");
      if (value.type === "start") { this.start(value); return; }
      const run = this.run;
      if (!run || value.id !== run.id || !run.started || run.closed) throw new Error("Unexpected launch command");
      if (value.type === "cancel" && launchKeys(value, ["type", "id"])) { this.stop(run); return; }
      if (value.type !== "authorize" || !launchKeys(value, ["type", "id", "input"]) || run.authorized
        || run.metadata.kind === "identity" || !(value.input instanceof ArrayBuffer)) throw new Error("Invalid launch authority");
      run.authorized = true;
      const recovery = run.metadata.kind === "bootstrap" && run.metadata.operation === "recover";
      if (value.input.byteLength !== (recovery || run.metadata.kind === "directory" ? 8 : 96)) throw new Error("Invalid native launch input size");
      const wire = new Uint8Array(value.input), input = Buffer.from(wire);
      let handedOff = false;
      try {
        if (recovery && !input.equals(createNativeRecoveryGrant())
          || run.metadata.kind === "directory" && !input.equals(createNativeDirectoryGrant())) throw new Error("Invalid native authority grant");
        if (!this.allowed(run) || !commitNativeLaunchGate(run.gate, run.deadline, this.now)) { this.stop(run); return; }
        // CAS is immediately followed by its clock/cancel post-check and IO.
        run.input = input; handedOff = true;
        run.child!.stdin.end(input, () => { input.fill(0); if (run.input === input) run.input = undefined; });
      } finally {
        wire.fill(0);
        // A queued native write may still reference input. Its callback or
        // actual child.close owns zeroization after handoff, including failure.
        if (!handedOff) input.fill(0);
      }
    } catch { this.fail(); }
  }
  private start(value: Record<string, unknown>) {
    if (this.run || !launchKeys(value, ["type", "version", "id", "request", "deadline", "gate"]) || value.version !== 1
      || !launchRecord(value.request) || typeof value.deadline !== "bigint" || !(value.gate instanceof SharedArrayBuffer))
      throw new Error("Invalid native launch start");
    const request = value.request;
    let metadata: NativeLaunchMetadata;
    if ((request.kind === "identity" || request.kind === "directory") && launchKeys(request, ["kind"])) metadata = { kind: request.kind };
    else if (request.kind === "bootstrap" && launchKeys(request, ["kind", "operation"])
      && typeof request.operation === "string" && ["publish", "consume", "recover"].includes(request.operation))
      metadata = { kind: "bootstrap", operation: request.operation as "publish" | "consume" | "recover" };
    else if (request.kind === "session" && launchKeys(request, ["kind", "operation"])
      && typeof request.operation === "string" && ["prepare", "seal", "publish", "release-pristine", "release-clean"].includes(request.operation))
      metadata = { kind: "session", operation: request.operation as "prepare" | "seal" | "publish" | "release-pristine" | "release-clean" };
    else throw new Error("Invalid native launch role");
    const cap = NATIVE_LAUNCH_MAX_BUDGET_NS, now = this.now();
    if (value.deadline <= now || value.deadline - now > cap || nativeLaunchGateState(value.gate).cancelled
      || nativeLaunchGateState(value.gate).committed) throw new Error("Invalid native launch initial gate/deadline");
    const run: Run = { id: value.id as string, metadata, deadline: value.deadline, gate: value.gate,
      started: false, closed: false, authorized: false, failed: false, killed: false, input: undefined, stdout: Buffer.alloc(0), stderrBytes: 0 };
    this.run = run;
    const directory = metadata.kind === "directory";
    const file = directory ? win32.join(this.config.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe")
      : metadata.kind === "identity" ? this.config.identity : metadata.kind === "bootstrap" ? this.config.bootstrap : this.config.broker;
    const args = metadata.kind === "directory" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", NATIVE_DIRECTORY_SCRIPT]
      : metadata.kind === "identity" ? ["--identity", String(process.pid)] : ["--" + metadata.operation, this.config.controlFile];
    try {
      const child = this.io.spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...this.config.env, ...(directory ? { TAHTIAPURI_PRIVATE_DIR: win32.dirname(this.config.controlFile) } : {}) } });
      run.child = child; // Retain before any listener, message, stdin or callback.
      child.once("close", (code, signal) => this.closed(run, code, signal));
      child.on("error", () => this.stop(run));
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => this.stop(run));
      child.stdout.on("data", (chunk: Buffer) => {
        if (run.closed) return;
        if (!Buffer.isBuffer(chunk) || run.stdout.length + chunk.length > 128) this.stop(run);
        else run.stdout = Buffer.concat([run.stdout, chunk]);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (run.closed) return;
        if (!Buffer.isBuffer(chunk)) { this.stop(run); return; }
        run.stderrBytes = Math.min(129, run.stderrBytes + chunk.length); run.failed = true;
        if (run.stderrBytes > 128) this.stop(run);
      });
      run.timer = setTimeout(() => this.stop(run), Math.max(0, Number((run.deadline - this.now() + 999_999n) / 1_000_000n)));
      run.started = true;
      this.io.post({ type: "started", id: run.id }); // Launch returned, not native ready.
      if (!this.allowed(run)) this.stop(run); // Includes late synchronous spawn.
      else if (metadata.kind === "identity") child.stdin.destroy(); // Read-only native query ignores stdin.
    } catch {
      run.failed = true;
      if (run.child) this.stop(run);
      else { this.finished = true; this.io.retire(true); }
    }
  }
  private closed(run: Run, code: number | null, signal: NodeJS.Signals | null) {
    if (run.closed || this.finished) return;
    run.closed = true; clearTimeout(run.timer); this.finished = true;
    run.input?.fill(0); run.input = undefined;
    if (this.now() >= run.deadline) { run.failed = true; cancelNativeLaunchGate(run.gate); }
    // The port/worker can retire only now; child exit or stdout alone is not close.
    try {
      this.io.post({ type: "closed", id: run.id, code, signal, stdout: new Uint8Array(run.stdout),
        stderrBytes: run.stderrBytes, failed: run.failed });
      run.stdout.fill(0); this.io.retire(false);
    } catch { run.stdout.fill(0); this.io.retire(true); }
  }
}
