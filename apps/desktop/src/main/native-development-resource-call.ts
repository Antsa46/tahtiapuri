import type { NativeCallOutcome } from "./native-launch-call-record.js";
import type { NativeLaunchResourceObservation, NativeLaunchResourceOwner } from "./native-launch-resource-owner.js";
import type { NativeLaunchSettlement } from "./native-launch-supervisor.js";

/** Host-owned observation of ONE exact resource call. No dispatch, timeout,
 * cancellation, replacement owner or current-status lookup lives here. */
export class NativeDevelopmentResourceCall<T> {
  readonly result: Promise<T>;
  readonly observed: Promise<void>;
  readonly original: Promise<T>;
  observation: NativeLaunchResourceObservation | undefined;
  originalOutcome: NativeCallOutcome | undefined;
  observationError: unknown;
  private observationFinished = false;
  private observationUnknown = false;
  private nativeExitKnown = false;
  private originalExitUnknown = false;
  private bindingStarted = false;
  private resolveObserved!: () => void;
  private collection: Promise<void> | undefined;
  originalOutcomes: readonly PromiseSettledResult<unknown>[] | undefined;

  constructor(original: Promise<T>) {
    this.original = original;
    // Install both original-result handlers BEFORE a lookup can throw.
    this.result = original.then(value => {
      this.originalOutcome = Object.freeze({ status: "fulfilled" }); return value;
    }, reason => {
      this.originalOutcome = Object.freeze({ status: "rejected", reason });
      this.originalExitUnknown = !!reason && typeof reason === "object" && "exitVerified" in reason && reason.exitVerified === false;
      throw reason;
    });
    void this.result.catch(() => {});
    this.observed = new Promise(resolve => { this.resolveObserved = resolve; });
  }
  /** Host adds this record to its lifetime BEFORE invoking this callback. */
  bind(owner: Pick<NativeLaunchResourceOwner, "observeCall">): void {
    if (this.bindingStarted) throw new Error("Native Host call already bound");
    this.bindingStarted = true;
    try {
      this.observation = owner.observeCall(this.original);
      this.collection = this.collect(this.observation);
      void this.collection.then(() => this.resolveObserved(), error => { this.unknown(error); this.resolveObserved(); });
    } catch (error) { this.unknown(error); this.resolveObserved(); }
  }
  get observationAvailable(): boolean { return this.bindingStarted && !!this.observation && !this.observationUnknown; }
  get settled(): boolean { return !!this.originalOutcome && this.observationFinished && !this.observationUnknown; }
  get exitVerified(): boolean { return this.settled && this.nativeExitKnown && !this.originalExitUnknown; }
  get failed(): boolean { return this.originalOutcome?.status === "rejected" || this.observationUnknown
    || this.observationFinished && !this.nativeExitKnown
    || !!this.originalOutcomes?.some(item => item.status === "rejected"
      || item.status === "fulfilled" && !!item.value && typeof item.value === "object"
        && "status" in item.value && item.value.status === "rejected"); }
  private unknown(error: unknown) {
    this.observationError = error; this.observationUnknown = true; this.observationFinished = true; this.nativeExitKnown = false;
  }
  private async collect(observation: NativeLaunchResourceObservation): Promise<void> {
    const binding = await observation.binding;
    const work: Promise<unknown>[] = [observation.outcome];
    let nativeSettlement: Promise<NativeLaunchSettlement> | undefined, noTaskProof = false;
    if (binding.kind === "stage") {
      if (binding.staging) work.push(binding.staging);
      // This operation starts no process; its FILE IO still has to settle.
      this.nativeExitKnown = true;
    } else {
      if (binding.verification) work.push(binding.verification);
      if (binding.operation) work.push(binding.operation);
      if (binding.native.state === "bound") {
        work.push(binding.native.observation.outcome);
        const native = await binding.native.observation.binding;
        if (native.kind === "task") { work.push(native.result, native.settled); nativeSettlement = native.settled; }
        else noTaskProof = true;
      } else if (binding.native.state === "unavailable") {
        this.observationUnknown = true; this.observationError = binding.native.reason;
      } else noTaskProof = !binding.operation;
    }
    // Retain rejections as observations. A fulfilled allSettled wrapper is not
    // an operation success, nor a replacement for a rejected raw settlement.
    const outcomes = await Promise.allSettled(work);
    this.originalOutcomes = Object.freeze(outcomes);
    if (noTaskProof) this.nativeExitKnown = this.originalOutcome?.status === "rejected"
      && !!this.originalOutcome.reason && typeof this.originalOutcome.reason === "object"
      && "exitVerified" in this.originalOutcome.reason && this.originalOutcome.reason.exitVerified === true;
    if (nativeSettlement) {
      const index = work.indexOf(nativeSettlement), outcome = outcomes[index];
      const settled = outcome?.status === "fulfilled" ? outcome.value as NativeLaunchSettlement : undefined;
      this.nativeExitKnown = !!settled && settled.childCloseObserved === true && settled.workerExited === true
        && settled.workerExitCode === 0 && settled.uncertain === false;
    }
    this.observationFinished = true;
  }
}
