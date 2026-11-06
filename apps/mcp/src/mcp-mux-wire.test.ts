import { afterEach, expect, it, vi } from "vitest";
import { encodeMuxFrame, McpMuxReader, MCP_MUX, MuxKind, nextMuxSequence } from "./mcp-mux-wire.js";
const frame = (sequence = 1, text = "synthetic") => encodeMuxFrame({ kind: MuxKind.mcp, body: Buffer.from(text) }, sequence, "to-worker");
function fixture() { const receive = vi.fn(), fail = vi.fn(); return { receive, fail, reader: new McpMuxReader("to-worker", receive, fail) }; }
afterEach(() => vi.useRealTimers());
it("parses fragmented and coalesced frames without retaining the caller's buffer", () => {
  const f = fixture();
  try {
    const input = frame();
    for (const byte of input) { const part = Buffer.from([byte]); f.reader.write(part); part.fill(0); }
    f.reader.write(Buffer.concat([frame(2, "second"), frame(3, "third")]));
    expect(f.receive.mock.calls.map(call => call[0].body.toString())).toEqual(["synthetic", "second", "third"]);
    expect(f.fail).not.toHaveBeenCalled();
  } finally { f.reader.stop(); }
});
it.each([0, 1, 2, 3])("rejects a high-bit alias in magic byte %i", position => {
  const f = fixture(), input = frame(); input[position] = input[position]! | 128;
  f.reader.write(input); expect(f.fail).toHaveBeenCalledTimes(1); expect(f.receive).not.toHaveBeenCalled(); f.reader.stop();
});
it.each(["version", "reserved", "kind", "direction", "size", "sequence"])("rejects an invalid %s from its header before payload", kind => {
  const f = fixture(), input = frame().subarray(0, MCP_MUX.headerBytes);
  if (kind === "version") input[4] = 2;
  if (kind === "reserved") input[6] = 1;
  if (kind === "kind") input[5] = 255;
  if (kind === "direction") input[5] = MuxKind.ready;
  if (kind === "size") input.writeUInt32LE(MCP_MUX.mcpInputBytes + 1, 8);
  if (kind === "sequence") input.writeUInt32LE(2, 12);
  f.reader.write(input); expect(f.fail).toHaveBeenCalledTimes(1); expect(f.receive).not.toHaveBeenCalled(); f.reader.stop();
});
it("enforces directional bounds and unsigned modular sequence arithmetic", () => {
  expect(nextMuxSequence(0xffffffff)).toBe(0); expect(nextMuxSequence(0)).toBe(1);
  expect(() => encodeMuxFrame({ kind: MuxKind.mcp, body: Buffer.alloc(0) }, 1, "to-worker")).toThrow();
  expect(() => encodeMuxFrame({ kind: MuxKind.close, body: Buffer.alloc(0) }, 1, "from-worker")).toThrow();
  expect(() => encodeMuxFrame({ kind: MuxKind.development, body: Buffer.alloc(MCP_MUX.developmentInputBytes) }, 1, "to-worker")).not.toThrow();
  expect(() => encodeMuxFrame({ kind: MuxKind.development, body: Buffer.alloc(MCP_MUX.developmentInputBytes) }, 1, "from-worker")).toThrow();
});
it("rejects partial EOF and never resets a partial frame's deadline with new bytes", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.reader.write(frame().subarray(0, 2)); await vi.advanceTimersByTimeAsync(1999);
  f.reader.write(frame().subarray(2, 3)); expect(f.fail).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.fail).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  const g = fixture(); g.reader.write(frame().subarray(0, -1)); g.reader.end();
  expect(g.fail).toHaveBeenCalledTimes(1); expect(g.receive).not.toHaveBeenCalled();
});
it("stops coalesced delivery immediately when its consumer closes it", () => {
  const f = fixture(); f.receive.mockImplementationOnce(() => f.reader.stop());
  f.reader.write(Buffer.concat([frame(), frame(2)]));
  expect(f.receive).toHaveBeenCalledTimes(1); expect(f.fail).not.toHaveBeenCalled();
});
