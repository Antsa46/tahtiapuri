import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { FrameReader, KINDS, HEADER, TRANSPORT_POLICY, decodeJson, encodeJson, frame, type Frame } from "@tahtiapuri/backend-transport";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { isInitialize, isReady, isResponse } from "@tahtiapuri/validation/backend";
import { isModelRun, isModelCancel } from "@tahtiapuri/validation/model-wire";
import { ObservingMigrationWire } from "./observing-migration-wire.js";

export interface NativeBackendProcess extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): boolean;
}
export type NativeBackendPrepared = {
  pid: number; childNonce: string; requestedPolicy: "lpac-registryRead"; creationMode: "detached-backend";
  appContainer: true; lpac: true | null; lpacQueryError: number; lpacQueryBytes: number;
  capabilitySids: { sid: string; attributes: 4 }[]; integrity: 4096; job: true;
  activeProcessLimit: 1; affinity: 1; priority: "BelowNormal"; processMemoryBytes: 536870912;
  aclsVerified: true; consoleAbsent: true; networkVerified: false;
};
export type NativeBackendResult = {
  sessionOutcome: "normal" | "failed" | "recovered"; cleanupOutcome: "clean" | "blocked";
  reason: "none" | "cleanup" | "owner-eof" | "owner-kill" | "owner-lease" | "timeout" | "backpressure" | "worker-exit" | "protocol" | "internal" | "isolation";
  error: number; runNonce: string | null; childCreated: boolean; childResumed: boolean; exitCode: number | null;
  jobEmpty: boolean; persistentAclRestored: boolean; profileDeleted: boolean; sessionRemoved: boolean;
  journalClean: boolean; stderrComplete: boolean; consoleBefore: boolean; consoleAfterFirstFrame: boolean;
};
const registrySid = "S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681";
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const nonce = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const protocolError = () => new Error("Native backend protocol rejected.");
export function isNativeBackendPrepared(value: unknown, ownerNonce: string): value is NativeBackendPrepared {
  return isRecord(value) && exactKeys(value, ["pid", "childNonce", "requestedPolicy", "creationMode", "appContainer", "lpac", "lpacQueryError", "lpacQueryBytes", "capabilitySids", "integrity", "job", "activeProcessLimit", "affinity", "priority", "processMemoryBytes", "aclsVerified", "consoleAbsent", "networkVerified"])
    && uint(value.pid) && value.pid > 0 && nonce(value.childNonce) && value.childNonce !== ownerNonce
    && value.requestedPolicy === "lpac-registryRead" && value.creationMode === "detached-backend" && value.appContainer === true
    && (value.lpac === true ? value.lpacQueryError === 0 && value.lpacQueryBytes === 4 : value.lpac === null && value.lpacQueryError === 87 && value.lpacQueryBytes === 0)
    && Array.isArray(value.capabilitySids) && value.capabilitySids.length === 1 && isRecord(value.capabilitySids[0])
    && exactKeys(value.capabilitySids[0], ["sid", "attributes"]) && value.capabilitySids[0].sid === registrySid && value.capabilitySids[0].attributes === 4
    && value.integrity === 4096 && value.job === true && value.activeProcessLimit === 1 && value.affinity === 1
    && value.priority === "BelowNormal" && value.processMemoryBytes === 536870912 && value.aclsVerified === true && value.consoleAbsent === true && value.networkVerified === false;
}
const resultFlags = ["childCreated", "childResumed", "jobEmpty", "persistentAclRestored", "profileDeleted", "sessionRemoved", "journalClean", "stderrComplete", "consoleBefore", "consoleAfterFirstFrame"] as const;
export function isNativeBackendResult(value: unknown, runNonce?: string): value is NativeBackendResult {
  return isRecord(value) && exactKeys(value, ["sessionOutcome", "cleanupOutcome", "reason", "error", "runNonce", "exitCode", ...resultFlags])
    && typeof value.sessionOutcome === "string" && ["normal", "failed", "recovered"].includes(value.sessionOutcome)
    && typeof value.cleanupOutcome === "string" && ["clean", "blocked"].includes(value.cleanupOutcome)
    && typeof value.reason === "string" && ["none", "cleanup", "owner-eof", "owner-kill", "owner-lease", "timeout", "backpressure", "worker-exit", "protocol", "internal", "isolation"].includes(value.reason)
    && uint(value.error) && (value.exitCode === null || uint(value.exitCode))
    && (runNonce !== undefined ? value.runNonce === runNonce : value.runNonce === null || typeof value.runNonce === "string" && /^[a-f0-9]{32}$/.test(value.runNonce))
    && resultFlags.every(key => typeof value[key] === "boolean")
    && (!value.childResumed || value.childCreated === true) && (!value.consoleAfterFirstFrame || value.childResumed === true)
    && (value.cleanupOutcome !== "clean" || ["jobEmpty", "persistentAclRestored", "profileDeleted", "sessionRemoved", "journalClean"].every(key => value[key] === true))
    && (value.sessionOutcome === "failed" || value.cleanupOutcome === "clean" && value.reason === "none" && value.error === 0)
    && (value.sessionOutcome !== "normal" || value.childCreated === true && value.childResumed === true && value.exitCode === 0 && value.stderrComplete === true && value.consoleBefore === true && value.consoleAfterFirstFrame === true)
    && (value.sessionOutcome !== "recovered" || value.childCreated === false && value.childResumed === false && value.exitCode === null && value.stderrComplete === false && value.consoleBefore === false && value.consoleAfterFirstFrame === false);
}

