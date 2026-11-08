import type { Writable } from "node:stream";
import { encodeControlFrame, NativeControl, type ControlFrame } from "./native-development-wire.js";
interface Write {
  bytes: Buffer; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout;
  returned: boolean; written: boolean; drained: boolean; drain(): void;
}
interface OriginalWrite {
  readonly entry: Write;
  dispatched: boolean;
  returned: boolean;
  callbackObserved: boolean;
}
/** FIFO success requires callback+drain. originalClosed observes only original
 * API/callback completion after stop, never peer delivery or OS termination. */
export class NativeControlWriter {
  private sequence = 1;
  private stopped = false;
  private entries = new Set<Write>();
  private queue: Write[] = [];
  private active: Write | undefined;
  private bytes = 0;
  readonly originalClosed: Promise<Readonly<{ failed: boolean }>>;
  private resolveOriginalClosed!: (result: Readonly<{ failed: boolean }>) => void;
  private readonly originalWrites = new Set<OriginalWrite>();
  private originalEnded = false;
  private originalFailed = false;
  private firstOriginalFailure: Readonly<{ reason: unknown }> | undefined;
  constructor(private readonly output: Writable, private readonly failed: () => void) {
    this.originalClosed = new Promise(resolve => { this.resolveOriginalClosed = resolve; });
  }
  get originalWorkSettled(): boolean { return this.originalEnded; }
  get originalFailure(): Readonly<{ reason: unknown }> | undefined { return this.firstOriginalFailure; }
  write(frame: ControlFrame): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new Error("Native control output closed.")); return; }
      let bytes: Buffer;
      try {
        const size = NativeControl.headerBytes + frame.body.length;
        if (this.output.destroyed || this.output.writableEnded || this.entries.size >= NativeControl.queuedFrames
          || this.bytes + this.output.writableLength + size > NativeControl.queuedBytes) throw new Error("Native control output limit.");
        bytes = encodeControlFrame(frame, this.sequence, "from-main");
      } catch { this.fail(); reject(new Error("Native control output rejected.")); return; }
      this.sequence = (this.sequence + 1) >>> 0;
      const entry: Write = { bytes, resolve, reject, returned: false, written: false, drained: false,
        timer: setTimeout(() => this.fail(), NativeControl.ioTimeoutMs),
        drain: () => { entry.drained = true; this.complete(entry); } };
      this.bytes += bytes.length; this.entries.add(entry); this.queue.push(entry); this.pump();
    });
  }
  private pump() {
    if (this.stopped || this.active) return;
    const entry = this.queue.shift(); if (!entry) return;
    this.active = entry;
    // This frame exists BEFORE EventEmitter.newListener or write callbacks can
    // synchronously stop/reenter. Logical queue cancellation cannot remove it.
    const original: OriginalWrite = { entry, dispatched: false, returned: false, callbackObserved: false };
    this.originalWrites.add(original);
    try {
      this.output.once("drain", entry.drain);
      if (this.stopped || !this.entries.has(entry)) {
        // newListener may have stopped us before once() installed its wrapper.
        this.output.off("drain", entry.drain); return;
      }
      original.dispatched = true; // A throw from write is not a no-start proof.
      const accepted = this.output.write(entry.bytes, error => {
        if (error) this.noteOriginalFailure(error);
        original.callbackObserved = true;
        try {
          if (error) { this.physicalFail(error); return; }
          if (!this.entries.has(entry)) return;
          entry.written = true; this.complete(entry);
        } finally { this.observeOriginal(original); }
      });
      entry.returned = true; if (accepted) entry.drained = true; this.complete(entry);
    } catch (error) { this.physicalFail(error); }
    finally {
      original.returned = true;
      this.observeOriginal(original);
    }
  }
  private observeOriginal(original: OriginalWrite): void {
    if (original.returned && (!original.dispatched || original.callbackObserved)) this.originalWrites.delete(original);
    this.checkOriginal();
  }
  private checkOriginal(): void {
    if (!this.originalEnded && this.stopped && this.originalWrites.size === 0) {
      this.originalEnded = true;
      this.resolveOriginalClosed(Object.freeze({ failed: this.originalFailed }));
    }
  }
  private noteOriginalFailure(reason: unknown): void {
    this.originalFailed = true;
    this.firstOriginalFailure ??= Object.freeze({ reason });
  }
  private complete(entry: Write) {
    if (!this.entries.has(entry) || !entry.returned || !entry.written || !entry.drained) return;
    this.entries.delete(entry); this.bytes -= entry.bytes.length; clearTimeout(entry.timer);
    this.output.off("drain", entry.drain); this.active = undefined; entry.resolve(); this.pump();
  }
  private physicalFail(reason: unknown) { this.noteOriginalFailure(reason); this.stop(); this.failed(); }
  private fail() { if (!this.stopped) this.physicalFail(new Error("Native control output failed.")); }
  /** Discard queued results during revocation. The caller owns stream destruction. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const entries = [...this.entries]; this.entries.clear(); this.queue = []; this.active = undefined; this.bytes = 0;
    for (const entry of entries) {
      clearTimeout(entry.timer); this.output.off("drain", entry.drain); entry.reject(new Error("Native control output closed."));
    }
    this.checkOriginal();
  }
}
