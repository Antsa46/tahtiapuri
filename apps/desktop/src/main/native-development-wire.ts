/** Trusted broker/Main control transport. Never forward worker bytes as control frames. */
export const NativeControl = {
  headerBytes: 16, requestBytes: 16_384, responseBytes: 65_536,
  ioTimeoutMs: 2000, authenticationTimeoutMs: 3000, shutdownTimeoutMs: 15000,
  queuedFrames: 8, queuedBytes: 524_288,
} as const;
export const ControlKind = { hello: 1, accept: 2, request: 3, response: 4, stop: 5, clean: 6 } as const;
export type ControlKind = typeof ControlKind[keyof typeof ControlKind];
export type ControlDirection = "to-main" | "from-main";
export interface ControlFrame { kind: ControlKind; body: Buffer }
function check(kind: number, length: number, direction: ControlDirection) {
  const fixed = direction === "to-main" ? new Map([[ControlKind.hello, 48], [ControlKind.clean, 0]])
    : new Map([[ControlKind.accept, 16], [ControlKind.stop, 0]]);
  const exact = fixed.get(kind);
  const data = direction === "to-main" ? ControlKind.request : ControlKind.response;
  const limit = direction === "to-main" ? NativeControl.requestBytes : NativeControl.responseBytes;
  if (!Number.isInteger(length) || (exact === undefined ? kind !== data || length < 1 || length > limit : length !== exact))
    throw new Error("Invalid native control frame.");
}
export function encodeControlFrame(frame: ControlFrame, sequence: number, direction: ControlDirection): Buffer {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error("Invalid control sequence.");
  check(frame.kind, frame.body.length, direction);
  const bytes = Buffer.alloc(NativeControl.headerBytes + frame.body.length);
  bytes.writeUInt32BE(0x544d4354); bytes[4] = 1; bytes[5] = frame.kind;
  bytes.writeUInt32LE(frame.body.length, 8); bytes.writeUInt32LE(sequence, 12);
  frame.body.copy(bytes, NativeControl.headerBytes); return bytes;
}
/** One bounded allocation after header validation; partial-frame deadline never resets on trickles. */
export class NativeControlReader {
  private readonly header = Buffer.alloc(NativeControl.headerBytes);
  private used = 0;
  private body: Buffer | undefined;
  private bodyUsed = 0;
  private kind: ControlKind = ControlKind.hello;
  private sequence = 1;
  private stopped = false;
  private terminal = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly direction: ControlDirection, private readonly receive: (frame: ControlFrame) => void,
    private readonly failed: () => void) {}
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.body = undefined; this.used = 0; this.bodyUsed = 0; }
  private fail() { if (!this.stopped) { this.stop(); this.failed(); } }
  /** CLEAN is terminal even if trailing bytes do not form a complete header. */
  forbidMoreData() { this.terminal = true; }
  end() { if (this.used || this.body) this.fail(); this.stop(); }
  write(chunk: Buffer) {
    if (this.stopped) return;
    if (!Buffer.isBuffer(chunk) || this.terminal && chunk.length > 0) { this.fail(); return; }
    let offset = 0;
    try {
      while (!this.stopped && offset < chunk.length) {
        this.timer ??= setTimeout(() => this.fail(), NativeControl.ioTimeoutMs);
        if (!this.body) {
          const n = Math.min(chunk.length - offset, NativeControl.headerBytes - this.used);
          chunk.copy(this.header, this.used, offset, offset + n); this.used += n; offset += n;
          if (this.used !== NativeControl.headerBytes) continue;
          if (this.header.readUInt32BE(0) !== 0x544d4354 || this.header[4] !== 1 || this.header.readUInt16LE(6) !== 0
            || this.header.readUInt32LE(12) !== this.sequence) throw new Error("Invalid native control header.");
          const kind = this.header[5]!, length = this.header.readUInt32LE(8);
          check(kind, length, this.direction); this.kind = kind as ControlKind;
          this.body = Buffer.alloc(length); this.bodyUsed = 0;
        }
        const n = Math.min(chunk.length - offset, this.body.length - this.bodyUsed);
        chunk.copy(this.body, this.bodyUsed, offset, offset + n); this.bodyUsed += n; offset += n;
        if (this.bodyUsed === this.body.length) {
          const frame = { kind: this.kind, body: this.body };
          this.sequence = (this.sequence + 1) >>> 0; this.body = undefined; this.used = 0; this.bodyUsed = 0;
          clearTimeout(this.timer); this.timer = undefined; this.receive(frame);
          if (this.terminal && offset < chunk.length) throw new Error("Data after terminal control frame.");
        }
      }
    } catch { this.fail(); }
  }
}
