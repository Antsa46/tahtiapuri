import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KINDS, frame, encodeJson } from "@tahtiapuri/backend-transport";
import { NativeBackendPort, isNativeBackendPrepared, isNativeBackendResult, type NativeBackendProcess } from "./native-backend-port.js";

const owner = "a".repeat(64), child = "b".repeat(64), run = "c".repeat(32), session = "d".repeat(64);
const emptyState = { revision: 0, places: [], activePlaceId: null };
const emptyDocument = Buffer.from(JSON.stringify({ schemaVersion: 1, state: emptyState,
  sha256: createHash("sha256").update(JSON.stringify(emptyState)).digest("hex") }) + "\n");
const sourceBody = (bytes = emptyDocument, mode = 0) => Buffer.concat([Buffer.from([1, mode, 0, 0]), bytes]);
const destinationBody = (bytes: Buffer | null = null) => Buffer.concat([Buffer.from([1, bytes ? 1 : 0, 0, 0]), bytes ?? Buffer.alloc(0)]);
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
  raw(kind: number, body = Buffer.alloc(0)) { this.stdout.write(frame(kind, this.sequence++, owner, body)); }
  row(kind: number, value?: unknown) { this.raw(kind, value === undefined ? Buffer.alloc(0) : encodeJson(value, 65536)); }
  snapshots(source = sourceBody(), destination = destinationBody()) { this.raw(KINDS.MIGRATION_SOURCE, source); this.raw(KINDS.MIGRATION_DESTINATION, destination); }
  app(value: unknown) { const bytes = frame(KINDS.APP, this.childSequence++, child, encodeJson(value, 16 * 1024 ** 2)); this.chunk(bytes); }
  chunk(bytes: Buffer) { for (let offset = 0; offset < bytes.length; offset += 65536) this.stdout.write(frame(KINDS.CHILD_CHUNK, this.sequence++, owner, bytes.subarray(offset, offset + 65536))); }
  kill() { this.killed = true; return true; }
  async close(code = 0) { this.stdout.end(); this.stderr.end(); await settle(); this.emit("exit", code, null); this.emit("close", code, null); await settle(); }
}
async function settle() { await vi.advanceTimersByTimeAsync(0); }
async function migrate(process: MemoryProcess) { process.snapshots(); await settle(); process.raw(KINDS.MIGRATED, Buffer.from([1, 1])); }
const live: MemoryProcess[] = [];
function setup(recover = false) {
  const process = new MemoryProcess(); live.push(process);
  const port = new NativeBackendPort(process, { ownerNonce: owner, ...(recover ? { recover: true } : { runNonce: run }) });
  return { process, port };
}
async function started() {
  const s = setup();
  s.port.on("spawn", () => s.port.postMessage({ type: "initialize", protocol: 1, session }));
  await migrate(s.process);
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
  await migrate(process);
  process.row(KINDS.PREPARED, prepared()); await settle();
  expect(await port.prepared).toMatchObject({ pid: 1234, lpac: null }); expect(spawn).not.toHaveBeenCalled();
  expect(process.writes.map(bytes => bytes.readUInt16LE(6))).toEqual([KINDS.MIGRATION_DECISION, KINDS.START]);
  expect(process.writes[0]).toHaveLength(56 + 68); expect(process.writes[1]).toHaveLength(56);
  process.row(KINDS.STARTED); expect(spawn).toHaveBeenCalledOnce();
});
it("sends one hash-bound decision and waits for MIGRATED then PREPARED before START", async () => {
  const s = setup(), spawn = vi.fn(); s.port.on("spawn", spawn);
  s.process.raw(KINDS.MIGRATION_SOURCE, sourceBody()); await settle(); expect(s.process.writes).toEqual([]);
  expect(() => s.port.postMessage({ type: "initialize", protocol: 1, session })).toThrow("unavailable");
  s.process.raw(KINDS.MIGRATION_DESTINATION, destinationBody()); await settle();
  expect(s.process.writes).toHaveLength(1);
  const decision = s.process.writes[0]!;
  expect(decision.readUInt16LE(6)).toBe(KINDS.MIGRATION_DECISION); expect(decision.readBigUInt64LE(8)).toBe(1n);
  expect([...decision.subarray(56, 60)]).toEqual([1, 1, 0, 0]);
  expect(decision.subarray(60, 92)).toEqual(createHash("sha256").update(emptyDocument).digest());
  expect(decision.subarray(92)).toEqual(Buffer.alloc(32));
  s.process.raw(KINDS.MIGRATED, Buffer.from([1, 1])); await settle(); expect(s.process.writes).toHaveLength(1);
  s.process.row(KINDS.PREPARED, prepared()); await settle(); expect(await s.port.prepared).toMatchObject({ pid: 1234 });
  expect(s.process.writes.map(bytes => bytes.readUInt16LE(6))).toEqual([KINDS.MIGRATION_DECISION, KINDS.START]);
  expect(spawn).not.toHaveBeenCalled(); s.process.row(KINDS.STARTED); expect(spawn).toHaveBeenCalledOnce();
});
it.each(["absent", "source-only", "decision-only"])("rejects PREPARED with a %s migration handshake", async stage => {
  const s = setup(), spawn = vi.fn(); s.port.on("spawn", spawn);
  if (stage !== "absent") s.process.raw(KINDS.MIGRATION_SOURCE, sourceBody());
  if (stage === "decision-only") { s.process.raw(KINDS.MIGRATION_DESTINATION, destinationBody()); await settle(); }
  s.process.row(KINDS.PREPARED, prepared()); await expect(s.port.prepared).rejects.toThrow("protocol");
  expect(spawn).not.toHaveBeenCalled(); expect(s.process.writes.some(bytes => bytes.readUInt16LE(6) === KINDS.START)).toBe(false);
});
it.each(["destination-first", "migrated-first", "duplicate-source", "duplicate-destination", "wrong-outcome", "duplicate-migrated"])("rejects %s without START", async scenario => {
  const s = setup();
  if (scenario === "destination-first") s.process.raw(KINDS.MIGRATION_DESTINATION, destinationBody());
  else if (scenario === "migrated-first") s.process.raw(KINDS.MIGRATED, Buffer.from([1, 1]));
  else {
    s.process.raw(KINDS.MIGRATION_SOURCE, sourceBody());
    if (scenario === "duplicate-source") s.process.raw(KINDS.MIGRATION_SOURCE, sourceBody());
    else {
      s.process.raw(KINDS.MIGRATION_DESTINATION, destinationBody()); await settle();
      if (scenario === "duplicate-destination") s.process.raw(KINDS.MIGRATION_DESTINATION, destinationBody());
      else if (scenario === "wrong-outcome") s.process.raw(KINDS.MIGRATED, Buffer.from([1, 2]));
      else { s.process.raw(KINDS.MIGRATED, Buffer.from([1, 1])); s.process.raw(KINDS.MIGRATED, Buffer.from([1, 1])); }
    }
  }
  await expect(s.port.completion).rejects.toThrow("protocol");
  expect(s.process.writes.some(bytes => bytes.readUInt16LE(6) === KINDS.START)).toBe(false);
});
it("accepts completed migration with a valid edited native destination", async () => {
  const s = setup(), state = { ...emptyState, revision: 2 };
  const edited = Buffer.from(JSON.stringify({ schemaVersion: 1, state, sha256: createHash("sha256").update(JSON.stringify(state)).digest("hex") }) + "\n");
  s.process.snapshots(sourceBody(emptyDocument, 1), destinationBody(edited)); await settle();
  expect([...s.process.writes[0]!.subarray(56, 60)]).toEqual([1, 3, 1, 0]);
  s.process.raw(KINDS.MIGRATED, Buffer.from([1, 3])); s.process.row(KINDS.PREPARED, prepared()); await settle();
  expect(await s.port.prepared).toMatchObject({ pid: 1234 }); expect(s.process.writes.at(-1)!.readUInt16LE(6)).toBe(KINDS.START);
});
it("sends blocked content decisions without inventing clean staging or physical closure", async () => {
  const s = setup(), badDestination = Buffer.from("private-invalid-synthetic-document"); let closed = false;
  void s.port.closure.then(() => { closed = true; });
  s.process.snapshots(sourceBody(), destinationBody(badDestination)); await settle();
  expect(s.process.writes).toHaveLength(1); expect([...s.process.writes[0]!.subarray(56, 60)]).toEqual([1, 0, 1, 0]);
  expect(s.process.writes[0]!.subarray(92)).toEqual(createHash("sha256").update(badDestination).digest());
  expect(s.process.killed).toBe(false); expect(closed).toBe(false);
  const blocked = { ...result(), sessionOutcome: "failed", cleanupOutcome: "blocked", reason: "protocol", error: 13,
    childCreated: false, childResumed: false, exitCode: null, jobEmpty: false, persistentAclRestored: false,
    profileDeleted: false, sessionRemoved: false, journalClean: false, stderrComplete: false, consoleBefore: false, consoleAfterFirstFrame: false };
  expect(isNativeBackendResult(blocked, run)).toBe(true); s.process.row(KINDS.RESULT, blocked);
  await expect(s.port.completion).rejects.toThrow("cleanup remains blocked");
  expect(closed).toBe(false); expect(s.process.killed).toBe(true);
  expect(s.process.writes.map(bytes => bytes.readUInt16LE(6))).toEqual([KINDS.MIGRATION_DECISION]);
  const cleanup = expect(s.port.confirmCleanup()).rejects.toThrow("blocked"); await s.process.close(1); await cleanup; expect(closed).toBe(true);
});
it("cannot acknowledge a blocked decision or prepare its worker", async () => {
  const s = setup(); s.process.snapshots(sourceBody(emptyDocument, 1)); await settle();
  expect(s.process.writes[0]![57]).toBe(0); s.process.raw(KINDS.MIGRATED, Buffer.from([1, 3]));
  await expect(s.port.completion).rejects.toThrow("protocol");
  expect(s.process.writes.some(bytes => bytes.readUInt16LE(6) === KINDS.START)).toBe(false);
});
it("does not reset the original preparation deadline for migration activity", async () => {
  const s = setup(); await vi.advanceTimersByTimeAsync(29_000);
  s.process.snapshots(); await settle(); s.process.raw(KINDS.MIGRATED, Buffer.from([1, 1]));
  await vi.advanceTimersByTimeAsync(1000); await expect(s.port.prepared).rejects.toThrow("preparation");
  expect(s.process.writes.some(bytes => bytes.readUInt16LE(6) === KINDS.START)).toBe(false);
});
it("cancels a partially received snapshot pair when its owner kills preparation", async () => {
  const s = setup(); s.process.raw(KINDS.MIGRATION_SOURCE, sourceBody()); expect(s.port.kill()).toBe(true);
  s.process.raw(KINDS.MIGRATION_DESTINATION, destinationBody()); await expect(s.port.completion).rejects.toThrow("protocol");
  expect(s.process.writes.some(bytes => bytes.readUInt16LE(6) === KINDS.MIGRATION_DECISION || bytes.readUInt16LE(6) === KINDS.START)).toBe(false);
});
it("retains the existing write deadline for a pending migration decision write", async () => {
  const s = setup(); s.process.hold = true; s.process.snapshots();
  await vi.advanceTimersByTimeAsync(2000); await expect(s.port.completion).rejects.toThrow("write deadline");
  expect(s.process.writes.map(bytes => bytes.readUInt16LE(6))).toEqual([KINDS.MIGRATION_DECISION]);
});
it.each([KINDS.STARTED, KINDS.CHILD_CHUNK, KINDS.STDERR])("rejects worker activity kind %s before the migration handshake", async kind => {
  const s = setup(); s.process.raw(kind, kind === KINDS.STARTED ? Buffer.alloc(0) : Buffer.from("synthetic"));
  await expect(s.port.completion).rejects.toThrow("protocol");
  expect(s.process.writes.some(bytes => bytes.readUInt16LE(6) === KINDS.START)).toBe(false);
});
it("does not permit migration controls inside the APP-only child channel", async () => {
  const s = await running(); s.process.chunk(frame(KINDS.MIGRATED, s.process.childSequence++, child, Buffer.from([1, 1])));
  await expect(s.port.completion).rejects.toThrow("header");
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
  const s = await running(), before = s.process.writes.length; s.process.hold = true;
  for (let i = 0; i < 32; i++) s.port.postMessage({ synthetic: i });
  expect(s.port.kill()).toBe(true); s.process.hold = false; s.process.release?.(); await settle();
  expect(s.process.writes[before + 1]!.readUInt16LE(6)).toBe(KINDS.KILL);
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
  const before = s.process.writes.length;
  s.port.postMessage({ synthetic: 1 }); s.port.postMessage({ synthetic: 2 }); const close = s.port.closeChildInput();
  s.process.hold = false; s.process.release?.(); await settle(); await close;
  expect(s.process.writes.slice(before).map(bytes => bytes.readUInt16LE(6))).toEqual([KINDS.APP, KINDS.APP, KINDS.CLOSE_CHILD_INPUT]);
  expect(() => s.port.postMessage({ synthetic: 3 })).toThrow("unavailable");
});
it("has a RESULT-only recovery mode with no START or child protocol", async () => {
  const s = setup(true); s.process.row(KINDS.RESULT, { ...result(), sessionOutcome: "recovered", runNonce: null, childCreated: false, childResumed: false, exitCode: null, stderrComplete: false, consoleBefore: false, consoleAfterFirstFrame: false });
  await s.process.close(); expect((await s.port.completion).sessionOutcome).toBe("recovered"); expect(s.process.writes).toEqual([]);
});
it("fails recovery on any PREPARED/worker record", async () => {
  const s = setup(true); s.process.row(KINDS.PREPARED, prepared()); await expect(s.port.completion).rejects.toThrow("header");
});
it.each([KINDS.MIGRATION_SOURCE, KINDS.MIGRATION_DESTINATION, KINDS.MIGRATED])("keeps recovery RESULT-only when migration kind %s arrives", async kind => {
  const s = setup(true), body = kind === KINDS.MIGRATION_SOURCE ? sourceBody() : kind === KINDS.MIGRATION_DESTINATION ? destinationBody() : Buffer.from([1, 1]);
  s.process.raw(kind, body); await expect(s.port.completion).rejects.toThrow("header");
  expect(s.process.writes).toEqual([]); expect(s.process.killed).toBe(true);
});