/** One in-flight write is unavoidable; independent controls bypass every queued APP. */
class OwnerWriter {
  private sequence = 1n;
  private readonly apps: WriteEntry[] = [];
  private readonly controls: WriteEntry[] = [];
  private active: WriteEntry | undefined;
  private appBytes = 0;
  private appCount = 0;
  private failed = false;
  private closing = false;
  private closed = false;
  constructor(private readonly output: Writable, private readonly ownerNonce: string, private readonly failure: (error: unknown) => void) {
    output.on("error", error => this.fail(error));
    output.on("close", () => { if (!this.closed) this.fail(new Error("Native backend input closed unexpectedly.")); });
  }
  send(kind: number, body: Buffer = Buffer.alloc(0)): Promise<void> {
    if (this.failed || this.closed || this.output.destroyed || this.output.writableEnded) return Promise.reject(protocolError());
    const control = kind !== KINDS.APP;
    if (!control && (this.closing || this.appCount >= 32 || body.length + HEADER > 256 * 1024 - this.appBytes)) return Promise.reject(new Error("Native backend pending input limit exceeded."));
    if (control && this.controls.length >= 3) return Promise.reject(new Error("Native backend pending control limit exceeded."));
    if (kind === KINDS.CLOSE_CHILD_INPUT) this.closing = true;
    if (!control) { this.appCount++; this.appBytes += HEADER + body.length; }
    const promise = new Promise<void>((resolve, reject) => {
      const entry = { kind, body: Buffer.from(body), resolve, reject };
      // CLOSE is an ordered APP barrier; KILL and HEARTBEAT remain independent.
      (kind === KINDS.CLOSE_CHILD_INPUT ? this.apps : control ? this.controls : this.apps).push(entry);
    });
    this.pump(); return promise;
  }
  private pump(): void {
    if (this.active || this.failed || this.closed) return;
    const entry = this.controls.shift() ?? this.apps.shift(); if (!entry) return;
    this.active = entry;
    let returned = false, callback = false, drain = false, needsDrain = false;
    const finish = () => {
      if (this.failed || this.active !== entry || !returned || !callback || needsDrain && !drain) return;
      entry.cancel?.(); this.active = undefined;
      if (entry.kind === KINDS.APP) { this.appCount--; this.appBytes -= HEADER + entry.body.length; }
      entry.resolve(); queueMicrotask(() => this.pump());
    };
    const onDrain = () => { drain = true; finish(); };
    const timeout = setTimeout(() => this.fail(new Error("Native backend write deadline exceeded.")), 2000);
    entry.cancel = () => { clearTimeout(timeout); this.output.removeListener("drain", onDrain); };
    this.output.on("drain", onDrain);
    try {
      needsDrain = !this.output.write(frame(entry.kind, this.sequence++, this.ownerNonce, entry.body), error => { if (error) this.fail(error); else { callback = true; finish(); } });
      returned = true; finish();
    } catch (error) { this.fail(error); }
  }
  fail(error: unknown): void {
    if (this.failed || this.closed) return; this.failed = true;
    const cause = error instanceof Error ? error : protocolError();
    this.active?.cancel?.(); this.active?.reject(cause); this.active = undefined;
    for (const entry of [...this.apps, ...this.controls]) entry.reject(cause);
    this.apps.length = 0; this.controls.length = 0; this.appCount = 0; this.appBytes = 0; this.failure(cause);
  }
  finish(): void {
    this.closed = true; this.active?.cancel?.();
    const error = new Error("Native backend process closed.");
    this.active?.reject(error); this.active = undefined;
    for (const entry of [...this.apps, ...this.controls]) entry.reject(error);
    this.apps.length = 0; this.controls.length = 0;
  }
}
type WriteEntry = { kind: number; body: Buffer; resolve(): void; reject(error: Error): void; cancel?(): void };

