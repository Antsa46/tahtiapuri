import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createObservedNativeDevelopmentLoader, type NativeLoaderContext } from "./native-development-resource-loader.js";
import type { NativeDevelopmentResources } from "./native-development-host.js";
import type { NativeCallOutcome } from "./native-launch-call-record.js";
const actors = vi.hoisted(() => vi.fn(() => { throw new Error("Application actor forbidden in loader observations"); }));
vi.mock("node:child_process", () => ({ spawn: actors, execFile: actors }));
vi.mock("node:worker_threads", () => ({ Worker: actors }));
const gate = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const owner = Object.freeze({ controlFile: "synthetic-opaque-owner" }) as NativeDevelopmentResources;
const fulfilled = Object.freeze({ status: "fulfilled" as const });
const turn = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve(); };
const input = () => ({ signal: new AbortController(), deadline: performance.now() + 10_000 });
beforeEach(() => { actors.mockClear(); });
afterEach(() => { expect(actors).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
it("returns the exact public Promise and closes a none binding only after original wrapper work", async () => {
  const result = gate<NativeDevelopmentResources>(), original = gate<void>(), begin = vi.fn(() => ({ result: result.promise, original: original.promise }));
  const loader = createObservedNativeDevelopmentLoader(begin), f = input(), value = loader(f.deadline, f.signal.signal);
  expect(value).toBe(result.promise); const observation = loader.observe(value); expect(Object.isFrozen(observation)).toBe(true);
  expect(() => loader.observe(value.then(item => item))).toThrow("Unknown original native loader");
  let bound = false; void observation.factory.then(() => { bound = true; }); result.resolve(owner); await turn();
  expect(await observation.result).toEqual(fulfilled); expect(bound).toBe(false);
  original.resolve(); expect(await observation.wrapper).toEqual(fulfilled); expect(await observation.factory).toEqual({ state: "none" });
  expect(begin).toHaveBeenCalledOnce(); expect(Object.keys(observation).sort()).toEqual(["factory", "result", "wrapper"]);
});
it("public timeout retains late factory preparation without upgrading the original rejection", async () => {
  const result = gate<NativeDevelopmentResources>(), wrapper = gate<void>(), prep = gate<NativeCallOutcome>();
  const factoryObservation = { result: result.promise.then(() => fulfilled, reason => ({ status: "rejected" as const, reason })), preparation: prep.promise };
  const observer = vi.fn(key => { expect(key).toBe(result.promise); return factoryObservation; });
  const loader = createObservedNativeDevelopmentLoader((_d, _s, context) => ({
    result: context.factory(() => result.promise, observer), original: wrapper.promise }));
  const f = input(), value = loader(f.deadline, f.signal.signal), observation = loader.observe(value), error = new Error("Bounded loader deadline");
  result.reject(error); await expect(value).rejects.toBe(error); expect(await observation.result).toEqual({ status: "rejected", reason: error });
  let bound = false; void observation.factory.then(() => { bound = true; }); await turn(); expect(bound).toBe(false);
  wrapper.resolve(); const binding = await observation.factory; expect(binding.state).toBe("bound"); if (binding.state !== "bound") throw new Error("binding");
  let ended = false; void binding.observation.preparation.then(() => { ended = true; }); await turn(); expect(ended).toBe(false);
  prep.resolve(fulfilled); expect(await binding.observation.preparation).toEqual(fulfilled);
  expect(await binding.result).toEqual({ status: "rejected", reason: error }); expect(observer).toHaveBeenCalledOnce();
});
it("a rejected public facade cannot admit a later factory while original wrapper IO is pending", async () => {
  const result = gate<NativeDevelopmentResources>(), original = gate<void>(); let context!: NativeLoaderContext;
  const loader = createObservedNativeDevelopmentLoader((_d, _s, c) => { context = c; return { result: result.promise, original: original.promise }; });
  const f = input(), value = loader(f.deadline, f.signal.signal), observation = loader.observe(value);
  result.reject(new Error("Early public failure")); await value.catch(() => {}); await turn();
  const start = vi.fn(() => Promise.resolve(owner)); expect(() => context.factory(start, () => ({ result: Promise.resolve(fulfilled), preparation: Promise.resolve(fulfilled) }))).toThrow("admission closed");
  expect(start).not.toHaveBeenCalled(); let bound = false; void observation.factory.then(() => { bound = true; }); await turn(); expect(bound).toBe(false);
  original.resolve(); expect(await observation.factory).toEqual({ state: "none" });
});
it.each([undefined, 0])("an observer throwing %s cannot erase an already started original factory result", async reason => {
  const actual = gate<NativeDevelopmentResources>(), result = gate<NativeDevelopmentResources>(), original = gate<void>();
  const loader = createObservedNativeDevelopmentLoader((_d, _s, context) => {
    try { context.factory(() => actual.promise, () => { throw reason; }); } catch { /* Trusted wrapper still owns its original IO. */ }
    return { result: result.promise, original: original.promise };
  });
  const f = input(), value = loader(f.deadline, f.signal.signal), observation = loader.observe(value);
  result.reject(new Error("Wrapper rejected")); await value.catch(() => {}); original.resolve(); const binding = await observation.factory;
  expect(binding.state).toBe("unknown"); if (binding.state !== "unknown") throw new Error("binding"); expect(binding.reason).toBe(reason); expect(binding.results).toHaveLength(1);
  const late = new Error("Factory result ended after observer failure"); actual.reject(late);
  expect(await binding.results[0]).toEqual({ status: "rejected", reason: late });
});
it("a synchronous start throw remains unknown rather than a no-work receipt", async () => {
  const reason = new Error("Original start handle unavailable");
  const loader = createObservedNativeDevelopmentLoader((_d, _s, context) => {
    context.factory(() => { throw reason; }, () => ({ result: Promise.resolve(fulfilled), preparation: Promise.resolve(fulfilled) }));
    throw new Error("unreachable");
  });
  const f = input(), value = loader(f.deadline, f.signal.signal), observation = loader.observe(value); await expect(value).rejects.toBe(reason);
  expect(await observation.wrapper).toEqual({ status: "unknown", reason }); expect(await observation.factory).toMatchObject({ state: "unknown", reason });
});
it("claims the factory slot before reentrant callbacks and never starts a second factory", async () => {
  const actual = gate<NativeDevelopmentResources>(), original = gate<void>(), second = vi.fn(() => Promise.resolve(owner));
  const loader = createObservedNativeDevelopmentLoader((_d, _s, context) => ({ result: context.factory(() => {
    expect(() => context.factory(second, () => ({ result: Promise.resolve(fulfilled), preparation: Promise.resolve(fulfilled) }))).toThrow("already claimed");
    return actual.promise;
  }, () => ({ result: Promise.resolve(fulfilled), preparation: Promise.resolve(fulfilled) })), original: original.promise }));
  const f = input(), value = loader(f.deadline, f.signal.signal), observation = loader.observe(value); actual.resolve(owner); original.resolve(); await value;
  expect(second).not.toHaveBeenCalled(); expect(await observation.factory).toMatchObject({ state: "unknown" });
});
it("a refused second loader call observes only its own no-start result and never replaces the first", async () => {
  const result = gate<NativeDevelopmentResources>(), original = gate<void>(), begin = vi.fn(() => ({ result: result.promise, original: original.promise }));
  const loader = createObservedNativeDevelopmentLoader(begin), f = input(), first = loader(f.deadline, f.signal.signal), refused = loader(f.deadline, f.signal.signal);
  const second = loader.observe(refused); await expect(refused).rejects.toThrow("already claimed");
  expect(await second.wrapper).toEqual({ status: "not-started" }); expect(await second.factory).toEqual({ state: "none" });
  let firstBound = false; void loader.observe(first).factory.then(() => { firstBound = true; }); await turn(); expect(firstBound).toBe(false);
  result.resolve(owner); original.resolve(); await first; expect(begin).toHaveBeenCalledOnce();
});
it.each(["abort", "deadline"] as const)("checks original %s before invoking a deferred factory callback", async mode => {
  const result = gate<NativeDevelopmentResources>(), original = gate<void>(); let context!: NativeLoaderContext;
  const loader = createObservedNativeDevelopmentLoader((_d, _s, c) => { context = c; return { result: result.promise, original: original.promise }; });
  const f = input(), value = loader(f.deadline, f.signal.signal), observation = loader.observe(value), start = vi.fn(() => Promise.resolve(owner));
  if (mode === "abort") f.signal.abort(); else vi.spyOn(performance, "now").mockReturnValue(f.deadline + 1);
  expect(() => context.factory(start, () => ({ result: Promise.resolve(fulfilled), preparation: Promise.resolve(fulfilled) }))).toThrow();
  expect(start).not.toHaveBeenCalled(); result.reject(new Error("Wrapper cancelled")); await value.catch(() => {}); original.resolve();
  expect(await observation.factory).toEqual({ state: "none" });
});
it("original wrapper rejection closes admission even if the public result later fulfills", async () => {
  const result = gate<NativeDevelopmentResources>(), original = gate<void>(); let context!: NativeLoaderContext;
  const loader = createObservedNativeDevelopmentLoader((_d, _s, c) => { context = c; return { result: result.promise, original: original.promise }; });
  const f = input(), value = loader(f.deadline, f.signal.signal), observation = loader.observe(value), reason = new Error("Original wrapper IO failed");
  original.reject(reason); expect(await observation.wrapper).toEqual({ status: "rejected", reason });
  const start = vi.fn(() => Promise.resolve(owner)); expect(() => context.factory(start, () => ({ result: Promise.resolve(fulfilled), preparation: Promise.resolve(fulfilled) }))).toThrow("admission closed");
  result.resolve(owner); await value; expect(await observation.result).toEqual(fulfilled); expect(start).not.toHaveBeenCalled();
});

it("an abort before the initializer is a known no-start, not another preparation attempt", async () => {
  const begin = vi.fn(() => ({ result: Promise.resolve(owner), original: Promise.resolve() }));
  const loader = createObservedNativeDevelopmentLoader(begin), f = input(); f.signal.abort();
  const value = loader(f.deadline, f.signal.signal), observed = loader.observe(value); await expect(value).rejects.toThrow();
  expect(begin).not.toHaveBeenCalled(); expect(await observed.wrapper).toEqual({ status: "not-started" });
  expect(await observed.factory).toEqual({ state: "none" });
});

it.each(["result", "preparation"] as const)("a raw %s observer rejection before binding is retained as unknown", async field => {
  const actual = gate<NativeDevelopmentResources>(), original = gate<void>();
  const raw = gate<NativeCallOutcome>(), reason = new Error("Original observation unavailable");
  const loader = createObservedNativeDevelopmentLoader((_d, _s, context) => ({
    result: context.factory(() => actual.promise, () => ({
      result: field === "result" ? raw.promise : Promise.resolve(fulfilled),
      preparation: field === "preparation" ? raw.promise : Promise.resolve(fulfilled),
    })), original: original.promise,
  }));
  const f = input(), value = loader(f.deadline, f.signal.signal), observed = loader.observe(value);
  raw.reject(reason); await turn(); // No consumer has received the binding yet.
  original.resolve(); const binding = await observed.factory;
  expect(binding.state).toBe("unknown"); if (binding.state !== "unknown") throw new Error("binding");
  expect(binding.reason).toBe(reason); expect(binding.results).toHaveLength(1);
  const late = new Error("Original factory rejection"); actual.reject(late); await expect(value).rejects.toBe(late);
  expect(await binding.results[0]).toEqual({ status: "rejected", reason: late });
});
it("a raw observer rejection after binding remains a rejection rather than a preparation receipt", async () => {
  const actual = gate<NativeDevelopmentResources>(), original = gate<void>(), raw = gate<NativeCallOutcome>();
  const loader = createObservedNativeDevelopmentLoader((_d, _s, context) => ({
    result: context.factory(() => actual.promise, () => ({ result: Promise.resolve(fulfilled), preparation: raw.promise })),
    original: original.promise,
  }));
  const f = input(), value = loader(f.deadline, f.signal.signal), observed = loader.observe(value);
  original.resolve(); const binding = await observed.factory;
  expect(binding.state).toBe("bound"); if (binding.state !== "bound") throw new Error("binding");
  expect(binding.observation.preparation).toBe(raw.promise);
  const reason = new Error("Late raw observation failure"); raw.reject(reason); await turn();
  await expect(binding.observation.preparation).rejects.toBe(reason);
  actual.resolve(owner); await value; expect(await binding.result).toEqual(fulfilled);
  expect(await observed.factory).toBe(binding); // A final binding is not rewritten by later status.
});

it("a missing mandatory deadline cannot start initializer IO or the factory", async () => {
  const start = vi.fn(() => Promise.resolve(owner));
  const begin = vi.fn((_d: number, _s: AbortSignal, context: NativeLoaderContext) => ({
    result: context.factory(start, () => ({ result: Promise.resolve(fulfilled), preparation: Promise.resolve(fulfilled) })),
    original: Promise.resolve(),
  }));
  const loader = createObservedNativeDevelopmentLoader(begin), f = input();
  const value = loader(undefined as unknown as number, f.signal.signal), observation = loader.observe(value);
  await expect(value).rejects.toThrow("deadline expired or invalid");
  expect(await observation.wrapper).toEqual({ status: "not-started" });
  expect(await observation.factory).toEqual({ state: "none" });
  expect(begin).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});
