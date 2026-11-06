import { Duplex } from "node:stream";
import { MCP_MUX, type MuxKind } from "./mcp-mux-wire.js";
import type { McpMuxWriter } from "./mcp-mux-writer.js";

type WriteCallback = (error?: Error | null) => void;
/** Only the two fixed worker channels use this adapter; no socket/path is accepted. */
export class McpMuxChannel extends Duplex {
  private pendingBytes = 0;
  private pendingWrites = 0;
  private readonly inputLimit: number;
  private readonly outputLimit: number;
  constructor(private readonly kind: MuxKind, private readonly writer: McpMuxWriter,
    private readonly fail: (error: Error) => void) {
    const inputLimit = kind === 1 ? MCP_MUX.mcpInputBytes : MCP_MUX.developmentInputBytes;
    const outputLimit = kind === 1 ? MCP_MUX.mcpOutputBytes : MCP_MUX.developmentOutputBytes;
    super({ readableHighWaterMark: inputLimit + 1, writableHighWaterMark: outputLimit + 1 });
    this.inputLimit = inputLimit; this.outputLimit = outputLimit;
    this.on("error", () => this.fail(new Error("MCP mux virtual channel failed.")));
  }
  override _read() {}
  receive(bytes: Buffer) {
    // setEncoding changes readableLength to UTF-16 code units. Four bytes per
    // unit bounds decoded data. StringDecoder can additionally retain up to
    // three incomplete UTF-8 bytes, so this channel budget is inputLimit + 3
    // in text mode (the per-frame payload limit remains inputLimit).
    const retained = this.readableLength * (this.readableEncoding ? 4 : 1);
    if (this.destroyed || !bytes.length || retained + bytes.length > this.inputLimit) {
      this.fail(new Error("MCP mux virtual input limit reached.")); return;
    }
    this.push(Buffer.from(bytes));
  }
  override write(chunk: unknown, callback?: WriteCallback): boolean;
  override write(chunk: unknown, encoding: BufferEncoding, callback?: WriteCallback): boolean;
  override write(chunk: unknown, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : Buffer.isBuffer(chunk) ? chunk.length : -1;
    if (this.destroyed || this.writableEnded || encoding !== "utf8" || size <= 0 || size > this.outputLimit
      || this.pendingWrites >= MCP_MUX.queuedFrames || this.pendingBytes + size > MCP_MUX.queuedBytes) {
      const error = new Error("MCP mux virtual output limit reached.");
      this.fail(error); done?.(error); return false;
    }
    this.pendingBytes += size; this.pendingWrites++;
    let settled = false;
    const complete: WriteCallback = error => {
      if (settled) return;
      settled = true; this.pendingBytes -= size; this.pendingWrites--; done?.(error);
    };
    try {
      // A retained upstream Buffer must not change after this admission.
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk as Buffer);
      return super.write(bytes, complete);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("MCP mux virtual write failed.");
      this.fail(failure); complete(failure); return false;
    }
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback) {
    this.writer.write({ kind: this.kind, body: chunk }, callback);
  }
}