/** FrameReader owns validation/allocation; this wrapper adds per-frame monotonic timers. */
class TimedReader {
  private readonly header = Buffer.alloc(HEADER);
  private headerUsed = 0;
  private remaining = 0;
  private progress: ReturnType<typeof setTimeout> | undefined;
  private lifetime: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly reader: FrameReader, private readonly failure: (error: unknown) => void) {}
  push(chunk: Buffer, accept: (record: Frame) => void): void {
    if (!Buffer.isBuffer(chunk)) throw protocolError();
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.headerUsed) this.lifetime = setTimeout(() => this.failure(new Error("Native backend frame age exceeded.")), 15_000);
      clearTimeout(this.progress); this.progress = setTimeout(() => this.failure(new Error("Native backend frame progress stalled.")), 2000);
      const headerPart = this.headerUsed < HEADER;
      const length = Math.min(headerPart ? HEADER - this.headerUsed : this.remaining, chunk.length - offset);
      const part = chunk.subarray(offset, offset + length);
      if (headerPart) { part.copy(this.header, this.headerUsed); this.headerUsed += length; }
      else this.remaining -= length;
      offset += length;
      this.reader.push(part, accept);
      if (headerPart && this.headerUsed === HEADER) this.remaining = this.header.readUInt32LE(16);
      if (this.headerUsed === HEADER && this.remaining === 0) { this.headerUsed = 0; this.clear(); }
    }
  }
  finish(): void { this.clear(); this.reader.finish(); }
  clear(): void { clearTimeout(this.progress); clearTimeout(this.lifetime); }
}
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Owners may attach later; terminal errors must never become unhandled events/rejections.
  void promise.catch(() => {}); return { promise, resolve, reject };
}
export interface NativeBackendPortOptions { ownerNonce: string; runNonce?: string; recover?: boolean }

