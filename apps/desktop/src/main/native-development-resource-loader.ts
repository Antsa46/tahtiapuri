import { NativeOperationDeadlineError, requireNativeOperationDeadline } from "./native-operation-deadline.js";
import type { NativeCallOutcome } from "./native-launch-call-record.js";
import type { NativeDevelopmentResources } from "./native-development-host.js";
import type { NativeLaunchMcpPreparationObservation } from "./native-launch-mcp-resources.js";

export type NativeLoaderWorkOutcome = NativeCallOutcome | Readonly<{ status: "not-started" }>
  | Readonly<{ status: "unknown"; reason: unknown }>;
export type NativeLoaderFactoryBinding = Readonly<{ state: "none" }>
  | Readonly<{ state: "bound"; result: Promise<NativeCallOutcome>; observation: NativeLaunchMcpPreparationObservation }>
  | Readonly<{ state: "unknown"; results: readonly Promise<NativeCallOutcome>[]; reason: unknown }>;
/** Status-only. Binding is final only after the ORIGINAL wrapper cannot start
 * another factory. No owner, dispatch, new deadline, cancellation or reset. */
export interface NativeDevelopmentLoadObservation {
  readonly result: Promise<NativeCallOutcome>;
  readonly wrapper: Promise<NativeLoaderWorkOutcome>;
  readonly factory: Promise<NativeLoaderFactoryBinding>;
}
export interface ObservedNativeDevelopmentResourceLoader {
  (deadline: number, signal: AbortSignal): Promise<NativeDevelopmentResources>;
  readonly observe: (original: Promise<unknown>) => NativeDevelopmentLoadObservation;
}
/** Trusted initializer seam; never an IPC input. The gate checks admission
 * BEFORE invoking the fixed, already approved factory closure. */
export interface NativeLoaderContext {
  factory<T extends NativeDevelopmentResources>(start: () => Promise<T>,
    observe: (original: Promise<unknown>) => NativeLaunchMcpPreparationObservation): Promise<T>;
}
export interface NativeLoaderWork {
  readonly result: Promise<NativeDevelopmentResources>;
  /** Full original binding-file/import work, not its bounded public facade. */
  readonly original: Promise<unknown>;
}
type Begin = (deadline: number, signal: AbortSignal, context: NativeLoaderContext) => NativeLoaderWork;
type Factory = { original: Promise<unknown>; result: Promise<NativeCallOutcome>; observation?: NativeLaunchMcpPreparationObservation };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
};
const status = (original: Promise<unknown>): Promise<NativeCallOutcome> => original.then(
  () => Object.freeze({ status: "fulfilled" as const }),
  reason => Object.freeze({ status: "rejected" as const, reason }));
const isPromise = (value: unknown): value is Promise<unknown> => value instanceof Promise;
const requireOpeningDeadline = (deadline: number): void => {
  // This new loader requires a deadline; the legacy helper also accepts none.
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) throw new NativeOperationDeadlineError();
  requireNativeOperationDeadline(deadline);
};

/** One wrapper lifetime, one factory admission. Do not replace this loader to
 * retry a failed Main lifetime. The production factory's singleton remains
 * the independent final fence. The initializer MUST use context.factory for
 * every factory call and include all wrapper IO in original. This helper has
 * no timers or actor imports. */
