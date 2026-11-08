import type { Duplex } from "node:stream";
import { isBridgeCommand, type DevelopmentResult } from "@tahtiapuri/validation/development";
import { NativeDevelopmentAdmission, type NativeDevelopmentLease, type NativeLaunchTicket } from "./native-development-admission.js";
import { ControlKind, NativeControl, NativeControlReader, type ControlFrame } from "./native-development-wire.js";
import { NativeControlWriter } from "./native-development-writer.js";

export interface NativeConnectionOutcome {
  readonly authenticated: boolean;
  readonly brokerCleanupReported: boolean;
  readonly backendDetachSettled: boolean;
  readonly descriptorConsumptionSettled: boolean;
  readonly epochRevoked: boolean;
  readonly streamClosed: boolean;
  readonly failed: boolean;
}
export interface NativeConnectionOwner {
  /** Remove only this claimed descriptor. Must not resolve before removal completes. */
  consume(ticket: NativeLaunchTicket, signal: AbortSignal, deadline: number): Promise<void>;
  /** Revoke this generation's backend epoch. A later generation must never share this closure. */
  revoke(): Promise<boolean>;
}

type OriginalKind = "authenticate" | "attach-facade" | "consume" | "invoke" | "revoke" | "revoke-producer" | "writer" | "stream-close" | "finish";
interface OriginalWork {
  readonly kind: OriginalKind;
  readonly original: Promise<unknown>;
  readonly observation: boolean;
  outcome?: Readonly<{ status: "fulfilled" }> | Readonly<{ status: "rejected"; reason: unknown }>;
}

/** One terminal Main-side connection. Listener, protected publication and actual
 * native broker process/Job evidence are owned separately; no automatic rearm. */
export class NativeMainConnection {
  readonly closed: Promise<NativeConnectionOutcome>;
  /** Own original API/callback work + actual stream close, never backend/Job proof. */
  readonly originalClosed: Promise<Readonly<{ failed: boolean }>>;
  private resolveOriginalClosed!: (result: Readonly<{ failed: boolean }>) => void;
  private readonly originalWork = new Set<OriginalWork>();
  private firstOriginalFailure: Readonly<{ reason: unknown }> | undefined;
  private laterOriginalFailures = 0;
  private originalFailed = false;
  private originalUnknown = false;
  private originalEnded = false;
  private terminalRegistrationComplete = false;
  private finishingWork: Promise<void> | undefined;
  private rawRevocation: Promise<boolean> | undefined;
  private resolveClosed!: (outcome: NativeConnectionOutcome) => void;
  private phase: "hello" | "authenticating" | "active" | "stopping" | "finishing" | "closed" = "hello";
  private lease: NativeDevelopmentLease | undefined;
  private authenticated = false;
  private authenticationComplete = false;
  private readonly authenticationDeadline: number;
  private cleanup = false;
  private failed = false;
  private streamClosed = false;
  private pending = 0;
  private discardedWhileStopping = 0;
  private calls = 0;
  private bucket = Date.now();
  private readonly ids = new Set<string>();
  private readonly abort = new AbortController();
  private readonly reader: NativeControlReader;
  private readonly writer: NativeControlWriter;
  private authenticationTimer: NodeJS.Timeout | undefined;
  private shutdownTimer: NodeJS.Timeout | undefined;
  private closeTimer: NodeJS.Timeout | undefined;
  private detach: Promise<boolean> | undefined;
  private consumption: Promise<void> | undefined;
  private revoked: Promise<boolean> | undefined;
  private finishStarted = false;
  private observedClose!: () => void;
  private readonly closeObserved: Promise<void>;

  constructor(private readonly stream: Duplex, private readonly admission: NativeDevelopmentAdmission,
    private readonly owner: NativeConnectionOwner) {
    this.authenticationDeadline = performance.now() + NativeControl.authenticationTimeoutMs;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.originalClosed = new Promise(resolve => { this.resolveOriginalClosed = resolve; });
    this.closeObserved = new Promise(resolve => { this.observedClose = resolve; });
    this.reader = new NativeControlReader("to-main", frame => this.receive(frame), () => this.fail());
    this.writer = new NativeControlWriter(stream, () => {
      const failure = this.writer.originalFailure;
      this.noteOriginalFailure(failure ? failure.reason : new Error("Original native write failed"));
      this.fail(); // History is latched BEFORE the already-closed phase guard.
    });
    this.retainOriginal("writer", this.writer.originalClosed.then(result => {
      if (typeof result.failed !== "boolean") throw new Error("Invalid original writer observation");
      if (result.failed) {
        const failure = this.writer.originalFailure;
        this.noteOriginalFailure(failure ? failure.reason : new Error("Original native writer failed"));
      }
    }), true);
    this.retainOriginal("stream-close", this.closeObserved, true);
    this.authenticationTimer = setTimeout(() => this.fail(), Math.max(0, this.authenticationDeadline - performance.now()));
    stream.on("error", error => this.fail(error));
    stream.once("end", () => { this.reader.end(); if (!this.cleanup) this.fail(); });
    stream.once("close", () => {
      this.streamClosed = true; this.observedClose();
      if (!this.finishStarted) this.fail();
    });
    stream.on("data", (chunk: Buffer) => this.reader.write(chunk));
    if (stream.destroyed || stream.readableEnded || stream.writableEnded) this.fail();
  }

