import { TextDecoder } from "node:util";
import type { Writable } from "node:stream";

export const HEADER = 56;
export const KINDS = Object.freeze({ START: 1, APP: 2, CLOSE_CHILD_INPUT: 3, KILL: 4, HEARTBEAT: 5, MIGRATION_DECISION: 6,
  PREPARED: 129, STARTED: 130, CHILD_CHUNK: 131, RESULT: 132, STDERR: 133, MIGRATION_SOURCE: 134, MIGRATION_DESTINATION: 135, MIGRATED: 136 });
/** Per-frame and pending-work policy; this does not establish OS isolation. */
export const TRANSPORT_POLICY = Object.freeze({ ownerInputBytes: 65_536, childOutputBytes: 16 * 1024 * 1024,
  maxPendingMessages: 32, maxPendingBytes: 32 * 1024 * 1024 + 32 * HEADER, writeTimeoutMs: 2000 });
const known = new Set<number>(Object.values(KINDS));
const uint64 = 0xffff_ffff_ffff_ffffn;
const integer = (value: number, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
function payloadLength(kind: number, bytes: number): boolean {
  if (kind === KINDS.HEARTBEAT) return bytes === 0;
  if (kind === KINDS.MIGRATION_DECISION) return bytes === 68;
  if (kind === KINDS.MIGRATION_SOURCE) return bytes >= 5 && bytes <= 32_772;
  if (kind === KINDS.MIGRATION_DESTINATION) return bytes >= 4 && bytes <= 32_772;
  if (kind === KINDS.MIGRATED) return bytes === 2;
  return true;
}
function nonceBytes(nonce: string): Buffer {
  if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error("Invalid TBIP nonce.");
  return Buffer.from(nonce, "hex");
}
export interface FrameOptions { nonce: string; allowedKinds: readonly number[]; maxPayloadBytes: number }
function limits(options: FrameOptions) {
  const nonce = nonceBytes(options.nonce), kinds = new Set(options.allowedKinds);
  if (!kinds.size || [...kinds].some(kind => !known.has(kind)) || !integer(options.maxPayloadBytes, 0, TRANSPORT_POLICY.childOutputBytes))
    throw new Error("Invalid TBIP frame policy.");
  return { nonce, kinds, maxPayloadBytes: options.maxPayloadBytes };
}
export interface Frame { readonly kind: number; readonly sequence: bigint; readonly body: Buffer }
export function frame(kind: number, sequence: bigint, nonce: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const bytes = nonceBytes(nonce);
  if (!known.has(kind) || typeof sequence !== "bigint" || sequence < 1n || sequence > uint64 || !Buffer.isBuffer(body) || body.length > TRANSPORT_POLICY.childOutputBytes
    || !payloadLength(kind, body.length))
    throw new Error("Invalid TBIP frame.");
  const result = Buffer.allocUnsafe(HEADER + body.length);
  result.write("TBIP", 0, "ascii"); result.writeUInt16LE(2, 4); result.writeUInt16LE(kind, 6);
  result.writeBigUInt64LE(sequence, 8); result.writeUInt32LE(body.length, 16); result.writeUInt32LE(0, 20); bytes.copy(result, 24); body.copy(result, HEADER);
  return result;
}
export function encodeJson(value: unknown, maxBytes: number): Buffer {
  if (!integer(maxBytes, 0, TRANSPORT_POLICY.childOutputBytes)) throw new Error("Invalid JSON budget.");
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("JSON payload exceeds budget.");
  return Buffer.from(text, "utf8");
}
export function decodeJson(buffer: Buffer): unknown {
  if (!Buffer.isBuffer(buffer)) throw new Error("JSON input must be bytes.");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer));
}

