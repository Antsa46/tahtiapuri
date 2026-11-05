import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { isInitialize, isRequest } from "@tahtiapuri/validation/backend";
import type { EngineReply, ModelInput } from "@tahtiapuri/validation/assistant";
import { BackendController, type ChildPort } from "../../../apps/desktop/src/main/backend-controller.js";
import { ParentModelEngine } from "../../../apps/backend/src/modules/assistant/adapters/parent-model-engine.js";
import { AssistantService } from "../../../apps/backend/src/modules/assistant/application/assistant-service.js";

afterEach(() => vi.useRealTimers());
const input: ModelInput = { prompt: "Synthetic cancellation fixture", backend: "cpu" };
const cancelled: EngineReply = { text: "", error: "CANCELLED", info: null };

/** In-memory transport only; the application queue and parent adapter are real. */
class BackendBridge extends EventEmitter implements ChildPort {
  readonly pid = 123;
  session: string | undefined;
  engine: ParentModelEngine | undefined;
  readonly modelMessages: unknown[] = [];
  postMessage(message: unknown): void {
    if (isInitialize(message)) {
      this.session = message.session;
      this.engine!.initialize(message.session);
      this.emit("message", { type: "ready", protocol: 1, session: message.session });
    } else if (this.engine!.receive(message)) {
      this.modelMessages.push(message);
    } else if (this.session && isRequest(message, this.session, Date.now())) {
      if (message.operation === "runtime.shutdown" || message.operation === "runtime.ping") {
        this.emit("message", { type: "response", protocol: 1, session: this.session, id: message.id, operation: message.operation, result: null });
        if (message.operation === "runtime.shutdown") this.emit("exit", 0);
      }
    }
  }
  kill(): boolean { this.emit("exit", 1); return true; }
}

it.each(["running", "before-launch"] as const)("releases the application queue after %s cancellation through the controller", async phase => {
  vi.useFakeTimers();
  const child = new BackendBridge();
  const engine = new ParentModelEngine(message => child.emit("message", message));
  child.engine = engine;
  const assistant = new AssistantService(engine);
  const runs: { id: string; progress(): void; resolve(reply: EngineReply): void }[] = [];
  const model = {
    run: vi.fn((id: string, _input: ModelInput, progress: () => void) => new Promise<EngineReply>(resolve => runs.push({ id, progress, resolve }))),
    cancel: vi.fn(),
  };
  const failed = vi.fn();
  const controller = new BackendController(() => child, failed, model);
  const started = controller.start(); child.emit("spawn"); await started;
  try {
    const first = assistant.submit(input), second = assistant.submit(input);
    if (!first.ok || !second.ok) throw new Error("Synthetic submission failed.");
    if (phase === "running") await vi.advanceTimersByTimeAsync(0);
    expect(assistant.cancel(first.job.id)).toMatchObject({ job: { state: "cancelled" } });
    expect(assistant.get(second.job.id)).toMatchObject({ job: { state: "queued" } });
    if (phase === "running") {
      expect(runs.map(run => run.id)).toEqual([first.job.id]);
      runs[0]!.progress();
      expect(child.modelMessages).toEqual([]);
      runs[0]!.resolve(cancelled);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(child.modelMessages).toEqual([{ type: "model.result", session: child.session, id: first.job.id, reply: cancelled }]);
    expect(runs.map(run => run.id)).toEqual(phase === "running" ? [first.job.id, second.job.id] : [second.job.id]);
    expect(assistant.get(first.job.id)).toMatchObject({ job: { state: "cancelled", error: "CANCELLED" } });
    expect(assistant.get(second.job.id)).toMatchObject({ job: { state: "loading" } });
    runs.at(-1)!.progress();
    expect(assistant.get(second.job.id)).toMatchObject({ job: { state: "running" } });
    runs.at(-1)!.resolve({ text: "", error: "ENGINE_UNAVAILABLE", info: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(assistant.get(second.job.id)).toMatchObject({ job: { state: "error", error: "ENGINE_UNAVAILABLE" } });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    assistant.dispose(); engine.dispose(); await controller.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});
