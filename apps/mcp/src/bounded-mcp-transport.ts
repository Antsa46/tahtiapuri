import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { McpInputGate, type McpRequestReservation } from "./mcp-input-gate.js";

// Candidate trial policy, not measured capacity. The byte budget conservatively
// counts reservations plus bytes already buffered by the injected writable.
export const MCP_OUTPUT_POLICY = {
  frameBytes: 262_144, reservedBytes: 524_288, pendingSends: 16, sendTimeoutMs: 2000,
} as const;
type McpMessage = Parameters<StdioServerTransport["send"]>[0];
interface PendingSend {
  request: McpRequestReservation | undefined;
  frame: string;
  bytes: number;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  returned: boolean;
  written: boolean;
  drained: boolean;
  ondrain(): void;
}

/** Candidate-only stdio: every queued/active send has a bounded lifetime. */
export class BoundedMcpTransport extends StdioServerTransport {
  private stopped = false;
  private closing: Promise<void> | undefined;
  private failure = new Error("MCP transport closed.");
  private pending = new Set<PendingSend>();
  private queue: PendingSend[] = [];
  private active: PendingSend | undefined;
  private reservedBytes = 0;

  private readonly gate: McpInputGate;
  constructor(private readonly input: Readable, private readonly output: Writable, private readonly release: () => void) {
    const gate = new McpInputGate(error => this.fail(error));
    super(gate, output, { maxBufferSize: 16_384 });
    this.gate = gate;
    // Keep a sink after SDK close removes its own handlers.
    gate.on("error", error => this.fail(error));
    output.once("close", this.outputClosed);
  }
  override async start(): Promise<void> {
    await super.start();
    if (!this.stopped) this.input.pipe(this.gate);
  }
  private readonly outputClosed = () => { void this.close(); };
  private fail(error: Error) {
    this.failure = error;
    void this.close();
  }
  override send(message: McpMessage): Promise<void> {
    if (this.stopped) return Promise.reject(this.failure);
    let request: McpRequestReservation | undefined;
    try {
      if ("id" in message && ("result" in message || "error" in message)) request = this.gate.claimResponse(message.id);
    } catch { this.fail(new Error("MCP response has no pending request.")); return Promise.reject(this.failure); }
    let frame: string;
    try { frame = JSON.stringify(message) + "\n"; }
    catch { this.fail(new Error("MCP message cannot be encoded.")); return Promise.reject(this.failure); }
    const bytes = Buffer.byteLength(frame);
    if (this.output.destroyed || this.output.writableEnded || bytes > MCP_OUTPUT_POLICY.frameBytes
      || this.pending.size >= MCP_OUTPUT_POLICY.pendingSends
      || this.reservedBytes + this.output.writableLength + bytes > MCP_OUTPUT_POLICY.reservedBytes) {
      this.fail(new Error("MCP output limit reached."));
      return Promise.reject(this.failure);
    }
    return new Promise<void>((resolve, reject) => {
      const entry: PendingSend = {
        request, frame, bytes, resolve, reject, returned: false, written: false, drained: false,
        timer: setTimeout(() => this.fail(new Error("MCP output timed out.")), MCP_OUTPUT_POLICY.sendTimeoutMs),
        ondrain: () => { entry.drained = true; this.finish(entry); },
      };
      this.reservedBytes += bytes;
      this.pending.add(entry);
      this.queue.push(entry);
      this.pump();
    });
  }
  private pump() {
    if (this.stopped || this.active) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active = entry;
    // Attach first: injected streams may invoke a callback or drain synchronously.
    this.output.once("drain", entry.ondrain);
    try {
      const accepted = this.output.write(entry.frame, error => {
        if (!this.pending.has(entry)) return;
        if (error) { this.fail(new Error("MCP output write failed.")); return; }
        entry.written = true;
        this.finish(entry);
      });
      entry.returned = true;
      if (accepted) entry.drained = true;
      this.finish(entry);
    } catch { this.fail(new Error("MCP output write failed.")); }
  }
  private finish(entry: PendingSend) {
    if (!this.pending.has(entry) || !entry.returned || !entry.written || !entry.drained) return;
    this.pending.delete(entry);
    clearTimeout(entry.timer);
    this.output.off("drain", entry.ondrain);
    this.reservedBytes -= entry.bytes;
    this.active = undefined;
    if (entry.request) this.gate.complete(entry.request);
    entry.resolve();
    this.pump();
  }
  override close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.gate.stop();
    this.closing = Promise.resolve().then(async () => {
      try { await super.close(); }
      finally { this.gate.destroy(); this.release(); }
    });
    // Publish before unpipe/pause: caller-owned streams can synchronously re-enter close.
    this.input.unpipe(this.gate);
    this.input.pause();
    this.output.off("close", this.outputClosed);
    for (const entry of this.pending) {
      clearTimeout(entry.timer);
      this.output.off("drain", entry.ondrain);
      entry.reject(this.failure);
    }
    this.pending.clear();
    this.queue = [];
    this.active = undefined;
    this.reservedBytes = 0;
    return this.closing;
  }
}