/** Retains only one header and one validated payload. Completed frames belong to the caller. */
export class FrameReader {
  private readonly options: ReturnType<typeof limits>;
  private readonly header = Buffer.alloc(HEADER);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private bodyUsed = 0;
  private kind = 0;
  private sequence = 1n;
  private failure: Error | undefined;
  private finished = false;
  private pushing = false;
  constructor(options: FrameOptions) { this.options = limits(options); }
  push(chunk: Buffer, accept: (record: Frame) => void): void {
    if (this.failure) throw this.failure;
    if (this.pushing) {
      this.failure = new Error("Reentrant TBIP input is forbidden."); this.body = undefined; throw this.failure;
    }
    this.pushing = true;
    try {
      if (this.finished || !Buffer.isBuffer(chunk)) throw new Error("Invalid TBIP input state or bytes.");
      let offset = 0;
      while (offset < chunk.length) {
        if (this.body === undefined) {
          const length = Math.min(HEADER - this.headerUsed, chunk.length - offset);
          chunk.copy(this.header, this.headerUsed, offset, offset + length); this.headerUsed += length; offset += length;
          if (this.headerUsed < HEADER) break;
          const kind = this.header.readUInt16LE(6), sequence = this.header.readBigUInt64LE(8), bytes = this.header.readUInt32LE(16);
          if (this.sequence > uint64 || !this.header.subarray(0, 4).equals(Buffer.from("TBIP")) || this.header.readUInt16LE(4) !== 2
            || this.header.readUInt32LE(20) !== 0 || !this.header.subarray(24).equals(this.options.nonce) || !this.options.kinds.has(kind)
            || sequence !== this.sequence || bytes > this.options.maxPayloadBytes || !payloadLength(kind, bytes)) throw new Error("Invalid TBIP header.");
          this.kind = kind; this.bodyUsed = 0; this.body = Buffer.allocUnsafe(bytes);
        }
        const length = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
        chunk.copy(this.body, this.bodyUsed, offset, offset + length); this.bodyUsed += length; offset += length;
        if (this.bodyUsed === this.body.length) {
          const record = { kind: this.kind, sequence: this.sequence++, body: this.body };
          this.body = undefined; this.headerUsed = 0; this.bodyUsed = 0;
          accept(record);
          // A callback may catch a nested failure or finish this reader itself.
          // Neither action can allow a later coalesced frame to be delivered.
          if (this.failure) throw this.failure;
          if (this.finished) throw new Error("TBIP input finished during delivery.");
        }
      }
    } catch (error) { this.failure ??= asError(error); this.body = undefined; throw this.failure; }
    finally { this.pushing = false; }
  }
  finish(): void {
    if (this.failure) throw this.failure;
    if (this.headerUsed || this.body !== undefined) { this.failure = new Error("Truncated TBIP frame."); this.body = undefined; throw this.failure; }
    this.finished = true;
  }
}

