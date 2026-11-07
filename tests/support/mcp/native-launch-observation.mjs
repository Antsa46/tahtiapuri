/** Test-only observation of original Main task promises. No actor factory,
 * retry, reset or termination API. Late diagnostics never replace the primary. */
export class NativeLaunchObservation {
  constructor(task, io) {
    this.task = task; this.io = io; this.sealed = false; this.lateNeeded = false;
    this.lateOriginal = null; this.lateFinished = null;
    this.lateState = { status: "not-needed", originalWriteSettled: false };
    this.state = { label: io.label, resultSettled: false, settlementObserved: false, settlement: null, error: null };
    this.result = task.result.then(value => {
      this.state.resultSettled = true; this.state.authorityCommitted = value.authorityCommitted;
      this.state.stdoutBytes = value.stdout.length; io.event("task-result"); return value;
    }, error => {
      this.state.resultSettled = true;
      this.state.error = { name: error?.name ?? "Error", exitVerified: error?.exitVerified ?? null,
        authorityCommitted: error?.authorityCommitted ?? null };
      io.fail(io.label + ":task-result"); throw error;
    });
    this.settled = task.settled.then(value => {
      this.state.settlementObserved = true; this.state.settlement = Object.freeze({ ...value }); io.event("task-settled");
      if (this.lateNeeded) this.writeLateOnce();
      return value;
    }, error => { io.fail(io.label + ":settlement-rejected"); throw error; });
    void this.result.catch(() => {}); void this.settled.catch(() => {});
  }
  snapshot() { return structuredClone(this.state); }
  sealPrimary() {
    if (this.sealed) throw new Error("Primary launch observation already sealed");
    this.sealed = true; this.lateNeeded = !this.state.settlementObserved;
    return this.snapshot();
  }
  writeLateOnce() {
    if (!this.lateNeeded || this.lateOriginal) return;
    const deadline = this.io.now() + 1000;
    this.lateState.status = "pending";
    const receipt = { schema: 1, kind: "late-settlement-observation", originalReceiptUnchanged: true,
      upgradesOriginalResult: false, firstFailure: this.io.firstFailure(), task: this.snapshot() };
    this.lateOriginal = Promise.resolve().then(() => {
      // Queue delay does not authorize a new write after its original cap.
      if (this.io.now() >= deadline) {
        this.lateState.status = "timeout"; this.io.fail("late-diagnostic-timeout"); return;
      }
      return this.io.write(receipt);
    });
    // Keep the original write observed even after this separate diagnostic cap.
    const observed = this.lateOriginal.then(() => {
      this.lateState.originalWriteSettled = true;
      if (this.lateState.status === "pending") {
        if (this.io.now() >= deadline) { this.lateState.status = "timeout"; this.io.fail("late-diagnostic-timeout"); }
        else this.lateState.status = "written";
      }
    }, () => {
      this.lateState.originalWriteSettled = true;
      if (this.lateState.status === "pending") this.lateState.status = "write-error";
      this.io.fail("late-diagnostic-write-error");
    });
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        if (this.lateState.status === "pending") { this.lateState.status = "timeout"; this.io.fail("late-diagnostic-timeout"); }
        resolve();
      }, Math.max(0, deadline - this.io.now()));
    });
    this.lateFinished = Promise.race([observed, timeout]).finally(() => clearTimeout(timer));
    void this.lateFinished.catch(() => {});
  }
}
