import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type RecoveryInputMode = "eof" | "hold" | "close";
export interface RecoveryProbeIo {
  absent(which: "pending" | "final"): Promise<void>;
  createPending(): Promise<void>;
  readPending(): Promise<Buffer>;
  removePending(): Promise<void>;
  diagnostic(name: string, value: unknown): Promise<void>;
}
type Stage = "case-enter" | "case-settled" | "fs-enter" | "fs-return" | "fs-error"
  | "spawn-enter" | "spawn-return" | "spawn-throw" | "stdin-enter" | "stdin-return" | "stdin-callback"
  | "child-close" | "failure" | "diagnostic-enter" | "diagnostic-return" | "diagnostic-error"
  | "teardown-enter" | "teardown-return";
type IoLabel = "package-verify" | "pending-absence" | "final-absence" | "pending-create" | "pending-read" | "pending-remove" | "diagnostic";
type FailureReason = "case-deadline" | "operation-deadline" | "work-rejected" | "child-io"
  | "stdin-error" | "close-unknown" | "native-result" | "diagnostic-deadline"
  | "case-overlap" | "teardown-unsettled" | "event-overflow";
type Context = { id: number; deadline: number; phase: Stage; spawn: "not-entered" | "entered" | "returned" | "threw";
  operation?: Promise<unknown>; operationSettled: boolean; child?: OwnedChild };
type OwnedChild = { handle: ChildProcessWithoutNullStreams; close: Promise<void>; closed: boolean;
  code: number | null; signal: NodeJS.Signals | null; closeAt: number | null; closeOrder: number | null; killRequests: number;
  failed: boolean; inputAttempted: boolean; inputCompleted: boolean; inputError: boolean;
  stdout: Buffer; stderr: Buffer; stop: () => void };
export type RecoveryProbeResult = { code: number | null; signal: NodeJS.Signals | null;
  stdout: string; stderr: string; closeObserved: boolean; killed: boolean; timedOut: boolean; inputError: boolean; elapsedMs: number };
const pendingBytes = Buffer.from([84, 77, 66, 79, 79, 84, 49, 0]);

/** Test-only owner for a fixed production CLI supplied by trusted fixture
 * composition. Never imported by application code. Retains original promises,
 * pending OS IO and returned child handles; no helper retries or replacement.
 * Diagnostic budgets do not extend the original native operation deadline. */
