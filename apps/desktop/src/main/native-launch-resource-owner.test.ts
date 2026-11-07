import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeLaunchResourceOwner, captureNativeLaunchResourceDeadline, captureNativeLaunchStageDeadline } from "./native-launch-resource-owner.js";
import { encodeNativeBootstrap } from "./native-development-bootstrap.js";
import { NativeLaunchFailure, type NativeLaunchSettlement } from "./native-launch-supervisor.js";
import type { NativeBootstrapOperation } from "./native-bootstrap-operation.js";
import type { NativeMcpSessionOperation } from "./native-mcp-session-operation.js";
import { createNativeCallRecord } from "./native-launch-call-record.js";
import type { NativeLaunchTaskBinding } from "./native-launch-operations.js";
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const descriptor = (pid = process.pid) => encodeNativeBootstrap({ main: { pid, creationTime: 1n }, pipeNonce: "11".repeat(16),
  ticket: { generation: "22".repeat(16), token: "33".repeat(32) } });
const turn = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
async function fixture(prepared = true) {
  let priming = prepared;
  let hr = 0n, perf = 0, last: NativeLaunchSettlement | null = null;
  const verified = deferred<void>(), onVerify = { callback: undefined as (() => void) | undefined };
  const inputs: Buffer[] = [];
  const known = (authority: boolean) => { last = Object.freeze({ childCloseObserved: true, workerExited: true,
    workerExitCode: 0, authorityCommitted: authority, uncertain: false }); };
  const operations = {
    prepareDirectory: vi.fn(async (_deadline: bigint, _signal: AbortSignal) => { known(true); }),
    identity: vi.fn(async (_deadline: bigint, _signal: AbortSignal) => { known(false); return { pid: process.pid, creationTime: 1n }; }),
    bootstrap: vi.fn(async (_operation: NativeBootstrapOperation, input: Uint8Array | undefined, _deadline: bigint, _signal: AbortSignal) => {
      if (input) inputs.push(Buffer.from(input)); known(true);
    }),
    session: vi.fn(async (_operation: NativeMcpSessionOperation, input: Uint8Array, _deadline: bigint, _signal: AbortSignal) => {
      inputs.push(Buffer.from(input)); known(true);
    }),
    status: vi.fn(() => ({ pending: false, failed: false, lastSettlement: last })),
    observeCall: vi.fn((original: Promise<unknown>) => {
      const record = createNativeCallRecord<NativeLaunchTaskBinding>(Object.freeze({ kind: "no-task" }));
      record.attach(original); return record.observation;
    }),
  };
  const verify = vi.fn((_signal: AbortSignal) => { onVerify.callback?.(); return priming ? Promise.resolve() : verified.promise; });
  const time = { hrtime: vi.fn(() => hr), performance: vi.fn(() => perf) };
  const staged = deferred<void>(), onStage = { callback: undefined as (() => void) | undefined };
  const stage = vi.fn((_signal: AbortSignal, _deadline: bigint) => { onStage.callback?.(); return staged.promise; });
  const owner = new NativeLaunchResourceOwner({ verify, stage, operations }, time), controller = new AbortController();
  if (prepared) {
    await owner.prepareDirectory(10_000, controller.signal);
    priming = false; last = null;
    for (const mock of [...Object.values(operations), verify, ...Object.values(time)]) if (vi.isMockFunction(mock)) mock.mockClear();
  }
  return { owner, operations, inputs, verify, verified, stage, staged, onStage, time, controller, onVerify, deadline: 10_000,
    advance: (ns: bigint) => { hr = ns; perf = Number(ns) / 1e6; }, known };
}
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it("captures hrtime before performance and subtracts their read gap conservatively", () => {
  const order: string[] = [];
  const deadline = captureNativeLaunchResourceDeadline(10_100, {
    hrtime: () => { order.push("hr"); return 100_000_000_000n; },
    performance: () => { order.push("perf"); return 2100; },
  });
  expect(order).toEqual(["hr", "perf"]); expect(deadline).toBe(108_000_000_000n);
});
it("caps at twenty seconds, floors sub-nanosecond remainder and rejects invalid owner deadlines", () => {
  const time = { hrtime: () => 100n, performance: () => 0 };
  expect(captureNativeLaunchResourceDeadline(50_000, time)).toBe(20_000_000_100n);
  for (const value of [NaN, Infinity, -1, 0, 0.0000009]) expect(() => captureNativeLaunchResourceDeadline(value, time)).toThrow();
});
it("copies before verify waits and preserves the same original cap when dispatching later", async () => {
  const f = await fixture(), input = descriptor(), original = Buffer.from(input);
  const done = f.owner.bootstrap("publish", input, 50_000, f.controller.signal);
  expect(f.verify).toHaveBeenCalledOnce(); expect(f.operations.bootstrap).not.toHaveBeenCalled();
  input.fill(0); f.advance(5_000_000_000n); f.verified.resolve(); await done;
  expect(f.inputs).toEqual([original]); expect(f.operations.bootstrap.mock.calls[0]![2]).toBe(20_000_000_000n);
  expect(f.operations.bootstrap.mock.calls[0]![1]).toEqual(Buffer.alloc(96));
});
it("verifies before identity and session dispatch without exposing paths or executable arguments", async () => {
  const f = await fixture(), done = f.owner.identity(f.deadline, f.controller.signal);
  expect(f.operations.identity).not.toHaveBeenCalled(); f.verified.resolve();
  expect(await done).toEqual({ pid: process.pid, creationTime: 1n });
  expect(f.operations.identity.mock.calls[0]![0]).toBe(10_000_000_000n);
  const g = await fixture(), session = g.owner.session("seal", descriptor(), g.deadline, g.controller.signal);
  g.verified.resolve(); await session; expect(g.operations.session).toHaveBeenCalledOnce();
});
it("a verification resolve after the original deadline cannot dispatch even without timer callbacks", async () => {
  const f = await fixture(), done = f.owner.identity(f.deadline, f.controller.signal);
  f.advance(10_000_000_001n); f.verified.resolve();
  await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.operations.identity).not.toHaveBeenCalled(); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
});
it("returns deadline failure while retaining pending verification then observes its late resolve", async () => {
  const f = await fixture(), done = f.owner.identity(f.deadline, f.controller.signal).catch(error => error);
  f.advance(10_000_000_000n); await vi.advanceTimersByTimeAsync(10_000);
  const failure = await done; expect(failure).toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.owner.status()).toMatchObject({ pending: true, failed: true, verificationPending: true });
  f.verified.resolve(); await turn(); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
  await expect(f.owner.identity(50_000, new AbortController().signal)).rejects.toThrow();
  expect(f.verify).toHaveBeenCalledOnce(); expect(f.operations.identity).not.toHaveBeenCalled();
});
it("keeps the original deadline failure when pending verification later rejects", async () => {
  const f = await fixture(), done = f.owner.identity(f.deadline, f.controller.signal).catch(error => error);
  f.advance(10_000_000_000n); await vi.advanceTimersByTimeAsync(10_000); const failure = await done;
  f.verified.reject(new Error("Late verifier failure")); await turn();
  expect(await done).toBe(failure); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
  expect(f.operations.identity).not.toHaveBeenCalled();
});
it("abort immediately returns failure while the original verifier remains pending", async () => {
  const f = await fixture(), done = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal).catch(error => error);
  f.controller.abort(); expect(await done).toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.verify.mock.calls[0]![0].aborted).toBe(true);
  expect(f.owner.status()).toMatchObject({ pending: true, failed: true, verificationPending: true });
  f.verified.resolve(); await turn(); expect(f.operations.bootstrap).not.toHaveBeenCalled();
});
it("a synchronous verifier failure fences the wrapper without dispatch", async () => {
  const f = await fixture(); f.verify.mockImplementation(() => { throw new Error("Synthetic verify failure"); });
  await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: true });
  expect(f.owner.status()).toMatchObject({ pending: false, failed: true }); expect(f.operations.identity).not.toHaveBeenCalled();
});
it("initial abort and expired owner budgets do no verification work", async () => {
  for (const reason of ["abort", "deadline"]) {
    const f = await fixture(); if (reason === "abort") f.controller.abort(); else f.advance(10_000_000_000n);
    await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: true });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.operations.identity).not.toHaveBeenCalled();
  }
});
it("reserves before a verifier callback can reenter another operation", async () => {
  const f = await fixture(); let rejected: Promise<unknown> | undefined;
  f.onVerify.callback = () => { rejected = f.owner.identity(f.deadline, f.controller.signal).catch(error => error); };
  const done = f.owner.identity(f.deadline, f.controller.signal); f.verified.resolve(); await done;
  expect(await rejected).toMatchObject({ exitVerified: false }); expect(f.verify).toHaveBeenCalledOnce(); expect(f.operations.identity).toHaveBeenCalledOnce();
});
it("rejects shared, malformed and foreign descriptors before verification", async () => {
  for (const input of [Buffer.alloc(95), Buffer.alloc(96), new Uint8Array(new SharedArrayBuffer(96)), descriptor(process.pid + 1)]) {
    const f = await fixture(); await expect(f.owner.session("prepare", input, f.deadline, f.controller.signal)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled(); expect(f.operations.session).not.toHaveBeenCalled();
  }
});
it("abort after verification settles still withholds dispatch", async () => {
  const f = await fixture(), done = f.owner.identity(f.deadline, f.controller.signal);
  f.verified.resolve(); f.controller.abort(); await expect(done).rejects.toThrow(); expect(f.operations.identity).not.toHaveBeenCalled();
});
it("preserves a transport failure object and the underlying pending native owner", async () => {
  const f = await fixture(), failure = new NativeLaunchFailure(false, true);
  f.operations.bootstrap.mockImplementation(async () => {
    f.operations.status.mockReturnValue({ pending: true, failed: true, lastSettlement: null }); throw failure;
  });
  const done = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal).catch(error => error);
  f.verified.resolve(); expect(await done).toBe(failure); expect(f.owner.status()).toMatchObject({ pending: true, failed: true });
});
it("checks abort again at semantic handoff after dispatch without replacing known close with unknown", async () => {
  const f = await fixture(); f.operations.bootstrap.mockImplementation(async () => { f.known(true); f.controller.abort(); });
  const done = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal); f.verified.resolve();
  await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: true });
});
it("does not verify against an already pending or failed Operations owner", async () => {
  for (const status of [{ pending: true, failed: false, lastSettlement: null }, { pending: false, failed: true, lastSettlement: null }]) {
    const f = await fixture(); f.operations.status.mockReturnValue(status);
    await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: false });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.owner.status().failed).toBe(true);
  }
});
it("a clock-read gap exhausting the owner budget does not start verification", async () => {
  const f = await fixture(); f.time.performance.mockImplementation(() => { f.advance(11_000_000_000n); return 0; });
  await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toThrow(); expect(f.verify).not.toHaveBeenCalled();
});
it("rejects free operation names and recovery payloads before verification", async () => {
  const f = await fixture(); await expect(f.owner.session("anything" as "prepare", descriptor(), f.deadline, f.controller.signal)).rejects.toThrow();
  expect(f.verify).not.toHaveBeenCalled();
  const g = await fixture(); await expect(g.owner.bootstrap("recover", descriptor(), g.deadline, g.controller.signal)).rejects.toThrow();
  expect(g.verify).not.toHaveBeenCalled();
});

