import { expect, it, vi } from "vitest";
import { NativeDevelopmentLoadCall } from "./native-development-load-call.js";
import type { NativeDevelopmentResources } from "./native-development-host.js";
import type { NativeCallOutcome } from "./native-launch-call-record.js";
import type { NativeLoaderFactoryBinding, NativeLoaderWorkOutcome } from "./native-development-resource-loader.js";
const gate = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const owner = Object.freeze({ controlFile: "synthetic-opaque-owner" }) as NativeDevelopmentResources;
const fulfilled = Object.freeze({ status: "fulfilled" as const });
const turn = async () => { for (let i = 0; i < 16; ++i) await Promise.resolve(); };
function fixture() {
  const original = gate<NativeDevelopmentResources>(), wrapper = gate<NativeLoaderWorkOutcome>(), factory = gate<NativeLoaderFactoryBinding>();
  const result = original.promise.then(() => fulfilled, reason => Object.freeze({ status: "rejected" as const, reason }));
  const observation = Object.freeze({ result, wrapper: wrapper.promise, factory: factory.promise });
  const loader = { observe: vi.fn((key: Promise<unknown>) => { expect(key).toBe(original.promise); return observation; }) };
  const call = new NativeDevelopmentLoadCall(original.promise);
  return { original, wrapper, factory, result, observation, loader, call };
}
function bound(preparation: Promise<NativeCallOutcome>, result: Promise<NativeCallOutcome> = Promise.resolve(fulfilled)): NativeLoaderFactoryBinding {
  return Object.freeze({ state: "bound", result, observation: Object.freeze({ result, preparation }) });
}
it("retains the exact original and requires wrapper plus actual preparation before accepting an owner", async () => {
  const f = fixture(), prep = gate<NativeCallOutcome>(); f.call.bind(f.loader);
  expect(f.call.original).toBe(f.original.promise); expect(() => f.call.bind(f.loader)).toThrow("already bound");
  f.original.resolve(owner); expect(await f.call.result).toBe(owner); f.wrapper.resolve(fulfilled); f.factory.resolve(bound(prep.promise));
  await turn(); expect(f.call.settled).toBe(false); expect(f.loader.observe).toHaveBeenCalledOnce();
  prep.resolve(fulfilled); await f.call.observed; expect(f.call.settled).toBe(true); expect(f.call.failed).toBe(false);
});
it("a public rejection retains late wrapper and preparation but never becomes successful", async () => {
  const f = fixture(), prep = gate<NativeCallOutcome>(), reason = new Error("Public loader timeout"); f.call.bind(f.loader);
  f.original.reject(reason); await expect(f.call.result).rejects.toBe(reason); expect(f.call.settled).toBe(false);
  f.wrapper.resolve(fulfilled); f.factory.resolve(bound(prep.promise)); await turn(); expect(f.call.settled).toBe(false);
  prep.resolve(fulfilled); await f.call.observed;
  expect(f.call.settled).toBe(true); expect(f.call.failed).toBe(true); expect(f.call.originalOutcome).toEqual({ status: "rejected", reason });
});
it.each([undefined, 0])("lookup throwing %s keeps the original work and permanent unknown status", async reason => {
  const f = fixture(); f.call.bind({ observe: () => { throw reason; } });
  let ended = false; void f.call.observed.then(() => { ended = true; }); await turn(); expect(ended).toBe(false);
  const error = new Error("Late original failure"); f.original.reject(error); await expect(f.call.result).rejects.toBe(error); await f.call.observed;
  expect(f.call.observationError).toBe(reason); expect(f.call.settled).toBe(false); expect(f.call.failed).toBe(true);
  expect(f.call.originalOutcome).toEqual({ status: "rejected", reason: error });
});
it("a raw preparation observation rejection remains unknown even when the owner returned", async () => {
  const f = fixture(), prep = gate<NativeCallOutcome>(), reason = new Error("Preparation observer unavailable"); f.call.bind(f.loader);
  f.original.resolve(owner); f.wrapper.resolve(fulfilled); f.factory.resolve(bound(prep.promise)); await turn(); prep.reject(reason); await f.call.observed;
  expect(f.call.observationError).toBe(reason); expect(f.call.settled).toBe(false); expect(f.call.failed).toBe(true);
});
it("unknown factory results remain retained but never prove actual preparation finished", async () => {
  const f = fixture(), actual = gate<NativeCallOutcome>(); f.call.bind(f.loader);
  f.original.reject(new Error("Wrapper failure")); await f.call.result.catch(() => {}); f.wrapper.resolve(fulfilled);
  f.factory.resolve({ state: "unknown", reason: 0, results: [actual.promise] });
  let ended = false; void f.call.observed.then(() => { ended = true; }); await turn(); expect(ended).toBe(false);
  const error = new Error("Original factory failed later"); actual.resolve({ status: "rejected", reason: error }); await f.call.observed;
  expect(f.call.observationError).toBe(0); expect(f.call.settled).toBe(false); expect(f.call.failed).toBe(true);
  expect(f.call.originalOutcomes.at(-1)).toEqual({ status: "fulfilled", value: { status: "rejected", reason: error } });
});
it.each(["fulfilled", "not-started"] as const)("a successful public owner cannot use none with wrapper %s", async status => {
  const f = fixture(); f.call.bind(f.loader); f.original.resolve(owner); f.wrapper.resolve({ status }); f.factory.resolve({ state: "none" }); await f.call.observed;
  expect(f.call.settled).toBe(false); expect(f.call.failed).toBe(true);
});
it("a known no-start rejection is completed work but never a successful owner", async () => {
  const f = fixture(), reason = new Error("Rejected before initializer"); f.call.bind(f.loader);
  f.original.reject(reason); await f.call.result.catch(() => {}); f.wrapper.resolve({ status: "not-started" }); f.factory.resolve({ state: "none" }); await f.call.observed;
  expect(f.call.settled).toBe(true); expect(f.call.failed).toBe(true); expect(f.call.originalOutcome).toEqual({ status: "rejected", reason });
});
it("a returned owner with a rejected preparation receipt is contradictory and cannot authorize work", async () => {
  const f = fixture(), reason = new Error("Original preparation rejected"); f.call.bind(f.loader);
  f.original.resolve(owner); f.wrapper.resolve(fulfilled); f.factory.resolve(bound(Promise.resolve({ status: "rejected", reason }))); await f.call.observed;
  expect(f.call.settled).toBe(false); expect(f.call.failed).toBe(true);
});
it("an observer cannot replace an original rejection with a fulfilled result receipt", async () => {
  const f = fixture(); f.call.bind({ observe: key => ({ ...f.loader.observe(key), result: Promise.resolve(fulfilled) }) });
  f.original.reject(new Error("Original rejection")); await f.call.result.catch(() => {}); f.wrapper.resolve({ status: "not-started" }); f.factory.resolve({ state: "none" }); await f.call.observed;
  expect(f.call.settled).toBe(false); expect(f.call.failed).toBe(true);
});

