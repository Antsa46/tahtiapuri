/** Private broker/worker transport. DATA payloads are stream bytes, not JSON messages. */
export const MCP_MUX = {
  headerBytes: 16, mcpInputBytes: 16_384, mcpOutputBytes: 262_144,
  developmentInputBytes: 65_536, developmentOutputBytes: 16_384,
  queuedBytes: 524_288, queuedFrames: 16, ioTimeoutMs: 2000,
} as const;
export const MuxKind = { mcp: 1, development: 2, close: 3, ready: 4 } as const;
export type MuxKind = typeof MuxKind[keyof typeof MuxKind];
export type MuxDirection = "to-worker" | "from-worker";
export interface MuxFrame { kind: MuxKind; body: Buffer }

function payloadLimit(kind: number, direction: MuxDirection): number {
  if (kind === MuxKind.mcp) return direction === "to-worker" ? MCP_MUX.mcpInputBytes : MCP_MUX.mcpOutputBytes;
  if (kind === MuxKind.development) return direction === "to-worker" ? MCP_MUX.developmentInputBytes : MCP_MUX.developmentOutputBytes;
  if (direction === "to-worker" && kind === MuxKind.close || direction === "from-worker" && kind === MuxKind.ready) return 0;
  throw new Error("Invalid MCP mux frame direction.");
}
function checkLength(kind: number, bytes: number, direction: MuxDirection) {
  const limit = payloadLimit(kind, direction);
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > limit || limit > 0 && bytes === 0) throw new Error("Invalid MCP mux payload length.");
}
/** Unsigned sequence starts at one and wraps from 0xffffffff to zero. */
export const nextMuxSequence = (sequence: number) => (sequence + 1) >>> 0;
export function encodeMuxFrame(frame: MuxFrame, sequence: number, direction: MuxDirection): Buffer {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error("Invalid MCP mux sequence.");
  checkLength(frame.kind, frame.body.length, direction);
  const bytes = Buffer.alloc(MCP_MUX.headerBytes + frame.body.length);
  bytes.write("TMCP", 0, "ascii"); bytes[4] = 1; bytes[5] = frame.kind;
  bytes.writeUInt32LE(frame.body.length, 8); bytes.writeUInt32LE(sequence, 12);
  frame.body.copy(bytes, MCP_MUX.headerBytes);
  return bytes;
}

/** Allocates a payload only after its complete header passes direction/size checks. */
export class McpMuxReader {
  private readonly header = Buffer.alloc(MCP_MUX.headerBytes);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private bodyUsed = 0;
  private kind: MuxKind = MuxKind.mcp;
  private sequence = 1;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly direction: MuxDirection, private readonly receive: (frame: MuxFrame) => void,
    private readonly fail: (error: Error) => void) {}
  private reject(error: Error) { if (!this.stopped) { this.stop(); this.fail(error); } }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.body = undefined; this.bodyUsed = 0; this.headerUsed = 0; }
  end() {
    if (!this.stopped && (this.headerUsed || this.body)) this.reject(new Error("Truncated MCP mux frame."));
    this.stop();
  }
  write(chunk: Buffer) {
    if (this.stopped) return;
    if (!Buffer.isBuffer(chunk)) { this.reject(new Error("MCP mux requires binary input.")); return; }
    let offset = 0;
    try {
      while (!this.stopped && offset < chunk.length) {
        this.timer ??= setTimeout(() => this.reject(new Error("MCP mux frame timed out.")), MCP_MUX.ioTimeoutMs);
        if (!this.body) {
          const count = Math.min(chunk.length - offset, MCP_MUX.headerBytes - this.headerUsed);
          chunk.copy(this.header, this.headerUsed, offset, offset + count); this.headerUsed += count; offset += count;
          if (this.headerUsed < MCP_MUX.headerBytes) continue;
          if (this.header.readUInt32BE(0) !== 0x544d4350 || this.header[4] !== 1 || this.header.readUInt16LE(6) !== 0
            || this.header.readUInt32LE(12) !== this.sequence) throw new Error("Invalid MCP mux header.");
          const kind = this.header[5]!; const length = this.header.readUInt32LE(8);
          checkLength(kind, length, this.direction); this.kind = kind as MuxKind;
          this.body = Buffer.alloc(length); this.bodyUsed = 0;
        }
        const count = Math.min(chunk.length - offset, this.body.length - this.bodyUsed);
        chunk.copy(this.body, this.bodyUsed, offset, offset + count); this.bodyUsed += count; offset += count;
        if (this.bodyUsed === this.body.length) {
          const frame = { kind: this.kind, body: this.body };
          this.sequence = nextMuxSequence(this.sequence);
          this.headerUsed = 0; this.body = undefined; this.bodyUsed = 0;
          clearTimeout(this.timer); this.timer = undefined;
          this.receive(frame);
        }
      }
    } catch (error) { this.reject(error instanceof Error ? error : new Error("Invalid MCP mux input.")); }
  }
}
