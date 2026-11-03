import { EventEmitter } from "node:events";
import { expect, it, vi, afterEach } from "vitest";
import { ModelHost } from "./model-host.js";
const info = { backend: "cpu", gpuLayers: 0, loadMs: 1, generationMs: 1, contextSize: 4096, engineVersion: "3.22.2", modelId: "qwen3-4b-q4-k-m" };
const profile = { file: "synthetic", bytes: 2497280256, sha256: "a".repeat(64), templateSha256: "b".repeat(64) };
const input = { prompt: "Synthetic", backend: "cpu" as const };
class Child extends EventEmitter {
  pid = 1; killed = false; session = ""; request: Record<string, unknown> | undefined;
  constructor(readonly respond: boolean) { super(); }
  postMessage(value: unknown) {
    const m = value as Record<string, unknown>;
    if (m.type === "initialize") { this.session = m.session as string; queueMicrotask(() => this.emit("message", { type: "ready", session: this.session, info })); }
    if (m.type === "run") { this.request = m; if (this.respond) queueMicrotask(() => this.emit("message", { type: "result", session: this.session, id: m.id, reply: { text: "ok", error: null, info } })); }
    if (m.type === "shutdown") setTimeout(() => this.emit("exit", 0), 100);
  }
  kill() { this.killed = true; this.emit("exit", 1); return true; }
}
afterEach(() => vi.useRealTimers());
for (const reason of ["timeout", "cancel"] as const) {
  it("reaps a retiring worker before a queued same-backend job: " + reason, async () => {
    vi.useFakeTimers(); const children: Child[] = [];
    const host = new ModelHost(() => { const child = new Child(children.length > 0); children.push(child); queueMicrotask(() => child.emit("spawn")); return child; }, profile);
    const first = host.run("00000000-0000-4000-8000-000000000001", input, () => {});
    await vi.advanceTimersByTimeAsync(0);
    const next = first.then(() => host.run("00000000-0000-4000-8000-000000000002", input, () => {}));
    if (reason === "cancel") host.cancel("00000000-0000-4000-8000-000000000001");
    await vi.advanceTimersByTimeAsync(reason === "cancel" ? 6000 : 61_000);
    expect((await first).error).toBe(reason === "cancel" ? "CANCELLED" : "TIMEOUT");
    expect((await next).text).toBe("ok"); expect(children).toHaveLength(2);
    const stopped = host.stop(); await vi.advanceTimersByTimeAsync(3000); await stopped;
  });
}
it("normalizes a native worker crash without affecting the backend process", async () => {
  vi.useFakeTimers(); const child = new Child(false);
  const host = new ModelHost(() => { queueMicrotask(() => child.emit("spawn")); return child; }, profile);
  const result = host.run("00000000-0000-4000-8000-000000000001", input, () => {});
  await vi.advanceTimersByTimeAsync(0); child.emit("exit", 17);
  expect((await result).error).toBe("ENGINE_CRASHED"); await host.stop();
});

for (const phase of ["initialize", "cancel"] as const) {
  it("handles a closed channel during " + phase + " without an uncaught main error", async () => {
    vi.useFakeTimers(); const child = new Child(false);
    const original = child.postMessage.bind(child);
    child.postMessage = value => {
      if ((value as { type: string }).type === phase) throw new Error("synthetic closed port");
      original(value);
    };
    const host = new ModelHost(() => { queueMicrotask(() => child.emit("spawn")); return child; }, profile);
    const jobId = "00000000-0000-4000-8000-000000000001";
    const result = host.run(jobId, input, () => {});
    await vi.advanceTimersByTimeAsync(0);
    if (phase === "cancel") expect(() => host.cancel(jobId)).not.toThrow();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).error).toBe(phase === "initialize" ? "ENGINE_UNAVAILABLE" : "ENGINE_CRASHED");
    await host.stop();
  });
}
