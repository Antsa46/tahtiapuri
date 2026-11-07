import type { Duplex } from "node:stream";
import { isBridgeCommand } from "@tahtiapuri/validation/development";
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

/** One terminal Main-side connection. Listener, protected publication and actual
 * native broker process/Job evidence are owned separately; no automatic rearm. */
export class NativeMainConnection {
  readonly closed: Promise<NativeConnectionOutcome>;
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
    this.closeObserved = new Promise(resolve => { this.observedClose = resolve; });
    this.reader = new NativeControlReader("to-main", frame => this.receive(frame), () => this.fail());
    this.writer = new NativeControlWriter(stream, () => this.fail());
    this.authenticationTimer = setTimeout(() => this.fail(), Math.max(0, this.authenticationDeadline - performance.now()));
    stream.on("error", () => this.fail());
    stream.once("end", () => { this.reader.end(); if (!this.cleanup) this.fail(); });
    stream.once("close", () => {
      this.streamClosed = true; this.observedClose();
      if (!this.finishStarted) this.fail();
    });
    stream.on("data", (chunk: Buffer) => this.reader.write(chunk));
    if (stream.destroyed || stream.readableEnded || stream.writableEnded) this.fail();
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
      void this.authenticate(ticket, lease); return;
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
    ++this.pending;
    void (async () => {
      const result = await this.lease!.invoke(value);
      if (this.phase !== "active") return;
      if (this.admission.phase !== "active") { this.fail(); return; }
      await this.writer.write({ kind: ControlKind.response, body: Buffer.from(JSON.stringify({ id: value.id, result }), "utf8") });
    })().catch(() => this.failUnlessFinishing()).finally(() => { --this.pending; });
  }
  private async authenticate(ticket: NativeLaunchTicket, lease: NativeDevelopmentLease) {
    try {
      this.consumption = Promise.resolve().then(() => {
        if (this.abort.signal.aborted || performance.now() >= this.authenticationDeadline)
          throw new Error("Native connection stopped or expired before descriptor consumption.");
        return this.owner.consume(ticket, this.abort.signal, this.authenticationDeadline);
      });
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
  private fail() {
    if (this.phase === "closed") return;
    this.failed = true; this.finish();
  }
  private revoke() {
    this.detach ??= this.admission.disable();
    // Complete (or bound) detach first: configure(null) would otherwise make
    // the real backend reject the still-pending detach as an old epoch.
    this.revoked ??= this.detach.then(() => this.bounded(Promise.resolve().then(() => this.owner.revoke())));
  }
  private finish() {
    if (this.finishStarted) return;
    this.finishStarted = true; this.phase = "finishing";
    clearTimeout(this.authenticationTimer); clearTimeout(this.shutdownTimer); this.abort.abort();
    if (this.lease || this.detach) this.revoke();
    this.writer.stop(); this.reader.forbidMoreData();
    // Reject even a partial trailing header in the already received chunk.
    this.stream.destroy();
    void (async () => {
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
    })();
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
