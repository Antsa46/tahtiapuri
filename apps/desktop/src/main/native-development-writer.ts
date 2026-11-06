import type { Writable } from "node:stream";
import { encodeControlFrame, NativeControl, type ControlFrame } from "./native-development-wire.js";
interface Write {
  bytes: Buffer; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout;
  returned: boolean; written: boolean; drained: boolean; drain(): void;
}
/** FIFO completion requires the physical callback and any required drain. */
export class NativeControlWriter {
  private sequence = 1;
  private stopped = false;
  private entries = new Set<Write>();
  private queue: Write[] = [];
  private active: Write | undefined;
  private bytes = 0;
  constructor(private readonly output: Writable, private readonly failed: () => void) {}
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
    this.active = entry; this.output.once("drain", entry.drain);
    try {
      const accepted = this.output.write(entry.bytes, error => {
        // A reentrant CLEAN may already have cancelled the logical queue.
        // Real physical errors are still failures, unlike intentional cancellation.
        if (error) { this.physicalFail(); return; }
        if (!this.entries.has(entry)) return;
        entry.written = true; this.complete(entry);
      });
      entry.returned = true; if (accepted) entry.drained = true; this.complete(entry);
    } catch { this.physicalFail(); }
  }
  private complete(entry: Write) {
    if (!this.entries.has(entry) || !entry.returned || !entry.written || !entry.drained) return;
    this.entries.delete(entry); this.bytes -= entry.bytes.length; clearTimeout(entry.timer);
    this.output.off("drain", entry.drain); this.active = undefined; entry.resolve(); this.pump();
  }
  private physicalFail() { this.stop(); this.failed(); }
  private fail() { if (!this.stopped) { this.stop(); this.failed(); } }
  /** Discard queued results during revocation. The caller owns stream destruction. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const entries = [...this.entries]; this.entries.clear(); this.queue = []; this.active = undefined; this.bytes = 0;
    for (const entry of entries) {
      clearTimeout(entry.timer); this.output.off("drain", entry.drain); entry.reject(new Error("Native control output closed."));
    }
  }
}
