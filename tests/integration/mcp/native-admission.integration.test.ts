import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { NativeDevelopmentAdmission } from "../../../apps/desktop/src/main/native-development-admission.js";
import { DevelopmentService } from "../../../apps/backend/src/modules/development/application/development-service.js";
import { AssistantService } from "../../../apps/backend/src/modules/assistant/application/assistant-service.js";
import type { BackendController } from "../../../apps/desktop/src/main/backend-controller.js";
import { isDevelopmentIdentity, isDevelopmentInvocation, type DevelopmentResult } from "@tahtiapuri/validation/development";
import type { EngineReply } from "@tahtiapuri/validation/assistant";

const input = { prompt: "Synthetic isolated ownership test", backend: "cpu" as const };
const epoch = "a".repeat(64);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture(gates: { attachAck?: Promise<void>; detach?: Promise<void> } = {}) {
  const pending: { id: string; resolve(value: EngineReply): void }[] = [], cancelled: string[] = [];
  const assistant = new AssistantService({ run: id => new Promise(resolve => pending.push({ id, resolve })), cancel: id => cancelled.push(id) });
  const service = new DevelopmentService(assistant); service.configure(epoch);
  const operations: string[] = [];
  const development: BackendController["development"] = async (operation, value) => {
    operations.push(operation);
    if (operation === "development.attach" && isDevelopmentIdentity(value)) {
      const result = service.attach(value); await gates.attachAck; return result;
    }
    if (operation === "development.detach" && isDevelopmentIdentity(value)) {
      await gates.detach; return service.detach(value);
    }
    if (operation === "development.invoke" && isDevelopmentInvocation(value)) return service.invoke(value);
    throw new Error("Unexpected fixture request");
  };
  const admission = new NativeDevelopmentAdmission({ development }, epoch, 1000);
  const ticket = admission.issueTicket()!;
  const lease = admission.claim(ticket.generation, ticket.token)!;
  cleanups.push(async () => {
    service.configure(null); assistant.dispose();
    for (const job of pending) job.resolve({ text: "", error: "CANCELLED", info: null });
    await tick();
  });
  return { assistant, service, admission, ticket, lease, pending, cancelled, operations };
}
function jobId(result: DevelopmentResult) {
  if (!result.ok || !("job" in result)) throw new Error("Expected admitted job");
  return result.job.id;
}
it("preserves all four UI/MCP ownership prohibitions through the native admission gate", async () => {
  const f = fixture(); expect(await f.lease.ready).toBe(true);
  const ui = jobId(f.assistant.submit(input));
  const mcp = jobId(await f.lease.invoke({ id: randomUUID(), operation: "probe", input }));
  expect(await f.lease.invoke({ id: randomUUID(), operation: "status", input: ui })).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(await f.lease.invoke({ id: randomUUID(), operation: "cancel", input: ui })).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(f.assistant.get(mcp)).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(f.assistant.cancel(mcp)).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(await f.lease.close()).toBe(true);
  expect(f.assistant.get(ui)).toMatchObject({ ok: true, job: { state: "loading" } });
  expect(f.cancelled).toEqual([]); // Queued MCP work was removed; active UI work continues.
  f.pending[0]!.resolve({ text: "UI-only synthetic result", error: null, info: null }); await tick();
  expect(f.pending.map(job => job.id)).toEqual([ui]);
  expect(f.assistant.get(ui)).toMatchObject({ job: { text: "UI-only synthetic result" } });
});
it("holds the backend's single client slot through delayed attach acknowledgement and detach", async () => {
  const attach = barrier(), detach = barrier();
  const f = fixture({ attachAck: attach.wait, detach: detach.wait });
  try {
    await tick(); expect(f.service.status()).toMatchObject({ status: { connected: true } });
    const closed = f.lease.close();
    expect(f.admission.issueTicket()).toBeUndefined();
    expect(f.admission.claim(f.ticket.generation, f.ticket.token)).toBeUndefined();
    attach.release(); expect(await f.lease.ready).toBe(false); await tick();
    expect(f.operations).toEqual(["development.attach", "development.detach"]);
    expect(f.admission.issueTicket()).toBeUndefined();
    expect(f.service.status()).toMatchObject({ status: { connected: true } });
    detach.release(); expect(await closed).toBe(true);
    expect(f.service.status()).toMatchObject({ status: { connected: false } });
    const next = f.admission.issueTicket()!; const replacement = f.admission.claim(next.generation, next.token)!;
    expect(await replacement.ready).toBe(true); expect(await f.lease.close()).toBe(true);
    expect(f.service.status()).toMatchObject({ status: { connected: true } });
    expect(await replacement.close()).toBe(true);
  } finally { attach.release(); detach.release(); await f.admission.disable(); }
});
it("disconnect cancels active MCP work, continues queued UI work and fences the old job after reconnect", async () => {
  const f = fixture(); expect(await f.lease.ready).toBe(true);
  const oldJob = jobId(await f.lease.invoke({ id: randomUUID(), operation: "probe", input }));
  const ui = jobId(f.assistant.submit(input));
  expect(await f.lease.close()).toBe(true); expect(f.cancelled).toEqual([oldJob]);
  const next = f.admission.issueTicket()!; const replacement = f.admission.claim(next.generation, next.token)!;
  expect(await replacement.ready).toBe(true);
  for (const operation of ["status", "cancel"] as const)
    expect(await replacement.invoke({ id: randomUUID(), operation, input: oldJob })).toEqual({ ok: false, code: "INVALID_INPUT" });
  f.pending[0]!.resolve({ text: "Late MCP-only synthetic result", error: null, info: null }); await tick();
  expect(f.pending.map(job => job.id)).toEqual([oldJob, ui]);
  expect(f.assistant.get(ui)).toMatchObject({ job: { state: "loading", text: "" } });
  expect(await f.lease.invoke({ id: randomUUID(), operation: "status", input: oldJob })).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
  expect(await replacement.close()).toBe(true);
});
