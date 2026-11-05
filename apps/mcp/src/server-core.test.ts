import { beforeEach, expect, it, vi } from "vitest";
import type { DevelopmentResult } from "@tahtiapuri/validation/development";
import { createDevelopmentServer } from "./server-core.js";

type Handler = (input: Record<string, unknown>, context: { mcpReq: { signal: AbortSignal } }) => Promise<unknown>;
const registered = vi.hoisted(() => new Map<string, { schema: { safeParse(value: unknown): { success: boolean } }; handler: Handler }>());
vi.mock("@modelcontextprotocol/server", () => ({ McpServer: class {
  server = {};
  registerTool(name: string, configuration: { inputSchema: { safeParse(value: unknown): { success: boolean } } }, handler: Handler) {
    registered.set(name, { schema: configuration.inputSchema, handler });
  }
} }));
const jobId = "00000000-0000-4000-8000-000000000001";
const job: DevelopmentResult = { ok: true, job: { id: jobId, state: "queued", text: "", error: null, info: null } };
beforeEach(() => registered.clear());
function fixture() {
  const request = vi.fn< (operation: "status" | "probe" | "cancel", input: unknown) => Promise<DevelopmentResult>>().mockResolvedValue(job);
  const close = vi.fn(); createDevelopmentServer({ request, close });
  const controller = new AbortController();
  const call = (input = { prompt: "synthetic", backend: "cpu" }) => registered.get("model_probe")!.handler(input, { mcpReq: { signal: controller.signal } });
  return { request, close, controller, call };
}
it("preserves the three strict tool schemas", () => {
  fixture(); expect([...registered.keys()].sort()).toEqual(["cancel_probe", "model_probe", "model_status"]);
  const probe = registered.get("model_probe")!.schema, status = registered.get("model_status")!.schema, cancel = registered.get("cancel_probe")!.schema;
  expect(probe.safeParse({ prompt: "x", backend: "cpu" }).success).toBe(true);
  for (const input of [{ prompt: "", backend: "cpu" }, { prompt: "x".repeat(2001), backend: "cpu" }, { prompt: "x", backend: "auto" }, { prompt: "x", backend: "cuda", tools: [] }]) expect(probe.safeParse(input).success).toBe(false);
  expect(status.safeParse({}).success).toBe(true); expect(status.safeParse({ jobId }).success).toBe(true);
  expect(status.safeParse({ jobId, path: "forbidden" }).success).toBe(false); expect(status.safeParse({ jobId: "invalid" }).success).toBe(false);
  expect(cancel.safeParse({ jobId }).success).toBe(true); expect(cancel.safeParse({}).success).toBe(false);
});
it("does not submit a request whose MCP signal is already aborted", async () => {
  const f = fixture(); f.controller.abort();
  expect(await f.call()).toMatchObject({ structuredContent: { ok: false, code: "CANCELLED" }, isError: true });
  expect(f.request).not.toHaveBeenCalled();
});
it("cancels the returned job when abort arrives before the probe reply", async () => {
  const f = fixture(); let reply!: (value: DevelopmentResult) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const pending = f.call(); f.controller.abort(); expect(f.request).toHaveBeenCalledTimes(1);
  reply(job); await pending;
  expect(f.request.mock.calls).toEqual([["probe", { prompt: "synthetic", backend: "cpu" }], ["cancel", jobId]]);
});
it("removes the abort listener once the probe call has settled", async () => {
  const f = fixture(); await f.call(); f.controller.abort(); expect(f.request).toHaveBeenCalledTimes(1);
});
