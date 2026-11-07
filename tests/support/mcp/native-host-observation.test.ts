import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeHostObservation } from "./native-host-observation.js";
import { createNativeCallRecord } from "../../../apps/desktop/src/main/native-launch-call-record.js";
import type { NativeLaunchResourceBinding } from "../../../apps/desktop/src/main/native-launch-resource-owner.js";
import type { NativeLaunchTaskBinding } from "../../../apps/desktop/src/main/native-launch-operations.js";
import type { NativeLaunchResult, NativeLaunchSettlement } from "../../../apps/desktop/src/main/native-launch-supervisor.js";
const gate = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const known: NativeLaunchSettlement = { childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: true, uncertain: false };
function fixture(kind: "native" | "stage" = "native") {
  const original = gate<void>(), stage = gate<void>(), result = gate<NativeLaunchResult>(), settled = gate<NativeLaunchSettlement>();
  const native = createNativeCallRecord<NativeLaunchTaskBinding>({ kind: "no-task" }); native.attach(original.promise);
  native.bind({ kind: "task", result: result.promise, settled: settled.promise });
  const resource = createNativeCallRecord<NativeLaunchResourceBinding>({ kind: "stage", staging: null, verification: null, operation: null, native: { state: "none" } });
  resource.attach(original.promise); resource.bind(kind === "stage"
    ? { kind, staging: stage.promise, verification: null, operation: null, native: { state: "none" } }
    : { kind, staging: null, verification: Promise.resolve(), operation: original.promise, native: { state: "bound", observation: native.observation } });
  const owner = { status: () => ({ pending: false, failed: false, verificationPending: false, stagingPending: false, directoryPrepared: true, lastSettlement: null }),
    observeCall: vi.fn((key: Promise<unknown>) => { expect(key).toBe(original.promise); return resource.observation; }) };
  return { owner, original, stage, result, settled,
    done: () => { original.resolve(); stage.resolve(); result.resolve({ stdout: Buffer.from("synthetic"), authorityCommitted: true }); settled.resolve(known); } };
}
function harness(write?: (name: string, value: unknown) => Promise<void>) {
  let main = true; const writes: { name: string; value: unknown }[] = [];
  const observe = new NativeHostObservation({ mainPhysical: () => main, write: (name, value) => {
    writes.push({ name, value: structuredClone(value) }); return write?.(name, value) ?? Promise.resolve();
  } });
  return { observe, writes, main: (value: boolean) => { main = value; } };
}
const tick = async (ms = 100) => { await vi.advanceTimersByTimeAsync(ms); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); }); // Synthetic handles only, never real actors.
it("retains the exact original and exposes the lifetime before lookup re-enters", async () => {
  const f = fixture(), h = harness(); f.owner.observeCall.mockImplementation(key => {
    expect(key).toBe(f.original.promise); expect(h.observe.snapshot().calls).toHaveLength(1); return createObservation();
  });
  const createObservation = () => {
    const n = createNativeCallRecord<NativeLaunchTaskBinding>({ kind: "no-task" }); n.attach(f.original.promise); n.bind({ kind: "task", result: f.result.promise, settled: f.settled.promise });
    const r = createNativeCallRecord<NativeLaunchResourceBinding>({ kind: "native", staging: null, verification: null, operation: null, native: { state: "none" } });
    r.attach(f.original.promise); r.bind({ kind: "native", staging: null, verification: Promise.resolve(), operation: f.original.promise, native: { state: "bound", observation: n.observation } }); return r.observation;
  };
  expect(h.observe.invoke(f.owner, "native", () => f.original.promise)).toBe(f.original.promise);
  f.done(); await tick(); const finished = h.observe.finish("primary", "late", {}); await tick();
  expect(await finished).toBe(true); expect(h.observe.snapshot().released).toBe(true); expect(vi.getTimerCount()).toBe(0);
  expect(h.writes).toHaveLength(1); expect(h.writes[0]!.value).toMatchObject({ passed: true });
});
it("late physical closure releases retention without upgrading original exit uncertainty", async () => {
  const f = fixture(), h = harness(), reason = Object.assign(new Error("Original uncertain result"), { exitVerified: false });
  h.observe.invoke(f.owner, "native", () => f.original.promise); f.original.reject(reason); f.result.reject(reason); await tick();
  const finished = h.observe.finish("primary", "late", {}); await tick();
  expect(h.writes[0]!.value).toMatchObject({ passed: false }); expect(h.observe.snapshot().released).toBe(false);
  f.settled.resolve({ ...known, uncertain: true }); await tick();
  expect(await finished).toBe(false); const snapshot = h.observe.snapshot();
  expect(snapshot.physical).toBe(true); expect(snapshot.calls[0]).toMatchObject({ originalExitVerified: false, physicalKnown: true });
  expect(snapshot.released).toBe(true); expect(h.writes[0]!.value).toMatchObject({ passed: false });
  expect(h.writes[1]!.value).toMatchObject({ passed: false, primaryUnchanged: true, upgradesOriginalResult: false });
});
it("stage needs original file IO to settle and never invents a child settlement", async () => {
  const f = fixture("stage"), h = harness(); h.observe.invoke(f.owner, "stage", () => f.original.promise);
  f.original.reject(Object.assign(new Error("Public stage timeout"), { exitVerified: true })); await tick();
  const finished = h.observe.finish("primary", "late", {}); await tick(); expect(h.observe.physical()).toBe(false);
  f.stage.resolve(); await tick(); expect(await finished).toBe(false);
  expect(h.observe.snapshot().calls[0]).toMatchObject({ bindingKind: "stage", taskBound: false, ioSettled: true, physical: null, physicalKnown: true });
});
it.each([undefined, 0])("lookup throwing %s retains the original and keeps physical ownership unknown", async reason => {
  const f = fixture(), h = harness(); f.owner.observeCall.mockImplementation(() => { throw reason; });
  expect(h.observe.invoke(f.owner, "unknown", () => f.original.promise)).toBe(f.original.promise);
  f.original.reject(new Error("Late original rejection")); await tick();
  expect(h.observe.physical()).toBe(false); expect(h.observe.snapshot().calls[0]).toMatchObject({ originalOutcome: { status: "rejected" }, physicalKnown: false });
});
it("a bounded factory rejection is not proof that its hidden original preparation ended", async () => {
  const h = harness(), original = Promise.reject(new Error("Public factory boundary"));
  expect(h.observe.workOriginal("factory", "factory", () => original)).toBe(original); await tick();
  expect(h.observe.physical()).toBe(false); expect(h.observe.snapshot().work[0]).toMatchObject({ outcome: { status: "rejected" } });
});
it("closed admission refuses another start before the callback executes", () => {
  const f = fixture(), h = harness(), start = vi.fn(() => f.original.promise); h.observe.beginClosing();
  expect(() => h.observe.invoke(f.owner, "late", start)).toThrow("admission closed"); expect(start).not.toHaveBeenCalled();
});
it("a diagnostic deadline retains the original write and terminal failure", async () => {
  const write = gate<void>(), h = harness(name => name === "primary" ? write.promise : Promise.resolve());
  const finished = h.observe.finish("primary", "late", {}); await tick(3100);
  expect(h.observe.snapshot().released).toBe(false); expect(h.observe.physical()).toBe(false);
  write.resolve(); await tick(); expect(await finished).toBe(false); expect(h.observe.snapshot().released).toBe(true);
  expect(h.writes[0]!.value).toMatchObject({ passed: true, upgradesOriginalResult: false });
  expect(h.writes[1]!.value).toMatchObject({ passed: false, primaryUnchanged: true });
});
it("live Main children keep retention until their original physical observation arrives", async () => {
  const h = harness(); h.main(false); const finished = h.observe.finish("primary", "late", {}); await tick();
  expect(h.observe.snapshot().released).toBe(false); h.main(true); await tick();
  expect(await finished).toBe(false); expect(h.observe.snapshot().released).toBe(true);
});
it("rejected raw task settlement cannot borrow a healthy current owner status", async () => {
  const f = fixture(), h = harness(); h.observe.invoke(f.owner, "native", () => f.original.promise);
  f.original.resolve(); f.result.resolve({ stdout: Buffer.from("synthetic"), authorityCommitted: true }); f.settled.reject(new Error("Original settlement unavailable")); await tick();
  expect(h.observe.physical()).toBe(false); expect(h.observe.snapshot().calls[0]).toMatchObject({ originalFailed: true, physicalKnown: false });
});
it("late original loader IO is observed after the failed primary without another preparation", async () => {
  const h = harness(), loading = gate<void>(), start = vi.fn(() => loading.promise);
  expect(h.observe.workOriginal("loader", "loader", start)).toBe(loading.promise);
  const finished = h.observe.finish("primary", "late", {}); await tick(); expect(h.observe.physical()).toBe(false);
  loading.resolve(); await tick(); expect(await finished).toBe(false); expect(start).toHaveBeenCalledOnce();
  expect(h.observe.snapshot().released).toBe(true); expect(h.writes[0]!.value).toMatchObject({ passed: false });
});
