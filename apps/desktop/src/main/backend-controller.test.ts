import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { BackendController, type ChildPort } from "./backend-controller.js";
import type { EngineReply, ModelInput } from "@tahtiapuri/validation/assistant";
class FakeChild extends EventEmitter implements ChildPort {
  pid = 123;
  messages: Record<string, unknown>[] = [];
  killed = false;
  postMessage(message: unknown) { this.messages.push(message as Record<string, unknown>); }
  kill() { this.killed = true; this.emit("exit", 1); return true; }
}
afterEach(() => { vi.useRealTimers(); });
type Model = { run(id: string, input: ModelInput, progress: () => void): Promise<EngineReply>; cancel(id: string): void };
async function setup<T extends FakeChild = FakeChild>(child: T = new FakeChild() as T, model?: Model) {
  const failed = vi.fn();
  const controller = new BackendController(() => child, failed, model);
  const started = controller.start(); child.emit("spawn");
  const session = child.messages[0]!.session;
  child.emit("message", { type: "ready", protocol: 1, session }); await started;
  return { child, controller, failed, session };
}
it("ignores a response with the wrong session and resolves only its own request", async () => {
  vi.useFakeTimers();
  const { child, controller, session } = await setup();
  const status = controller.getStatus();
  const request = child.messages.at(-1)!;
  child.emit("message", { ...request, type: "response", session: "b".repeat(64), result: { state: "ready", model: "not-loaded", protocolVersion: 1 } });
  child.emit("message", { type: "response", protocol: 1, session, id: request.id, operation: "runtime.status", result: { state: "ready", model: "not-loaded", protocolVersion: 1 } });
  expect(await status).toMatchObject({ state: "ready" });
  const stopped = controller.stop(); await vi.advanceTimersByTimeAsync(4000); await stopped;
});
it("kills an unresponsive owned child and rejects outstanding work on close", async () => {
  vi.useFakeTimers();
  const { child, controller } = await setup();
  const pending = controller.getStatus().catch(error => error.message);
  const stopped = controller.stop();
  await vi.advanceTimersByTimeAsync(4000); await stopped;
  expect(child.killed).toBe(true);
  expect(await pending).toBe("Backend unavailable.");
  await expect(controller.getStatus()).rejects.toThrow("unavailable");
});
it("bounds startup and cleans up a child that never becomes ready", async () => {
  vi.useFakeTimers(); const child = new FakeChild();
  const controller = new BackendController(() => child, vi.fn());
  const started = controller.start().catch(error => error.message);
  child.emit("spawn"); await vi.advanceTimersByTimeAsync(5000);
  expect(await started).toContain("timed out");
  const stopped = controller.stop(); await vi.advanceTimersByTimeAsync(4000); await stopped;
  expect(child.killed).toBe(true);
});
it("invalidates pending replies when the backend dies", async () => {
  const { child, controller, failed } = await setup();
  const pending = controller.getStatus().catch(error => error.message);
  child.emit("exit", 9);
  expect(await pending).toBe("Backend unavailable.");
  expect(failed).toHaveBeenCalledOnce();
  await controller.stop();
});

