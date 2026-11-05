import { afterEach, expect, it, vi } from "vitest";
import { ParentModelEngine } from "./parent-model-engine.js";
const id = "00000000-0000-4000-8000-000000000001";
const input = { prompt: "Synthetic", backend: "cpu" as const };
afterEach(() => vi.useRealTimers());
it("idempotently disposes pending result timers and cannot be reinitialized", async () => {
  vi.useFakeTimers(); const send = vi.fn(), engine = new ParentModelEngine(send);
  engine.initialize("a".repeat(64)); const result = engine.run(id, input, () => {});
  engine.dispose(); engine.dispose(); engine.initialize("b".repeat(64));
  expect((await result).error).toBe("ENGINE_UNAVAILABLE"); expect(vi.getTimerCount()).toBe(0);
  expect((await engine.run(id, input, () => {})).error).toBe("ENGINE_UNAVAILABLE"); expect(send).toHaveBeenCalledTimes(1);
});
for (const phase of ["model.run", "model.cancel"] as const) {
  it("settles a job and removes its timer after channel loss during " + phase, async () => {
    vi.useFakeTimers();
    const engine = new ParentModelEngine(message => {
      if ((message as { type: string }).type === phase) throw new Error("closed port");
    });
    engine.initialize("a".repeat(64));
    const result = engine.run(id, input, () => {});
    if (phase === "model.cancel") expect(() => engine.cancel(id)).not.toThrow();
    expect(await result).toEqual({ text: "", error: "ENGINE_UNAVAILABLE", info: null });
    expect(vi.getTimerCount()).toBe(0);
  });
}
it("a timeout settles even when the cancellation channel has closed", async () => {
  vi.useFakeTimers();
  const engine = new ParentModelEngine(message => {
    if ((message as { type: string }).type === "model.cancel") throw new Error("closed port");
  });
  engine.initialize("a".repeat(64));
  const result = engine.run(id, input, () => {});
  await vi.advanceTimersByTimeAsync(185_000);
  expect((await result).error).toBe("TIMEOUT");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the application queue behind the owner's terminal acknowledgement", async () => {
  vi.useFakeTimers();
  const { AssistantService } = await import("../application/assistant-service.js");
  const sent: { type: string; id: string }[] = [];
  const engine = new ParentModelEngine(message => sent.push(message as typeof sent[number]));
  const session = "b".repeat(64); engine.initialize(session);
  const service = new AssistantService(engine);
  const first = service.submit(input), second = service.submit(input);
  if (!first.ok || !second.ok) throw new Error("Submission failed");
  await vi.advanceTimersByTimeAsync(185_000);
  expect(sent.map(x => x.type)).toEqual(["model.run", "model.cancel"]);
  expect(service.get(second.job.id)).toMatchObject({ job: { state: "queued" } });
  engine.receive({ type: "model.result", session, id: first.job.id,
    reply: { text: "", error: "CANCELLED", info: null } });
  await vi.advanceTimersByTimeAsync(0);
  expect(service.get(first.job.id)).toMatchObject({ job: { state: "error", error: "TIMEOUT" } });
  expect(sent.filter(x => x.type === "model.run").map(x => x.id)).toEqual([first.job.id, second.job.id]);
  engine.receive({ type: "model.result", session, id: second.job.id,
    reply: { text: "", error: "CANCELLED", info: null } });
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("retires the channel when cancellation is not acknowledged, preventing another worker", async () => {
  vi.useFakeTimers();
  const { AssistantService } = await import("../application/assistant-service.js");
  const send = vi.fn();
  const engine = new ParentModelEngine(send); engine.initialize("c".repeat(64));
  const service = new AssistantService(engine);
  const first = service.submit(input), second = service.submit(input);
  if (!first.ok || !second.ok) throw new Error("Submission failed");
  await vi.advanceTimersByTimeAsync(195_000);
  expect(service.get(first.job.id)).toMatchObject({ job: { state: "error", error: "TIMEOUT" } });
  expect(service.get(second.job.id)).toMatchObject({ job: { state: "error", error: "ENGINE_UNAVAILABLE" } });
  expect(send.mock.calls.filter(([x]) => x.type === "model.run")).toHaveLength(1);
  engine.initialize("d".repeat(64));
  expect((await engine.run(id, input, () => {})).error).toBe("ENGINE_UNAVAILABLE");
  expect(vi.getTimerCount()).toBe(0);
});

it("a lost cancellation channel cannot be used for a queued replacement", async () => {
  vi.useFakeTimers();
  const send = vi.fn((message: unknown) => {
    if ((message as { type: string }).type === "model.cancel") throw new Error("closed port");
  });
  const engine = new ParentModelEngine(send); engine.initialize("e".repeat(64));
  const result = engine.run(id, input, () => {});
  engine.cancel(id);
  expect((await result).error).toBe("ENGINE_UNAVAILABLE");
  expect((await engine.run(id, input, () => {})).error).toBe("ENGINE_UNAVAILABLE");
  expect(send.mock.calls.filter(([x]) => (x as { type: string }).type === "model.run")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