type Output = Pick<Writable, "write" | "end" | "on" | "removeListener" | "destroyed" | "writableEnded">;
export interface WriterOptions extends FrameOptions { onFailure?(error: Error): void }
type Entry = { kind: number; body: Buffer; bytes: number; resolve(): void; reject(error: Error): void; cleanup?(): void };
type Waiter = { resolve(): void; reject(error: Error): void };
export class BoundedWriter {
  private readonly options: ReturnType<typeof limits>;
  private readonly queue: Entry[] = [];
  private active: Entry | undefined;
  private pendingMessages = 0;
  private pendingBytes = 0;
  private sequence = 1n;
  private failure: Error | undefined;
  private ending = false;
  private finished = false;
  private peerCloseExpected = false;
  private peerClosed = false;
  private lastCompletedKind: number | undefined;
  private drainPromise: Promise<void> | undefined;
  private drainWaiter: Waiter | undefined;
  private endPromise: Promise<void> | undefined;
  private endWaiter: Waiter | undefined;
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  private sealPromise: Promise<void> | undefined;
  private readonly nonce: string;
  private readonly onFailure: ((error: Error) => void) | undefined;
  constructor(private readonly stream: Output, configuration: WriterOptions) {
    this.options = limits(configuration);
    this.nonce = configuration.nonce; this.onFailure = configuration.onFailure;
    // Keep the error listener through terminal states, including late callbacks/errors.
    stream.on("error", error => this.fail(error));
    stream.on("close", () => {
      if (this.finished) return;
      if (this.peerCloseExpected && !this.pendingMessages) { this.peerClosed = true; this.finished = true; this.ending = true; }
      else this.fail(new Error("TBIP output closed before finish."));
    });
    stream.on("finish", () => {
      if (!this.ending || this.pendingMessages) this.fail(new Error("TBIP output ended externally."));
      else this.finishEnd();
    });
  }
  fail(error: unknown): void {
    if (this.failure) return;
    this.failure = asError(error); clearTimeout(this.endTimer);
    this.active?.cleanup?.(); this.active?.reject(this.failure); this.active = undefined;
    for (const entry of this.queue) entry.reject(this.failure);
    this.queue.length = 0; this.pendingMessages = 0; this.pendingBytes = 0;
    this.drainWaiter?.reject(this.failure); this.drainWaiter = undefined; this.drainPromise = undefined;
    this.endWaiter?.reject(this.failure);
    try { this.onFailure?.(this.failure); } catch { /* Failure remains terminal. */ }
  }
  send(kind: number, body: Buffer): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    try {
      if (this.ending || this.stream.destroyed || this.stream.writableEnded) throw new Error("TBIP output is closed.");
      if (!this.options.kinds.has(kind) || !Buffer.isBuffer(body) || body.length > this.options.maxPayloadBytes || !payloadLength(kind, body.length)) throw new Error("Invalid TBIP output payload.");
      const bytes = HEADER + body.length;
      if (this.sequence + BigInt(this.queue.length) > uint64 || this.pendingMessages >= TRANSPORT_POLICY.maxPendingMessages
        || bytes > TRANSPORT_POLICY.maxPendingBytes - this.pendingBytes) throw new Error("TBIP pending output limit exceeded.");
      const copy = Buffer.from(body); this.pendingMessages++; this.pendingBytes += bytes;
      const promise = new Promise<void>((resolve, reject) => this.queue.push({ kind, body: copy, bytes, resolve, reject }));
      this.pump(); return promise;
    } catch (error) { this.fail(error); return Promise.reject(this.failure); }
  }
  private pump(): void {
    if (this.failure || this.active || !this.queue.length) return;
    const entry = this.queue.shift()!; this.active = entry;
    let returned = false, callbackDone = false, needsDrain = false, drained = false;
    const complete = () => {
      if (this.failure || this.active !== entry || !returned || !callbackDone || (needsDrain && !drained)) return;
      entry.cleanup?.(); this.active = undefined; this.pendingMessages--; this.pendingBytes -= entry.bytes;
      this.lastCompletedKind = entry.kind; entry.resolve();
      if (!this.pendingMessages) { this.drainWaiter?.resolve(); this.drainWaiter = undefined; this.drainPromise = undefined; }
      queueMicrotask(() => this.pump());
    };
    const onDrain = () => { drained = true; complete(); };
    const timer = setTimeout(() => this.fail(new Error("TBIP write progress deadline exceeded.")), TRANSPORT_POLICY.writeTimeoutMs);
    entry.cleanup = () => { clearTimeout(timer); this.stream.removeListener("drain", onDrain); };
    this.stream.on("drain", onDrain);
    try {
      const encoded = frame(entry.kind, this.sequence++, this.nonce, entry.body);
      // Drop the duplicate payload as soon as the stream owns the encoded frame.
      entry.body = Buffer.alloc(0);
      needsDrain = !this.stream.write(encoded, (error?: Error | null) => {
        if (error) { this.fail(error); return; } callbackDone = true; complete();
      });
      returned = true; if (!needsDrain) this.stream.removeListener("drain", onDrain); complete();
    } catch (error) { this.fail(error); }
  }
  drain(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.pendingMessages) return Promise.resolve();
    this.drainPromise ??= new Promise((resolve, reject) => { this.drainWaiter = { resolve, reject }; });
    return this.drainPromise;
  }
  private finishEnd(): void {
    if (this.failure) return;
    this.finished = true; clearTimeout(this.endTimer); this.endWaiter?.resolve();
  }
  end(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.endPromise) return this.endPromise;
    if (this.peerClosed || this.sealPromise) return Promise.reject(new Error("TBIP output already sealed."));
    this.ending = true;
    this.endPromise = new Promise((resolve, reject) => { this.endWaiter = { resolve, reject }; });
    void this.drain().then(() => {
      if (this.failure) return;
      this.endTimer = setTimeout(() => this.fail(new Error("TBIP output finish deadline exceeded.")), TRANSPORT_POLICY.writeTimeoutMs);
      try { this.stream.end((error?: Error | null) => { if (error) this.fail(error); else this.finishEnd(); }); }
      catch (error) { this.fail(error); }
    }).catch(error => this.fail(error));
    return this.endPromise;
  }
  seal(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.sealPromise) return this.sealPromise;
    if (this.peerClosed) return Promise.resolve();
    if (this.ending) return Promise.reject(new Error("TBIP output already ending."));
    this.ending = true;
    this.sealPromise = this.drain().then(() => { if (this.failure) throw this.failure; this.finished = true; });
    return this.sealPromise;
  }
  expectPeerClose(): void {
    if (this.failure) throw this.failure;
    if (this.ending || this.pendingMessages || (!this.peerCloseExpected && this.lastCompletedKind !== KINDS.CLOSE_CHILD_INPUT))
      throw new Error("Expected peer close requires a drained CLOSE_CHILD_INPUT.");
    this.peerCloseExpected = true;
  }
}
