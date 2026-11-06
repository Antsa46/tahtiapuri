import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { McpMuxWriter } from "./mcp-mux-writer.js";
import { MCP_MUX, MuxKind } from "./mcp-mux-wire.js";
const frame = (size = 8) => ({ kind: MuxKind.mcp, body: Buffer.alloc(size) });
function fixture(accepted = false) {
  const callbacks: ((error?: Error | null) => void)[] = [], fail = vi.fn();
  const output = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writableFinished: false, writableLength: 0,
    write: vi.fn((_bytes: Buffer, done: (error?: Error | null) => void) => { callbacks.push(done); return accepted; }),
    end: vi.fn((done: (error?: Error | null) => void) => { output.writableEnded = true; output.writableFinished = true; done(); }),
    destroy: vi.fn(() => { output.destroyed = true; }),
  });
  return { output, callbacks, fail, writer: new McpMuxWriter(output as unknown as Writable, fail) };
}
afterEach(() => vi.useRealTimers());
it("serializes both channels and waits for physical callback and drain", async () => {
  const f = fixture(), one = vi.fn(), two = vi.fn();
  f.writer.write(frame(), one); f.writer.write({ kind: MuxKind.development, body: Buffer.from("x") }, two);
  expect(f.output.write).toHaveBeenCalledTimes(1); f.callbacks[0]!(); expect(one).not.toHaveBeenCalled();
  f.output.emit("drain"); expect(one).toHaveBeenCalledWith(); expect(f.output.write).toHaveBeenCalledTimes(2);
  f.output.emit("drain"); expect(two).not.toHaveBeenCalled(); f.callbacks[1]!(); expect(two).toHaveBeenCalledWith();
  await f.writer.finish(); expect(f.fail).not.toHaveBeenCalled();
});
it("fails every admitted callback once when the frame count is exceeded", () => {
  const f = fixture(), callbacks = Array.from({ length: 17 }, () => vi.fn());
  for (const callback of callbacks) f.writer.write(frame(), callback);
  expect(callbacks.every(callback => callback.mock.calls.length === 1 && callback.mock.calls[0]![0] instanceof Error)).toBe(true);
  f.callbacks[0]!(); f.output.emit("drain"); expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);
  expect(f.fail).toHaveBeenCalledTimes(1); expect(f.output.destroy).toHaveBeenCalledTimes(1);
});
it("counts headers and retained physical bytes against the queue bound", () => {
  const f = fixture(); f.output.writableLength = MCP_MUX.queuedBytes - MCP_MUX.headerBytes;
  const callback = vi.fn(); f.writer.write(frame(1), callback);
  expect(callback).toHaveBeenCalledWith(expect.any(Error)); expect(f.output.write).not.toHaveBeenCalled();
});
it("times out a stalled physical reader and settles finish as failed", async () => {
  vi.useFakeTimers(); const f = fixture(), callback = vi.fn(); f.writer.write(frame(), callback);
  const finished = expect(f.writer.finish()).rejects.toThrow(); f.callbacks[0]!();
  await vi.advanceTimersByTimeAsync(2000); await finished;
  expect(callback).toHaveBeenCalledWith(expect.any(Error)); expect(f.output.listenerCount("drain")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it("does not lose teardown when a callback throws", () => {
  const f = fixture(), later = vi.fn();
  f.writer.write(frame(), () => { throw new Error("synthetic callback"); }); f.writer.write(frame(), later);
  expect(() => f.writer.abort()).not.toThrow(); expect(later).toHaveBeenCalledWith(expect.any(Error)); expect(f.output.destroy).toHaveBeenCalledTimes(1);
});
it("rejects asynchronous real Writable finalization errors instead of declaring success", async () => {
  const fail = vi.fn();
  const output = new Writable({ write(_bytes, _encoding, done) { done(); }, final(done) { setImmediate(() => done(new Error("synthetic final failure"))); } });
  const writer = new McpMuxWriter(output, fail);
  await expect(writer.finish()).rejects.toThrow("finish failed");
  await new Promise(resolve => setImmediate(resolve)); expect(fail).toHaveBeenCalledTimes(1); expect(output.destroyed).toBe(true);
});
it("rejects synchronous end errors and write callback errors", async () => {
  const f = fixture(); f.output.end.mockImplementation(() => { throw new Error("synthetic end failure"); });
  await expect(f.writer.finish()).rejects.toThrow("finish failed");
  const g = fixture(), callback = vi.fn(); g.writer.write(frame(), callback); g.callbacks[0]!(new Error("synthetic write failure"));
  expect(callback).toHaveBeenCalledWith(expect.any(Error)); expect(g.fail).toHaveBeenCalledTimes(1);
});
