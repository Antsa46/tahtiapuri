import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { promisify } from "node:util";
import { createNativeProcessTrace } from "./native-process-trace.js";

function child() {
  return Object.assign(new EventEmitter(), { pid: 17, kill: vi.fn(() => true) }) as unknown as ChildProcess.ChildProcess;
}
function module(spawn: unknown, execFile: unknown = () => { throw new Error("Unexpected execFile"); }) {
  return { spawn, execFile } as unknown as typeof ChildProcess;
}
it("preserves the frozen execFile custom promise, child, arguments, and result", async () => {
  const trace = createNativeProcessTrace(), scope = trace.current(), owned = child(), value = { stdout: "value", stderr: "" };
  const original = Object.assign(Promise.resolve(value), { child: owned });
  const callback = vi.fn(), custom = vi.fn(function (this: unknown, ...args: unknown[]) {
    expect(this).toBe(receiver); expect(args).toEqual([path, ["--identity", "private"], { callback }]); return original;
  });
  const exec = vi.fn();
  // Node may expose a nonconfigurable custom implementation. The wrapper must
  // not violate a Proxy get invariant or replace the original returned promise.
  Object.defineProperty(exec, promisify.custom, { value: custom });
  const wrapped = trace.wrap(module(() => owned, exec)), receiver = {}, path = "C:\\private\\main-identity.exe";
  const run = promisify(wrapped.execFile);
  const observed = Reflect.apply(run, receiver, [path, ["--identity", "private"], { callback }]);
  expect(observed).toBe(original); expect(observed.child).toBe(owned); expect(await observed).toBe(value);
  expect(exec).not.toHaveBeenCalled(); expect(custom).toHaveBeenCalledTimes(1); expect(callback).not.toHaveBeenCalled();
  owned.emit("spawn"); owned.emit("exit", 0, null); owned.emit("close", 0, null);
  expect(trace.records(scope)[0]).toMatchObject({ observedClose: true, exit: { code: 0, signal: null } });
  expect(scope.events.map(event => event.event)).toEqual([
    "execFile-custom-enter", "execFile-custom-return", "exec-promise-resolved", "child-spawn", "child-exit", "child-close",
  ]);
  expect(JSON.stringify(scope)).not.toContain("C:\\\\private"); expect(JSON.stringify(scope)).not.toContain("callback");
});
it("records synchronous entry and return and preserves spawn and kill results", () => {
  const trace = createNativeProcessTrace(), scope = trace.current(), owned = child(), receiver = {}, args = ["C:\\private\\main-bootstrap.exe", ["--consume", "private.bin"]];
  const spawn = vi.fn(function (this: unknown, ...values: unknown[]) {
    expect(this).toBe(receiver); expect(values).toBeDefined();
    expect(scope.events.at(-1)?.event).toBe("spawn-enter"); return owned;
  });
  const observed = Reflect.apply(trace.wrap(module(spawn)).spawn, receiver, args);
  expect(observed).toBe(owned); expect(owned.kill()).toBe(true);
  owned.emit("exit", 1, "SIGTERM"); owned.emit("close", 1, "SIGTERM");
  expect(scope.events.map(event => event.event)).toEqual(["spawn-enter", "spawn-return", "kill-request", "kill-return", "child-exit", "child-close"]);
  expect(scope.events[0]?.operation).toBe("main-bootstrap.exe--consume");
  expect(trace.records(scope)[0]?.exit).toEqual({ code: 1, signal: "SIGTERM" });
});
it("retains original rejection and late child events in their original case", async () => {
  const trace = createNativeProcessTrace(), first = trace.current(), owned = child();
  let reject!: (error: unknown) => void;
  const original = Object.assign(new Promise((_resolve, fail) => { reject = fail; }), { child: owned });
  const exec = Object.defineProperty(() => owned, promisify.custom, { value: () => original });
  const actual = promisify(trace.wrap(module(() => owned, exec)).execFile)("C:\\private\\main-identity.exe");
  const second = trace.begin(), error = Object.assign(new Error("private message"), { exitVerified: false });
  reject(error); await expect(actual).rejects.toBe(error);
  expect(trace.rejected(first, "identity", error)).toBe(true);
  owned.emit("error", error); owned.emit("exit", 1, null); owned.emit("close", 1, null);
  expect(first.uncertain).toBe(true); expect(second.events).toEqual([]);
  expect(first.events.find(event => event.event === "operation-rejected")).toMatchObject({ failureClass: "Error", exitVerified: false });
  expect(trace.records(first)[0]?.observedClose).toBe(true); expect(trace.children(second)).toEqual([]);
  expect(JSON.stringify(first)).not.toContain("private message");
});
it("does not alter a synchronous launch error or a failed kill", () => {
  const trace = createNativeProcessTrace(), failure = new Error("private error");
  expect(() => trace.wrap(module(() => { throw failure; })).spawn("private")).toThrow(failure);
  const owned = child(); owned.kill = () => { throw failure; };
  trace.wrap(module(() => owned)).spawn("private");
  expect(() => owned.kill()).toThrow(failure);
  owned.emit("close", 1, null);
  expect(trace.current().events.map(event => event.event)).toEqual(["spawn-enter", "spawn-throw", "spawn-enter", "spawn-return", "kill-request", "kill-throw", "child-close"]);
});
it("bounds diagnostic records and retains an observed close after overflow", () => {
  const trace = createNativeProcessTrace(), scope = trace.current(), owned = child();
  trace.wrap(module(() => owned)).spawn("private");
  for (let i = 0; i < 600; ++i) trace.note(scope, "synthetic", "bounded");
  owned.emit("close", 0, null);
  expect(scope.events).toHaveLength(512); expect(scope.overflow && scope.uncertain).toBe(true);
  expect(trace.records(scope)[0]?.observedClose).toBe(true);
});

