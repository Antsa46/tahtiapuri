import { isObservingResult, type ObservingOperation, type ObservingResult } from "@tahtiapuri/validation/observing";
import { isSkyResult, isSkySelectionResult, type SkyResult, type SkySelectionResult } from "@tahtiapuri/validation/sky";
import { isDevelopmentResult, type DevelopmentResult } from "@tahtiapuri/validation/development";
import { isModelRun, isModelCancel } from "@tahtiapuri/validation/model-wire";
import { isEngineReply, isAssistantResult, type EngineReply, type ModelInput, type AssistantResult } from "@tahtiapuri/validation/assistant";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { isReady, isResponse, type Operation, type Response } from "@tahtiapuri/validation/backend";
import { isRuntimeStatus, type RuntimeStatus } from "@tahtiapuri/validation/public";

export interface ChildPort extends EventEmitter {
  readonly pid: number | undefined;
  /** Trusted adapter budget, including native preparation; at most forty seconds. */
  readonly startupTimeoutMs?: number;
  /** Actual process close, or a bounded rejection that leaves ownership unverified. */
  readonly closure?: Promise<void>;
  postMessage(message: unknown): void;
  kill(): boolean;
  closeChildInput?(): Promise<void>;
  confirmCleanup?(): Promise<void>;
}
type Pending = { operation: Operation; resolve(value: Response): void; reject(error: Error): void; timer: NodeJS.Timeout };
type OwnedModelRun = { active: boolean };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

