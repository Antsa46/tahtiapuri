import { afterEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
const state = vi.hoisted(() => ({ active: undefined as undefined | {
  child: EventEmitter & { kill: ReturnType<typeof vi.fn> }; resolve(): void; reject(error: Error): void;
} }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const custom = () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    state.active = { child, resolve, reject };
    return Object.assign(promise, { child });
  };
  return { execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: custom }) };
});
import { securePrivateDirectory, PrivateDirectoryProcessError } from "./private-directory.js";
afterEach(() => vi.useRealTimers());
async function settle() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
it("holds ownership after an early AbortError until actual close", async () => {
  const promise = securePrivateDirectory("synthetic"); let settled = false;
  const observed = promise.then(() => { settled = true; }, error => { settled = true; return error; });
  const error = new Error("aborted"); error.name = "AbortError";
  state.active!.reject(error); await settle(); expect(settled).toBe(false);
  state.active!.child.emit("close", 1); const failure = await observed;
  expect(failure).toBeInstanceOf(PrivateDirectoryProcessError); expect(failure.exitVerified).toBe(true);
});
it("does not treat a successful callback as process-exit evidence", async () => {
  const promise = securePrivateDirectory("synthetic"); let settled = false; void promise.then(() => { settled = true; });
  state.active!.resolve(); await settle(); expect(settled).toBe(false);
  state.active!.child.emit("close", 0); await promise; expect(settled).toBe(true);
});
it("marks exit unconfirmed when close never arrives", async () => {
  vi.useFakeTimers(); const promise = securePrivateDirectory("synthetic");
  const observed = promise.catch(error => error); state.active!.reject(new Error("early failure"));
  await vi.advanceTimersByTimeAsync(12000); const failure = await observed;
  expect(failure).toBeInstanceOf(PrivateDirectoryProcessError); expect(failure.exitVerified).toBe(false);
  expect(state.active!.child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
