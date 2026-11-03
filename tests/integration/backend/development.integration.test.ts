import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DevelopmentService } from "../../../apps/backend/src/modules/development/application/development-service.js";
import { AssistantService } from "../../../apps/backend/src/modules/assistant/application/assistant-service.js";
import type { EngineReply } from "@tahtiapuri/validation/assistant";
const input = { prompt: "Synteettinen koe", backend: "cpu" as const };
const epoch = "a".repeat(64), clientId = randomUUID();
const identity = { epoch, clientId };
const reply: EngineReply = { text: "synthetic late answer", error: "CANCELLED", info: null };
function setup() {
  const pending: { id: string; resolve(reply: EngineReply): void }[] = [], cancelled: string[] = [];
  const assistant = new AssistantService({ run: id => new Promise(resolve => pending.push({ id, resolve })), cancel: id => cancelled.push(id) });
  const development = new DevelopmentService(assistant);
  return { assistant, development, pending, cancelled };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
it("starts closed and does not accept a caller-supplied session", () => {
  const { development } = setup();
  expect(development.status()).toMatchObject({ status: { enabled: false, connected: false } });
  expect(development.attach(identity)).toMatchObject({ ok: false });
  expect(development.invoke({ ...identity, operation: "probe", input })).toMatchObject({ ok: false });
});
it("shares admission but never exposes UI or another connection's jobs", () => {
  const { assistant, development } = setup(); development.configure(epoch); development.attach(identity);
  const ui = assistant.submit(input), probe = development.invoke({ ...identity, operation: "probe", input });
  if (!ui.ok || !probe.ok || !("job" in probe)) throw new Error();
  expect(development.invoke({ ...identity, operation: "status", input: ui.job.id })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  expect(development.invoke({ ...identity, operation: "cancel", input: ui.job.id })).toMatchObject({ ok: false });
  expect(assistant.get(probe.job.id)).toMatchObject({ ok: false });
  expect(assistant.cancel(probe.job.id)).toMatchObject({ ok: false });
  expect(development.invoke({ ...identity, clientId: randomUUID(), operation: "status", input: probe.job.id })).toMatchObject({ ok: false });
  expect(development.invoke({ ...identity, operation: "probe", input })).toMatchObject({ code: "BUSY" });
  development.configure(null); expect(assistant.get(ui.job.id)).toMatchObject({ job: { state: "loading" } }); assistant.dispose();
});
it("revokes active and queued MCP work and suppresses late results", async () => {
  const { assistant, development, pending, cancelled } = setup(); development.configure(epoch); development.attach(identity);
  const a = development.invoke({ ...identity, operation: "probe", input }), b = development.invoke({ ...identity, operation: "probe", input });
  if (!a.ok || !("job" in a) || !b.ok || !("job" in b)) throw new Error();
  development.configure(null); expect(cancelled).toEqual([a.job.id]);
  pending[0]!.resolve(reply); await tick(); expect(pending).toHaveLength(1);
  development.configure("b".repeat(64)); development.attach({ epoch: "b".repeat(64), clientId });
  expect(development.invoke({ ...identity, operation: "status", input: a.job.id })).toMatchObject({ ok: false });
  expect(development.invoke({ epoch: "b".repeat(64), clientId, operation: "status", input: a.job.id })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  assistant.dispose();
});
it("disconnect cancels its active work while a queued UI job continues", async () => {
  const { assistant, development, pending, cancelled } = setup(); development.configure(epoch); development.attach(identity);
  const a = development.invoke({ ...identity, operation: "probe", input }), ui = assistant.submit(input);
  if (!a.ok || !("job" in a) || !ui.ok) throw new Error();
  development.detach(identity); expect(cancelled).toEqual([a.job.id]);
  pending[0]!.resolve(reply); await tick();
  expect(pending[1]?.id).toBe(ui.job.id);
  expect(assistant.get(ui.job.id)).toMatchObject({ job: { state: "loading" } });
  assistant.dispose();
});
