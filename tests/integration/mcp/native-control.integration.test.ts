import { createConnection, createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NativeMainConnection } from "../../../apps/desktop/src/main/native-main-connection.js";
import { NativeDevelopmentAdmission } from "../../../apps/desktop/src/main/native-development-admission.js";
import { ControlKind, NativeControlReader, encodeControlFrame, type ControlFrame } from "../../../apps/desktop/src/main/native-development-wire.js";
import { DevelopmentService } from "../../../apps/backend/src/modules/development/application/development-service.js";
import { AssistantService } from "../../../apps/backend/src/modules/assistant/application/assistant-service.js";
import type { BackendController } from "../../../apps/desktop/src/main/backend-controller.js";
import { isDevelopmentIdentity, isDevelopmentInvocation, type BridgeCommand, type DevelopmentResult } from "@tahtiapuri/validation/development";
import type { EngineReply } from "@tahtiapuri/validation/assistant";

const epoch = "a".repeat(64);
const input = { prompt: "Synthetic control-channel ownership test", backend: "cpu" as const };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function jobId(result: DevelopmentResult) {
  if (!result.ok || !("job" in result)) throw new Error("Expected admitted job"); return result.job.id;
}
async function fixture() {
  const jobs: { id: string; resolve(value: EngineReply): void }[] = [], cancelled: string[] = [];
  const assistant = new AssistantService({ run: id => new Promise(resolve => jobs.push({ id, resolve })), cancel: id => cancelled.push(id) });
  const service = new DevelopmentService(assistant); service.configure(epoch);
  const operations: string[] = [];
  const development: BackendController["development"] = async (operation, value) => {
    operations.push(operation);
    if (operation === "development.attach" && isDevelopmentIdentity(value)) return service.attach(value);
    if (operation === "development.detach" && isDevelopmentIdentity(value)) return service.detach(value);
    if (operation === "development.invoke" && isDevelopmentInvocation(value)) return service.invoke(value);
    throw new Error("Unexpected fixture operation");
  };
  const admission = new NativeDevelopmentAdmission({ development }, epoch, 1000);
  const ticket = admission.issueTicket()!;
  let connection!: NativeMainConnection, accepted!: () => void;
  const connected = new Promise<void>(resolve => { accepted = resolve; });
  const server = createServer({ allowHalfOpen: true }, stream => {
    connection = new NativeMainConnection(stream, admission, {
      consume: async value => { expect(value).toEqual(ticket); },
      revoke: async () => { operations.push("epoch.revoke"); service.configure(null); return true; },
    });
    accepted();
  });
  const name = process.platform === "win32" ? "\\\\.\\pipe\\tahtiapuri-control-test-" + randomUUID() : join(tmpdir(), "tahtiapuri-" + randomUUID() + ".sock");
  let client: Socket | undefined;
  const reader = new NativeControlReader("from-main", frame => {
    const waiter = waiters.shift(); if (waiter) waiter.resolve(frame); else frames.push(frame);
  }, () => { wireFailed = true; });
  const frames: ControlFrame[] = [], waiters: { resolve(value: ControlFrame): void; reject(error: Error): void }[] = [];
  let sequence = 1, wireFailed = false;
  cleanups.push(async () => {
    reader.stop(); client?.destroy();
    if (connection) { const result = connection.stop(); await result; }
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("Fixture closed"));
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.configure(null); assistant.dispose();
    for (const job of jobs) job.resolve({ text: "", error: "CANCELLED", info: null });
    await tick();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(name, resolve); });
  client = createConnection(name);
  client.on("error", () => {}); client.on("data", chunk => reader.write(chunk)); client.on("end", () => reader.end());
  await connected;
  const send = (kind: typeof ControlKind[keyof typeof ControlKind], body = Buffer.alloc(0)) => {
    client!.write(encodeControlFrame({ kind, body }, sequence++, "to-main"));
  };
  const next = async () => {
    if (frames.length) return frames.shift()!;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<ControlFrame>((resolve, reject) => {
        const waiter = { resolve, reject }; waiters.push(waiter);
        timer = setTimeout(() => {
          const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Fixture frame deadline"));
        }, 3000);
      });
    } finally { clearTimeout(timer); }
  };
  send(ControlKind.hello, Buffer.from(ticket.generation + ticket.token, "hex"));
  expect((await next()).kind).toBe(ControlKind.accept);
  const request = async (operation: BridgeCommand["operation"], value: BridgeCommand["input"]): Promise<DevelopmentResult> => {
    const id = randomUUID(); send(ControlKind.request, Buffer.from(JSON.stringify({ id, operation, input: value })));
    const frame = await next(); expect(frame.kind).toBe(ControlKind.response);
    const response = JSON.parse(frame.body.toString()) as { id: string; result: DevelopmentResult };
    expect(response.id).toBe(id); return response.result;
  };
  return { connection, client, admission, assistant, service, operations, jobs, cancelled, request, send, next,
    wireFailed: () => wireFailed };
}
it("uses a real local pipe and actual services for all four UI/MCP ownership boundaries", async () => {
  const f = await fixture();
  const ui = jobId(f.assistant.submit(input));
  const mcp = jobId(await f.request("probe", input));
  expect(await f.request("status", ui)).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(await f.request("cancel", ui)).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(f.assistant.get(mcp)).toEqual({ ok: false, code: "INVALID_INPUT" });
  expect(f.assistant.cancel(mcp)).toEqual({ ok: false, code: "INVALID_INPUT" });
  f.send(ControlKind.clean);
  expect(await f.connection.closed).toMatchObject({ failed: false, brokerCleanupReported: true, backendDetachSettled: true, epochRevoked: true, streamClosed: true });
  expect(f.operations.slice(-2)).toEqual(["development.detach", "epoch.revoke"]);
  expect(f.service.status()).toMatchObject({ status: { enabled: false, connected: false } });
  expect(f.assistant.get(ui)).toMatchObject({ job: { state: "loading" } });
  expect(f.cancelled).toEqual([]); expect(f.admission.issueTicket()).toBeUndefined(); expect(f.wireFailed()).toBe(false);
});
it("STOP releases active MCP work while the queued UI work survives", async () => {
  const f = await fixture();
  const mcp = jobId(await f.request("probe", input)), ui = jobId(f.assistant.submit(input));
  const closed = f.connection.stop(); expect((await f.next()).kind).toBe(ControlKind.stop);
  expect(f.cancelled).toEqual([mcp]);
  f.jobs[0]!.resolve({ text: "Late synthetic MCP result", error: null, info: null });
  await tick(); expect(f.jobs.map(job => job.id)).toEqual([mcp, ui]);
  expect(f.assistant.get(ui)).toMatchObject({ job: { state: "loading", text: "" } });
  f.send(ControlKind.clean); expect((await closed).failed).toBe(false);
});
it("real pipe EOF cancels the owner's work but does not claim native cleanup", async () => {
  const f = await fixture(); const mcp = jobId(await f.request("probe", input));
  f.client.end();
  expect(await f.connection.closed).toMatchObject({ failed: true, brokerCleanupReported: false, backendDetachSettled: true, epochRevoked: true, streamClosed: true });
  expect(f.cancelled).toEqual([mcp]); expect(f.admission.issueTicket()).toBeUndefined();
});
