import type { ChildPort } from "./backend-controller.js";
import type { ApprovedModel } from "@tahtiapuri/validation/model-wire";
import { randomBytes } from "node:crypto";
import { isEngineInfo, isEngineReply, isErrorCode, type EngineReply, type ModelInput } from "@tahtiapuri/validation/assistant";
import { exactKeys, isRecord } from "@tahtiapuri/validation/public";
const errorReply = (code: EngineReply["error"]): EngineReply => ({ text: "", error: code, info: null });
export class ModelHost {
  private child: ChildPort | undefined;
  private session = "";
  private mode = "";
  private exited = true;
  private closed = false;
  private ready = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private boot: { resolve(): void; reject(code: string): void; timer: NodeJS.Timeout } | undefined;
  private active: { id: string; resolve(reply: EngineReply): void; progress(): void; timer: NodeJS.Timeout; cancelTimer?: NodeJS.Timeout } | undefined;
  constructor(private readonly fork: () => ChildPort, private readonly profile: ApprovedModel) {}
  private fail(code: EngineReply["error"]) {
    if (this.active) {
      clearTimeout(this.active.timer); clearTimeout(this.active.cancelTimer);
      this.active.resolve(errorReply(code)); this.active = undefined;
    }
  }
  private async ensure(mode: ModelInput["backend"]) {
    if (this.closed) throw "ENGINE_UNAVAILABLE";
    if (this.stopping) await this.stopping;
    if (this.child && this.ready && this.mode === mode && !this.exited) return;
    await this.stopChild();
    if (this.closed || this.cancelled) throw "CANCELLED";
    this.session = randomBytes(32).toString("hex"); this.mode = mode; this.ready = false;
    const session = this.session, child = this.fork(); this.child = child; this.exited = false;
    await new Promise<void>((resolve, reject) => {
      this.boot = { resolve, reject, timer: setTimeout(() => reject("TIMEOUT"), 120_000) };
      child.on("spawn", () => {
        try { child.postMessage({ type: "initialize", session, profile: this.profile, backend: mode }); }
        catch { this.boot?.reject("ENGINE_UNAVAILABLE"); }
      });
      child.on("message", (message: unknown) => {
        if (!isRecord(message) || message.session !== session) return;
        if (message.type === "ready" && exactKeys(message, ["type", "session", "info"]) && isEngineInfo(message.info)
          && message.info.backend === mode) {
          this.ready = true; clearTimeout(this.boot?.timer); this.boot?.resolve(); this.boot = undefined;
        } else if (message.type === "generating" && exactKeys(message, ["type", "session", "id"]) && this.active?.id === message.id) {
          this.active?.progress();
        } else if (message.type === "load-error" && exactKeys(message, ["type", "session", "code"]) && isErrorCode(message.code)) {
          this.boot?.reject(message.code);
        } else if (message.type === "result" && exactKeys(message, ["type", "session", "id", "reply"])
          && this.active?.id === message.id && isEngineReply(message.reply)) {
          const active = this.active; if (!active) return; clearTimeout(active.timer); clearTimeout(active.cancelTimer);
          this.active = undefined; active.resolve(this.cancelled ? errorReply("CANCELLED") : message.reply);
        }
      });
      child.once("exit", () => {
        if (this.child !== child) return;
        this.exited = true; this.ready = false; clearInterval(this.heartbeat);
        clearTimeout(this.boot?.timer); this.boot?.reject("ENGINE_CRASHED"); this.boot = undefined; this.fail("ENGINE_CRASHED");
      });
      this.heartbeat = setInterval(() => {
        try { child.postMessage({ type: "ping", session }); } catch { void this.retire("ENGINE_CRASHED"); }
      }, 2000);
    });
  }
  private busyId: string | undefined;
  private cancelled = false;
  async run(id: string, input: ModelInput, onRunning: () => void): Promise<EngineReply> {
    if (this.busyId || this.closed) return errorReply("BUSY");
    this.busyId = id; this.cancelled = false;
    try {
      await this.ensure(input.backend);
      if (this.busyId !== id || this.closed || this.cancelled) return errorReply("CANCELLED");
      return await new Promise<EngineReply>(resolve => {
        this.active = { id, resolve, progress: onRunning, timer: setTimeout(() => { void this.retire("TIMEOUT"); }, 60_000) };
        this.child!.postMessage({ type: "run", session: this.session, id, input });
      });
    } catch (code) {
      await this.stopChild(); return errorReply(isErrorCode(code) ? code : "ENGINE_UNAVAILABLE");
    } finally { if (this.busyId === id) this.busyId = undefined; }
  }
  cancel(id: string) {
    if (this.busyId !== id) return;
    this.cancelled = true;
    if (!this.ready || !this.active) {
      this.boot?.reject("CANCELLED"); void this.stopChild(); return;
    }
    try { this.child?.postMessage({ type: "cancel", session: this.session, id }); }
    catch { void this.retire("ENGINE_CRASHED"); return; }
    clearTimeout(this.active.cancelTimer);
    this.active.cancelTimer = setTimeout(() => { if (this.active?.id === id) void this.retire("CANCELLED"); }, 5000);
  }
  private async retire(code: EngineReply["error"]) {
    this.boot?.reject(code ?? "ENGINE_CRASHED");
    const active = this.active;
    this.active = undefined; this.ready = false;
    if (active) { clearTimeout(active.timer); clearTimeout(active.cancelTimer); }
    try { await this.stopChild(); } catch { code = "ENGINE_CRASHED"; }
    active?.resolve(errorReply(code));
  }
  async stop() { this.closed = true; this.boot?.reject("CANCELLED"); this.fail("CANCELLED"); await this.stopChild(); }
  private stopping: Promise<void> | undefined;
  private stopChild(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const child = this.child; clearInterval(this.heartbeat); clearTimeout(this.boot?.timer);
      if (!child || this.exited) return;
      try { child.postMessage({ type: "shutdown", session: this.session }); } catch {}
      for (let i = 0; i < 20 && !this.exited; i++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!this.exited) child.kill();
      for (let i = 0; i < 40 && !this.exited; i++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!this.exited) throw new Error("Model worker exit unconfirmed.");
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
