import { NativeDevelopmentResourceCall } from "../../../apps/desktop/src/main/native-development-resource-call.js";
import type { NativeDevelopmentResources } from "../../../apps/desktop/src/main/native-development-host.js";
import type { NativeLaunchResourceBinding } from "../../../apps/desktop/src/main/native-launch-resource-owner.js";
import type { NativeLaunchTaskBinding } from "../../../apps/desktop/src/main/native-launch-operations.js";
import type { NativeLaunchSettlement } from "../../../apps/desktop/src/main/native-launch-supervisor.js";
type Owner = Pick<NativeDevelopmentResources, "status" | "observeCall">;
type Outcome = { status: "pending" } | { status: "fulfilled" } | { status: "rejected"; reason: unknown };
type Work = { kind: "loader" | "factory" | "io"; label: string; original: Promise<unknown>; outcome: Outcome };
type Call = { label: string; ledger: NativeDevelopmentResourceCall<unknown>; binding?: NativeLaunchResourceBinding;
  task?: Extract<NativeLaunchTaskBinding, { kind: "task" }>; physical?: NativeLaunchSettlement;
  ioSettled: boolean; observing?: Promise<void>; observationError?: unknown; unknown: boolean };
type Diagnostic = { label: string; original: Promise<void>; outcome: Outcome; settledAt?: number; deadline: number };
const errorInfo = (reason: unknown) => reason && typeof reason === "object" ? {
  name: "name" in reason ? reason.name : null, exitVerified: "exitVerified" in reason ? reason.exitVerified : null,
  authorityCommitted: "authorityCommitted" in reason ? reason.authorityCommitted : null,
} : { thrown: String(reason) };
const outcome = (value: Outcome) => value.status === "rejected" ? { status: value.status, reason: errorInfo(value.reason) } : { status: value.status };
export interface NativeHostObservationIO {
  /** Actual Main-child handles and original Main IO, not a current success flag. */
  mainPhysical(): boolean;
  mainEvidence?(): unknown;
  write(name: string, value: unknown): Promise<void>;
}
/** TEST ONLY. Owns original handles, never launches/retries/resets an actor.
 * The real-case runner must disable framework timeouts and own the whole tree.
 * A live interval keeps unknown work available to that outer owner. */
