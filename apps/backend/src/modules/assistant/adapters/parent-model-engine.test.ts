import { afterEach, expect, it, vi } from "vitest";
import { ParentModelEngine } from "./parent-model-engine.js";
const id = "00000000-0000-4000-8000-000000000001";
const input = { prompt: "Synthetic", backend: "cpu" as const };
afterEach(() => vi.useRealTimers());
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
