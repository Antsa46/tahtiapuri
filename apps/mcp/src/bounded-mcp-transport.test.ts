import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import { BoundedMcpTransport, MCP_OUTPUT_POLICY } from "./bounded-mcp-transport.js";

const message = (text = "synthetic") => ({ jsonrpc: "2.0" as const, method: "synthetic", params: { text } });
async function fixture(accept = false) {
  const callbacks: ((error?: Error | null) => void)[] = [];
  const output = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writableLength: 0,
    write: vi.fn((_frame: string, callback: (error?: Error | null) => void) => { callbacks.push(callback); return accept; }),
  });
  const input = new PassThrough(), release = vi.fn();
  const transport = new BoundedMcpTransport(input, output as unknown as Writable, release);
  await transport.start();
  return { input, output, callbacks, release, transport };
}
afterEach(() => vi.useRealTimers());
it("serializes sends and requires both write completion and drain", async () => {
  const f = await fixture();
  const first = f.transport.send(message("first")), second = f.transport.send(message("second"));
  expect(f.output.write).toHaveBeenCalledTimes(1); f.callbacks[0]!();
  expect(f.output.write).toHaveBeenCalledTimes(1);
  f.output.emit("drain"); await first; expect(f.output.write).toHaveBeenCalledTimes(2);
  f.output.emit("drain"); f.callbacks[1]!(); await second;
  await f.transport.close(); expect(f.release).toHaveBeenCalledTimes(1);
});
it("does not settle an accepted write until its completion callback", async () => {
  const f = await fixture(true); let settled = false;
  const pending = f.transport.send(message()); void pending.then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  f.callbacks[0]!(); await pending; expect(settled).toBe(true); await f.transport.close();
});
it("enforces the 256 KiB limit on encoded bytes and closes irreversibly", async () => {
  const f = await fixture();
  await expect(f.transport.send(message("é".repeat(MCP_OUTPUT_POLICY.frameBytes / 2)))).rejects.toThrow("limit");
  await f.transport.close(); expect(f.release).toHaveBeenCalledTimes(1); expect(f.output.write).not.toHaveBeenCalled();
  await expect(f.transport.send(message())).rejects.toThrow();
});
it("bounds active plus queued bytes before admitting another frame", async () => {
  const f = await fixture();
  const pending = [f.transport.send(message("x".repeat(180_000))), f.transport.send(message("x".repeat(180_000)))];
  const overflow = f.transport.send(message("x".repeat(180_000)));
  const results = await Promise.allSettled([...pending, overflow]);
  expect(results.every(result => result.status === "rejected")).toBe(true);
  expect(f.output.write).toHaveBeenCalledTimes(1); await f.transport.close();
});
it("also counts bytes already buffered in the injected writable", async () => {
  const f = await fixture(); f.output.writableLength = MCP_OUTPUT_POLICY.reservedBytes;
  await expect(f.transport.send(message())).rejects.toThrow("limit");
  expect(f.output.write).not.toHaveBeenCalled(); await f.transport.close();
});
it("admits at most sixteen sends while a reader is stalled", async () => {
  const f = await fixture();
  const pending = Array.from({ length: 16 }, () => f.transport.send(message()));
  const overflow = f.transport.send(message());
  expect((await Promise.allSettled([...pending, overflow])).every(result => result.status === "rejected")).toBe(true);
  expect(f.output.write).toHaveBeenCalledTimes(1); await f.transport.close();
});
it("closes a starved reader at two seconds and rejects every active or queued send", async () => {
  vi.useFakeTimers(); const f = await fixture();
  const pending = [f.transport.send(message()), f.transport.send(message())];
  const results = Promise.allSettled(pending);
  // Even a completed write cannot keep the session alive forever without drain.
  f.callbacks[0]!(); await vi.advanceTimersByTimeAsync(1999); expect(f.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect((await results).every(result => result.status === "rejected")).toBe(true);
  await f.transport.close(); expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.output.listenerCount("drain")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it("also bounds an accepted write whose callback never completes", async () => {
  vi.useFakeTimers(); const f = await fixture(true);
  const pending = expect(f.transport.send(message())).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(2000); await pending; await f.transport.close();
});
it("explicit close rejects pending sends exactly once and releases all timers and drain listeners", async () => {
  vi.useFakeTimers(); const f = await fixture();
  const pending = [f.transport.send(message()), f.transport.send(message())];
  const results = Promise.allSettled(pending), closing = f.transport.close();
  expect(f.transport.close()).toBe(closing); await closing;
  expect((await results).every(result => result.status === "rejected")).toBe(true);
  f.callbacks[0]!(); f.output.emit("drain"); await vi.advanceTimersByTimeAsync(2000);
  expect(f.output.write).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.output.listenerCount("drain")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it.each(["error", "close"])("rejects pending sends on output %s and consumes late output errors", async event => {
  const f = await fixture(); const pending = expect(f.transport.send(message())).rejects.toThrow();
  f.output.emit(event, new Error("synthetic")); await pending; await f.transport.close();
  expect(() => f.output.emit("error", new Error("late synthetic"))).not.toThrow();
  expect(f.release).toHaveBeenCalledTimes(1);
});
it("fails closed if a write throws or its callback reports failure", async () => {
  const thrown = await fixture(); thrown.output.write.mockImplementation(() => { throw new Error("synthetic"); });
  await expect(thrown.transport.send(message())).rejects.toThrow("write failed"); await thrown.transport.close();
  const failed = await fixture(); const pending = expect(failed.transport.send(message())).rejects.toThrow("write failed");
  failed.callbacks[0]!(new Error("synthetic")); await pending; await failed.transport.close();
});
