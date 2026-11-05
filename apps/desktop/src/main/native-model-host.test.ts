import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { NativeModelHost, type NativeBrokerPort } from "./native-model-host.js";
import { NativePreparationError, type PreparedNativeResources } from "./native-model-resources.js";
const id = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
const input = { prompt: "Jupiter", backend: "cpu" as const };
function words(...n: number[]) { const b = Buffer.alloc(n.length * 4); n.forEach((v, i) => b.writeUInt32LE(v, i * 4)); return b; }
const launch = { type: "launched", requestedPolicy: "lpac", pid: 1234, appContainer: true, lpac: null, lpacQueryError: 87, lpacQueryBytes: 0,
  capabilities: 0, integrity: 4096, sid: "S-1-15-2-1-2-3-4-5-6-7", job: true, activeProcessLimit: 1, affinity: 1, priority: "BelowNormal",
  jobCommitBytes: 6 * 1024 ** 3, sentinelInherited: false, aclsVerified: true, networkVerified: false };
const result = { type: "result", case: "desktop", passed: true, jobEmpty: true, profileDeleted: true, watchdogReason: 0, failure: "", error: 0 };
class Broker extends EventEmitter implements NativeBrokerPort {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  requests: Buffer[] = []; killed = false; exited = false; loading = false; generating = false; closing = false;
  constructor(readonly options: { holdLoad?: boolean; holdGenerate?: boolean; holdClose?: boolean; corrupt?: boolean } = {}) {
    super(); this.stdin.on("data", (bytes: Buffer) => { this.requests.push(Buffer.from(bytes)); queueMicrotask(() => this.request(bytes)); });
    queueMicrotask(() => { this.emit("spawn"); this.row(launch); });
  }
  row(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
  frame(op: number, id: number, body = Buffer.alloc(0)) { this.row({ type: "frame", op, id, bodyHex: body.toString("hex") }); }
  request(bytes: Buffer) {
    if (this.exited) return;
    const op = bytes.readUInt16LE(6), id = bytes.readUInt32LE(8);
    if (this.options.corrupt) { this.stdout.write("sensitive invalid data\n"); return; }
    if (op === 1) this.frame(129, id);
    if (op === 11) { this.loading = true; this.frame(131, id); if (!this.options.holdLoad) this.loaded(id); }
    if (op === 3) { this.generating = true; this.frame(131, id); this.frame(137, id); if (!this.options.holdGenerate) this.done(id); }
    if (op === 6) { this.closing = true; if (!this.options.holdClose) this.close(id); }
  }
  loaded(id = 2) { this.frame(136, id, Buffer.concat([words(4096, 32, 32, 1, 1, 0), Buffer.from("57f1fd00f0013a2be96aa79b857391f27e23df5b5f847072b524c897e24d0361")])); }
  done(id = 3) { this.frame(135, id, Buffer.concat([words(100, 2, 0, 0), Buffer.from("Jupiter")])); }
  close(id: number) { this.frame(134, id, words(1, 0, 0)); this.row(result); this.exit(0); }
  exit(code: number) { if (this.exited) return; this.exited = true; this.stdout.end(); this.stderr.end(); this.emit("close", code); }
  kill() { this.killed = true; this.exit(1); return true; }
}
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function setup(options: ConstructorParameters<typeof Broker>[0] = {}, cleanup = vi.fn(async () => {})) {
  const brokers: Broker[] = [], budgets: number[] = [];
  const resources: PreparedNativeResources = { root: "synthetic", broker: "synthetic.exe", profile: "synthetic", cleanup };
  const prepare = vi.fn(async (_signal: AbortSignal) => resources);
  const host = new NativeModelHost({ prepare, launch: (_resources, _session, budget) => {
    budgets.push(budget); const broker = new Broker(options); brokers.push(broker); return broker;
  } });
  return { host, prepare, brokers, budgets, cleanup, resources };
}
afterEach(() => vi.useRealTimers());
it("runs fresh processes sequentially and returns native identity only after cleanup", async () => {
  const s = setup(); const a = await s.host.run(id, input, () => {}), b = await s.host.run(other, input, () => {});
  expect(a).toMatchObject({ text: "Jupiter", error: null, info: { backend: "cpu", engineVersion: "llama.cpp-v0.9.0-cpu" } });
  expect(b.text).toBe("Jupiter"); expect(s.cleanup).toHaveBeenCalledTimes(2); expect(s.brokers).toHaveLength(2);
  expect(s.brokers[0]!.requests[0]!.subarray(16, 48)).not.toEqual(s.brokers[1]!.requests[0]!.subarray(16, 48));
  expect(s.budgets.every(n => n >= 1000 && n <= 175000)).toBe(true);
});
it("does not release the model port until staging cleanup completes", async () => {
  let release!: () => void; const cleanup = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const s = setup({}, cleanup); let returned = false;
  const promise = s.host.run(id, input, () => {}).then(reply => { returned = true; return reply; }); await settle();
  expect(cleanup).toHaveBeenCalledOnce(); expect(returned).toBe(false);
  expect((await s.host.run(other, input, () => {})).error).toBe("BUSY"); expect(s.prepare).toHaveBeenCalledOnce();
  release(); expect((await promise).error).toBeNull();
});
it("rejects CUDA and malformed Unicode before preparing resources", async () => {
  const s = setup(); expect((await s.host.run(id, { ...input, backend: "cuda" }, () => {})).error).toBe("ENGINE_UNAVAILABLE");
  expect((await s.host.run(id, { ...input, prompt: "\ud800" }, () => {})).error).toBe("INVALID_INPUT"); expect(s.prepare).not.toHaveBeenCalled();
});
it("cancels a preparation and can retry after verified preparatory cleanup", async () => {
  const s = setup(); s.prepare.mockImplementationOnce(signal => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new NativePreparationError(true)), { once: true });
  }));
  const pending = s.host.run(id, input, () => {}); s.host.cancel(other); s.host.cancel(id);
  expect((await pending).error).toBe("CANCELLED"); expect(s.brokers).toHaveLength(0);
  expect((await s.host.run(other, input, () => {})).error).toBeNull();
});
it("permanently closes after uncertain preparatory cleanup", async () => {
  const s = setup(); s.prepare.mockRejectedValueOnce(new NativePreparationError(false));
  expect((await s.host.run(id, input, () => {})).error).toBe("ENGINE_UNAVAILABLE");
  expect((await s.host.run(other, input, () => {})).error).toBe("ENGINE_UNAVAILABLE"); expect(s.prepare).toHaveBeenCalledOnce();
});
for (const phase of ["load", "generate"] as const) it("cancels during " + phase + " and allows another fresh process after cleanup", async () => {
  const s = setup(phase === "load" ? { holdLoad: true } : { holdGenerate: true });
  const pending = s.host.run(id, input, () => {}); await settle();
  expect(phase === "load" ? s.brokers[0]!.loading : s.brokers[0]!.generating).toBe(true);
  s.host.cancel(id); s.host.cancel(id); expect((await pending).error).toBe("CANCELLED"); expect(s.cleanup).toHaveBeenCalledOnce();
  const next = s.host.run(other, input, () => {}); await settle(); s.host.cancel(other); await next; expect(s.brokers).toHaveLength(2);
});
it("returns cancellation when requested after generation while cleanup is pending", async () => {
  let release!: () => void; const s = setup({}, vi.fn(() => new Promise<void>(resolve => { release = resolve; })));
  const pending = s.host.run(id, input, () => {}); await settle(); s.host.cancel(id); release();
  expect((await pending).error).toBe("CANCELLED");
});
it("kills and permanently closes a malformed protocol without claiming cleanup", async () => {
  const s = setup({ corrupt: true }); expect((await s.host.run(id, input, () => {})).error).toBe("ENGINE_CRASHED");
  expect(s.brokers[0]!.killed).toBe(true); expect(s.cleanup).not.toHaveBeenCalled();
  expect((await s.host.run(other, input, () => {})).error).toBe("ENGINE_UNAVAILABLE"); expect(s.brokers).toHaveLength(1);
});
it("rejects partial output at EOF and retains uncertain staging", async () => {
  const s = setup({ holdLoad: true }); const pending = s.host.run(id, input, () => {}); await settle();
  s.brokers[0]!.stdout.write('{"type":'); s.brokers[0]!.exit(0);
  expect((await pending).error).toBe("ENGINE_CRASHED"); expect(s.cleanup).not.toHaveBeenCalled();
});
it("a cleanup failure closes the runtime without a second deletion attempt", async () => {
  const s = setup({}, vi.fn(async () => { throw new Error("cleanup failed"); }));
  expect((await s.host.run(id, input, () => {})).error).toBe("ENGINE_CRASHED"); expect(s.cleanup).toHaveBeenCalledOnce();
  expect((await s.host.run(other, input, () => {})).error).toBe("ENGINE_UNAVAILABLE");
});
it("reserves cleanup time and kills a worker which never acknowledges cancellation", async () => {
  vi.useFakeTimers(); const s = setup({ holdGenerate: true, holdClose: true }); const pending = s.host.run(id, input, () => {}); await settle();
  await vi.advanceTimersByTimeAsync(170000); expect(s.brokers[0]!.closing).toBe(true);
  await vi.advanceTimersByTimeAsync(5000); expect((await pending).error).toBe("TIMEOUT"); expect(s.brokers[0]!.killed).toBe(true);
  expect(s.cleanup).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  expect((await s.host.run(other, input, () => {})).error).toBe("ENGINE_UNAVAILABLE");
});
it("stop waits for cooperative shutdown and keeps the host closed", async () => {
  const s = setup({ holdGenerate: true }); const pending = s.host.run(id, input, () => {}); await settle();
  await s.host.stop(); expect((await pending).error).toBe("CANCELLED"); expect(s.cleanup).toHaveBeenCalledOnce();
  expect((await s.host.run(other, input, () => {})).error).toBe("ENGINE_UNAVAILABLE");
});

for (const stream of ["stdout", "stderr"] as const) it("handles a " + stream + " read error without an unhandled main-process exception", async () => {
  const s = setup({ holdLoad: true }); const pending = s.host.run(id, input, () => {}); await settle();
  expect(() => s.brokers[0]![stream].emit("error", new Error("pipe error"))).not.toThrow();
  expect((await pending).error).toBe("ENGINE_CRASHED"); expect(s.cleanup).not.toHaveBeenCalled();
  expect((await s.host.run(other, input, () => {})).error).toBe("ENGINE_UNAVAILABLE");
});

it("does not certify a clean stop after a prior fatal protocol or cleanup failure", async () => {
  for (const s of [setup({ corrupt: true }), setup({}, vi.fn(async () => { throw new Error("cleanup failed"); }))]) {
    await s.host.run(id, input, () => {});
    await expect(s.host.stop()).rejects.toThrow("Native runtime exit unconfirmed.");
  }
});
