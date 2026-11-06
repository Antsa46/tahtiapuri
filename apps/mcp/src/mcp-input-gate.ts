import { Transform, type TransformCallback } from "node:stream";

// Candidate policy: limits count encoded bytes, including each newline.
export const MCP_INPUT_POLICY = {
  frameBytes: 16_384, pendingRequests: 8, reservedBytes: 131_072,
  requestTimeoutMs: 10_000, idBytes: 128,
} as const;
type RequestId = string | number;
export interface McpRequestReservation {
  readonly id: RequestId;
  readonly bytes: number;
  readonly timer: NodeJS.Timeout;
  responding: boolean;
}

/** Owns admission before the SDK can retain parsed messages in its async queue. */
export class McpInputGate extends Transform {
  private readonly frame = Buffer.alloc(MCP_INPUT_POLICY.frameBytes);
  private used = 0;
  private stopped = false;
  private initialized = false;
  private readonly requests = new Map<RequestId, McpRequestReservation>();
  private reservedBytes = 0;

  constructor(private readonly fail: (error: Error) => void) { super(); }

  private reject(reason: string) {
    if (this.stopped) return;
    this.stop();
    this.fail(new Error(reason));
  }
  stop() {
    this.stopped = true;
    this.used = 0;
    for (const request of this.requests.values()) clearTimeout(request.timer);
    this.requests.clear();
    this.reservedBytes = 0;
  }
  claimResponse(id: unknown): McpRequestReservation {
    const entry = typeof id === "string" || typeof id === "number" ? this.requests.get(id) : undefined;
    if (this.stopped || !entry || entry.responding) throw new Error("MCP response has no pending request.");
    entry.responding = true;
    return entry;
  }
  complete(entry: McpRequestReservation) {
    // A late callback must never release a later request reusing the same ID.
    if (this.requests.get(entry.id) !== entry) return;
    this.requests.delete(entry.id);
    this.reservedBytes -= entry.bytes;
    clearTimeout(entry.timer);
  }
  private admit(bytes: number): boolean {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.frame.subarray(0, bytes - 1)));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch { this.reject("Invalid MCP input frame."); return false; }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || !message.method.length
      || message.method.length > 128
      || Object.hasOwn(message, "params") && (!message.params || typeof message.params !== "object" || Array.isArray(message.params))
      || Object.keys(message).some(key => !["jsonrpc", "id", "method", "params"].includes(key))) {
      this.reject("Invalid MCP input envelope."); return false;
    }
    if (!Object.hasOwn(message, "id")) {
      // RPC cancellation can suppress the SDK response, so it closes this
      // candidate session. The ordinary cancel_probe tool remains reusable.
      if (message.method !== "notifications/initialized" || this.initialized) {
        this.reject("Unsupported MCP notification."); return false;
      }
      this.initialized = true;
      return true;
    }
    const id = message.id;
    if (!(typeof id === "string" && Buffer.byteLength(id) <= MCP_INPUT_POLICY.idBytes
      || typeof id === "number" && Number.isSafeInteger(id))) {
      this.reject("Invalid MCP request ID."); return false;
    }
    if (this.requests.has(id) || this.requests.size >= MCP_INPUT_POLICY.pendingRequests
      || this.reservedBytes + bytes > MCP_INPUT_POLICY.reservedBytes) {
      this.reject("MCP input limit reached."); return false;
    }
    const entry: McpRequestReservation = { id, bytes, responding: false,
      timer: setTimeout(() => this.reject("MCP request timed out."), MCP_INPUT_POLICY.requestTimeoutMs) };
    this.requests.set(id, entry);
    this.reservedBytes += bytes;
    return true;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    // Copy only the bounded current frame; never keep a slice of an upstream
    // chunk, which could retain an arbitrarily large backing allocation.
    let offset = 0;
    while (!this.stopped && offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const count = (end < 0 ? chunk.length : end + 1) - offset;
      if (this.used + count > MCP_INPUT_POLICY.frameBytes) { this.reject("MCP input frame too large."); break; }
      chunk.copy(this.frame, this.used, offset, offset + count);
      this.used += count; offset += count;
      if (end >= 0) {
        const bytes = this.used;
        this.used = 0;
        if (!this.admit(bytes)) break;
        this.push(Buffer.from(this.frame.subarray(0, bytes)));
      }
    }
    callback();
  }
  override _flush(callback: TransformCallback) {
    if (this.used) this.reject("Truncated MCP input frame.");
    callback();
  }
}