it("attributes a delayed async launch to its original case", async () => {
  const trace = createNativeProcessTrace(), first = trace.current(), owned = child(), wrapped = trace.wrap(module(() => owned));
  let release!: () => void;
  const barrier = new Promise<void>(done => { release = done; });
  const pending = trace.run(first, async () => { await barrier; return wrapped.spawn("private"); });
  const second = trace.begin(); release();
  expect(await pending).toBe(owned); owned.emit("close", 0, null);
  expect(trace.records(first)).toHaveLength(1); expect(trace.records(second)).toEqual([]); expect(second.events).toEqual([]);
});
it("keeps late exit uncertainty after the outer timeout and blocks a clean new case", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const trace = createNativeProcessTrace(), first = trace.current(), controller = new AbortController(), pending = new Set<Promise<unknown>>();
    let reject!: (error: unknown) => void, tainted = false, startedNext = false;
    const work = new Promise<never>((_resolve, fail) => { reject = fail; });
    const outcome = trace.within(first, () => work, 10, "identity",
      { end: performance.now() + 1000, controller, pending, taint: () => { tainted = true; } }).catch(error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await outcome).toMatchObject({ message: "identity late completion" });
    expect(tainted).toBe(false); expect(pending.size).toBe(1);
    reject(Object.assign(new Error("private original"), { exitVerified: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(tainted).toBe(true); expect(controller.signal.aborted).toBe(true); expect(pending.size).toBe(0);
    const blocked = trace.begin();
    if (!tainted) startedNext = true;
    expect(startedNext).toBe(false); expect(trace.records(blocked)).toEqual([]); expect(blocked.events).toEqual([]);
    expect(first.events.filter(event => event.event === "operation-rejected")).toEqual([
      expect.objectContaining({ operation: "identity", failureClass: "Error", exitVerified: false }),
    ]);
    expect(JSON.stringify(first)).not.toContain("private original");
  } finally { vi.useRealTimers(); }
});