it("keeps an A observer captured during verify bound to A after B has started and completed", async () => {
  const f = await fixture(), first = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  const observedA = f.owner.observeCall(first);
  f.verified.resolve(); await first;
  const second = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal), observedB = f.owner.observeCall(second);
  await second; // Deliberately let B finish before continuing A's observation.
  const a = await observedA.binding, b = await observedB.binding;
  expect(a.operation).toBe(f.operations.bootstrap.mock.results[0]!.value);
  expect(b.operation).toBe(f.operations.bootstrap.mock.results[1]!.value); expect(a.operation).not.toBe(b.operation);
  if (a.native.state !== "bound" || b.native.state !== "bound") throw new Error("Missing bound native observations");
  expect(a.native.observation).toBe(f.operations.observeCall.mock.results[0]!.value);
  expect(b.native.observation).toBe(f.operations.observeCall.mock.results[1]!.value);
  expect(f.owner.observeCall(first)).toBe(observedA); expect(f.owner.observeCurrentCall()).toBe(observedB);
});
it("a foreign resource promise cannot use the current call as its observation", async () => {
  const f = await fixture(), original = f.owner.identity(f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  expect(() => f.owner.observeCall(Promise.resolve())).toThrow("Unknown");
  expect(f.owner.observeCurrentCall()).toBe(observation); expect(f.owner.status().failed).toBe(false);
  f.verified.resolve(); await original; expect(await observation.outcome).toEqual({ status: "fulfilled" });
});
it("verify-without-dispatch retains its original rejected IO and original deadline outcome separately", async () => {
  const f = await fixture(), original = f.owner.identity(f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  const failure = original.catch(error => error); f.controller.abort(); const originalFailure = await failure;
  const binding = await observation.binding;
  expect(binding.verification).toBe(f.verified.promise); expect(binding.operation).toBeNull(); expect(binding.native).toEqual({ state: "none" });
  const ioFailure = new Error("Late original verify rejection"); f.verified.reject(ioFailure);
  expect(await Promise.allSettled([binding.verification])).toEqual([{ status: "rejected", reason: ioFailure }]);
  expect(await observation.outcome).toEqual({ status: "rejected", reason: originalFailure });
  expect(f.operations.identity).not.toHaveBeenCalled();
});
it("observation lookup failure is unavailable after dispatch rather than no-operation or safe close", async () => {
  const f = await fixture(), reason = new Error("Synthetic observer lookup failure");
  f.operations.observeCall.mockImplementation(() => { throw reason; });
  const original = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  f.verified.resolve(); await expect(original).rejects.toMatchObject({ exitVerified: false, authorityCommitted: true });
  const binding = await observation.binding;
  expect(binding.operation).toBe(f.operations.bootstrap.mock.results[0]!.value);
  expect(binding.native).toEqual({ state: "unavailable", reason });
  expect(await Promise.allSettled([binding.operation])).toEqual([{ status: "fulfilled", value: undefined }]);
  expect((await observation.outcome).status).toBe("rejected");
});
it("creates the resource record before a verifier callback asks for an observer", async () => {
  const f = await fixture(); let observation: ReturnType<typeof f.owner.observeCurrentCall>;
  f.onVerify.callback = () => { observation = f.owner.observeCurrentCall(); expect(observation).toBeDefined(); };
  const original = f.owner.identity(f.deadline, f.controller.signal);
  expect(f.owner.observeCall(original)).toBe(observation); f.verified.resolve(); await original;
  expect((await observation!.binding).operation).toBe(f.operations.identity.mock.results[0]!.value);
});

it("caps staging at thirty seconds while retaining a shorter original owner deadline", () => {
  const time = { hrtime: () => 100_000_000_000n, performance: () => 2000 };
  expect(captureNativeLaunchStageDeadline(100_000, time)).toBe(130_000_000_000n);
  expect(captureNativeLaunchStageDeadline(3000, time)).toBe(101_000_000_000n);
  expect(captureNativeLaunchResourceDeadline(100_000, time)).toBe(120_000_000_000n);
});
it("retains the original staging promise without inventing native close evidence", async () => {
  const f = await fixture(), original = f.owner.prepareWorker(f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  expect(f.stage.mock.calls[0]![1]).toBe(10_000_000_000n);
  expect(f.owner.status()).toMatchObject({ pending: true, stagingPending: true, verificationPending: false });
  f.staged.resolve(); await original;
  const binding = await observation.binding;
  expect(binding).toEqual({ kind: "stage", staging: f.staged.promise, verification: null, operation: null, native: { state: "none" } });
  expect(f.operations.identity).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  expect(f.owner.status()).toMatchObject({ pending: false, failed: false, stagingPending: false });
  const next = f.owner.identity(f.deadline, f.controller.signal); f.verified.resolve(); await next;
  expect(await observation.binding).toBe(binding); expect((await f.owner.observeCall(next).binding).kind).toBe("native");
});
it("an aborted staging result retains original IO and blocks all further dispatch after late success", async () => {
  const f = await fixture(), original = f.owner.prepareWorker(f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  const failed = original.catch(error => error); f.controller.abort(); const reason = await failed;
  expect(reason).toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.stage.mock.calls[0]![0].aborted).toBe(true);
  expect(f.owner.status()).toMatchObject({ pending: true, failed: true, stagingPending: true });
  await expect(f.owner.identity(f.deadline, new AbortController().signal)).rejects.toThrow();
  await expect(f.owner.prepareWorker(f.deadline, new AbortController().signal)).rejects.toThrow();
  const binding = await observation.binding; expect(binding.staging).toBe(f.staged.promise);
  f.staged.resolve(); await turn();
  expect(f.owner.status()).toMatchObject({ pending: false, failed: true, stagingPending: false });
  expect(await observation.outcome).toEqual({ status: "rejected", reason });
  expect(f.stage).toHaveBeenCalledOnce(); expect(f.operations.identity).not.toHaveBeenCalled();
});
it("timeout keeps a late rejected staging promise observed with its original reason", async () => {
  const f = await fixture(), original = f.owner.prepareWorker(f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  const failed = original.catch(error => error); await vi.advanceTimersByTimeAsync(10_000); const reason = await failed;
  const binding = await observation.binding, ioFailure = new Error("Original staging copy rejected late");
  expect(f.owner.status()).toMatchObject({ pending: true, failed: true, stagingPending: true });
  f.staged.reject(ioFailure);
  expect(await Promise.allSettled([binding.staging])).toEqual([{ status: "rejected", reason: ioFailure }]);
  await turn(); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
  expect(await observation.outcome).toEqual({ status: "rejected", reason }); expect(f.stage).toHaveBeenCalledOnce();
});
it("rejects late staging success without timer dispatch and does not start a native call", async () => {
  const f = await fixture(), original = f.owner.prepareWorker(f.deadline, f.controller.signal);
  const failed = original.catch(error => error); f.advance(10_000_000_001n); f.staged.resolve();
  expect(await failed).toMatchObject({ exitVerified: true, authorityCommitted: false });
  await expect(f.owner.session("seal", descriptor(), 20_000, new AbortController().signal)).rejects.toThrow();
  expect(f.operations.session).not.toHaveBeenCalled(); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
});
it("reserves staging before reentrant callbacks and keeps its observation through rejected calls", async () => {
  const f = await fixture(); const rejected: Promise<unknown>[] = []; let current: ReturnType<typeof f.owner.observeCurrentCall>;
  f.onStage.callback = () => {
    current = f.owner.observeCurrentCall();
    rejected.push(f.owner.identity(f.deadline, f.controller.signal), f.owner.prepareWorker(f.deadline, f.controller.signal));
    for (const item of rejected) void item.catch(() => {});
  };
  const original = f.owner.prepareWorker(f.deadline, f.controller.signal);
  expect(f.owner.observeCall(original)).toBe(current); expect(f.owner.observeCurrentCall()).toBe(current);
  expect((await Promise.allSettled(rejected)).every(value => value.status === "rejected")).toBe(true);
  expect(f.stage).toHaveBeenCalledOnce(); expect(f.operations.identity).not.toHaveBeenCalled();
  f.staged.resolve(); await original; expect(f.owner.observeCurrentCall()).toBe(current); expect(f.owner.status().failed).toBe(false);
});
it.each([0, Infinity])("invalid staging deadline %s prevents original IO and closes the owner", async deadline => {
  const f = await fixture(), original = f.owner.prepareWorker(deadline, f.controller.signal);
  await expect(original).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.stage).not.toHaveBeenCalled(); expect((await f.owner.observeCall(original).binding).staging).toBeNull();
  expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
});
it("already aborted staging never calls the bound package capability", async () => {
  const f = await fixture(); f.controller.abort();
  await expect(f.owner.prepareWorker(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.stage).not.toHaveBeenCalled(); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
});
it("a synchronous staging failure is sticky and reports that no original staging promise returned", async () => {
  const f = await fixture(); f.stage.mockImplementationOnce(() => { throw new Error("Synchronous stage failure"); });
  const original = f.owner.prepareWorker(f.deadline, f.controller.signal);
  await expect(original).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect((await f.owner.observeCall(original).binding).staging).toBeNull();
  await expect(f.owner.prepareWorker(f.deadline, f.controller.signal)).rejects.toThrow(); expect(f.stage).toHaveBeenCalledOnce();
});
it("an already pending native owner prevents staging from starting", async () => {
  const f = await fixture(); f.operations.status.mockReturnValueOnce({ pending: true, failed: false, lastSettlement: null });
  await expect(f.owner.prepareWorker(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: false });
  expect(f.stage).not.toHaveBeenCalled(); expect(f.owner.status().failed).toBe(true);
});

it.each(["identity", "bootstrap", "session", "stage"] as const)("unprepared directory forbids %s before verification or dispatch and permanently fences the owner", async kind => {
  const f = await fixture(false);
  const original = kind === "identity" ? f.owner.identity(f.deadline, f.controller.signal)
    : kind === "bootstrap" ? f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal)
    : kind === "session" ? f.owner.session("prepare", descriptor(), f.deadline, f.controller.signal)
    : f.owner.prepareWorker(f.deadline, f.controller.signal);
  await expect(original).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.verify).not.toHaveBeenCalled(); expect(f.stage).not.toHaveBeenCalled(); expect(f.operations.prepareDirectory).not.toHaveBeenCalled();
  await expect(f.owner.prepareDirectory(f.deadline, f.controller.signal)).rejects.toThrow(); expect(f.owner.status().failed).toBe(true);
});
it("directory uses the same original verification and observation before enabling other operations", async () => {
  const f = await fixture(false), original = f.owner.prepareDirectory(f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  expect(f.owner.status()).toMatchObject({ pending: true, directoryPrepared: false });
  await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toThrow();
  f.verified.resolve(); await original; expect(f.owner.status()).toMatchObject({ pending: false, failed: false, directoryPrepared: true });
  expect(f.operations.prepareDirectory.mock.calls[0]![0]).toBe(10_000_000_000n);
  expect((await observation.binding).verification).toBe(f.verified.promise);
  await expect(f.owner.identity(f.deadline, f.controller.signal)).resolves.toMatchObject({ pid: process.pid });
});
it("directory verification resolving late without timer dispatch never starts the mutating operation", async () => {
  const f = await fixture(false), original = f.owner.prepareDirectory(f.deadline, f.controller.signal).catch(error => error);
  f.advance(10_000_000_001n); f.verified.resolve(); expect(await original).toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.operations.prepareDirectory).not.toHaveBeenCalled(); expect(f.owner.status()).toMatchObject({ failed: true, directoryPrepared: false });
});
it("successful directory preparation is one-shot on the same owner", async () => {
  const f = await fixture(); await expect(f.owner.prepareDirectory(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.operations.prepareDirectory).not.toHaveBeenCalled(); expect(f.owner.status().failed).toBe(true);
});
