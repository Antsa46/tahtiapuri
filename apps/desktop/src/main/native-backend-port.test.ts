import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KINDS, frame, encodeJson } from "@tahtiapuri/backend-transport";
import { NativeBackendPort, isNativeBackendPrepared, isNativeBackendResult, type NativeBackendProcess } from "./native-backend-port.js";

const owner = "a".repeat(64), child = "b".repeat(64), run = "c".repeat(32), session = "d".repeat(64);
const prepared = () => ({ pid: 1234, childNonce: child, requestedPolicy: "lpac-registryRead", creationMode: "detached-backend", appContainer: true,
  lpac: null, lpacQueryError: 87, lpacQueryBytes: 0, capabilitySids: [{ sid: "S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681", attributes: 4 }],
  integrity: 4096, job: true, activeProcessLimit: 1, affinity: 1, priority: "BelowNormal", processMemoryBytes: 536870912, aclsVerified: true, consoleAbsent: true, networkVerified: false });
const result = () => ({ sessionOutcome: "normal", cleanupOutcome: "clean", reason: "none", error: 0, runNonce: run, childCreated: true, childResumed: true,
  exitCode: 0, jobEmpty: true, persistentAclRestored: true, profileDeleted: true, sessionRemoved: true, journalClean: true, stderrComplete: true, consoleBefore: true, consoleAfterFirstFrame: true });
const ready = () => ({ type: "ready", protocol: 1, session });
const ping = () => ({ type: "response", protocol: 1, session, id: "00000000-0000-4000-8000-000000000001", operation: "runtime.ping", result: null });
class MemoryProcess extends EventEmitter implements NativeBackendProcess {
  pid = 1000; stdout = new PassThrough(); stderr = new PassThrough(); killed = false;
  writes: Buffer[] = []; hold = false; release: (() => void) | undefined;
  stdin = new Writable({ write: (bytes: Buffer, _encoding, callback) => {
    this.writes.push(Buffer.from(bytes));
    if (this.hold) this.release = () => { this.release = undefined; callback(); }; else callback();
  } });
  sequence = 1n; childSequence = 1n;
  row(kind: number, value?: unknown) { this.stdout.write(frame(kind, this.sequence++, owner, value === undefined ? Buffer.alloc(0) : encodeJson(value, 65536))); }
  app(value: unknown) { const bytes = frame(KINDS.APP, this.childSequence++, child, encodeJson(value, 16 * 1024 ** 2)); this.chunk(bytes); }
  chunk(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 65536) this.stdout.write(frame(KINDS.CHILD_CHUNK, this.sequence++, owner, bytes.subarray(offset, offset + 65536))); }
  kill() { this.killed = true; return true; }
  async close(code = 0) { this.stdout.end(); this.stderr.end(); await settle(); this.emit("exit", code, null); this.emit("close", code, null); await settle(); }
}
async function settle() { await vi.advanceTimersByTimeAsync(0); }
const live: MemoryProcess[] = [];
function setup(recover = false) {
  const process = new MemoryProcess(); live.push(process);
  const port = new NativeBackendPort(process, { ownerNonce: owner, ...(recover ? { recover: true } : { runNonce: run }) });
  return { process, port };
}
async function started() {
  const s = setup();
  s.port.on("spawn", () => s.port.postMessage({ type: "initialize", protocol: 1, session }));
  s.process.row(KINDS.PREPARED, prepared()); await settle(); s.process.row(KINDS.STARTED); await settle(); return s;
}
async function running() { const s = await started(); s.process.app(ready()); await settle(); return s; }
async function shutdown(s: Awaited<ReturnType<typeof running>>) {
  s.port.postMessage({ type: "request", protocol: 1, session, id: "00000000-0000-4000-8000-000000000001", operation: "runtime.shutdown", expiresAtUnixMs: Date.now() + 1000 });
  s.process.app({ ...ping(), operation: "runtime.shutdown" }); await settle();
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { for (const process of live.splice(0)) { process.emit("close", 1); process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy(); } await settle(); vi.useRealTimers(); });

