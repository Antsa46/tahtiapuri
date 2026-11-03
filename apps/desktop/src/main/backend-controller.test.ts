import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { BackendController, type ChildPort } from "./backend-controller.js";
class FakeChild extends EventEmitter implements ChildPort {
  pid = 123;
  messages: Record<string, unknown>[] = [];
  killed = false;
  postMessage(message: unknown) { this.messages.push(message as Record<string, unknown>); }
  kill() { this.killed = true; this.emit("exit", 1); return true; }
}
afterEach(() => { vi.useRealTimers(); });
async function setup() {
  const child = new FakeChild(); const failed = vi.fn();
  const controller = new BackendController(() => child, failed);
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
