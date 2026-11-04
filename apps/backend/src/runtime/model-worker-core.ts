import { isBackend, isEngineInfo, isEngineReply, isJobId, isModelInput, type ComputeBackend, type EngineInfo, type EngineReply, type ModelErrorCode } from "@tahtiapuri/validation/assistant";
import { isSession } from "@tahtiapuri/validation/backend";
import type { ApprovedModel } from "@tahtiapuri/validation/model-wire";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";

export interface WorkerEngine {
  initialize(profile: ApprovedModel, backend: ComputeBackend): Promise<EngineInfo>;
  generate(prompt: string, signal: AbortSignal, onFirstText: () => void): Promise<EngineReply>;
  dispose(): Promise<void>;
}
type InitialMessage = { type: "initialize"; session: string; profile: ApprovedModel; backend: ComputeBackend };
function isInitialMessage(value: unknown): value is InitialMessage {
  return isRecord(value) && exactKeys(value, ["type", "session", "profile", "backend"])
    && value.type === "initialize" && isSession(value.session) && isBackend(value.backend)
    && isRecord(value.profile) && exactKeys(value.profile, ["file", "bytes", "sha256", "templateSha256"])
    && typeof value.profile.file === "string" && value.profile.file.length > 0 && value.profile.file.length <= 4096
    && !value.profile.file.includes("\0") && value.profile.bytes === 2497280256
    && isSession(value.profile.sha256) && isSession(value.profile.templateSha256);
}

/** Transport-independent lifecycle. The launcher, never this worker, establishes OS rights. */
export class ModelWorkerCore {
  private state: "new" | "loading" | "ready" | "stopping" | "stopped" = "new";
  private session: string | undefined;
  private backend: ComputeBackend | undefined;
  private operation: Promise<void> | undefined;
  private current: { id: string; abort: AbortController } | undefined;
  private stopping: Promise<void> | undefined;
  private exitCode = 0;
  private lastParent: number;
  constructor(
    private readonly engine: WorkerEngine,
    private readonly send: (message: unknown) => void,
    private readonly exit: (code: number) => void,
    private readonly errorCode: (error: unknown, cancelled: boolean) => ModelErrorCode,
    private readonly now: () => number = Date.now,
  ) { this.lastParent = now(); }

  private post(message: unknown) {
    if (this.state === "stopping" || this.state === "stopped") return;
    try { this.send(message); } catch { void this.stop(1); }
  }
  private replyError(error: unknown, cancelled: boolean): EngineReply {
    return { text: "", error: this.errorCode(error, cancelled), info: null };
  }
  receive(message: unknown): void {
    if (this.state === "stopping" || this.state === "stopped") return;
    if (this.state === "new") {
      if (!isInitialMessage(message)) return;
      this.session = message.session; this.backend = message.backend;
      this.lastParent = this.now(); this.state = "loading";
      this.operation = Promise.resolve().then(() => this.state === "loading" ? this.engine.initialize(message.profile, message.backend) : undefined).then(info => {
        if (this.state !== "loading") return;
        if (!isEngineInfo(info) || info.backend !== this.backend) throw new Error("ENGINE_UNAVAILABLE");
        this.state = "ready"; this.post({ type: "ready", session: this.session, info });
      }).catch(error => {
        this.post({ type: "load-error", session: this.session, code: this.errorCode(error, false) });
        void this.stop(1);
      });
      return;
    }
    if (!isRecord(message) || message.session !== this.session) return;
    if (exactKeys(message, ["type", "session"]) && message.type === "ping") { this.lastParent = this.now(); return; }
    if (exactKeys(message, ["type", "session"]) && message.type === "shutdown") {
      this.lastParent = this.now(); void this.stop(); return;
    }
    if (exactKeys(message, ["type", "session", "id"]) && message.type === "cancel" && isJobId(message.id)) {
      this.lastParent = this.now(); if (this.current?.id === message.id) this.current.abort.abort(); return;
    }
    if (this.state !== "ready" || this.current || !exactKeys(message, ["type", "session", "id", "input"])
      || message.type !== "run" || !isJobId(message.id) || !isModelInput(message.input)) return;
    this.lastParent = this.now();
    const { id, input } = message;
    if (input.backend !== this.backend) {
      this.post({ type: "result", session: this.session, id, reply: { text: "", error: "INVALID_INPUT", info: null } });
      return;
    }
    const abort = new AbortController(); this.current = { id, abort };
    this.operation = Promise.resolve().then(() => {
      if (abort.signal.aborted) return this.replyError(undefined, true);
      return this.engine.generate(input.prompt, abort.signal, () => {
        if (!abort.signal.aborted) this.post({ type: "generating", session: this.session, id });
      });
    }).then(reply => {
      const valid = isEngineReply(reply) && (reply.info === null || reply.info.backend === this.backend);
      if (!valid) { void this.stop(1); return; }
      this.post({ type: "result", session: this.session, id,
        reply: abort.signal.aborted ? this.replyError(undefined, true) : reply });
    }).catch(() => {
      // Expected native errors are EngineReply values. A rejection can mean failed
      // context disposal: retire this process before the owner starts another job.
      void this.stop(1);
    }).finally(() => { this.current = undefined; });
  }
  checkParent(): void {
    if (this.now() - this.lastParent > 10_000) void this.stop(1);
  }
  stop(code = 0): Promise<void> {
    this.exitCode = Math.max(this.exitCode, code);
    if (this.stopping) return this.stopping;
    this.state = "stopping"; this.current?.abort.abort();
    // The owner imposes a hard deadline. Never dispose underneath a native operation.
    this.stopping = (async () => {
      await this.operation;
      try { await this.engine.dispose(); } catch { this.exitCode = 1; }
      this.state = "stopped"; this.exit(this.exitCode);
    })();
    return this.stopping;
  }
}