  get originalWorkSettled(): boolean { return this.originalEnded; }
  get originalFailure(): Readonly<{ reason: unknown }> | undefined { return this.firstOriginalFailure; }
  private noteOriginalFailure(reason: unknown): void {
    this.originalFailed = true;
    if (!this.firstOriginalFailure) this.firstOriginalFailure = Object.freeze({ reason });
    else this.laterOriginalFailures = Math.min(Number.MAX_SAFE_INTEGER, this.laterOriginalFailures + 1);
  }
  private retainOriginal<T>(kind: OriginalKind, original: Promise<T>, observation = false): Promise<T> {
    const record: OriginalWork = { kind, original, observation }; this.originalWork.add(record);
    const ended = (outcome: NonNullable<OriginalWork["outcome"]>) => {
      record.outcome = Object.freeze(outcome);
      if (outcome.status === "rejected") {
        this.noteOriginalFailure(outcome.reason);
        if (record.observation) this.originalUnknown = true; // Rejected status port is not end proof.
      }
      this.originalWork.delete(record); this.checkOriginal();
    };
    void original.then(() => ended({ status: "fulfilled" }), reason => ended({ status: "rejected", reason }));
    return original;
  }
  private checkOriginal(): void {
    if (!this.originalEnded && !this.originalUnknown && this.terminalRegistrationComplete && this.originalWork.size === 0) {
      this.originalEnded = true;
      this.resolveOriginalClosed(Object.freeze({ failed: this.originalFailed }));
    }
  }

