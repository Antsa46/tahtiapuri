import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isJobId, isModelInput, type EngineReply, type ModelInput, type ModelErrorCode } from "@tahtiapuri/validation/assistant";
import { MODEL_TIME_BUDGET } from "@tahtiapuri/validation/model-wire";
import { NativeModelExchange } from "./native-model-exchange.js";
import { NativeBrokerRecords, nativePromptBody } from "./native-model-protocol.js";
import { prepareNativeResources, NativePreparationError, type NativeResourceConfig, type PreparedNativeResources } from "./native-model-resources.js";
import { childEnvironment } from "./child-environment.js";
export interface NativeBrokerPort extends EventEmitter { stdin: Writable; stdout: Readable; stderr: Readable; kill(): boolean }
export type NativeModelDependencies = {
  prepare(signal: AbortSignal): Promise<PreparedNativeResources>;
  launch(resources: PreparedNativeResources, session: string, budgetMs: number): NativeBrokerPort;
};
type Job = { id: string; controller: AbortController; cancelled: boolean; timedOut: boolean; fatal: boolean;
  exchange?: NativeModelExchange; broker?: NativeBrokerPort; hardCancel?: NodeJS.Timeout; promise?: Promise<EngineReply> };
const failure = (error: ModelErrorCode): EngineReply => ({ text: "", error, info: null });
export class NativeModelHost {
  private active: Job | undefined;
  private closed = false;
  private unavailable = false;
  constructor(private readonly dependencies: NativeModelDependencies) {}
  run(id: string, input: ModelInput, progress: () => void): Promise<EngineReply> {
    if (this.closed || this.unavailable) return Promise.resolve(failure("ENGINE_UNAVAILABLE"));
    if (this.active) return Promise.resolve(failure("BUSY"));
    if (!isJobId(id) || !isModelInput(input)) return Promise.resolve(failure("INVALID_INPUT"));
    // A caller's backend field is a requirement, never permission to downgrade.
    if (input.backend !== "cpu") return Promise.resolve(failure("ENGINE_UNAVAILABLE"));
    try { nativePromptBody(input.prompt); } catch { return Promise.resolve(failure("INVALID_INPUT")); }
    const job: Job = { id, controller: new AbortController(), cancelled: false, timedOut: false, fatal: false };
    this.active = job;
    job.promise = this.execute(job, input.prompt, progress).finally(() => {
      clearTimeout(job.hardCancel); if (this.active === job) this.active = undefined;
    });
    return job.promise;
  }
  private fatal(job: Job) {
    job.fatal = true; this.unavailable = true; job.controller.abort();
    try { job.broker?.kill(); } catch { /* No unverified cleanup claim. */ }
  }
  private interrupt(job: Job) {
    job.controller.abort();
    try { job.exchange?.cancel(); } catch { this.fatal(job); }
    if (job.broker && !job.hardCancel) job.hardCancel = setTimeout(() => this.fatal(job), 5000);
  }
  cancel(id: string) {
    const job = this.active; if (!job || job.id !== id) return;
    job.cancelled = true; this.interrupt(job);
  }
  async stop(): Promise<void> {
    this.closed = true;
    const job = this.active;
    if (!job) { if (this.unavailable) throw new Error("Native runtime exit unconfirmed."); return; }
    job.cancelled = true; this.interrupt(job);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([job.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { this.fatal(job); reject(new Error("Native runtime exit unconfirmed.")); }, 10000);
      })]);
      if (job.fatal) throw new Error("Native runtime exit unconfirmed.");
    } finally { clearTimeout(timer); }
  }
  private async execute(job: Job, prompt: string, progress: () => void): Promise<EngineReply> {
    const deadline = performance.now() + MODEL_TIME_BUDGET.ownerJobMs;
    let resources: PreparedNativeResources | undefined, attemptedLaunch = false, cleanupStarted = false;
    const cleanup = async () => { cleanupStarted = true; await resources!.cleanup(); };
    // Reserve ten seconds of the shared budget for cooperative close + cleanup.
    const cancelAt = setTimeout(() => { job.timedOut = true; this.interrupt(job); }, MODEL_TIME_BUDGET.ownerJobMs - 10000);
    const finalAt = setTimeout(() => { job.timedOut = true; this.fatal(job); }, MODEL_TIME_BUDGET.ownerJobMs);
    try {
      resources = await this.dependencies.prepare(job.controller.signal);
      if (job.cancelled || job.timedOut || this.closed) {
        await cleanup(); return failure(job.timedOut ? "TIMEOUT" : "CANCELLED");
      }
      const budget = Math.min(175000, Math.floor(deadline - performance.now() - 5000));
      if (budget < 1000) { job.timedOut = true; await cleanup(); return failure("TIMEOUT"); }
      const session = randomBytes(32).toString("hex"), parser = new NativeBrokerRecords();
      job.exchange = new NativeModelExchange(session, prompt, bytes => {
        if (job.fatal || !job.broker) throw new Error("Native runtime unavailable.");
        job.broker.stdin.write(bytes);
      }, () => { if (!job.cancelled && !job.timedOut && !job.fatal && !this.closed) progress(); });
      attemptedLaunch = true; const broker = this.dependencies.launch(resources, session, budget); job.broker = broker;
      const exitCode = await new Promise<number | null>(resolve => {
        broker.once("close", (code: number | null) => resolve(code));
        broker.once("error", () => this.fatal(job)); broker.stdin.on("error", () => this.fatal(job));
        broker.stdout.on("data", (chunk: Buffer) => {
          if (job.fatal) return;
          try { parser.push(chunk, record => job.exchange!.receive(record)); } catch { this.fatal(job); }
        });
        broker.stdout.on("error", () => this.fatal(job));
        broker.stderr.on("error", () => this.fatal(job));
        broker.stderr.on("data", () => this.fatal(job));
        broker.once("spawn", () => {
          if (job.fatal) return;
          try { if (job.cancelled || job.timedOut || this.closed) job.exchange!.cancel(); job.exchange!.start(); }
          catch { this.fatal(job); }
        });
      });
      clearTimeout(job.hardCancel);
      if (job.fatal) return failure(job.timedOut ? "TIMEOUT" : "ENGINE_CRASHED");
      parser.finish();
      const candidate = job.exchange.candidateAfterBrokerExit(exitCode);
      // No further work is accepted until the worker, Job, profile, broker and
      // filesystem resources have all passed their respective terminal gates.
      await cleanup();
      if (job.fatal || job.timedOut) return failure("TIMEOUT");
      return job.cancelled || this.closed ? failure("CANCELLED") : candidate;
    } catch (error) {
      if (attemptedLaunch) { this.fatal(job); return failure(job.timedOut ? "TIMEOUT" : "ENGINE_CRASHED"); }
      if (resources && !cleanupStarted) {
        try { await cleanup(); } catch { this.fatal(job); }
      } else if (resources || !(error instanceof NativePreparationError) || !error.cleanupVerified) this.fatal(job);
      if (job.fatal) return failure(job.timedOut ? "TIMEOUT" : "ENGINE_UNAVAILABLE");
      return failure(job.timedOut ? "TIMEOUT" : job.cancelled || this.closed ? "CANCELLED" : "ENGINE_UNAVAILABLE");
    } finally {
      clearTimeout(cancelAt); clearTimeout(finalAt); clearTimeout(job.hardCancel);
      job.broker?.stdin.destroy(); job.broker?.stdout.destroy(); job.broker?.stderr.destroy();
    }
  }
}
export function createNativeModelHost(config: NativeResourceConfig): NativeModelHost {
  return new NativeModelHost({ prepare: signal => prepareNativeResources(config, signal),
    launch: (resources, session, budgetMs) => spawn(resources.broker,
      ["run", "lpac", resources.profile, resources.root, "desktop", session, String(budgetMs)],
      { cwd: resources.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: { ...childEnvironment(process.env), PATH: join(process.env.SystemRoot ?? "C:\\Windows", "System32") } }),
  });
}