export function createObservedNativeDevelopmentLoader(begin: Begin): ObservedNativeDevelopmentResourceLoader {
  const observations = new WeakMap<Promise<unknown>, NativeDevelopmentLoadObservation>();
  // Retain every original and unknown-start record through this Main lifetime.
  const records: { factories: Factory[]; original?: Promise<unknown>; result?: Promise<unknown>; unknown: boolean; reason?: unknown }[] = [];
  let claimed = false;
  const load = (deadline: number, signal: AbortSignal): Promise<NativeDevelopmentResources> => {
    if (claimed) {
      const refused = Promise.reject<NativeDevelopmentResources>(new Error("Native loader lifetime already claimed"));
      observations.set(refused, Object.freeze({ result: status(refused),
        wrapper: Promise.resolve(Object.freeze({ status: "not-started" as const })),
        factory: Promise.resolve(Object.freeze({ state: "none" as const })) }));
      return refused;
    }
    claimed = true; // Before initializer callbacks or any original IO.
    const record: typeof records[number] = { factories: [], unknown: false }; records.push(record);
    const wrapper = deferred<NativeLoaderWorkOutcome>(), binding = deferred<NativeLoaderFactoryBinding>();
    let closed = false, factoryClaimed = false, wrapperRecorded = false, beginCalled = false;
    const unknown = (reason: unknown) => { if (!record.unknown) { record.unknown = true; record.reason = reason; } };
    const finishBinding = () => {
      closed = true;
      if (record.unknown) binding.resolve(Object.freeze({ state: "unknown", reason: record.reason,
        results: Object.freeze(record.factories.map(item => item.result)) }));
      else if (!record.factories.length) binding.resolve(Object.freeze({ state: "none" }));
      else {
        const item = record.factories[0]!;
        if (!item.observation) binding.resolve(Object.freeze({ state: "unknown", reason: new Error("Factory observation missing"),
          results: Object.freeze([item.result]) }));
        else binding.resolve(Object.freeze({ state: "bound", result: item.result, observation: item.observation }));
      }
    };
    const context: NativeLoaderContext = Object.freeze({ factory<T extends NativeDevelopmentResources>(start: () => Promise<T>,
      observe: (original: Promise<unknown>) => NativeLaunchMcpPreparationObservation): Promise<T> {
      if (closed) throw new Error("Native loader factory admission closed");
      if (factoryClaimed) { const error = new Error("Native loader factory already claimed"); unknown(error); throw error; }
      signal.throwIfAborted(); requireOpeningDeadline(deadline);
      factoryClaimed = true; // Before a reentrant or throwing start callback.
      let original: Promise<T>;
      try { original = start(); } catch (error) { unknown(error); throw error; }
      if (!isPromise(original)) { const error = new Error("Invalid original native factory promise"); unknown(error); throw error; }
      const item: Factory = { original, result: status(original) }; record.factories.push(item); // BEFORE observer callbacks.
      try {
        const value = observe(original);
        const result = value.result;
        if (!isPromise(result)) throw new Error("Invalid original factory result observation");
        // Observe rejection immediately, even while the wrapper still owns the
        // binding latch. Keep the raw Promise: observer failure is UNKNOWN,
        // never a receipt that the actual preparation has finished.
        void result.catch(unknown);
        const preparation = value.preparation;
        if (!isPromise(preparation)) throw new Error("Invalid original factory preparation observation");
        void preparation.catch(unknown);
        item.observation = Object.freeze({ result, preparation });
      } catch (error) { unknown(error); throw error; }
      return original; // Exact factory key, never an async proxy.
    } });
    let result: Promise<NativeDevelopmentResources>;
    try {
      signal.throwIfAborted(); requireOpeningDeadline(deadline);
      beginCalled = true;
      const work = begin(deadline, signal, context);
      const original = work.original;
      if (!isPromise(original)) throw new Error("Invalid original loader work");
      record.original = original; wrapperRecorded = true;
      void status(original).then(outcome => { wrapper.resolve(outcome); finishBinding(); });
      result = work.result;
      if (!isPromise(result)) throw new Error("Invalid public loader result");
      record.result = result;
    } catch (error) {
      closed = true; // Synchronous failure fences deferred callbacks immediately.
      if (beginCalled) unknown(error);
      result = Promise.reject(error);
      if (!wrapperRecorded) {
        wrapper.resolve(beginCalled ? Object.freeze({ status: "unknown", reason: error }) : Object.freeze({ status: "not-started" }));
        finishBinding();
      }
    }
    const resultStatus = status(result);
    // Close future factory admission at either public completion; ORIGINAL IO
    // still determines when the binding latch and wrapper observation finish.
    void resultStatus.then(() => { closed = true; });
    observations.set(result, Object.freeze({ result: resultStatus, wrapper: wrapper.promise, factory: binding.promise }));
    return result; // Host records this exact Promise before observe().
  };
  const observe = (original: Promise<unknown>): NativeDevelopmentLoadObservation => {
    const observation = observations.get(original);
    if (!observation) throw new Error("Unknown original native loader promise");
    return observation;
  };
  return Object.freeze(Object.assign(load, { observe }));
}
