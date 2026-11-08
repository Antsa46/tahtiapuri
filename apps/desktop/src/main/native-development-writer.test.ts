import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { NativeControlWriter } from "./native-development-writer.js";
import { ControlKind, NativeControl } from "./native-development-wire.js";

// Pure synthetic output. No Node stream IO, process, native actor or socket.
class Output extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  readonly held: ((error?: Error) => void)[] = [];
  readonly write = vi.fn((_bytes: Buffer, callback: (error?: Error) => void): boolean => { this.held.push(callback); return true; });
  release(error?: Error) { const callback = this.held.shift(); if (!callback) throw new Error("No original mock callback"); callback(error); }
}
const fixtures: { output: Output; writer: NativeControlWriter }[] = [];
function fixture(failed = vi.fn<() => void>()) {
  const output = new Output(), writer = new NativeControlWriter(output as unknown as Writable, failed);
  const write = () => { const result = writer.write({ kind: ControlKind.stop, body: Buffer.alloc(0) }); void result.catch(() => {}); return result; };
  fixtures.push({ output, writer }); return { output, writer, failed, write };
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.writer.stop(); for (const cb of f.output.held.splice(0)) cb(); } vi.useRealTimers(); });
const turn = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
it("original closure requires terminal admission even after a completed write", async () => {
  const f = fixture(), result = f.write(); f.output.release(); await result;
  expect(f.writer.originalWorkSettled).toBe(false); f.writer.stop();
  expect(await f.writer.originalClosed).toEqual({ failed: false }); expect(f.writer.originalWorkSettled).toBe(true);
});
it("logical stop and stream close cannot replace the pending original write callback", async () => {
  const f = fixture(), result = f.write(); f.writer.stop(); f.output.emit("close"); await expect(result).rejects.toThrow("closed");
  let ended = false; void f.writer.originalClosed.then(() => { ended = true; }); await turn();
  expect(ended).toBe(false); expect(f.writer.originalWorkSettled).toBe(false);
  f.output.release(); expect(await f.writer.originalClosed).toEqual({ failed: false });
});
it("a late callback error ends original work with sticky failure after logical cancellation", async () => {
  const f = fixture(), result = f.write(), error = new Error("Late physical mock failure"); f.writer.stop(); await result.catch(() => {});
  f.output.release(error); const end = await f.writer.originalClosed;
  expect(end).toEqual({ failed: true }); expect(Object.isFrozen(end)).toBe(true); expect(f.writer.originalFailure?.reason).toBe(error);
  expect(f.failed).toHaveBeenCalledOnce(); expect(await f.writer.originalClosed).toBe(end); await expect(result).rejects.toThrow("closed");
});
it("a synchronous callback plus stop cannot finish the original port inside the write frame", async () => {
  const f = fixture(); f.output.write.mockImplementation((_bytes, callback) => {
    callback(); f.writer.stop(); expect(f.writer.originalWorkSettled).toBe(false); return true;
  });
  const result = f.write(); await expect(result).rejects.toThrow("closed"); expect(await f.writer.originalClosed).toEqual({ failed: false });
});
it("stop from newListener prevents write and removes the listener added after that stop", async () => {
  const f = fixture(); f.output.once("newListener", name => {
    if (name === "drain") { f.writer.stop(); expect(f.writer.originalWorkSettled).toBe(false); }
  });
  const result = f.write(); await expect(result).rejects.toThrow("closed");
  expect(f.output.write).not.toHaveBeenCalled(); expect(f.output.listenerCount("drain")).toBe(0);
  expect(await f.writer.originalClosed).toEqual({ failed: false });
});
it("failure before entering write is a known no-dispatch end", async () => {
  const f = fixture(), error = new Error("Mock listener registration failed");
  vi.spyOn(f.output, "once").mockImplementation(() => { throw error; });
  await expect(f.write()).rejects.toThrow("closed"); expect(f.output.write).not.toHaveBeenCalled();
  expect(await f.writer.originalClosed).toEqual({ failed: true }); expect(f.writer.originalFailure?.reason).toBe(error);
});
it.each([false, true])("write throw after entry (reentrant stop=%s) waits for its own later callback", async stop => {
  const f = fixture(), error = new Error("Original write threw");
  f.output.write.mockImplementation((_bytes, callback) => { f.output.held.push(callback); if (stop) f.writer.stop(); throw error; });
  await expect(f.write()).rejects.toThrow("closed"); expect(f.writer.originalWorkSettled).toBe(false);
  f.output.emit("close"); await turn(); expect(f.writer.originalWorkSettled).toBe(false);
  f.output.release(); expect(await f.writer.originalClosed).toEqual({ failed: true }); expect(f.writer.originalFailure?.reason).toBe(error);
});
it("a write throw with no callback proof remains unresolved even after stream close", async () => {
  const f = fixture(); f.output.write.mockImplementation(() => { throw new Error("No callback handle proof"); });
  await f.write().catch(() => {}); f.output.emit("close"); let ended = false;
  void f.writer.originalClosed.then(() => { ended = true; }); await turn(); expect(ended).toBe(false); expect(f.writer.originalWorkSettled).toBe(false);
});
it("queued writes are cancelled without pretending they reached the physical output", async () => {
  const f = fixture(), first = f.write(), second = f.write(); expect(f.output.write).toHaveBeenCalledOnce(); f.writer.stop();
  await expect(first).rejects.toThrow("closed"); await expect(second).rejects.toThrow("closed"); expect(f.writer.originalWorkSettled).toBe(false);
  f.output.release(); expect(await f.writer.originalClosed).toEqual({ failed: false }); expect(f.output.write).toHaveBeenCalledOnce();
});
it("the terminal no-work port cannot be reopened by a refused later write", async () => {
  const f = fixture(); f.writer.stop(); const end = await f.writer.originalClosed;
  await expect(f.write()).rejects.toThrow("closed"); expect(f.output.write).not.toHaveBeenCalled(); expect(await f.writer.originalClosed).toBe(end);
});
it("a throwing owner failure callback cannot bypass original callback bookkeeping", async () => {
  const ownerError = new Error("Owner callback threw"), failed = vi.fn(() => { throw ownerError; });
  const f = fixture(failed), result = f.write(), error = new Error("Original callback error");
  expect(() => f.output.release(error)).toThrow(ownerError); await result.catch(() => {});
  expect(await f.writer.originalClosed).toEqual({ failed: true }); expect(f.writer.originalFailure?.reason).toBe(error);
});
it("callback and drain still preserve FIFO public success", async () => {
  const f = fixture(); f.output.write.mockImplementation((_bytes, callback) => { f.output.held.push(callback); return false; });
  const first = f.write(), second = f.write(); f.output.release(); expect(f.output.write).toHaveBeenCalledOnce();
  f.output.emit("drain"); await first; expect(f.output.write).toHaveBeenCalledTimes(2);
  f.output.release(); f.output.emit("drain"); await second; f.writer.stop(); expect(await f.writer.originalClosed).toEqual({ failed: false });
});
it("public IO timeout never finishes a pending original callback or erases failure", async () => {
  vi.useFakeTimers(); const f = fixture(), result = f.write(); await vi.advanceTimersByTimeAsync(NativeControl.ioTimeoutMs);
  await expect(result).rejects.toThrow("closed"); expect(f.writer.originalWorkSettled).toBe(false);
  f.output.release(); expect(await f.writer.originalClosed).toEqual({ failed: true }); await expect(result).rejects.toThrow("closed");
});