it("defers spawn/initialize until STARTED and sends exactly one empty START", async () => {
  const { port, process } = setup(), spawn = vi.fn(); port.on("spawn", spawn);
  process.row(KINDS.PREPARED, prepared()); await settle();
  expect(await port.prepared).toMatchObject({ pid: 1234, lpac: null }); expect(spawn).not.toHaveBeenCalled();
  expect(process.writes).toHaveLength(1); expect(process.writes[0]!.readUInt16LE(6)).toBe(KINDS.START); expect(process.writes[0]).toHaveLength(56);
  process.row(KINDS.STARTED); expect(spawn).toHaveBeenCalledOnce();
});
it("requires first APP to be the actual ready schema with the initialized session", async () => {
  const s = await started(); s.process.app({ ...ready(), extra: true });
  await expect(s.port.completion).rejects.toThrow("protocol");
});
it("rejects worker receipt spoofing inside an APP frame", async () => {
  const s = await running(); s.process.app(result()); await expect(s.port.completion).rejects.toThrow("protocol");
});
it("keeps the 10 second typed-ready timer despite diagnostic activity and raw heartbeats", async () => {
  const s = await started();
  await vi.advanceTimersByTimeAsync(9000); s.process.row(KINDS.STDERR, "untrusted diagnostic");
  await vi.advanceTimersByTimeAsync(1000); await expect(s.port.completion).rejects.toThrow("typed ready");
  expect(s.process.writes.some(bytes => bytes.readUInt16LE(6) === KINDS.HEARTBEAT && bytes.length === 56)).toBe(true);
});
it("uses an independent 30 second preparation timer", async () => {
  const s = setup(); await vi.advanceTimersByTimeAsync(30000); await expect(s.port.prepared).rejects.toThrow("preparation");
});
it("lets an idle ready process live past the old frame quota and 20 second lifetime", async () => {
  const s = await running(), receive = vi.fn(); s.port.on("message", receive);
  for (let i = 0; i < 300; i++) s.process.app(ping());
  await vi.advanceTimersByTimeAsync(22_000); expect(receive).toHaveBeenCalledTimes(300); expect(s.process.killed).toBe(false);
  const heartbeat = s.process.writes.filter(bytes => bytes.readUInt16LE(6) === KINDS.HEARTBEAT);
  expect(heartbeat.length).toBeGreaterThan(5); expect(heartbeat.every(bytes => typeof bytes.readBigUInt64LE(8) === "bigint")).toBe(true);
});
it("rejects a 64 bit sequence mismatch without truncating it to a 32 bit value", async () => {
  const s = setup(); s.process.stdout.write(frame(KINDS.PREPARED, 0x1_0000_0001n, owner, encodeJson(prepared(), 65536)));
  await expect(s.port.completion).rejects.toThrow("header");
});
it("keeps RESULT errors sticky when null is followed by a plausible clean receipt", async () => {
  const s = await running(); s.process.row(KINDS.RESULT, null); s.process.row(KINDS.RESULT, result()); await s.process.close();
  await expect(s.port.completion).rejects.toThrow("protocol");
});
it.each([null, { unexpected: true }])("immediately terminates a consumed invalid RESULT without waiting for another receipt: %j", async value => {
  const s = await running(); let physicallyClosed = false;
  void s.port.closure.then(() => { physicallyClosed = true; });
  s.process.row(KINDS.RESULT, value);
  expect(s.process.killed).toBe(true); await expect(s.port.completion).rejects.toThrow("protocol");
  await settle(); expect(physicallyClosed).toBe(false);
  await s.process.close(1); await s.port.closure; expect(physicallyClosed).toBe(true);
});
it("rejects duplicate clean receipts even before actual process closure", async () => {
  const s = await running(); await shutdown(s); await s.port.closeChildInput(); s.process.row(KINDS.RESULT, result()); s.process.row(KINDS.RESULT, result()); await s.process.close();
  await expect(s.port.completion).rejects.toThrow("protocol");
});
it("keeps actual process exit distinct from the cleanup receipt and pipe closure", async () => {
  const s = await running(), exited = vi.fn(), completed = vi.fn(); s.port.on("exit", exited); void s.port.completion.then(completed);
  await shutdown(s); await s.port.closeChildInput(); s.process.row(KINDS.RESULT, result()); await settle(); expect(completed).not.toHaveBeenCalled(); expect(exited).not.toHaveBeenCalled();
  await s.process.close(); expect(exited).toHaveBeenCalledOnce(); expect(completed).toHaveBeenCalledOnce();
});
it("rejects actual exit zero when the authoritative result is missing", async () => {
  const s = await running(); await s.process.close(); await expect(s.port.completion).rejects.toThrow("missing");
});
it("does not infer stderr completion from zero diagnostic bytes", async () => {
  const s = await running(); await shutdown(s); await s.port.closeChildInput(); s.process.row(KINDS.RESULT, { ...result(), stderrComplete: false }); await s.process.close();
  await expect(s.port.completion).rejects.toThrow("protocol");
});
it("preserves a clean cleanup receipt for a failed application session", async () => {
  const s = await running(); s.port.kill(); s.process.row(KINDS.RESULT, { ...result(), sessionOutcome: "failed", reason: "owner-kill", error: 995, exitCode: 42 }); await s.process.close(1);
  expect(await s.port.completion).toMatchObject({ sessionOutcome: "failed", cleanupOutcome: "clean" });
});
it("cannot accept a clean receipt with an unproven journal/Job flag", () => {
  expect(isNativeBackendResult({ ...result(), jobEmpty: false }, run)).toBe(false);
  expect(isNativeBackendResult({ ...result(), journalClean: false }, run)).toBe(false);
  expect(isNativeBackendPrepared({ ...prepared(), childNonce: owner }, owner)).toBe(false);
  expect(isNativeBackendPrepared({ ...prepared(), lpac: true }, owner)).toBe(false);
});
it("rejects partial-frame stalls and preserves the 15 second overall frame age", async () => {
  const s = setup(); const bytes = frame(KINDS.PREPARED, 1n, owner, encodeJson(prepared(), 65536));
  s.process.stdout.write(bytes.subarray(0, 1));
  for (let i = 1; i < 15; i++) { await vi.advanceTimersByTimeAsync(1000); s.process.stdout.write(bytes.subarray(i, i + 1)); }
  await vi.advanceTimersByTimeAsync(1000); await expect(s.port.completion).rejects.toThrow("frame age");
});
it("starts no partial-frame timer while a pipe is empty", async () => {
  const s = await running(); await vi.advanceTimersByTimeAsync(16_000); expect(s.process.killed).toBe(false);
  s.process.stdout.write(Buffer.from("T")); await vi.advanceTimersByTimeAsync(2000); await expect(s.port.completion).rejects.toThrow("progress");
});
it("does not let a full APP queue block KILL", async () => {
  const s = await running(); s.process.hold = true;
  for (let i = 0; i < 32; i++) s.port.postMessage({ synthetic: i });
  expect(s.port.kill()).toBe(true); s.process.hold = false; s.process.release?.(); await settle();
  expect(s.process.writes[3]!.readUInt16LE(6)).toBe(KINDS.KILL);
});
it("does not let pending APP messages block an independent raw heartbeat", async () => {
  const s = await running(); s.process.hold = true;
  s.port.postMessage({ synthetic: 1 }); s.port.postMessage({ synthetic: 2 });
  // Release before the active write's deadline; heartbeat is queued in the same turn.
  vi.advanceTimersByTime(1999); s.process.hold = false; s.process.release?.(); vi.advanceTimersByTime(1); await settle();
  expect(s.process.writes.some(bytes => bytes.readUInt16LE(6) === KINDS.HEARTBEAT)).toBe(true);
});
it("orders CLOSE_CHILD_INPUT after every already admitted APP", async () => {
  const s = await running(); await expect(s.port.closeChildInput()).rejects.toThrow("shutdown response"); await shutdown(s); s.process.hold = true;
  s.port.postMessage({ synthetic: 1 }); s.port.postMessage({ synthetic: 2 }); const close = s.port.closeChildInput();
  s.process.hold = false; s.process.release?.(); await settle(); await close;
  expect(s.process.writes.slice(3).map(bytes => bytes.readUInt16LE(6))).toEqual([KINDS.APP, KINDS.APP, KINDS.CLOSE_CHILD_INPUT]);
  expect(() => s.port.postMessage({ synthetic: 3 })).toThrow("unavailable");
});
it("has a RESULT-only recovery mode with no START or child protocol", async () => {
  const s = setup(true); s.process.row(KINDS.RESULT, { ...result(), sessionOutcome: "recovered", runNonce: null, childCreated: false, childResumed: false, exitCode: null, stderrComplete: false, consoleBefore: false, consoleAfterFirstFrame: false });
  await s.process.close(); expect((await s.port.completion).sessionOutcome).toBe("recovered"); expect(s.process.writes).toEqual([]);
});
it("fails recovery on any PREPARED/worker record", async () => {
  const s = setup(true); s.process.row(KINDS.PREPARED, prepared()); await expect(s.port.completion).rejects.toThrow("header");
});