it("an unknown wrapper still waits for a known factory result and retains its late raw rejection", async () => {
  const f = fixture(), actual = gate<NativeCallOutcome>(), reason = new Error("Initializer threw after factory start"); f.call.bind(f.loader);
  f.original.reject(reason); await f.call.result.catch(() => {});
  f.wrapper.resolve({ status: "unknown", reason }); f.factory.resolve({ state: "unknown", reason, results: [actual.promise] });
  let ended = false; void f.call.observed.then(() => { ended = true; }); await turn(); expect(ended).toBe(false);
  const late = new Error("Known original factory handle rejected later"); actual.reject(late); await f.call.observed;
  expect(f.call.settled).toBe(false); expect(f.call.failed).toBe(true); expect(f.call.observationError).toBe(reason);
  expect(f.call.originalOutcomes.at(-1)).toEqual({ status: "rejected", reason: late });
});
it("a contradictory public receipt cannot discard a bound pending preparation", async () => {
  const f = fixture(), prep = gate<NativeCallOutcome>(), reason = new Error("Wrong reported result");
  f.call.bind({ observe: key => ({ ...f.loader.observe(key), result: Promise.resolve({ status: "rejected", reason }) }) });
  f.original.resolve(owner); f.wrapper.resolve(fulfilled); f.factory.resolve(bound(prep.promise));
  let ended = false; void f.call.observed.then(() => { ended = true; }); await turn(); expect(ended).toBe(false);
  expect(f.call.settled).toBe(false); prep.resolve(fulfilled); await f.call.observed;
  expect(f.call.settled).toBe(false); expect(f.call.failed).toBe(true);
  expect(f.call.originalOutcomes.at(-1)).toEqual({ status: "fulfilled", value: fulfilled });
});
