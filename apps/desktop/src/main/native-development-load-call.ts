import type { NativeCallOutcome } from "./native-launch-call-record.js";
import type { NativeDevelopmentResources } from "./native-development-host.js";
import type { NativeDevelopmentLoadObservation, ObservedNativeDevelopmentResourceLoader } from "./native-development-resource-loader.js";

/** Host retains this record BEFORE observe() can throw. Original completion is
 * distinct from success; unavailable observations never prove work finished.
 * There is no dispatch, timer, cancellation, replacement owner or reset. */
export class NativeDevelopmentLoadCall {
  readonly original: Promise<NativeDevelopmentResources>;
  readonly result: Promise<NativeDevelopmentResources>;
  readonly observed: Promise<void>;
  originalOutcome: NativeCallOutcome | undefined;
  observation: NativeDevelopmentLoadObservation | undefined;
  observationError: unknown;
  originalOutcomes: readonly PromiseSettledResult<unknown>[] = Object.freeze([]);
  private readonly originalStatus: Promise<NativeCallOutcome>;
  private bindingStarted = false;
  private observationUnknown = false;
  private observationFinished = false;
  private reportedFailure = false;
  private resolveObserved!: () => void;
  private collection: Promise<void> | undefined;

  constructor(original: Promise<NativeDevelopmentResources>) {
    this.original = original;
    this.result = original.then(value => {
      this.originalOutcome = Object.freeze({ status: "fulfilled" }); return value;
    }, reason => {
      this.originalOutcome = Object.freeze({ status: "rejected", reason }); throw reason;
    });
    // Both handlers are installed before an observer can reenter or throw.
    this.originalStatus = this.result.then(() => this.originalOutcome!, () => this.originalOutcome!);
    this.observed = new Promise(resolve => { this.resolveObserved = resolve; });
  }
  bind(loader: Pick<ObservedNativeDevelopmentResourceLoader, "observe">): void {
    if (this.bindingStarted) throw new Error("Native Host loader already bound");
    this.bindingStarted = true;
    try {
      const value = loader.observe(this.original);
      this.observation = Object.freeze({ result: this.retain(value.result), wrapper: this.retain(value.wrapper), factory: this.retain(value.factory) });
      this.collection = this.collect(this.observation);
      void this.collection.then(() => this.resolveObserved(), error => {
        this.unknown(error); void this.originalStatus.then(() => this.resolveObserved());
      });
    } catch (error) {
      this.unknown(error);
      // Even a failed lookup cannot discard the known original public work.
      void this.originalStatus.then(() => this.resolveObserved());
    }
  }
  get observationAvailable(): boolean { return !!this.observation && !this.observationUnknown; }
  get settled(): boolean { return !!this.originalOutcome && this.observationFinished && !this.observationUnknown; }
  get failed(): boolean { return this.originalOutcome?.status === "rejected" || this.observationUnknown || this.reportedFailure; }
  private unknown(error: unknown): void { if (!this.observationUnknown) this.observationError = error; this.observationUnknown = true; }
  private retain<T>(value: Promise<T>): Promise<T> {
    if (!(value instanceof Promise)) throw new Error("Invalid original loader observation promise");
    void value.catch(error => this.unknown(error)); return value;
  }
  private report(value: unknown, allowNotStarted = false): string {
    if (!value || typeof value !== "object" || !("status" in value)
      || value.status !== "fulfilled" && value.status !== "rejected" && !(allowNotStarted && value.status === "not-started"))
      throw new Error("Unknown original loader work status");
    if (value.status === "rejected") this.reportedFailure = true;
    return value.status as string;
  }
  private async collect(observation: NativeDevelopmentLoadObservation): Promise<void> {
    const first = await Promise.allSettled([this.originalStatus, observation.result, observation.wrapper, observation.factory] as const);
    this.originalOutcomes = Object.freeze([...first]);
    const [own, publicResult, wrapper, factory] = first;
    let late: PromiseSettledResult<unknown>[] = [];
    const binding = factory.status === "fulfilled" ? factory.value : undefined;
    // Collect every available ORIGINAL before checking consistency. A bad
    // wrapper/public receipt cannot discard a known pending factory handle.
    const work: Promise<unknown>[] = [];
    try {
      const take = (get: () => Promise<unknown>) => {
        try { work.push(this.retain(get())); } catch (error) { this.unknown(error); }
      };
      if (binding?.state === "unknown") {
        this.unknown(binding.reason);
        for (const original of binding.results) take(() => original);
      } else if (binding?.state === "bound") {
        take(() => binding.result);
        take(() => binding.observation.result);
        take(() => binding.observation.preparation);
      } else if (binding?.state !== "none") this.unknown(new Error("Missing original factory binding"));
    } catch (error) { this.unknown(error); }
    // Registration failure must still wait for every handle already captured.
    late = await Promise.allSettled(work);
    this.originalOutcomes = Object.freeze([...first, ...late]);
    try {
      if (first.some(item => item.status === "rejected") || own.status !== "fulfilled" || publicResult.status !== "fulfilled"
        || wrapper.status !== "fulfilled" || factory.status !== "fulfilled") throw new Error("Original loader observation unavailable");
      if (wrapper.value.status === "unknown") this.unknown(wrapper.value.reason);
      const ownStatus = this.report(own.value), reportedStatus = this.report(publicResult.value), wrapperStatus = this.report(wrapper.value, true);
      if (ownStatus !== reportedStatus) throw new Error("Original loader result observation differs");
      if (binding?.state === "unknown") return; // Result receipts alone never prove preparation completion.
      if (binding?.state === "none") {
        if (ownStatus === "fulfilled") throw new Error("Successful native loader has no factory binding");
      } else if (binding?.state === "bound") {
        if (wrapperStatus === "not-started") throw new Error("Started factory has no original wrapper work");
        if (late.length !== 3 || late.some(item => item.status === "rejected")) throw new Error("Factory preparation observation unavailable");
        const statuses = late.map(item => this.report(item.status === "fulfilled" ? item.value : undefined, true));
        if (statuses[0] === "not-started" || statuses[1] === "not-started" || statuses[0] !== statuses[1]
          || statuses[0] === "fulfilled" && statuses[2] !== "fulfilled"
          || ownStatus === "fulfilled" && (wrapperStatus !== "fulfilled" || statuses.some(value => value !== "fulfilled")))
          throw new Error("Inconsistent original native preparation observations");
      } else throw new Error("Missing original factory binding");
      this.observationFinished = true;
    } catch (error) { this.unknown(error); }
  }
}
