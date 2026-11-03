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
  postMessage(message: unknown): void;
  kill(): boolean;
}
type Pending = { operation: Operation; resolve(value: Response): void; reject(error: Error): void; timer: NodeJS.Timeout };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class BackendController {
  private readonly session = randomBytes(32).toString("hex");
  private child: ChildPort | undefined;
  private ready = false;
  private closing = false;
  private exited = false;
  private heartbeatPending = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private rejectStart: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, Pending>();
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly fork: () => ChildPort, private readonly onUnexpectedExit: () => void, private readonly model?: { run(id: string, input: ModelInput, progress: () => void): Promise<EngineReply>; cancel(id: string): void }) {}

  start(): Promise<void> {
    if (this.child || this.closing) return Promise.reject(new Error("Backend already started or closed."));
    return new Promise((resolve, reject) => {
      this.rejectStart = reject;
      this.startTimer = setTimeout(() => reject(new Error("Backend startup timed out.")), 5000);
      try {
        const child = this.fork();
        this.child = child;
        child.on("spawn", () => {
          try { child.postMessage({ type: "initialize", protocol: 1, session: this.session }); }
          catch { this.rejectStart?.(new Error("Backend channel closed during startup.")); }
        });
        child.on("message", (message: unknown) => {
          if (isModelCancel(message, this.session)) { this.model?.cancel(message.id); return; }
          if (this.ready && !this.closing && isModelRun(message, this.session)) {
            const unavailable: EngineReply = { text: "", error: "ENGINE_UNAVAILABLE", info: null };
            void (this.model?.run(message.id, message.input, () => {
              if (!this.closing) { try { child.postMessage({ type: "model.progress", session: this.session, id: message.id }); } catch { this.onUnexpectedExit(); } }
            }) ?? Promise.resolve(unavailable)).catch(() => ({ ...unavailable, error: "ENGINE_CRASHED" as const })).then(reply => {
              if (!this.closing && !this.exited && isEngineReply(reply)) {
                try { child.postMessage({ type: "model.result", session: this.session, id: message.id, reply }); }
                catch { this.onUnexpectedExit(); }
              }
            });
            return;
          }
          if (!this.ready && !this.closing && isReady(message, this.session)) {
            this.ready = true;
            clearTimeout(this.startTimer);
            this.rejectStart = undefined;
            this.heartbeat = setInterval(() => {
              if (this.heartbeatPending || this.closing) return;
              this.heartbeatPending = true;
              void this.request("runtime.ping").catch(() => {
                if (!this.closing) this.onUnexpectedExit();
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
          this.ready = false;
          clearTimeout(this.startTimer);
          clearInterval(this.heartbeat);
          this.rejectStart?.(new Error("Backend exited before ready."));
          this.rejectPending();
          if (!this.closing) this.onUnexpectedExit();
        });
      } catch (error) {
        clearTimeout(this.startTimer);
        reject(error);
      }
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
    if ((operation === "runtime.status" || operation.startsWith("sky.") || operation.startsWith("assistant.") || operation === "development.invoke" || operation === "development.status") && this.pending.size >= 14)
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
          ...((operation.startsWith("sky.") || operation.startsWith("assistant.") || (operation.startsWith("development.") && operation !== "development.status")) ? { input } : {}),
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

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOwnedProcess();
    return this.stopPromise;
  }

  private async stopOwnedProcess(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.startTimer);
    this.rejectStart?.(new Error("Backend stopping."));
    this.rejectPending();
    if (!this.child || this.exited) return;
    if (this.ready) {
      await Promise.race([this.request("runtime.shutdown").catch(() => undefined), delay(1000)]);
    }
    for (let n = 0; n < 10 && !this.exited; n++) await delay(50);
    if (!this.exited) {
      this.child.kill();
      for (let n = 0; n < 40 && !this.exited; n++) await delay(50);
    }
    this.rejectPending();
    if (!this.exited) throw new Error("Backend exit was not confirmed.");
  }
}