it("preserves heartbeat capacity when UI status requests reach backpressure", async () => {
  vi.useFakeTimers();
  const { child, controller, failed, session } = await setup();
  const waiting = Array.from({ length: 14 }, () => controller.getStatus().catch(() => undefined));
  await expect(controller.getStatus()).rejects.toThrow("limit");
  await vi.advanceTimersByTimeAsync(2000);
  const ping = child.messages.at(-1)!;
  expect(ping.operation).toBe("runtime.ping");
  child.emit("message", { type: "response", protocol: 1, session, id: ping.id, operation: "runtime.ping", result: null });
  await vi.advanceTimersByTimeAsync(1);
  expect(failed).not.toHaveBeenCalled();
  const stopped = controller.stop(); await vi.advanceTimersByTimeAsync(4000);
  await stopped; await Promise.all(waiting);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
class FakeNativeChild extends FakeChild {
  readonly startupTimeoutMs = 40_000;
  readonly physicalClose = deferred<void>();
  readonly closure = this.physicalClose.promise;
  readonly cleanup = deferred<void>();
  readonly order: string[] = [];
  acknowledgeShutdown = true;
  closeChildInput = vi.fn(async () => { this.order.push("close-input"); });
  confirmCleanup = vi.fn(() => { this.order.push("confirm-cleanup"); return this.cleanup.promise; });
  override postMessage(message: unknown) {
    super.postMessage(message);
    const request = message as Record<string, unknown>;
    if (request.operation === "runtime.shutdown" && this.acknowledgeShutdown) {
      this.order.push("shutdown-response");
      this.emit("message", { type: "response", protocol: 1, session: request.session, id: request.id, operation: request.operation, result: null });
    }
  }
  override kill() { this.killed = true; this.order.push("kill"); return true; }
  closeBroker() { this.emit("exit", 0); this.physicalClose.resolve(); }
}

it("waits for native physical closure and cleanup after an early exit event", async () => {
  vi.useFakeTimers();
  const { child, controller } = await setup(new FakeNativeChild());
  child.emit("exit", 0);
  let done = false;
  const stopped = controller.stop();
  void stopped.then(() => { done = true; });
  expect(controller.stop()).toBe(stopped);
  await vi.advanceTimersByTimeAsync(1000);
  expect(done).toBe(false);
  expect(child.confirmCleanup).not.toHaveBeenCalled();
  child.physicalClose.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(child.confirmCleanup).toHaveBeenCalledOnce();
  expect(done).toBe(false);
  child.cleanup.resolve();
  await stopped;
  expect(done).toBe(true);
});

it("orders a matching native shutdown response before input close and allows slow cleanup", async () => {
  vi.useFakeTimers();
  const { child, controller } = await setup(new FakeNativeChild());
  let done = false;
  const stopped = controller.stop().then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(child.order).toEqual(["shutdown-response", "close-input"]);
  expect(child.killed).toBe(false);
  expect(done).toBe(false);
  child.closeBroker(); child.cleanup.resolve(); await stopped;
  expect(child.order.at(-1)).toBe("confirm-cleanup");
});

it("kills native shutdown without a valid matching acknowledgement and never closes its input", async () => {
  vi.useFakeTimers();
  const { child, controller, session } = await setup(new FakeNativeChild());
  child.acknowledgeShutdown = false;
  const stopped = controller.stop();
  const request = child.messages.at(-1)!;
  child.emit("message", { type: "response", protocol: 1, session, id: "0".repeat(36), operation: "runtime.shutdown", result: null });
  child.emit("message", { type: "response", protocol: 1, session: "b".repeat(64), id: request.id, operation: "runtime.shutdown", result: null });
  child.emit("message", { type: "response", protocol: 1, session, id: request.id, operation: "runtime.shutdown", result: {} });
  await vi.advanceTimersByTimeAsync(2499);
  expect(child.killed).toBe(false);
  expect(child.closeChildInput).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(child.killed).toBe(true);
  expect(child.closeChildInput).not.toHaveBeenCalled();
  child.closeBroker(); child.cleanup.resolve(); await stopped;
});

it("kills when acknowledged input close fails but still awaits native closure", async () => {
  vi.useFakeTimers();
  const child = new FakeNativeChild();
  child.closeChildInput.mockRejectedValue(new Error("close failed"));
  const { controller } = await setup(child);
  let done = false;
  const stopped = controller.stop().then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(child.killed).toBe(true); expect(done).toBe(false);
  child.closeBroker(); child.cleanup.resolve(); await stopped;
});

it("rejects blocked native cleanup even after physical closure", async () => {
  vi.useFakeTimers();
  const { child, controller } = await setup(new FakeNativeChild());
  const stopped = controller.stop();
  const rejected = expect(stopped).rejects.toThrow("blocked");
  child.cleanup.reject(new Error("Native backend cleanup remains blocked."));
  await vi.advanceTimersByTimeAsync(0);
  expect(child.confirmCleanup).not.toHaveBeenCalled();
  child.closeBroker(); await rejected;
  await expect(controller.start()).rejects.toThrow("closed");
  expect(controller.stop()).toBe(stopped);
});

it("bounds missing native closure and does not accept early cleanup failure as closure", async () => {
  vi.useFakeTimers();
  const { child, controller } = await setup(new FakeNativeChild());
  const stopped = controller.stop();
  const rejected = expect(stopped).rejects.toThrow("physical closure unverified");
  child.cleanup.reject(new Error("failed before close"));
  await vi.advanceTimersByTimeAsync(24_999);
  expect(child.confirmCleanup).not.toHaveBeenCalled();
  expect(child.killed).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await rejected;
  expect(child.killed).toBe(true);
});

it("bounds missing post-close native cleanup proof", async () => {
  vi.useFakeTimers();
  const { child, controller } = await setup(new FakeNativeChild());
  child.closeBroker();
  const stopped = controller.stop();
  const rejected = expect(stopped).rejects.toThrow("cleanup unverified");
  await vi.advanceTimersByTimeAsync(2500); await rejected;
});

it("rejects an incomplete native lifecycle instead of accepting its exit event", async () => {
  const child = new FakeChild();
  const nativeLike: ChildPort = Object.assign(child, { closure: Promise.resolve() });
  const controller = new BackendController(() => nativeLike, vi.fn());
  const started = controller.start(); child.emit("spawn");
  child.emit("message", { type: "ready", protocol: 1, session: child.messages[0]!.session }); await started;
  child.emit("exit", 0);
  await expect(controller.stop()).rejects.toThrow("cleanup unverified");
});

it("uses the native startup budget while retaining a finite ready deadline", async () => {
  vi.useFakeTimers(); const child = new FakeNativeChild();
  const controller = new BackendController(() => child, vi.fn());
  let done = false;
  const started = controller.start().catch(error => { done = true; return error.message; });
  await vi.advanceTimersByTimeAsync(39_999); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(await started).toContain("timed out");
  const stopped = controller.stop(); expect(child.killed).toBe(true);
  child.closeBroker(); child.cleanup.resolve(); await stopped;
});

it("accepts native preparation beyond the legacy startup window", async () => {
  vi.useFakeTimers(); const child = new FakeNativeChild();
  const controller = new BackendController(() => child, vi.fn());
  const started = controller.start();
  await vi.advanceTimersByTimeAsync(6000);
  child.emit("spawn");
  child.emit("message", { type: "ready", protocol: 1, session: child.messages[0]!.session });
  await started;
  const stopped = controller.stop(); child.closeBroker(); child.cleanup.resolve(); await stopped;
});

it.each([0, -1, 40_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid startup budget %s while retaining child ownership", async budget => {
  vi.useFakeTimers();
  const child = Object.assign(new FakeChild(), { startupTimeoutMs: budget });
  const controller = new BackendController(() => child, vi.fn());
  await expect(controller.start()).rejects.toThrow("startup budget");
  const stopped = controller.stop(); await vi.advanceTimersByTimeAsync(3000); await stopped;
  expect(child.killed).toBe(true);
});

it("handles a fork failure and an EventEmitter channel error without leaking ownership", async () => {
  const broken = new BackendController(() => { throw new Error("fork failed"); }, vi.fn());
  await expect(broken.start()).rejects.toThrow("fork failed"); await broken.stop();
  const { child, controller, failed } = await setup();
  expect(() => child.emit("error", new Error("channel failure"))).not.toThrow();
  expect(child.killed).toBe(true); expect(failed).toHaveBeenCalledOnce(); await controller.stop();
});

const modelId = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const reply: EngineReply = { text: "", error: "CANCELLED", info: null };
function sendRun(child: FakeChild, session: unknown, id = modelId(1)) {
  child.emit("message", { type: "model.run", session, id, input: { prompt: "Synthetic fixture", backend: "cpu" } });
}

it.each(["stop", "exit"] as const)("cancels owned model work on %s and suppresses late progress and results", async ending => {
  vi.useFakeTimers(); const result = deferred<EngineReply>(); let progress!: () => void;
  const model = { run: vi.fn((_id: string, _input: ModelInput, update: () => void) => { progress = update; return result.promise; }), cancel: vi.fn() };
  const { child, controller, session } = await setup(new FakeChild(), model);
  sendRun(child, session); await vi.advanceTimersByTimeAsync(0);
  expect(model.run).toHaveBeenCalledOnce();
  let stopped: Promise<void>;
  if (ending === "exit") { child.emit("exit", 1); stopped = controller.stop(); }
  else stopped = controller.stop();
  expect(model.cancel).toHaveBeenCalledExactlyOnceWith(modelId(1));
  progress(); result.resolve(reply); await vi.advanceTimersByTimeAsync(4000); await stopped;
  expect(child.messages.filter(message => message.type === "model.progress" || message.type === "model.result")).toEqual([]);
});

it("ignores unowned model cancels, suppresses canceled progress and acknowledges actual settlement once", async () => {
  vi.useFakeTimers(); const result = deferred<EngineReply>(); let progress!: () => void;
  const model = { run: vi.fn((_id: string, _input: ModelInput, update: () => void) => { progress = update; return result.promise; }), cancel: vi.fn() };
  const { child, controller, session } = await setup(new FakeChild(), model);
  child.emit("message", { type: "model.cancel", session, id: modelId(2) }); expect(model.cancel).not.toHaveBeenCalled();
  sendRun(child, session); await vi.advanceTimersByTimeAsync(0);
  child.emit("message", { type: "model.cancel", session, id: modelId(1) });
  child.emit("message", { type: "model.cancel", session, id: modelId(1) });
  progress();
  expect(child.messages.some(message => message.type === "model.result" || message.type === "model.progress")).toBe(false);
  const actualSettlement: EngineReply = { text: "synthetic settlement", error: "ENGINE_CRASHED", info: null };
  result.resolve(actualSettlement); await vi.advanceTimersByTimeAsync(0);
  expect(model.cancel).toHaveBeenCalledExactlyOnceWith(modelId(1));
  expect(child.messages.filter(message => message.type === "model.result")).toEqual([{ type: "model.result", session, id: modelId(1), reply: actualSettlement }]);
  expect(child.messages.some(message => message.type === "model.progress")).toBe(false);
  // Settlement releases the slot; a fresh invocation cannot be affected by the old one.
  sendRun(child, session); await vi.advanceTimersByTimeAsync(0); expect(model.run).toHaveBeenCalledTimes(2);
  const stopped = controller.stop(); await vi.advanceTimersByTimeAsync(4000); await stopped;
});

it("acknowledges cancellation before deferred launch without starting the model", async () => {
  vi.useFakeTimers();
  const model = { run: vi.fn(() => Promise.resolve(reply)), cancel: vi.fn() };
  const { child, controller, session } = await setup(new FakeChild(), model);
  sendRun(child, session);
  child.emit("message", { type: "model.cancel", session, id: modelId(1) });
  await vi.advanceTimersByTimeAsync(0);
  expect(model.run).not.toHaveBeenCalled();
  expect(child.messages.filter(message => message.type === "model.result")).toEqual([{ type: "model.result", session, id: modelId(1), reply: { text: "", error: "CANCELLED", info: null } }]);
  const stopped = controller.stop(); await vi.advanceTimersByTimeAsync(4000); await stopped;
});

it("turns a synchronous model throw into ENGINE_CRASHED and releases ownership", async () => {
  vi.useFakeTimers();
  const model = { run: vi.fn((): Promise<EngineReply> => { throw new Error("synthetic crash"); }), cancel: vi.fn() };
  const { child, controller, session } = await setup(new FakeChild(), model);
  expect(() => sendRun(child, session)).not.toThrow(); await vi.advanceTimersByTimeAsync(0);
  expect(child.messages.at(-1)).toMatchObject({ type: "model.result", id: modelId(1), reply: { error: "ENGINE_CRASHED" } });
  child.emit("message", { type: "model.cancel", session, id: modelId(1) }); expect(model.cancel).not.toHaveBeenCalled();
  const stopped = controller.stop(); await vi.advanceTimersByTimeAsync(4000); await stopped;
});

it.each(["duplicate", "flood", "cancel-flood"] as const)("fails closed on model %s without forwarding more than sixteen runs", async kind => {
  vi.useFakeTimers(); const pending = deferred<EngineReply>();
  const model = { run: vi.fn(() => pending.promise), cancel: vi.fn() };
  const { child, controller, session, failed } = await setup(new FakeChild(), model);
  const count = kind === "duplicate" ? 1 : 16;
  for (let n = 1; n <= count; n++) {
    sendRun(child, session, modelId(n)); await vi.advanceTimersByTimeAsync(0);
    if (kind === "cancel-flood") child.emit("message", { type: "model.cancel", session, id: modelId(n) });
  }
  sendRun(child, session, modelId(kind === "duplicate" ? 1 : 17)); await vi.advanceTimersByTimeAsync(0);
  expect(model.run).toHaveBeenCalledTimes(count);
  expect(model.cancel).toHaveBeenCalledTimes(count);
  expect(child.killed).toBe(true); expect(failed).toHaveBeenCalledOnce();
  await controller.stop(); pending.resolve(reply); await vi.advanceTimersByTimeAsync(0);
  expect(child.messages.some(message => message.type === "model.result")).toBe(false);
});