/** Exit is actual broker exit. Completion additionally requires a single verified CLEAN receipt. */
export class NativeBackendPort extends EventEmitter {
  readonly startupTimeoutMs = 40_000;
  readonly prepared: Promise<NativeBackendPrepared>;
  readonly completion: Promise<NativeBackendResult>;
  readonly closure: Promise<void>;
  private readonly preparation = deferred<NativeBackendPrepared>();
  private readonly terminal = deferred<NativeBackendResult>();
  private readonly processClosed = deferred<void>();
  private readonly writer: OwnerWriter;
  private readonly outer: TimedReader;
  private readonly migration = new ObservingMigrationWire();
  private child: TimedReader | undefined;
  private state: "preparing" | "prepared" | "started" | "closing" | "terminal" = "preparing";
  private resultSeen = false;
  private receipt: NativeBackendResult | undefined;
  private failure: Error | undefined;
  private session: string | undefined;
  private ready = false;
  private shutdownRequest: string | undefined;
  private shutdownResponse = false;
  private exitSeen = false;
  private brokerClosed = false;
  private stdoutEnded = false;
  private stderrBytes = 0;
  private brokerStderrBytes = 0;
  private closePromise: Promise<void> | undefined;
  private readonly prepareTimer: ReturnType<typeof setTimeout>;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private heartbeatPending = false;
  private terminationTimer: ReturnType<typeof setTimeout> | undefined;
  private receiptCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private killSent = false;
  constructor(private readonly process: NativeBackendProcess, private readonly options: NativeBackendPortOptions) {
    super();
    if (!nonce(options.ownerNonce) || (!options.recover && !/^[a-f0-9]{32}$/.test(options.runNonce ?? ""))) throw protocolError();
    this.prepared = this.preparation.promise; this.completion = this.terminal.promise; this.closure = this.processClosed.promise;
    this.writer = new OwnerWriter(process.stdin, options.ownerNonce, error => this.writeFailure(error));
    this.outer = new TimedReader(new FrameReader({ nonce: options.ownerNonce, allowedKinds: options.recover ? [KINDS.RESULT]
      : [KINDS.MIGRATION_SOURCE, KINDS.MIGRATION_DESTINATION, KINDS.MIGRATED, KINDS.PREPARED, KINDS.STARTED, KINDS.CHILD_CHUNK, KINDS.RESULT, KINDS.STDERR], maxPayloadBytes: 65536 }), error => this.fail(error));
    this.prepareTimer = setTimeout(() => this.fail(new Error("Native backend preparation timed out.")), 30_000);
    process.stdout.on("data", (chunk: Buffer) => { try { this.outer.push(chunk, record => this.record(record)); } catch (error) { this.fail(error); } });
    process.stdout.on("end", () => {
      this.stdoutEnded = true;
      try { this.outer.finish(); this.child?.finish(); if (!this.resultSeen) throw new Error("Native backend result missing."); } catch (error) { this.fail(error); }
    });
    process.stdout.on("error", error => this.fail(error));
    process.stdout.on("close", () => { if (!this.stdoutEnded) this.fail(new Error("Native backend output closed without EOF.")); });
    // Raw diagnostics are untrusted, discarded, and cannot establish EOF/completeness.
    process.stderr.on("data", (chunk: Buffer) => { if (!Buffer.isBuffer(chunk) || (this.brokerStderrBytes += chunk.length) > 16384) this.fail(new Error("Native backend diagnostics exceeded budget.")); });
    process.stderr.on("error", error => this.fail(error));
    process.on("error", error => this.fail(error));
    process.once("exit", (code: number | null, signal: string | null) => { this.exitSeen = true; this.emit("exit", code, signal); });
    process.once("close", (code: number | null) => this.closed(code));
  }
  get pid(): number | undefined { return this.process.pid; }
  async confirmCleanup(): Promise<void> {
    try { const result = await this.completion; if (result.cleanupOutcome !== "clean" || !result.journalClean) throw new Error("Native backend cleanup unverified."); }
    finally { await this.closure; }
  }
  private record(record: Frame): void {
    if (record.kind === KINDS.RESULT) {
      // Consume before decoding: malformed, null and duplicate results remain terminal.
      if (this.resultSeen) throw protocolError(); this.resultSeen = true;
      const value = decodeJson(record.body);
      if (!isNativeBackendResult(value, this.options.recover ? undefined : this.options.runNonce)
        || this.options.recover && value.sessionOutcome !== "recovered" && value.sessionOutcome !== "failed"
        || !this.options.recover && value.sessionOutcome === "recovered") throw protocolError();
      this.receipt = value; this.state = "terminal"; this.clearTimers(); this.writer.finish();
      this.receiptCloseTimer = setTimeout(() => this.fail(new Error("Native backend receipt was not followed by process closure.")), 2000);
      this.child?.finish();
      if (value.cleanupOutcome !== "clean") this.fail(new Error("Native backend cleanup remains blocked."));
      return;
    }
    if (this.resultSeen || this.failure) throw protocolError();
    if (record.kind === KINDS.MIGRATION_SOURCE || record.kind === KINDS.MIGRATION_DESTINATION || record.kind === KINDS.MIGRATED) {
      if (this.state !== "preparing" || this.killSent) throw protocolError();
      if (record.kind === KINDS.MIGRATION_SOURCE) this.migration.acceptSource(record.body);
      else if (record.kind === KINDS.MIGRATION_DESTINATION) {
        const decision = this.migration.decide(record.body);
        // Content failures send action0 and await the unchanged terminal receipt
        // policy. They never authorize PREPARED/START or invent clean staging.
        void this.writer.send(KINDS.MIGRATION_DECISION, decision).catch(error => this.writeFailure(error));
      } else this.migration.acceptMigrated(record.body);
      return;
    }
    if (record.kind === KINDS.PREPARED) {
      const value = decodeJson(record.body);
      if (this.state !== "preparing" || this.killSent || !this.migration.complete || !isNativeBackendPrepared(value, this.options.ownerNonce)) throw protocolError();
      this.state = "prepared"; this.preparation.resolve(value);
      this.child = new TimedReader(new FrameReader({ nonce: value.childNonce, allowedKinds: [KINDS.APP], maxPayloadBytes: TRANSPORT_POLICY.childOutputBytes }), error => this.fail(error));
      void this.writer.send(KINDS.START).catch(error => this.writeFailure(error)); return;
    }
    if (record.kind === KINDS.STARTED) {
      if (this.state !== "prepared" || record.body.length) throw protocolError();
      clearTimeout(this.prepareTimer); this.state = "started";
      this.readyTimer = setTimeout(() => this.fail(new Error("Native backend typed ready timed out.")), 10_000);
      this.heartbeat = setInterval(() => {
        if (this.heartbeatPending || this.failure || this.resultSeen) return; this.heartbeatPending = true;
        void this.writer.send(KINDS.HEARTBEAT).catch(error => this.writeFailure(error)).finally(() => { this.heartbeatPending = false; });
      }, 2000);
      this.emit("spawn"); return;
    }
    if (record.kind === KINDS.STDERR) {
      if (!this.migration.complete || (this.stderrBytes += record.body.length) > 16384) throw protocolError(); return;
    }
    if (record.kind !== KINDS.CHILD_CHUNK || !this.child || !["started", "closing"].includes(this.state) || !record.body.length) throw protocolError();
    this.child.push(record.body, app => {
      const message = decodeJson(app.body);
      if (!this.session) throw protocolError();
      if (!this.ready) {
        if (!isReady(message, this.session)) throw protocolError();
        this.ready = true; clearTimeout(this.readyTimer);
      } else if (isResponse(message, this.session)) {
        if (message.operation === "runtime.shutdown") {
          if (!this.shutdownRequest || message.id !== this.shutdownRequest || this.shutdownResponse) throw protocolError();
          this.shutdownResponse = true;
        }
      } else if (!(isModelRun(message, this.session) || isModelCancel(message, this.session))) throw protocolError();
      this.emit("message", message);
    });
  }
  postMessage(message: unknown): void {
    if (this.failure || this.state !== "started") throw new Error("Native backend unavailable.");
    if (!this.session) { if (!isInitialize(message)) throw protocolError(); this.session = message.session; }
    else if (isInitialize(message)) throw protocolError();
    if (isRecord(message) && message.type === "request" && message.operation === "runtime.shutdown") {
      if (this.shutdownRequest || typeof message.id !== "string") throw protocolError(); this.shutdownRequest = message.id;
    }
    const body = encodeJson(message, TRANSPORT_POLICY.ownerInputBytes);
    void this.writer.send(KINDS.APP, body).catch(error => this.writeFailure(error));
  }
  closeChildInput(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.failure || this.state !== "started" || !this.ready || !this.shutdownResponse) return Promise.reject(new Error("Native backend cannot close input before shutdown response."));
    this.state = "closing";
    this.closePromise = this.writer.send(KINDS.CLOSE_CHILD_INPUT).catch(error => { this.fail(error); throw error; });
    return this.closePromise;
  }
  kill(): boolean {
    if (this.brokerClosed || this.resultSeen || this.killSent) return false; this.killSent = true;
    if (this.state === "preparing") this.migration.cancel();
    if (this.options.recover) return this.process.kill();
    void this.writer.send(KINDS.KILL).catch(() => { this.process.kill(); });
    this.armTermination(); return true;
  }
  private armTermination(): void {
    this.terminationTimer ??= setTimeout(() => { this.process.kill(); const error = new Error("Native backend closure unverified; recovery required."); this.terminal.reject(error); this.processClosed.reject(error); }, 25_000);
  }
  private writeFailure(error: unknown): void { if (!this.resultSeen) this.fail(error); }
  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : protocolError();
    this.preparation.reject(this.failure); this.clearTimers(); this.terminal.reject(this.failure);
    if (!this.brokerClosed) { if (!this.resultSeen) this.kill(); else this.process.kill(); this.armTermination(); }
    // ChildPort users can observe this without requiring an EventEmitter error listener.
    if (this.listenerCount("error")) this.emit("error", this.failure);
  }
  private clearTimers(): void { clearTimeout(this.prepareTimer); clearTimeout(this.readyTimer); clearInterval(this.heartbeat); this.outer.clear(); this.child?.clear(); this.migration.cancel(); }
  private closed(code: number | null): void {
    this.brokerClosed = true;
    this.clearTimers(); clearTimeout(this.terminationTimer); clearTimeout(this.receiptCloseTimer); this.writer.finish(); this.processClosed.resolve();
    if (!this.exitSeen) { this.exitSeen = true; this.emit("exit", code, null); }
    this.state = "terminal";
    if (!this.failure && (!this.stdoutEnded || !this.receipt || !this.resultSeen || this.receipt.cleanupOutcome !== "clean")) this.failure = new Error("Native backend cleanup unverified; recovery required.");
    if (!this.failure && this.receipt?.sessionOutcome === "normal" && (code !== 0 || this.receipt.exitCode !== 0 || !this.ready || !this.closePromise || !this.receipt.stderrComplete || !this.receipt.consoleBefore || !this.receipt.consoleAfterFirstFrame)) this.failure = protocolError();
    if (this.failure) { this.preparation.reject(this.failure); this.terminal.reject(this.failure); }
    else if (this.receipt) {
      this.preparation.reject(new Error("Native backend did not prepare a child.")); this.terminal.resolve(this.receipt);
    }
  }
}
