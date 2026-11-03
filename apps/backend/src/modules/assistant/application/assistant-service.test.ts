import { expect, it } from "vitest";
import { AssistantService } from "./assistant-service.js";
import type { EngineReply, ModelInput } from "@tahtiapuri/validation/assistant";
const input: ModelInput = { prompt: "Synteettinen kysymys", backend: "cpu" };
const reply: EngineReply = { text: "Synteettinen vastaus", error: null, info: { backend: "cpu", gpuLayers: 0, loadMs: 1, generationMs: 1, contextSize: 4096, engineVersion: "3.22.2", modelId: "qwen3-4b-q4-k-m" } };
function fixture() {
  const pending: { id: string; resolve(reply: EngineReply): void }[] = []; const cancelled: string[] = [];
  const service = new AssistantService({ run: (id, _input, onRunning) => { onRunning(); return new Promise(resolve => pending.push({ id, resolve })); }, cancel: id => cancelled.push(id) });
  return { service, pending, cancelled };
}
it("bounds admission to one active and one queued request", () => {
  const { service, pending } = fixture(); service.submit(input); service.submit(input);
  expect(service.submit(input)).toEqual({ ok: false, code: "BUSY" }); expect(pending).toHaveLength(1);
  service.dispose();
});
it("cancels only the specified job and suppresses a late native answer", async () => {
  const { service, pending, cancelled } = fixture(); const result = service.submit(input); if (!result.ok) throw new Error();
  service.cancel(result.job.id); expect(cancelled).toEqual([result.job.id]); pending[0]!.resolve(reply);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(service.get(result.job.id)).toMatchObject({ job: { state: "cancelled", text: "", error: "CANCELLED" } });
});
it("never executes a queued request cancelled before it begins", async () => {
  const { service, pending } = fixture(); service.submit(input); const queued = service.submit(input); if (!queued.ok) throw new Error();
  service.cancel(queued.job.id); pending[0]!.resolve(reply); await new Promise(resolve => setTimeout(resolve, 0));
  expect(pending).toHaveLength(1); service.dispose();
});
it("rejects unknown job IDs and stops accepting work after disposal", () => {
  const { service } = fixture(); expect(service.cancel("not-owned")).toEqual({ ok: false, code: "INVALID_INPUT" });
  service.dispose(); expect(service.submit(input)).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
});
