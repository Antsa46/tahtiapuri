import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { readFrames, REQUEST_FRAME_BYTES, RESPONSE_FRAME_BYTES } from "@tahtiapuri/validation/development-framing";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
import { type BridgeCommand, type DevelopmentResult, isDevelopmentResult } from "@tahtiapuri/validation/development";

const unavailable = (): DevelopmentResult => ({ ok: false, code: "ENGINE_UNAVAILABLE" });
export interface DevelopmentRequests {
  request(operation: BridgeCommand["operation"], input: unknown): Promise<DevelopmentResult>;
  close(): void;
}

/** Owns only an already-authenticated stream. It never opens a descriptor or socket. */
export class ConnectedDevelopmentClient implements DevelopmentRequests {
  private closed = false;
  private buffer = "";
  private blocked = false;
  private drainTimer: NodeJS.Timeout | undefined;
  private pending = new Map<string, { resolve(value: DevelopmentResult): void; timer: NodeJS.Timeout }>();
  onclose: (() => void) | undefined;

  constructor(private readonly stream: Duplex, initialData = "") {
    stream.setEncoding("utf8");
    stream.on("error", this.failed);
    stream.on("close", this.failed);
    stream.on("end", this.failed);
    stream.on("drain", this.drained);
    stream.on("data", this.receive);
    if (stream.destroyed || stream.readableEnded || stream.writableEnded) this.close();
    else if (initialData) this.receive(initialData);
  }

  get isClosed() { return this.closed; }

  private readonly failed = () => this.close();
  private readonly drained = () => {
    this.blocked = false;
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
  };
  private readonly receive = (chunk: string) => {
    if (this.closed) return;
    try {
      const parsed = readFrames(this.buffer, chunk, RESPONSE_FRAME_BYTES);
      this.buffer = parsed.remainder;
      for (const line of parsed.frames) {
        const message: unknown = JSON.parse(line);
        if (!isRecord(message) || !exactKeys(message, ["id", "result"]) || typeof message.id !== "string" || !isDevelopmentResult(message.result)) throw new Error("Invalid development response.");
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message.result);
      }
    } catch { this.close(); }
  };

  request(operation: BridgeCommand["operation"], input: unknown): Promise<DevelopmentResult> {
    if (this.closed || this.stream.destroyed || this.stream.writableEnded || this.blocked || this.pending.size >= 4) return Promise.resolve(unavailable());
    const id = randomUUID();
    let frame: string;
    try {
      frame = JSON.stringify({ id, operation, input }) + "\n";
      if (Buffer.byteLength(frame) > REQUEST_FRAME_BYTES || this.stream.writableLength + Buffer.byteLength(frame) > REQUEST_FRAME_BYTES * 4) return Promise.resolve(unavailable());
    } catch { return Promise.resolve(unavailable()); }
    return new Promise(resolve => {
      const timer = setTimeout(() => this.close(), 5000);
      this.pending.set(id, { resolve, timer });
      try {
        if (!this.stream.write(frame) && !this.closed) {
          // A reply can arrive before drain. Retain a separate deadline even if it
          // settles the last pending request, and never enqueue another write.
          this.blocked = true;
          this.drainTimer = setTimeout(() => this.close(), 5000);
        }
      } catch { this.close(); }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.drainTimer);
    this.buffer = "";
    this.stream.off("data", this.receive);
    this.stream.off("drain", this.drained);
    this.stream.off("end", this.failed);
    this.stream.off("close", this.failed);
    // Keep the error listener to consume a late error from an in-flight write.
    this.stream.destroy();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.resolve(unavailable()); }
    this.pending.clear();
    this.onclose?.();
  }
}
