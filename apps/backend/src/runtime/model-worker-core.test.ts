import { expect, it, vi } from "vitest";
import { ModelWorkerCore, type WorkerEngine } from "./model-worker-core.js";
import type { EngineInfo, EngineReply } from "@tahtiapuri/validation/assistant";
const session = "a".repeat(64);
const id = "00000000-0000-4000-8000-000000000001";
const profile = { file: "synthetic.gguf", bytes: 2497280256, sha256: "b".repeat(64), templateSha256: "c".repeat(64) };
const info: EngineInfo = { backend: "cpu", gpuLayers: 0, loadMs: 1, generationMs: 1, contextSize: 4096, engineVersion: "3.22.2", modelId: "qwen3-4b-q4-k-m" };
const reply: EngineReply = { text: "synthetic", error: null, info };
const initial = { type: "initialize", session, profile, backend: "cpu" };
const run = { type: "run", session, id, input: { prompt: "synthetic", backend: "cpu" } };
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides: Partial<WorkerEngine> = {}) {
  const engine = { initialize: vi.fn(async () => info), generate: vi.fn(async () => reply), dispose: vi.fn(async () => {}), ...overrides };
  const send = vi.fn(), exit = vi.fn(); let clock = 0;
  const core = new ModelWorkerCore(engine, send, exit, (_error, cancelled) => cancelled ? "CANCELLED" : "ENGINE_UNAVAILABLE", () => clock);
  return { engine, send, exit, core, time: (n: number) => { clock = n; } };
}
it("waits for an in-flight load before disposing and suppresses late ready", async () => {
  const load = deferred<EngineInfo>(); const f = fixture({ initialize: vi.fn(() => load.promise) });
  f.core.receive(initial); await drain(); const stopping = f.core.stop();
  expect(f.engine.dispose).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled();
  load.resolve(info); await stopping;
  expect(f.send).not.toHaveBeenCalled(); expect(f.engine.dispose).toHaveBeenCalledTimes(1); expect(f.exit).toHaveBeenCalledWith(0);
});
it("aborts generation, waits for settlement and never disposes under active native work", async () => {
  const work = deferred<EngineReply>(); let signal!: AbortSignal;
  const f = fixture({ generate: vi.fn((_prompt, s) => { signal = s; return work.promise; }) });
  f.core.receive(initial); await drain(); f.core.receive(run); await drain();
  const stopping = f.core.stop(); expect(signal.aborted).toBe(true); expect(f.engine.dispose).not.toHaveBeenCalled();
  work.resolve(reply); await stopping;
  expect(f.send.mock.calls.map(c => (c[0] as { type: string }).type)).toEqual(["ready"]);
  expect(f.engine.dispose).toHaveBeenCalledTimes(1);
});
it("retires the process after an unexpected generation or disposal rejection", async () => {
  const generate = vi.fn().mockRejectedValue(new Error("private path"));
  const f = fixture({ generate }); f.core.receive(initial); await drain(); f.core.receive(run); await drain();
  await f.core.stop(); f.core.receive(run); await drain();
  expect(f.engine.generate).toHaveBeenCalledTimes(1); expect(f.engine.dispose).toHaveBeenCalledTimes(1);
  expect(f.exit).toHaveBeenCalledWith(1);
  expect(f.send.mock.calls.map(c => (c[0] as { type: string }).type)).toEqual(["ready"]);
});
it("an expected error reply leaves the healthy engine available for retry", async () => {
  const generate = vi.fn().mockResolvedValueOnce({ text: "", error: "OUT_OF_MEMORY", info }).mockResolvedValue(reply);
  const f = fixture({ generate }); f.core.receive(initial); await drain(); f.core.receive(run); await drain();
  expect(f.send).toHaveBeenLastCalledWith({ type: "result", session, id, reply: { text: "", error: "OUT_OF_MEMORY", info } });
  f.core.receive(run); await drain(); expect(f.send).toHaveBeenLastCalledWith({ type: "result", session, id, reply });
  await f.core.stop();
});
it("does not start a queued native load after an immediate shutdown", async () => {
  const f = fixture(); f.core.receive(initial); await f.core.stop();
  expect(f.engine.initialize).not.toHaveBeenCalled(); expect(f.engine.dispose).toHaveBeenCalledTimes(1);
});
it("stops safely even when sending a load error fails", async () => {
  const f = fixture({ initialize: vi.fn().mockRejectedValue(new Error("private")) });
  f.send.mockImplementation(() => { throw new Error("closed"); });
  f.core.receive(initial); await drain(); await f.core.stop();
  expect(f.engine.dispose).toHaveBeenCalledTimes(1); expect(f.exit).toHaveBeenCalledTimes(1);
});
it("a closed progress channel aborts work before disposing", async () => {
  const work = deferred<EngineReply>(); let signal!: AbortSignal;
  const f = fixture({ generate: vi.fn((_p, s, progress) => { signal = s; progress(); return work.promise; }) });
  f.core.receive(initial); await drain(); f.send.mockImplementation(() => { throw new Error("closed"); });
  f.core.receive(run); await drain();
  expect(signal.aborted).toBe(true); expect(f.engine.dispose).not.toHaveBeenCalled();
  work.reject(new Error("native cancellation")); await drain(); await f.core.stop();
  expect(f.exit).toHaveBeenCalledWith(1);
});
it("ignores stale sessions, extra authority fields and duplicate initialization", async () => {
  const f = fixture();
  for (const value of [{ ...initial, command: "spawn" }, { ...initial, profile: { ...profile, file: "" } },
    { ...initial, profile: { ...profile, file: "bad\0file" } }, { ...initial, backend: "auto" }]) f.core.receive(value);
  expect(f.engine.initialize).not.toHaveBeenCalled();
  f.core.receive(initial); f.core.receive(initial); await drain();
  for (const value of [{ ...run, session: "d".repeat(64) }, { ...run, mode: "standard-cuda" },
    { ...run, input: { ...run.input, mode: "standard-cuda" } }]) f.core.receive(value);
  expect(f.engine.initialize).toHaveBeenCalledTimes(1); expect(f.engine.generate).not.toHaveBeenCalled();
  await f.core.stop();
});
it("a request cannot change the initialized compute backend", async () => {
  const f = fixture(); f.core.receive(initial); await drain();
  f.core.receive({ ...run, input: { prompt: "synthetic", backend: "cuda" } });
  expect(f.engine.generate).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenLastCalledWith({ type: "result", session, id, reply: { text: "", error: "INVALID_INPUT", info: null } });
  await f.core.stop();
});
it("serializes work and turns a cancelled late answer into CANCELLED", async () => {
  const work = deferred<EngineReply>(); const f = fixture({ generate: vi.fn(() => work.promise) });
  f.core.receive(initial); await drain(); f.core.receive(run); f.core.receive(run); await drain();
  f.core.receive({ type: "cancel", session, id }); work.resolve(reply); await drain();
  expect(f.engine.generate).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenLastCalledWith({ type: "result", session, id, reply: { text: "", error: "CANCELLED", info: null } });
  await f.core.stop();
});
it("malformed heartbeats cannot keep an orphan alive", async () => {
  const f = fixture(); f.core.receive(initial); await drain(); f.time(9000);
  f.core.receive({ type: "ping", session: "d".repeat(64) }); f.core.receive({ type: "ping", session, extra: true });
  f.time(10001); f.core.checkParent(); await drain(); expect(f.exit).toHaveBeenCalledWith(1);
});
it("keeps valid parent liveness and makes stop idempotent including disposal failure", async () => {
  const f = fixture({ dispose: vi.fn().mockRejectedValue(new Error("native")) });
  f.core.receive(initial); await drain(); f.time(9000); f.core.receive({ type: "ping", session });
  f.time(11000); f.core.checkParent(); expect(f.exit).not.toHaveBeenCalled();
  await Promise.all([f.core.stop(), f.core.stop()]);
  expect(f.engine.dispose).toHaveBeenCalledTimes(1); expect(f.exit).toHaveBeenCalledTimes(1); expect(f.exit).toHaveBeenCalledWith(1);
});
it("rejects false engine metadata and oversized replies", async () => {
  const load = fixture({ initialize: vi.fn(async () => ({ ...info, backend: "cuda", gpuLayers: 10 })) });
  load.core.receive(initial); await drain();
  expect(load.send).toHaveBeenCalledWith({ type: "load-error", session, code: "ENGINE_UNAVAILABLE" });
  const f = fixture({ generate: vi.fn(async () => ({ ...reply, text: "x".repeat(8193) })) });
  f.core.receive(initial); await drain(); f.core.receive(run); await drain();
  await f.core.stop(); expect(f.exit).toHaveBeenCalledWith(1);
  expect(f.send.mock.calls.map(c => (c[0] as { type: string }).type)).toEqual(["ready"]);
});