  /** Revokes admission immediately, then gives an authenticated broker a bounded
   * opportunity to stop its worker and report CLEAN. Not a native cleanup proof. */
  stop(): Promise<NativeConnectionOutcome> {
    if (this.phase === "closed" || this.phase === "finishing") return this.closed;
    if (!this.authenticationComplete && performance.now() >= this.authenticationDeadline) { this.fail(); return this.closed; }
    if (this.phase === "stopping") return this.closed;
    const active = this.authenticated;
    this.phase = "stopping";
    // STOP never renews an unfinished authentication. Only a completed one
    // receives the independent shutdown grace.
    if (this.authenticationComplete) clearTimeout(this.authenticationTimer);
    this.abort.abort(); this.revoke();
    // Abort listeners may synchronously complete CLEAN or close the stream.
    if (this.finishStarted) return this.closed;
    if (!active) { this.finish(); return this.closed; }
    this.shutdownTimer = setTimeout(() => this.fail(), NativeControl.shutdownTimeoutMs);
    void this.writer.write({ kind: ControlKind.stop, body: Buffer.alloc(0) }).catch(() => this.failUnlessFinishing());
    return this.closed;
  }
  private receive(frame: ControlFrame) {
    if (this.phase === "closed") return;
    if (!this.authenticationComplete && (this.phase === "hello" || this.phase === "authenticating" || this.phase === "active" || this.phase === "stopping")
      && performance.now() >= this.authenticationDeadline) { this.fail(); return; }
    if (this.phase === "hello" && frame.kind === ControlKind.hello) {
      const ticket = { generation: frame.body.subarray(0, 16).toString("hex"), token: frame.body.subarray(16).toString("hex") };
      const lease = this.admission.claim(ticket.generation, ticket.token, this.authenticationDeadline);
      if (!lease) { this.fail(); return; }
      this.lease = lease; this.phase = "authenticating";
      this.retainOriginal("attach-facade", lease.ready);
      this.retainOriginal("authenticate", Promise.resolve().then(() => {
        if (this.phase !== "authenticating") return;
        return this.authenticate(ticket, lease);
      }));
      return;
    }
    if ((this.phase === "active" || this.phase === "stopping") && this.authenticated && frame.kind === ControlKind.clean) {
      this.cleanup = true; this.finish(); return;
    }
    const stoppingRequest = this.phase === "stopping" && this.authenticated;
    if ((this.phase !== "active" && !stoppingRequest) || frame.kind !== ControlKind.request) { this.fail(); return; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(frame.body)); }
    catch { this.fail(); return; }
    if (!isBridgeCommand(value) || this.ids.has(value.id) || !stoppingRequest && this.pending >= 4) { this.fail(); return; }
    if (Date.now() - this.bucket >= 1000) { this.bucket = Date.now(); this.calls = 0; }
    if (++this.calls > 60) { this.fail(); return; }
    this.ids.add(value.id); if (this.ids.size > 256) this.ids.delete(this.ids.values().next().value!);
    // STOP and an already-sent REQUEST can cross on the duplex pipe. Validate
    // and discard at most eight, without invoking, replying or renewing grace.
    if (stoppingRequest) { if (++this.discardedWhileStopping > 8) this.fail(); return; }
    const command = value;
    ++this.pending;
    this.retainOriginal("invoke", Promise.resolve().then(async () => {
      try {
        if (this.phase !== "active") return;
        if (!this.authenticationComplete && performance.now() >= this.authenticationDeadline) { this.fail(); return; }
        let result: DevelopmentResult;
        try { result = await this.lease!.invoke(command); }
        catch (error) { this.noteOriginalFailure(error); throw error; }
        if (this.phase !== "active") return;
        if (this.admission.phase !== "active") { this.fail(); return; }
        await this.writer.write({ kind: ControlKind.response, body: Buffer.from(JSON.stringify({ id: command.id, result }), "utf8") });
      } catch { this.failUnlessFinishing(); } // Intentional logical writer cancellation is not a raw callback error.
      finally { --this.pending; }
    }));
  }
  private async authenticate(ticket: NativeLaunchTicket, lease: NativeDevelopmentLease) {
    try {
      this.consumption = this.retainOriginal("consume", Promise.resolve().then(() => {
        if (this.abort.signal.aborted || performance.now() >= this.authenticationDeadline)
          throw new Error("Native connection stopped or expired before descriptor consumption.");
        return this.owner.consume(ticket, this.abort.signal, this.authenticationDeadline);
      }));
      const [, ready] = await Promise.all([this.consumption, lease.ready]);
      if (this.phase !== "authenticating") return;
      if (!ready || this.abort.signal.aborted || performance.now() >= this.authenticationDeadline) { this.fail(); return; }
      // ACK can reach the broker before the physical write callback fires.
      this.phase = "active"; this.authenticated = true;
      await this.writer.write({ kind: ControlKind.accept, body: Buffer.from(ticket.generation, "hex") });
      if (this.phase !== "active") return;
      if (this.abort.signal.aborted || performance.now() >= this.authenticationDeadline) { this.fail(); return; }
      this.authenticationComplete = true;
      clearTimeout(this.authenticationTimer);
    } catch { this.failUnlessFinishing(); }
  }
  private failUnlessFinishing() {
    if (this.phase !== "finishing" && this.phase !== "closed") this.fail();
  }
  private fail(reason: unknown = new Error("Native connection failed")) {
    this.noteOriginalFailure(reason);
    if (this.phase === "closed") return;
    this.failed = true; this.finish();
  }
  private revoke() {
    this.detach ??= this.admission.disable();
    // Complete (or bound) detach first: configure(null) would otherwise make
    // the real backend reject the still-pending detach as an old epoch.
    this.revoked ??= this.retainOriginal("revoke-producer", this.detach.then(() => {
      // Retain the exact owner call BEFORE its bounded facade. This producer
      // remains registered until the later raw call has also been registered.
      this.rawRevocation = this.retainOriginal("revoke", Promise.resolve().then(() => this.owner.revoke()));
      return this.bounded(this.rawRevocation);
    }));
  }
  private finish() {
    if (this.finishStarted || this.finishingWork) return;
    this.finishStarted = true; this.phase = "finishing";
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    // Publish the producer BEFORE abort/destroy callbacks can reenter. Protocol
    // fencing below remains synchronous so a partial trailer after CLEAN fails.
    this.finishingWork = this.retainOriginal("finish", started.then(async () => {
      const [detached, revoked, consumed, closed] = await Promise.all([
        this.detach ?? Promise.resolve(false), this.revoked ?? Promise.resolve(false),
        this.consumption ? this.bounded(this.consumption.then(() => true, () => true)) : Promise.resolve(true),
        new Promise<boolean>(resolve => {
          if (this.streamClosed) { resolve(true); return; }
          this.closeTimer = setTimeout(() => resolve(false), NativeControl.ioTimeoutMs);
          void this.closeObserved.then(() => resolve(true));
        }),
      ]);
      clearTimeout(this.closeTimer); this.reader.stop(); this.phase = "closed";
      this.resolveClosed(Object.freeze({ authenticated: this.authenticated, brokerCleanupReported: this.cleanup,
        backendDetachSettled: detached, descriptorConsumptionSettled: consumed, epochRevoked: revoked, streamClosed: closed,
        failed: this.failed || (!!this.detach && (!detached || !revoked)) || !consumed || !closed || this.authenticated && !this.cleanup }));
    }));
    try {
      clearTimeout(this.authenticationTimer); clearTimeout(this.shutdownTimer); this.abort.abort();
      if (this.lease || this.detach) this.revoke();
      this.writer.stop(); this.reader.forbidMoreData();
      this.stream.destroy();
    } catch (error) {
      this.noteOriginalFailure(error); this.originalUnknown = true; this.failed = true;
    } finally {
      this.terminalRegistrationComplete = true;
      begin(); this.checkOriginal();
    }
  }
  private bounded(work: Promise<boolean>): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value === true); } };
      const timer = setTimeout(() => finish(false), NativeControl.authenticationTimeoutMs);
      void work.then(finish, () => finish(false));
    });
  }
}
