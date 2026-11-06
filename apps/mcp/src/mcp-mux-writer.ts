import type { Writable } from "node:stream";
import { encodeMuxFrame, MCP_MUX, nextMuxSequence, type MuxFrame } from "./mcp-mux-wire.js";

interface Entry {
  bytes: Buffer;
  callback(error?: Error): void;
  timer: NodeJS.Timeout;
  returned: boolean;
  written: boolean;
  drained: boolean;
  ondrain(): void;
}
/** One bounded FIFO. A virtual write completes only after physical callback and drain. */
export class McpMuxWriter {
  private sequence = 1;
  private pending = new Set<Entry>();
  private queue: Entry[] = [];
  private active: Entry | undefined;
  private bytes = 0;
  private stopped = false;
  private ending = false;
  private finishPromise: Promise<void> | undefined;
  private finished: (() => void) | undefined;
  private finishFailed: ((error: Error) => void) | undefined;
  private finishTimer: NodeJS.Timeout | undefined;
  private failure = new Error("MCP mux output closed.");
  constructor(private readonly output: Writable, private readonly fail: (error: Error) => void) {
    output.on("error", this.outputError); output.once("close", this.outputClosed);
  }
  private readonly outputError = () => this.abort(new Error("MCP mux output failed."));
  private readonly outputClosed = () => { if (!this.output.writableFinished) this.abort(new Error("MCP mux output closed early.")); };
  write(frame: MuxFrame, callback: (error?: Error) => void) {
    if (this.stopped || this.ending) { callback(this.failure); return; }
    let bytes: Buffer;
    try {
      const size = MCP_MUX.headerBytes + frame.body.length;
      if (this.output.destroyed || this.output.writableEnded || this.pending.size >= MCP_MUX.queuedFrames
        || this.bytes + this.output.writableLength + size > MCP_MUX.queuedBytes) throw new Error("MCP mux output limit reached.");
      bytes = encodeMuxFrame(frame, this.sequence, "from-worker");
    } catch (error) {
      const failure = error instanceof Error ? error : this.failure;
      this.abort(failure); callback(failure); return;
    }
    this.sequence = nextMuxSequence(this.sequence);
    const entry: Entry = { bytes, callback, returned: false, written: false, drained: false,
      timer: setTimeout(() => this.abort(new Error("MCP mux output timed out.")), MCP_MUX.ioTimeoutMs),
      ondrain: () => { entry.drained = true; this.complete(entry); } };
    this.bytes += bytes.length; this.pending.add(entry); this.queue.push(entry); this.pump();
  }
  private pump() {
    if (this.stopped || this.active) return;
    const entry = this.queue.shift();
    if (!entry) { this.finishIfEmpty(); return; }
    this.active = entry; this.output.once("drain", entry.ondrain);
    try {
      const accepted = this.output.write(entry.bytes, error => {
        if (!this.pending.has(entry)) return;
        if (error) { this.abort(new Error("MCP mux physical write failed.")); return; }
        entry.written = true; this.complete(entry);
      });
      entry.returned = true; if (accepted) entry.drained = true; this.complete(entry);
    } catch { this.abort(new Error("MCP mux physical write failed.")); }
  }
  private complete(entry: Entry) {
    if (!this.pending.has(entry) || !entry.returned || !entry.written || !entry.drained) return;
    this.pending.delete(entry); this.bytes -= entry.bytes.length; clearTimeout(entry.timer);
    this.output.off("drain", entry.ondrain); this.active = undefined;
    try { entry.callback(); } catch { this.abort(new Error("MCP mux completion callback failed.")); return; }
    this.pump();
  }
  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    if (this.stopped) return Promise.reject(this.failure);
    this.ending = true;
    this.finishPromise = new Promise<void>((resolve, reject) => { this.finished = resolve; this.finishFailed = reject; });
    this.finishTimer = setTimeout(() => this.abort(new Error("MCP mux output finish timed out.")), MCP_MUX.ioTimeoutMs);
    this.finishIfEmpty();
    return this.finishPromise;
  }
  private finishIfEmpty() {
    if (!this.ending || this.stopped || this.pending.size || this.output.writableEnded) return;
    try {
      this.output.end((error?: Error | null) => {
        if (this.stopped) return;
        if (error) { this.abort(new Error("MCP mux output finish failed.")); return; }
        this.stopped = true; clearTimeout(this.finishTimer); this.output.off("close", this.outputClosed);
        this.finished?.();
      });
    } catch { this.abort(new Error("MCP mux output finish failed.")); }
  }
  abort(error = this.failure) {
    if (this.stopped) return;
    this.stopped = true; this.failure = error; clearTimeout(this.finishTimer);
    const entries = [...this.pending]; this.pending.clear(); this.queue = []; this.active = undefined; this.bytes = 0;
    for (const entry of entries) { clearTimeout(entry.timer); this.output.off("drain", entry.ondrain); }
    this.finishFailed?.(error);
    // Publish terminal state before callbacks can synchronously attempt another write.
    try { this.fail(error); } catch { /* Teardown must still settle every admitted write. */ }
    for (const entry of entries) { try { entry.callback(error); } catch { /* Continue owned teardown. */ } }
    this.output.destroy();
  }
}