export class NativeRecoveryProbe {
  private firstFailure: Readonly<{ reason: FailureReason; at: number; order: number; case: number | null }> | null = null;
  private closing = false;
  private contexts: Context[] = [];
  private active: Context | undefined;
  private workId = 0;
  private eventSequence = 0;
  private pending = new Map<number, { kind: "filesystem" | "diagnostic"; label: IoLabel; operation: Promise<unknown> }>();
  private events: { stage: Stage; at: number; order: number; case: number | null; operation?: IoLabel }[] = [];
  private overflow = false;
  constructor(private readonly io: RecoveryProbeIo, private readonly launch: () => ChildProcessWithoutNullStreams,
    private readonly now: () => number = performance.now.bind(performance)) {}
  private mark(stage: Stage, context?: Context, operation?: IoLabel) {
    const order = ++this.eventSequence;
    if (context) context.phase = stage;
    if (this.events.length < 1024) this.events.push({ stage, at: this.now(), order, case: context?.id ?? null, ...(operation ? { operation } : {}) });
    else { this.overflow = true; this.fail("event-overflow", context); }
    return order;
  }
  private fail(reason: FailureReason, context?: Context) {
    if (!this.firstFailure) {
      this.firstFailure = Object.freeze({ reason, at: this.now(), order: ++this.eventSequence, case: context?.id ?? null });
      if (this.events.length < 1024) this.events.push({ stage: "failure", at: this.now(), order: this.firstFailure.order, case: context?.id ?? null });
    }
  }
  prepare<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.canStart() || this.contexts.length) return Promise.reject(new Error("Recovery preparation owner fenced"));
    return this.work("filesystem", undefined, "package-verify", operation, this.now() + 10000);
  }
  canStart() {
    return !this.closing && !this.firstFailure && !this.active && !this.pending.size
      && !this.contexts.some(context => context.child && !context.child.closed);
  }
  private alive(context: Context, deadline = context.deadline) {
    if (this.closing || this.firstFailure || this.active !== context || this.now() >= deadline) {
      this.fail(this.now() >= context.deadline ? "case-deadline" : "operation-deadline", context);
      throw new Error("Recovery probe original deadline or owner fence");
    }
  }
  private async until<T>(operation: Promise<T>, deadline: number, timeout: () => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const remaining = deadline - this.now();
      if (remaining <= 0) { timeout(); throw new Error("Recovery observation original deadline"); }
      const value = await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timeout(); reject(new Error("Recovery observation deadline")); }, remaining);
      })]);
      if (this.now() >= deadline) { timeout(); throw new Error("Recovery observation late completion"); }
      return value;
    } finally { clearTimeout(timer); }
  }
  private async work<T>(kind: "filesystem" | "diagnostic", context: Context | undefined,
    label: IoLabel, operation: () => Promise<T>, deadline: number): Promise<T> {
    const id = ++this.workId; this.mark(kind === "filesystem" ? "fs-enter" : "diagnostic-enter", context, label);
    // The rejected promise remains observed even after the local timer wins.
    let original: Promise<T>;
    try { original = operation(); }
    catch (error) { this.fail("work-rejected", context); throw error; }
    const observed = original.then(value => {
      this.pending.delete(id); this.mark(kind === "filesystem" ? "fs-return" : "diagnostic-return", context, label); return value;
    }, error => {
      this.pending.delete(id); this.mark(kind === "filesystem" ? "fs-error" : "diagnostic-error", context, label);
      this.fail("work-rejected", context); throw error;
    });
    this.pending.set(id, { kind, label, operation: observed }); void observed.catch(() => {});
    return this.until(observed, deadline, () => this.fail(kind === "filesystem" ? "case-deadline" : "diagnostic-deadline", context));
  }
  private async fs<T>(context: Context, label: IoLabel, operation: () => Promise<T>) {
    this.alive(context); const value = await this.work("filesystem", context, label, operation, context.deadline);
    this.alive(context); return value;
  }
  private diagnostic(name: string, value: unknown, context?: Context) {
    if (name !== "teardown.json" && !/^case-(0[1-9]|1[0-3])(?:-process)?\.json$/.test(name))
      return Promise.reject(new Error("Invalid recovery diagnostic name"));
    return this.work("diagnostic", context, "diagnostic", () => this.io.diagnostic(name, value), this.now() + 1000);
  }
  run(input: Buffer, mode: RecoveryInputMode, accepted: boolean, expectedCode: number): Promise<RecoveryProbeResult> {
    if (!this.canStart() || this.contexts.length >= 13) {
      this.fail("case-overlap"); return Promise.reject(new Error("Recovery probe refuses another launch"));
    }
    const context: Context = { id: this.contexts.length + 1, deadline: this.now() + 8500,
      phase: "case-enter", spawn: "not-entered", operationSettled: false };
    this.contexts.push(context); this.active = context; this.mark("case-enter", context);
    // Copy before IO/callbacks. The fixed fixture supplies only public grant bytes.
    const captured = Buffer.from(input);
    const original = this.runCase(context, captured, mode, accepted, expectedCode);
    const observed = original.then(value => {
      context.operationSettled = true; this.active = undefined; this.mark("case-settled", context); return value;
    }, error => {
      this.fail("work-rejected", context); context.operationSettled = true; this.active = undefined;
      this.mark("case-settled", context); throw error;
    });
    context.operation = observed; void observed.catch(() => {}); return observed;
  }
  private async runCase(context: Context, input: Buffer, mode: RecoveryInputMode, accepted: boolean, expectedCode: number) {
    const timer = setTimeout(() => this.fail("case-deadline", context), Math.max(0, context.deadline - this.now()));
    try {
      await this.fs(context, "pending-absence", () => this.io.absent("pending"));
      await this.fs(context, "final-absence", () => this.io.absent("final"));
      await this.fs(context, "pending-create", () => this.io.createPending());
      const result = await this.invoke(context, input, mode); this.alive(context);
      if (result.code !== expectedCode || result.signal !== null || !result.closeObserved || result.killed || result.inputError)
        throw new Error("Unexpected native recovery result");
      await this.fs(context, "final-absence", () => this.io.absent("final"));
      if (accepted) {
        if (result.stdout !== "descriptor-absent\n" || result.stderr !== "") throw new Error("Invalid recovery acknowledgement");
        await this.fs(context, "pending-absence", () => this.io.absent("pending"));
      } else {
        if (result.stdout !== "" || (expectedCode === 1 ? !/^bootstrap-(input-size|recovery-grant):13\r?\n$/.test(result.stderr) : result.stderr !== ""))
          throw new Error("Invalid recovery refusal");
        if (!(await this.fs(context, "pending-read", () => this.io.readPending())).equals(pendingBytes)) throw new Error("Recovery changed refused fixture");
        await this.fs(context, "pending-remove", () => this.io.removePending());
      }
      this.alive(context);
      await this.diagnostic("case-" + context.id.toString().padStart(2, "0") + ".json",
        { passed: true, inputHex: input.toString("hex"), mode, accepted, outcome: result,
          completeGrantCloseIsNotRevocation: mode === "close" }, context);
      this.alive(context); return result;
    } catch (error) { this.fail("native-result", context); throw error; }
    finally { clearTimeout(timer); }
  }
  private async invoke(context: Context, input: Buffer, mode: RecoveryInputMode): Promise<RecoveryProbeResult> {
    this.alive(context);
    const begin = this.now(), deadline = Math.min(begin + 6000, context.deadline);
    this.mark("spawn-enter", context); context.spawn = "entered";
    let handle: ChildProcessWithoutNullStreams;
    try { handle = this.launch(); }
    catch (error) { context.spawn = "threw"; this.mark("spawn-throw", context); this.fail("child-io", context); throw error; }
    context.spawn = "returned"; this.mark("spawn-return", context);
    let resolveClosed!: () => void;
    const child: OwnedChild = { handle, close: new Promise<void>(resolveClose => { resolveClosed = resolveClose; }),
      closed: false, code: null, signal: null, closeAt: null, closeOrder: null, killRequests: 0, failed: false,
      inputAttempted: false, inputCompleted: false, inputError: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stop: () => {} };
    context.child = child; // Retain the actual handle before any stdin operation.
    child.stop = () => {
      child.failed = true;
      if (!child.closed && !child.killRequests) { ++child.killRequests; try { handle.kill(); } catch { this.fail("child-io", context); } }
    };
    handle.once("close", (code, signal) => {
      child.closed = true; child.code = code; child.signal = signal; child.closeAt = this.now();
      child.closeOrder = this.mark("child-close", context); resolveClosed();
    });
    const ioError = () => { if (!child.closed) { this.fail("child-io", context); child.stop(); } };
    handle.on("error", ioError); handle.stdout.on("error", ioError); handle.stderr.on("error", ioError);
    handle.stdin.on("error", () => {
      if (!child.closed) { child.inputError = true; this.fail("stdin-error", context); child.stop(); }
    });
    for (const [stream, field, cap] of [[handle.stdout, "stdout", 128], [handle.stderr, "stderr", 256]] as const)
      stream.on("data", (chunk: Buffer) => {
        if (child.closed) return;
        if (!Buffer.isBuffer(chunk) || child[field].length + chunk.length > cap) ioError();
        else child[field] = Buffer.concat([child[field], chunk]);
      });
    let timer: NodeJS.Timeout | undefined, returning = false;
    const closeUntil = async () => {
      if (child.closed) return;
      try { await this.until(child.close, deadline + 1000, () => this.fail("close-unknown", context)); }
      catch { this.fail("close-unknown", context); throw new Error("Native recovery close remained unknown"); }
    };
    try {
      timer = setTimeout(() => { this.fail("operation-deadline", context); child.stop(); }, Math.max(0, deadline - this.now()));
      try {
        this.alive(context, deadline); child.inputAttempted = true; this.mark("stdin-enter", context);
        if (mode === "eof") handle.stdin.end(input, () => { child.inputCompleted = true; this.mark("stdin-callback", context); });
        else handle.stdin.write(input, error => {
          if (error) { child.inputError = true; this.fail("stdin-error", context); child.stop(); }
          else {
            child.inputCompleted = true; this.mark("stdin-callback", context);
            if (mode === "close") { try { handle.stdin.destroy(); } catch { child.inputError = true; this.fail("stdin-error", context); child.stop(); } }
          }
        });
        this.mark("stdin-return", context);
      } catch { child.inputError = true; this.fail("stdin-error", context); child.stop(); }
      await closeUntil(); this.alive(context, deadline);
      if (child.failed || child.inputError || !child.inputCompleted) throw new Error("Recovery helper transport failed");
      const result = { code: child.code, signal: child.signal, stdout: child.stdout.toString("ascii"),
        stderr: child.stderr.toString("ascii"), closeObserved: child.closed, killed: child.killRequests !== 0,
        timedOut: false, inputError: child.inputError, elapsedMs: this.now() - begin };
      returning = true; return result;
    } catch (error) { child.failed = true; this.fail("native-result", context); throw error; }
    finally {
      clearTimeout(timer);
      if (!child.closed) { child.stop(); try { await closeUntil(); } catch { /* Original failure and unknown handle remain retained. */ } }
      try { handle.stdin.destroy(); } catch { child.inputError = true; this.fail("stdin-error", context); child.stop(); }
      await this.diagnostic("case-" + context.id.toString().padStart(2, "0") + "-process.json",
        { failed: child.failed, code: child.code, signal: child.signal, closeObserved: child.closed,
          timedOut: this.now() >= deadline, inputError: child.inputError, inputAttempted: child.inputAttempted,
          inputWriteCompleted: child.inputCompleted, killRequests: child.killRequests, elapsedMs: this.now() - begin,
          stdoutHex: child.stdout.toString("hex"), stderrHex: child.stderr.toString("hex") }, context);
      if (returning && (child.failed || child.inputError || !child.closed || this.firstFailure))
        throw new Error("Recovery final observation failed");
    }
  }
  snapshot() {
    return {
      failed: this.firstFailure !== null, originalFailure: this.firstFailure,
      closing: this.closing, eventsOverflow: this.overflow,
      pendingWork: [...this.pending.values()].map(work => ({ kind: work.kind, operation: work.label })),
      contexts: this.contexts.map(context => ({ id: context.id, phase: context.phase, spawn: context.spawn,
        operationSettled: context.operationSettled, childReturned: !!context.child,
        childPid: context.child?.handle.pid ?? null, childCloseObserved: context.child?.closed ?? false,
        childCloseAt: context.child?.closeAt ?? null, killRequests: context.child?.killRequests ?? 0,
        inputAttempted: context.child?.inputAttempted ?? false,
        closeAfterOriginalFailure: context.child?.closeOrder !== null && context.child?.closeOrder !== undefined && !!this.firstFailure
          && context.child.closeOrder > this.firstFailure.order })),
      events: this.events.map(event => ({ ...event })),
    };
  }
  async teardown() {
    this.closing = true; this.mark("teardown-enter"); // Fence before waiting or stopping anything.
    if (this.active || this.pending.size || this.contexts.some(context => context.child && !context.child.closed))
      this.fail("teardown-unsettled", this.active);
    for (const context of this.contexts) if (context.child && !context.child.closed) context.child.stop();
    const pending = [...this.pending.values()].map(work => work.operation);
    for (const context of this.contexts) {
      if (context.operation && !context.operationSettled) pending.push(context.operation);
      if (context.child && !context.child.closed) pending.push(context.child.close);
    }
    let drainedWithinBudget = true;
    try { await this.until(Promise.allSettled(pending), this.now() + 1000, () => { drainedWithinBudget = false; }); }
    catch { drainedWithinBudget = false; }
    this.mark("teardown-return");
    const snapshot = { ...this.snapshot(), drainedWithinBudget,
      scope: "Test-only original ownership and later observations; late close never upgrades original failure" };
    await this.diagnostic("teardown.json", snapshot);
    return snapshot;
  }
}