export class NativeHostObservation {
  private readonly work: Work[] = [];
  private readonly calls: Call[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly owners = new Set<Owner>();
  private readonly guard: NodeJS.Timeout;
  private admitting = true;
  private finished = false;
  private released = false;
  private unknownStart = false;
  private failure: string | null = null;
  constructor(private readonly io: NativeHostObservationIO) {
    this.guard = setInterval(() => this.releaseIfKnown(), 25); // BEFORE any launch.
  }
  markFailure(reason: string) { this.failure ??= reason; }
  workOriginal<T>(kind: Work["kind"], label: string, start: () => Promise<T>): Promise<T> {
    if (!this.admitting) { this.markFailure("work-after-admission-close"); throw new Error("Host test admission closed"); }
    let original: Promise<T>;
    try { original = start(); } catch (error) { this.unknownStart = true; this.markFailure(label + ":sync-start"); throw error; }
    const record: Work = { kind, label, original, outcome: { status: "pending" } }; this.work.push(record);
    void original.then(() => { record.outcome = { status: "fulfilled" }; }, reason => {
      record.outcome = { status: "rejected", reason }; this.markFailure(label + ":original-work-rejected");
    });
    return original;
  }
  owner(value: Owner) { this.owners.add(value); }
  invoke<T>(owner: Owner, label: string, start: () => Promise<T>): Promise<T> {
    if (!this.admitting) { this.markFailure("call-after-admission-close"); throw new Error("Host test admission closed"); }
    this.owners.add(owner);
    let original: Promise<T>;
    try { original = start(); } catch (error) { this.unknownStart = true; this.markFailure(label + ":sync-start"); throw error; }
    const ledger = new NativeDevelopmentResourceCall(original);
    const record: Call = { label, ledger: ledger as NativeDevelopmentResourceCall<unknown>, ioSettled: false, unknown: false };
    this.calls.push(record); // Lifetime visible BEFORE lookup can throw/re-enter.
    ledger.bind(owner);
    record.observing = this.observePhysical(record).catch(error => {
      record.unknown = true; record.observationError = error; this.markFailure(label + ":physical-observation");
    });
    return original; // Exact original WeakMap key; never an async wrapper.
  }
  private async observePhysical(record: Call): Promise<void> {
    const observation = record.ledger.observation;
    if (!observation || !record.ledger.observationAvailable) throw new Error("Missing original Host call observation");
    const binding = await observation.binding; record.binding = binding;
    const work: Promise<unknown>[] = [record.ledger.original, record.ledger.observed, observation.outcome];
    if (binding.staging) work.push(binding.staging);
    if (binding.verification) work.push(binding.verification);
    if (binding.operation) work.push(binding.operation);
    if (binding.kind === "native") {
      if (binding.native.state === "unavailable") throw binding.native.reason;
      if (binding.native.state === "bound") {
        work.push(binding.native.observation.outcome);
        const native = await binding.native.observation.binding;
        if (native.kind === "task") {
          record.task = native; work.push(native.result);
          const physical = native.settled.then(value => { record.physical = Object.freeze({ ...value }); }, error => { throw error; });
          void physical.catch(() => {}); work.push(physical);
        }
      }
    }
    // Rejected operation IO is physically settled, but never semantic success.
    await Promise.allSettled(work); record.ioSettled = true;
  }
  beginClosing() { this.admitting = false; }
  private callPhysical(record: Call): boolean {
    if (!record.ioSettled || record.unknown) return false;
    if (record.binding?.kind === "stage") return true; // Original file IO, no process invented.
    if (record.task) return record.physical?.childCloseObserved === true && record.physical.workerExited === true
      && typeof record.physical.workerExitCode === "number";
    const original = record.ledger.originalOutcome;
    return original?.status === "rejected" && !!original.reason && typeof original.reason === "object"
      && "exitVerified" in original.reason && original.reason.exitVerified === true;
  }
  physical(): boolean {
    if (this.unknownStart || this.work.some(record => record.outcome.status === "pending"
      || record.kind === "factory" && record.outcome.status !== "fulfilled") || this.calls.some(record => !this.callPhysical(record))
      || this.diagnostics.some(record => record.outcome.status === "pending")) return false;
    try { return this.io.mainPhysical() && [...this.owners].every(owner => !owner.status().pending); }
    catch { this.markFailure("status-observation-failed"); return false; }
  }
  healthy(): boolean {
    if (this.failure || !this.physical() || this.work.some(record => record.outcome.status !== "fulfilled")
      || this.calls.some(record => record.ledger.failed || !record.ledger.settled || !record.ledger.exitVerified)
      || this.diagnostics.some(record => record.outcome.status !== "fulfilled" || record.settledAt! >= record.deadline)) return false;
    try { return [...this.owners].every(owner => !owner.status().failed); }
    catch { this.markFailure("owner-health-observation-failed"); return false; }
  }
  snapshot() {
    return { admitting: this.admitting, released: this.released, failure: this.failure, unknownStart: this.unknownStart,
      physical: this.physical(), healthy: this.healthy(), main: this.io.mainEvidence?.() ?? null,
      work: this.work.map(record => ({ kind: record.kind, label: record.label, outcome: outcome(record.outcome) })),
      calls: this.calls.map(record => ({ label: record.label, originalOutcome: record.ledger.originalOutcome
        ? outcome(record.ledger.originalOutcome) : { status: "pending" }, ledgerSettled: record.ledger.settled,
        originalExitVerified: record.ledger.exitVerified, originalFailed: record.ledger.failed,
        bindingKind: record.binding?.kind ?? "unknown", ioSettled: record.ioSettled, taskBound: !!record.task,
        physical: record.physical ?? null, physicalKnown: this.callPhysical(record),
        observationError: record.unknown ? errorInfo(record.observationError) : null,
        rawOutcomes: record.ledger.originalOutcomes?.map(item => item.status === "fulfilled"
          ? { status: item.status } : { status: item.status, reason: errorInfo(item.reason) }) ?? null })),
      owners: [...this.owners].map(owner => { try { return owner.status(); } catch { return null; } }),
      diagnostics: this.diagnostics.map(record => ({ label: record.label, outcome: outcome(record.outcome),
        settledWithinOriginalBudget: record.settledAt !== undefined && record.settledAt < record.deadline })),
      scope: "Original resource/Worker handles and separately traced Main children; not an independent OS descendant inventory" };
  }
  private pause() { return new Promise<void>(resolve => setTimeout(resolve, 25)); }
  private async diagnostic(label: string, value: unknown): Promise<void> {
    const deadline = performance.now() + 3000;
    let original: Promise<void>;
    try { original = this.io.write(label, value); }
    catch { this.markFailure(label + ":diagnostic-sync-error"); return; }
    const record: Diagnostic = { label, original, deadline, outcome: { status: "pending" } }; this.diagnostics.push(record);
    void original.then(() => { record.settledAt = performance.now(); record.outcome = { status: "fulfilled" }; }, reason => {
      record.settledAt = performance.now(); record.outcome = { status: "rejected", reason }; this.markFailure(label + ":diagnostic-write-rejected");
    });
    while (record.outcome.status === "pending" && performance.now() < deadline) await this.pause();
    if (record.settledAt === undefined || record.settledAt >= deadline) this.markFailure(label + ":original-diagnostic-deadline");
    // Keep the ORIGINAL write observed even after its public observation cap.
    await original.then(() => {}, () => {});
  }
  async finish(primary: string, late: string, detail: Record<string, unknown>): Promise<boolean> {
    this.beginClosing();
    if (!this.physical()) this.markFailure("original-cleanup-observation-incomplete");
    const primaryValue = structuredClone({ ...detail, schema: 1, passed: this.healthy(), resources: this.snapshot(),
      upgradesOriginalResult: false, terminalSuccessRequires: "Passed named case and natural outer exit0; this receipt alone is insufficient" });
    await this.diagnostic(primary, primaryValue);
    const neededLate = !primaryValue.passed || !this.physical() || !!this.failure;
    while (!this.physical()) await this.pause(); // Live guard + framework timeout0 + outer tree owner.
    if (neededLate) await this.diagnostic(late, { schema: 1, passed: false, primaryUnchanged: true,
      upgradesOriginalResult: false, resources: this.snapshot() });
    this.finished = true; this.releaseIfKnown(); return primaryValue.passed && this.healthy();
  }
  private releaseIfKnown() {
    if (!this.finished || this.released || !this.physical()) return;
    this.released = true; clearInterval(this.guard);
  }
}
