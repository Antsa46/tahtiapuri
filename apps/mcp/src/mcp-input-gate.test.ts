import { afterEach, expect, it, vi } from "vitest";
import { McpInputGate, MCP_INPUT_POLICY } from "./mcp-input-gate.js";

const frame = (id: string | number, params?: unknown) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "ping", ...(params === undefined ? {} : { params }) }) + "\n");
function fixture() {
  const fail = vi.fn();
  const gate = new McpInputGate(fail);
  const forwarded: Buffer[] = [];
  gate.on("data", (chunk: Buffer) => forwarded.push(chunk));
  const close = () => { gate.stop(); gate.destroy(); };
  return { gate, fail, forwarded, close };
}
afterEach(() => vi.useRealTimers());
it("admits eight pending requests and stops before a ninth reaches the SDK", () => {
  const f = fixture();
  try {
    f.gate.write(Buffer.concat(Array.from({ length: 10 }, (_, id) => frame(id))));
    expect(f.forwarded).toHaveLength(8); expect(f.fail).toHaveBeenCalledTimes(1);
    f.gate.write(frame(11)); expect(f.forwarded).toHaveLength(8);
  } finally { f.close(); }
});
it("counts type-sensitive IDs and rejects a duplicate still in flight", () => {
  const f = fixture();
  try {
    f.gate.write(frame(1)); f.gate.write(frame("1")); expect(f.forwarded).toHaveLength(2);
    f.gate.write(frame(1)); expect(f.forwarded).toHaveLength(2); expect(f.fail).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});
it("allows repeated completed requests without a lifetime request count limit", () => {
  const f = fixture();
  try {
    for (let n = 0; n < 40; n++) {
      f.gate.write(frame("same"));
      f.gate.complete(f.gate.claimResponse("same"));
    }
    expect(f.forwarded).toHaveLength(40); expect(f.fail).not.toHaveBeenCalled();
  } finally { f.close(); }
});
it("does not let a late completion release a reused ID or a duplicate response", () => {
  const f = fixture();
  try {
    f.gate.write(frame(1)); const old = f.gate.claimResponse(1); f.gate.complete(old);
    f.gate.write(frame(1)); f.gate.complete(old);
    const current = f.gate.claimResponse(1);
    expect(() => f.gate.claimResponse(1)).toThrow("pending request");
    expect(current).not.toBe(old);
    f.gate.complete(current);
    expect(() => f.gate.claimResponse(1)).toThrow("pending request");
  } finally { f.close(); }
});
it("copies partial frames before forwarding and handles coalesced input", () => {
  const f = fixture();
  try {
    const bytes = frame("split", { text: "tähti" });
    const first = Buffer.from(bytes.subarray(0, 9)); f.gate.write(first); first.fill(0);
    expect(f.forwarded).toHaveLength(0);
    f.gate.write(Buffer.concat([bytes.subarray(9), frame("next")]));
    expect(f.forwarded).toEqual([bytes, frame("next")]); expect(f.fail).not.toHaveBeenCalled();
  } finally { f.close(); }
});
it("counts the delimiter in the maximum encoded frame size", () => {
  const f = fixture();
  try {
    const base = frame(1, { text: "" });
    const exact = frame(1, { text: "x".repeat(MCP_INPUT_POLICY.frameBytes - base.length) });
    expect(exact.length).toBe(MCP_INPUT_POLICY.frameBytes); f.gate.write(exact);
    expect(f.forwarded).toHaveLength(1); f.gate.complete(f.gate.claimResponse(1));
    const over = frame(1, { text: "x".repeat(MCP_INPUT_POLICY.frameBytes - base.length + 1) });
    f.gate.write(over); expect(f.forwarded).toHaveLength(1); expect(f.fail).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});
it.each([
  Buffer.from("\n"), Buffer.from("[]\n"), Buffer.from("{broken}\n"),
  Buffer.from('{"jsonrpc":"2.0","id":null,"method":"ping"}\n'),
  Buffer.from('{"jsonrpc":"2.0","id":9007199254740992,"method":"ping"}\n'),
  frame("é".repeat(65)), frame(1, null), frame(1, []), frame(1, "invalid"), frame(1, 1),
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), frame(1)]),
  Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'),
  Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"'), Buffer.from([0xff]), Buffer.from('"}\n')]),
])("rejects malformed input before forwarding: %j", bytes => {
  const f = fixture();
  try { f.gate.write(bytes); expect(f.forwarded).toHaveLength(0); expect(f.fail).toHaveBeenCalledTimes(1); }
  finally { f.close(); }
});
it("rejects a truncated final frame", async () => {
  const f = fixture();
  try {
    await new Promise<void>(resolve => f.gate.end(frame(1).subarray(0, -1), resolve));
    expect(f.forwarded).toHaveLength(0); expect(f.fail).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});
it("allows only one initialized notification and closes on RPC cancellation", () => {
  for (const notification of ["notifications/initialized", "notifications/cancelled", "notifications/unknown"]) {
    const f = fixture();
    try {
      f.gate.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      f.gate.write(JSON.stringify({ jsonrpc: "2.0", method: notification, params: { requestId: 1 } }) + "\n");
      expect(f.forwarded).toHaveLength(1); expect(f.fail).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  }
});
it("expires unanswered requests and clears every timer on close", async () => {
  vi.useFakeTimers(); const f = fixture();
  try {
    f.gate.write(frame(1)); f.gate.write(frame(2));
    await vi.advanceTimersByTimeAsync(9999); expect(f.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.fail).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); expect(() => f.gate.claimResponse(1)).toThrow();
  } finally { f.close(); }
});
