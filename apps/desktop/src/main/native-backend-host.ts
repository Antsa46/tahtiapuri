import { EventEmitter } from "node:events";
import type { ChildPort } from "./backend-controller.js";
import {
  launchNativeBackend, loadNativeBackendRuntime, prepareNativeBackendResources, recoverNativeBackend,
  type NativeBackendResourceConfig, type NativeBackendRuntime, type PreparedNativeBackendResources,
} from "./native-backend-resources.js";

export interface NativeBackendSession extends ChildPort {
  readonly closure: Promise<void>;
  closeChildInput(): Promise<void>;
  confirmCleanup(): Promise<void>;
}
export interface NativeBackendDependencies {
  load(signal: AbortSignal): Promise<NativeBackendRuntime>;
  recover(runtime: NativeBackendRuntime, signal: AbortSignal): Promise<unknown>;
  prepare(runtime: NativeBackendRuntime, signal: AbortSignal): Promise<PreparedNativeBackendResources>;
  launch(resources: PreparedNativeBackendResources, signal: AbortSignal): Promise<NativeBackendSession>;
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const unavailable = () => new Error("Native backend unavailable; cleanup may require recovery.");

/** A synchronous ChildPort with owned asynchronous preparation, never a fallback. */
export class NativeBackendChild extends EventEmitter implements ChildPort {
  readonly startupTimeoutMs = 40_000;
  readonly closure: Promise<void>;
  private readonly closed = deferred();
  private readonly abort = new AbortController();
  private readonly work: Promise<void>;
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private inner: NativeBackendSession | undefined;
  private stopped = false;
  private physicallyClosed = false;
  private prelaunchCleanupVerified = false;
  private failure: Error | undefined;

  constructor(private readonly dependencies: NativeBackendDependencies) {
    super();
    this.closure = this.closed.promise;
    // This original budget includes load, recovery, staging and native startup.
    this.startupTimer = setTimeout(() => {
      this.kill();
      const error = new Error("Native backend startup timed out.");
      if (!this.inner) this.closed.reject(error);
      this.fail(error);
    }, this.startupTimeoutMs);
    // Give BackendController the current synchronous turn to install listeners.
    this.work = Promise.resolve().then(() => this.start());
    void this.work.catch(error => this.fail(error));
  }
  get pid(): number | undefined { return this.inner?.pid; }

  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : unavailable();
    if (this.listenerCount("error")) this.emit("error", this.failure);
  }
  private clearTimers(): void { clearTimeout(this.startupTimer); clearTimeout(this.closeTimer); }
  private async start(): Promise<void> {
    let resources: PreparedNativeBackendResources | undefined;
    let launchAttempted = false, noNativeRisk = true;
    try {
      const signal = this.abort.signal;
      signal.throwIfAborted();
      const runtime = await this.dependencies.load(signal);
      signal.throwIfAborted();
      // A failed recovery or staging call cannot establish clean ownership.
      noNativeRisk = false;
      await this.dependencies.recover(runtime, signal);
      noNativeRisk = true; signal.throwIfAborted();
      noNativeRisk = false;
      resources = await this.dependencies.prepare(runtime, signal);
      signal.throwIfAborted();
      launchAttempted = true;
      const inner = await this.dependencies.launch(resources, signal);
      this.inner = inner;
      inner.on("error", error => { this.fail(error); this.kill(); });
      inner.on("message", message => { if (!this.stopped) this.emit("message", message); });
      inner.once("spawn", () => {
        clearTimeout(this.startupTimer);
        if (this.stopped || this.failure) { inner.kill(); return; }
        this.emit("spawn");
      });
      inner.once("exit", (code: number | null, signal: string | null) => this.emit("exit", code, signal));
      void inner.closure.then(() => {
        this.physicallyClosed = true; this.clearTimers(); this.closed.resolve();
      }, error => { this.clearTimers(); this.closed.reject(error instanceof Error ? error : unavailable()); this.fail(error); this.kill(); });
      // Cancellation may have arrived while the asynchronous launcher settled.
      if (this.stopped || signal.aborted || this.failure) inner.kill();
    } catch (error) {
      if (resources && !launchAttempted) {
        try { await resources.discardBeforeLaunch(); noNativeRisk = true; }
        catch { noNativeRisk = false; }
      }
      this.prelaunchCleanupVerified = noNativeRisk;
      this.physicallyClosed = noNativeRisk;
      this.clearTimers();
      if (noNativeRisk) this.closed.resolve(); else this.closed.reject(unavailable());
      this.fail(error);
    }
  }
  postMessage(message: unknown): void {
    if (!this.inner || this.stopped || this.failure || this.physicallyClosed) throw unavailable();
    this.inner.postMessage(message);
  }
  closeChildInput(): Promise<void> {
    return this.inner && !this.stopped ? this.inner.closeChildInput() : Promise.reject(unavailable());
  }
  kill(): boolean {
    if (this.physicallyClosed || this.stopped) return false;
    this.stopped = true; this.abort.abort();
    // One cancellation budget; repeated calls never extend it. An unresolved
    // preparation is unknown, not proof that no late process can have existed.
    this.closeTimer ??= setTimeout(() => this.closed.reject(unavailable()), 25_000);
    if (this.inner) return this.inner.kill();
    return true;
  }
  async confirmCleanup(): Promise<void> {
    await this.closure;
    await this.work;
    if (this.inner) { await this.inner.confirmCleanup(); return; }
    if (!this.prelaunchCleanupVerified) throw unavailable();
  }
}

export function createNativeBackendFactory(config: NativeBackendResourceConfig): () => ChildPort {
  const approved = { runtimeRoot: config.runtimeRoot, userDataRoot: config.userDataRoot };
  let used = false;
  return () => {
    if (used) throw new Error("Native backend factory already consumed.");
    used = true;
    return new NativeBackendChild({
      load: signal => loadNativeBackendRuntime(approved, signal),
      recover: (runtime, signal) => recoverNativeBackend(runtime, signal),
      prepare: (runtime, signal) => prepareNativeBackendResources(runtime, signal),
      launch: (resources, signal) => launchNativeBackend(resources, signal),
    });
  };
}
