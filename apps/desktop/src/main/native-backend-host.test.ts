import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeBackendChild, createNativeBackendFactory, type NativeBackendDependencies, type NativeBackendSession } from "./native-backend-host.js";
import { loadNativeBackendRuntime, type NativeBackendRuntime, type PreparedNativeBackendResources } from "./native-backend-resources.js";

// The host unit boundary injects lifecycle operations; no file/process module executes.
vi.mock("./native-backend-resources.js", () => ({ loadNativeBackendRuntime: vi.fn(), recoverNativeBackend: vi.fn(),
  prepareNativeBackendResources: vi.fn(), launchNativeBackend: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
class Session extends EventEmitter implements NativeBackendSession {
  pid = 1234;
  readonly physical = deferred<void>();
  readonly closure = this.physical.promise;
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
  readonly closeChildInput = vi.fn(async () => {});
  readonly confirmCleanup = vi.fn(async () => {});
  close() { this.emit("exit", 0, null); this.physical.resolve(); }
}
const runtime = { runtimeRoot: "synthetic-runtime", userDataRoot: "synthetic-data" } as NativeBackendRuntime;
function fixture(overrides: Partial<NativeBackendDependencies> = {}) {
  const inner = new Session(), order: string[] = [];
  const discard = vi.fn(async () => {});
  const resources = { discardBeforeLaunch: discard } as unknown as PreparedNativeBackendResources;
  const dependencies = {
    load: vi.fn(async () => { order.push("load"); return runtime; }),
    recover: vi.fn(async () => { order.push("recover"); }),
    prepare: vi.fn(async () => { order.push("prepare"); return resources; }),
    launch: vi.fn(async () => { order.push("launch"); return inner; }),
    ...overrides,
  };
  const child = new NativeBackendChild(dependencies), error = vi.fn(); child.on("error", error);
  return { child, inner, dependencies, order, discard, resources, error };
}
async function settle() { await vi.advanceTimersByTimeAsync(0); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("recovers before staging/launch and forwards only the native session's lifecycle", async () => {
  const f = fixture(), spawn = vi.fn(), message = vi.fn(), exit = vi.fn();
  f.child.on("spawn", spawn); f.child.on("message", message); f.child.on("exit", exit);
  expect(f.order).toEqual([]); await settle();
  expect(f.order).toEqual(["load", "recover", "prepare", "launch"]); expect(f.child.pid).toBe(1234);
  expect(spawn).not.toHaveBeenCalled(); f.inner.emit("spawn"); expect(spawn).toHaveBeenCalledOnce();
  f.child.postMessage({ synthetic: true }); expect(f.inner.postMessage).toHaveBeenCalledWith({ synthetic: true });
  f.inner.emit("message", { synthetic: "reply" }); expect(message).toHaveBeenCalledWith({ synthetic: "reply" });
  f.inner.close(); await f.child.closure; await f.child.confirmCleanup();
  expect(exit).toHaveBeenCalledWith(0, null); expect(f.discard).not.toHaveBeenCalled();
});
it("does not report cancellation before a pending read settles or start later recovery", async () => {
  const load = deferred<NativeBackendRuntime>(), f = fixture({ load: () => load.promise });
  await settle(); const closed = vi.fn(); void f.child.closure.then(closed);
  expect(f.child.kill()).toBe(true); expect(f.child.kill()).toBe(false); await settle(); expect(closed).not.toHaveBeenCalled();
  load.resolve(runtime); await settle(); await f.child.closure; await f.child.confirmCleanup();
  expect(closed).toHaveBeenCalledOnce(); expect(f.dependencies.recover).not.toHaveBeenCalled(); expect(f.dependencies.launch).not.toHaveBeenCalled();
});
it("discards an owned staged session that arrives after cancellation without launching it", async () => {
  const prepared = deferred<PreparedNativeBackendResources>(), f = fixture({ prepare: () => prepared.promise });
  await settle(); f.child.kill(); prepared.resolve(f.resources); await settle();
  await f.child.closure; await f.child.confirmCleanup();
  expect(f.discard).toHaveBeenCalledOnce(); expect(f.dependencies.launch).not.toHaveBeenCalled();
});
it("keeps a failed recovery unverified and never stages or falls back", async () => {
  const f = fixture({ recover: async () => { throw new Error("blocked recovery"); } }); await settle();
  await expect(f.child.closure).rejects.toThrow("recovery"); await expect(f.child.confirmCleanup()).rejects.toThrow();
  expect(f.dependencies.prepare).not.toHaveBeenCalled(); expect(f.dependencies.launch).not.toHaveBeenCalled();
});
it("does not infer stage cleanup when preparation failed before returning owned resources", async () => {
  const f = fixture({ prepare: async () => { throw new Error("partial staging unknown"); } }); await settle();
  await expect(f.child.closure).rejects.toThrow(); await expect(f.child.confirmCleanup()).rejects.toThrow();
  expect(f.discard).not.toHaveBeenCalled(); expect(f.dependencies.launch).not.toHaveBeenCalled();
});
it("retains staged data after an uncertain launch instead of calling discardBeforeLaunch", async () => {
  const f = fixture({ launch: async () => { throw new Error("launch outcome unknown"); } }); await settle();
  await expect(f.child.closure).rejects.toThrow(); await expect(f.child.confirmCleanup()).rejects.toThrow();
  expect(f.discard).not.toHaveBeenCalled();
});
it("attaches and kills a late launched session after cancellation, then waits actual closure", async () => {
  const launched = deferred<NativeBackendSession>(), f = fixture({ launch: () => launched.promise }); await settle();
  const closed = vi.fn(), spawn = vi.fn(); void f.child.closure.then(closed); f.child.on("spawn", spawn);
  f.child.kill(); launched.resolve(f.inner); await settle(); expect(f.inner.kill).toHaveBeenCalled();
  f.inner.emit("spawn"); expect(spawn).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
  f.inner.close(); await f.child.closure; expect(f.discard).not.toHaveBeenCalled();
});
it("does not treat physical close as a clean native result", async () => {
  const f = fixture(); await settle();
  f.inner.confirmCleanup.mockRejectedValue(new Error("native cleanup blocked"));
  f.inner.close(); await f.child.closure; await expect(f.child.confirmCleanup()).rejects.toThrow("blocked");
});
it("cannot confirm cleanup while the actual native closure is still pending", async () => {
  const f = fixture(); await settle(); const confirmed = vi.fn();
  void f.child.confirmCleanup().then(confirmed); await settle(); expect(confirmed).not.toHaveBeenCalled();
  expect(f.inner.confirmCleanup).not.toHaveBeenCalled(); f.inner.close(); await settle(); expect(confirmed).toHaveBeenCalledOnce();
});
it("uses one startup budget including asynchronous preparation, without reset on launch", async () => {
  const load = deferred<NativeBackendRuntime>(), f = fixture({ load: () => load.promise });
  await vi.advanceTimersByTimeAsync(20_000); load.resolve(runtime); await settle();
  await vi.advanceTimersByTimeAsync(19_999); expect(f.error).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.error).toHaveBeenCalled(); expect(f.inner.kill).toHaveBeenCalled();
  f.inner.close(); await f.child.closure;
});
it("bounds cancelled unresolved preparation without declaring it clean", async () => {
  const load = deferred<NativeBackendRuntime>(), f = fixture({ load: () => load.promise }); await settle();
  f.child.kill(); await vi.advanceTimersByTimeAsync(24_000); f.child.kill();
  await vi.advanceTimersByTimeAsync(1000); await expect(f.child.closure).rejects.toThrow("recovery");
  load.resolve(runtime); await settle(); await expect(f.child.confirmCleanup()).rejects.toThrow();
});

it("rejects confirmCleanup at the first cancellation deadline even if preparation never settles", async () => {
  const never = new Promise<NativeBackendRuntime>(() => {}), f = fixture({ load: () => never });
  await settle();
  const cleanup = f.child.confirmCleanup(); void cleanup.catch(() => {});
  f.child.kill(); await vi.advanceTimersByTimeAsync(24_000); f.child.kill();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(cleanup).rejects.toThrow("recovery");
  expect(f.dependencies.recover).not.toHaveBeenCalled(); expect(f.dependencies.launch).not.toHaveBeenCalled();
});

it("captures trusted paths once and refuses to reuse a consumed production factory", async () => {
  vi.mocked(loadNativeBackendRuntime).mockRejectedValue(new Error("synthetic metadata rejection"));
  const config = { runtimeRoot: "approved-runtime", userDataRoot: "approved-data" };
  const factory = createNativeBackendFactory(config); config.runtimeRoot = "changed-later";
  const child = factory(); child.on("error", () => {}); await settle();
  expect(loadNativeBackendRuntime).toHaveBeenCalledWith({ runtimeRoot: "approved-runtime", userDataRoot: "approved-data" }, expect.any(AbortSignal));
  expect(() => factory()).toThrow("consumed"); await child.closure; await child.confirmCleanup!();
});