export class BackendController {
  private readonly session = randomBytes(32).toString("hex");
  private child: ChildPort | undefined;
  private ready = false;
  private closing = false;
  private exited = false;
  private failed = false;
  private unexpectedExitNotified = false;
  private heartbeatPending = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private rejectStart: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly ownedModelRuns = new Map<string, OwnedModelRun>();
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly fork: () => ChildPort, private readonly onUnexpectedExit: () => void, private readonly model?: { run(id: string, input: ModelInput, progress: () => void): Promise<EngineReply>; cancel(id: string): void }) {}

  start(): Promise<void> {
    if (this.child || this.closing || this.failed) return Promise.reject(new Error("Backend already started or closed."));
    return new Promise((resolve, reject) => {
      this.rejectStart = reject;
      try {
        const child = this.fork();
        this.child = child;
        child.on("error", () => this.failOwnedProcess(new Error("Backend channel failed.")));
        // Observe a terminal rejection even if the caller has not started stopping yet.
        void child.closure?.catch(() => undefined);
        child.on("spawn", () => {
          if (this.closing || this.failed || this.exited) return;
          try { child.postMessage({ type: "initialize", protocol: 1, session: this.session }); }
          catch { this.failOwnedProcess(new Error("Backend channel closed during startup.")); }
        });
        child.on("message", (message: unknown) => {
          if (this.closing || this.failed || this.exited) {
            if (!isResponse(message, this.session) || message.operation !== "runtime.shutdown") return;
          }
          if (isModelCancel(message, this.session)) { this.cancelModelRun(message.id); return; }
          if (this.ready && !this.closing && !this.failed && !this.exited && isModelRun(message, this.session)) {
            this.runModel(child, message.id, message.input);
            return;
          }
          if (!this.ready && !this.closing && !this.failed && !this.exited && isReady(message, this.session)) {
            this.ready = true;
            clearTimeout(this.startTimer);
            this.rejectStart = undefined;
            this.heartbeat = setInterval(() => {
              if (this.heartbeatPending || this.closing) return;
              this.heartbeatPending = true;
              void this.request("runtime.ping").catch(() => {
                if (!this.closing) this.failOwnedProcess(new Error("Backend heartbeat failed."));
              }).finally(() => { this.heartbeatPending = false; });
            }, 2000);
            resolve();
          } else if (isResponse(message, this.session)) {
            const pending = this.pending.get(message.id);
            if (!pending || pending.operation !== message.operation) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            pending.resolve(message);
          }
        });
        child.once("exit", () => {
          this.exited = true;
          this.unavailable(new Error("Backend exited before ready."), !this.closing);
        });
        const budget = child.startupTimeoutMs ?? 5000;
        if (!Number.isSafeInteger(budget) || budget < 1 || budget > 40_000) throw new Error("Invalid backend startup budget.");
        this.startTimer = setTimeout(() => this.unavailable(new Error("Backend startup timed out."), false), budget);
      } catch (error) {
        this.unavailable(error instanceof Error ? error : new Error("Backend startup failed."), false);
      }
    });
  }

  private unavailable(error: Error, notify: boolean): void {
    this.failed = true;
    this.ready = false;
    clearTimeout(this.startTimer);
    clearInterval(this.heartbeat);
    this.rejectStart?.(error);
    this.rejectStart = undefined;
    this.rejectPending();
    this.cancelOwnedModelRuns();
    if (notify && !this.unexpectedExitNotified) {
      this.unexpectedExitNotified = true;
      this.onUnexpectedExit();
    }
  }

  private signalKill(): void {
    try { this.child?.kill(); } catch { /* Closure must still be independently confirmed. */ }
  }

  private failOwnedProcess(error: Error): void {
    this.unavailable(error, !this.closing);
    this.signalKill();
  }

  private cancelModelRun(id: string): void {
    const owned = this.ownedModelRuns.get(id);
    if (!owned?.active) return;
    owned.active = false;
    try { this.model?.cancel(id); } catch { /* Cancellation is only a command, never cleanup proof. */ }
  }

  private cancelOwnedModelRuns(): void {
    for (const id of this.ownedModelRuns.keys()) this.cancelModelRun(id);
    this.ownedModelRuns.clear();
  }

  private runModel(child: ChildPort, id: string, input: ModelInput): void {
    // Canceled but unsettled runs still consume capacity; cancel floods cannot grow it.
    if (this.ownedModelRuns.has(id) || this.ownedModelRuns.size >= 16) {
      this.failOwnedProcess(new Error("Backend model run limit or duplicate rejected."));
      return;
    }
    const owned: OwnedModelRun = { active: true };
    this.ownedModelRuns.set(id, owned);
    // A live cancellation revokes launch/progress, but settlement still acknowledges
    // this same pending token so the backend can release its application queue.
    const owns = () => this.ownedModelRuns.get(id) === owned && !this.closing && !this.failed && !this.exited && this.child === child;
    const unavailable: EngineReply = { text: "", error: "ENGINE_UNAVAILABLE", info: null };
    void Promise.resolve().then(() => {
      if (!owns()) return unavailable;
      if (!owned.active) return { text: "", error: "CANCELLED" as const, info: null };
      return this.model?.run(id, input, () => {
        if (!owns() || !owned.active) return;
        try { child.postMessage({ type: "model.progress", session: this.session, id }); }
        catch { this.failOwnedProcess(new Error("Backend model progress channel closed.")); }
      }) ?? unavailable;
    }).catch(() => ({ ...unavailable, error: "ENGINE_CRASHED" as const })).then(reply => {
      if (!owns() || !isEngineReply(reply)) return;
      try { child.postMessage({ type: "model.result", session: this.session, id, reply }); }
      catch { this.failOwnedProcess(new Error("Backend model result channel closed.")); }
    }).finally(() => {
      if (this.ownedModelRuns.get(id) === owned) this.ownedModelRuns.delete(id);
    });
  }

  private rejectPending() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Backend unavailable."));
    }
    this.pending.clear();
  }

  private request(operation: Operation, input?: unknown): Promise<Response> {
    const child = this.child;
    if (!child || !this.ready || this.exited || (this.closing && operation !== "runtime.shutdown"))
      return Promise.reject(new Error("Backend unavailable."));
    if ((operation === "runtime.status" || operation.startsWith("observing.") || operation.startsWith("sky.") || operation.startsWith("assistant.") || operation === "development.invoke" || operation === "development.status") && this.pending.size >= 14)
      return Promise.reject(new Error("Backend request limit reached."));
    if (this.pending.size >= 16) return Promise.reject(new Error("Backend request limit reached."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Backend request timed out."));
      }, 2500);
      this.pending.set(id, { operation, resolve, reject, timer });
      try {
        child.postMessage({
          type: "request", protocol: 1, session: this.session, id, operation,
          expiresAtUnixMs: Date.now() + 2500,
          ...(((operation.startsWith("observing.") && operation !== "observing.read") || operation.startsWith("sky.") || operation.startsWith("assistant.") || (operation.startsWith("development.") && operation !== "development.status")) ? { input } : {}),
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Backend channel closed."));
      }
    });
  }

  async getStatus(): Promise<RuntimeStatus> {
    const response = await this.request("runtime.status");
    if (!isRuntimeStatus(response.result)) throw new Error("Invalid backend status.");
    return response.result;
  }

  async assistant(operation: "assistant.submit" | "assistant.get" | "assistant.cancel", input: unknown): Promise<AssistantResult> {
    const response = await this.request(operation, input);
    return isAssistantResult(response.result) ? response.result : { ok: false, code: "ENGINE_UNAVAILABLE" };
  }

  async development(operation: "development.status" | "development.configure" | "development.attach" | "development.detach" | "development.invoke", input?: unknown): Promise<DevelopmentResult> {
    const response = await this.request(operation, input);
    if (!isDevelopmentResult(response.result)) throw new Error("Invalid development response.");
    return response.result;
  }

  async sky(operation: "sky.snapshot", input: unknown): Promise<SkyResult>;
  async sky(operation: "sky.select", input: unknown): Promise<SkySelectionResult>;
  async sky(operation: "sky.snapshot" | "sky.select", input: unknown): Promise<SkyResult | SkySelectionResult> {
    const response = await this.request(operation, input);
    if (operation === "sky.snapshot" ? isSkyResult(response.result) : isSkySelectionResult(response.result)) return response.result as SkyResult | SkySelectionResult;
    return { ok: false, code: "UNAVAILABLE" };
  }

  async observing(operation: ObservingOperation, input?: unknown): Promise<ObservingResult> {
    const response = await this.request(operation, input);
    return isObservingResult(response.result) ? response.result : { ok: false, code: "UNAVAILABLE" };
  }

  stop(): Promise<void> {
    if (!this.stopPromise) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      this.stopPromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // Publish ownership before cancellation can synchronously reenter stop().
      void this.stopOwnedProcess().then(resolve, reject);
    }
    return this.stopPromise;
  }

  private async stopOwnedProcess(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.startTimer);
    this.rejectStart?.(new Error("Backend stopping."));
    this.rejectStart = undefined;
    this.rejectPending();
    this.cancelOwnedModelRuns();
    const child = this.child;
    if (!child) return;
    const nativeLifecycle = child.closure !== undefined || child.closeChildInput !== undefined || child.confirmCleanup !== undefined;
    if (nativeLifecycle) {
      if (!this.exited) {
        let inputClosed = false;
        if (this.ready) {
          try {
            await this.request("runtime.shutdown");
            if (!child.closeChildInput) throw new Error("Native backend input close unavailable.");
            await bounded(Promise.resolve().then(() => child.closeChildInput!()), 2500, "Native backend input close timed out.");
            inputClosed = true;
          } catch { /* Never close input without a matching valid shutdown response. */ }
        }
        if (!inputClosed) this.signalKill();
      }
      if (!child.closure) throw new Error("Native backend physical closure unverified; recovery required.");
      // Session/completion failure can precede physical close and cannot release ownership.
      try { await bounded(child.closure, 25_000, "Native backend physical closure unverified; recovery required."); }
      catch (error) { this.signalKill(); throw error; }
      if (!child.confirmCleanup) throw new Error("Native backend cleanup unverified; recovery required.");
      await bounded(Promise.resolve().then(() => child.confirmCleanup!()), 2500, "Native backend cleanup unverified; recovery required.");
      return;
    }
    if (this.exited) return;
    if (this.ready) {
      await bounded(this.request("runtime.shutdown"), 1000, "Backend shutdown timed out.").catch(() => undefined);
    }
    for (let n = 0; n < 10 && !this.exited; n++) await delay(50);
    if (!this.exited) {
      this.signalKill();
      for (let n = 0; n < 40 && !this.exited; n++) await delay(50);
    }
    this.rejectPending();
    if (!this.exited) throw new Error("Backend exit was not confirmed.");
  }
}
