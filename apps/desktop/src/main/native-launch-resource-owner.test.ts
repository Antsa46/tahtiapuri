import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeLaunchResourceOwner, captureNativeLaunchResourceDeadline } from "./native-launch-resource-owner.js";
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
function fixture() {
  let hr = 0n, perf = 0, last: NativeLaunchSettlement | null = null;
  const verified = deferred<void>(), onVerify = { callback: undefined as (() => void) | undefined };
  const inputs: Buffer[] = [];
  const known = (authority: boolean) => { last = Object.freeze({ childCloseObserved: true, workerExited: true,
    workerExitCode: 0, authorityCommitted: authority, uncertain: false }); };
  const operations = {
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
  const verify = vi.fn((_signal: AbortSignal) => { onVerify.callback?.(); return verified.promise; });
  const time = { hrtime: vi.fn(() => hr), performance: vi.fn(() => perf) };
  const owner = new NativeLaunchResourceOwner({ verify, operations }, time), controller = new AbortController();
  return { owner, operations, inputs, verify, verified, time, controller, onVerify, deadline: 10_000,
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
  const f = fixture(), input = descriptor(), original = Buffer.from(input);
  const done = f.owner.bootstrap("publish", input, 50_000, f.controller.signal);
  expect(f.verify).toHaveBeenCalledOnce(); expect(f.operations.bootstrap).not.toHaveBeenCalled();
  input.fill(0); f.advance(5_000_000_000n); f.verified.resolve(); await done;
  expect(f.inputs).toEqual([original]); expect(f.operations.bootstrap.mock.calls[0]![2]).toBe(20_000_000_000n);
  expect(f.operations.bootstrap.mock.calls[0]![1]).toEqual(Buffer.alloc(96));
});
it("verifies before identity and session dispatch without exposing paths or executable arguments", async () => {
  const f = fixture(), done = f.owner.identity(f.deadline, f.controller.signal);
  expect(f.operations.identity).not.toHaveBeenCalled(); f.verified.resolve();
  expect(await done).toEqual({ pid: process.pid, creationTime: 1n });
  expect(f.operations.identity.mock.calls[0]![0]).toBe(10_000_000_000n);
  const g = fixture(), session = g.owner.session("seal", descriptor(), g.deadline, g.controller.signal);
  g.verified.resolve(); await session; expect(g.operations.session).toHaveBeenCalledOnce();
});
it("a verification resolve after the original deadline cannot dispatch even without timer callbacks", async () => {
  const f = fixture(), done = f.owner.identity(f.deadline, f.controller.signal);
  f.advance(10_000_000_001n); f.verified.resolve();
  await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.operations.identity).not.toHaveBeenCalled(); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
});
it("returns deadline failure while retaining pending verification then observes its late resolve", async () => {
  const f = fixture(), done = f.owner.identity(f.deadline, f.controller.signal).catch(error => error);
  f.advance(10_000_000_000n); await vi.advanceTimersByTimeAsync(10_000);
  const failure = await done; expect(failure).toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.owner.status()).toMatchObject({ pending: true, failed: true, verificationPending: true });
  f.verified.resolve(); await turn(); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
  await expect(f.owner.identity(50_000, new AbortController().signal)).rejects.toThrow();
  expect(f.verify).toHaveBeenCalledOnce(); expect(f.operations.identity).not.toHaveBeenCalled();
});
it("keeps the original deadline failure when pending verification later rejects", async () => {
  const f = fixture(), done = f.owner.identity(f.deadline, f.controller.signal).catch(error => error);
  f.advance(10_000_000_000n); await vi.advanceTimersByTimeAsync(10_000); const failure = await done;
  f.verified.reject(new Error("Late verifier failure")); await turn();
  expect(await done).toBe(failure); expect(f.owner.status()).toMatchObject({ pending: false, failed: true });
  expect(f.operations.identity).not.toHaveBeenCalled();
});
it("abort immediately returns failure while the original verifier remains pending", async () => {
  const f = fixture(), done = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal).catch(error => error);
  f.controller.abort(); expect(await done).toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.verify.mock.calls[0]![0].aborted).toBe(true);
  expect(f.owner.status()).toMatchObject({ pending: true, failed: true, verificationPending: true });
  f.verified.resolve(); await turn(); expect(f.operations.bootstrap).not.toHaveBeenCalled();
});
it("a synchronous verifier failure fences the wrapper without dispatch", async () => {
  const f = fixture(); f.verify.mockImplementation(() => { throw new Error("Synthetic verify failure"); });
  await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: true });
  expect(f.owner.status()).toMatchObject({ pending: false, failed: true }); expect(f.operations.identity).not.toHaveBeenCalled();
});
it("initial abort and expired owner budgets do no verification work", async () => {
  for (const reason of ["abort", "deadline"]) {
    const f = fixture(); if (reason === "abort") f.controller.abort(); else f.advance(10_000_000_000n);
    await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: true });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.operations.identity).not.toHaveBeenCalled();
  }
});
it("reserves before a verifier callback can reenter another operation", async () => {
  const f = fixture(); let rejected: Promise<unknown> | undefined;
  f.onVerify.callback = () => { rejected = f.owner.identity(f.deadline, f.controller.signal).catch(error => error); };
  const done = f.owner.identity(f.deadline, f.controller.signal); f.verified.resolve(); await done;
  expect(await rejected).toMatchObject({ exitVerified: false }); expect(f.verify).toHaveBeenCalledOnce(); expect(f.operations.identity).toHaveBeenCalledOnce();
});
it("rejects shared, malformed and foreign descriptors before verification", async () => {
  for (const input of [Buffer.alloc(95), Buffer.alloc(96), new Uint8Array(new SharedArrayBuffer(96)), descriptor(process.pid + 1)]) {
    const f = fixture(); await expect(f.owner.session("prepare", input, f.deadline, f.controller.signal)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled(); expect(f.operations.session).not.toHaveBeenCalled();
  }
});
it("abort after verification settles still withholds dispatch", async () => {
  const f = fixture(), done = f.owner.identity(f.deadline, f.controller.signal);
  f.verified.resolve(); f.controller.abort(); await expect(done).rejects.toThrow(); expect(f.operations.identity).not.toHaveBeenCalled();
});
it("preserves a transport failure object and the underlying pending native owner", async () => {
  const f = fixture(), failure = new NativeLaunchFailure(false, true);
  f.operations.bootstrap.mockImplementation(async () => {
    f.operations.status.mockReturnValue({ pending: true, failed: true, lastSettlement: null }); throw failure;
  });
  const done = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal).catch(error => error);
  f.verified.resolve(); expect(await done).toBe(failure); expect(f.owner.status()).toMatchObject({ pending: true, failed: true });
});
it("checks abort again at semantic handoff after dispatch without replacing known close with unknown", async () => {
  const f = fixture(); f.operations.bootstrap.mockImplementation(async () => { f.known(true); f.controller.abort(); });
  const done = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal); f.verified.resolve();
  await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: true });
});
it("does not verify against an already pending or failed Operations owner", async () => {
  for (const status of [{ pending: true, failed: false, lastSettlement: null }, { pending: false, failed: true, lastSettlement: null }]) {
    const f = fixture(); f.operations.status.mockReturnValue(status);
    await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: false });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.owner.status().failed).toBe(true);
  }
});
it("a clock-read gap exhausting the owner budget does not start verification", async () => {
  const f = fixture(); f.time.performance.mockImplementation(() => { f.advance(11_000_000_000n); return 0; });
  await expect(f.owner.identity(f.deadline, f.controller.signal)).rejects.toThrow(); expect(f.verify).not.toHaveBeenCalled();
});
it("rejects free operation names and recovery payloads before verification", async () => {
  const f = fixture(); await expect(f.owner.session("anything" as "prepare", descriptor(), f.deadline, f.controller.signal)).rejects.toThrow();
  expect(f.verify).not.toHaveBeenCalled();
  const g = fixture(); await expect(g.owner.bootstrap("recover", descriptor(), g.deadline, g.controller.signal)).rejects.toThrow();
  expect(g.verify).not.toHaveBeenCalled();
});

it("keeps an A observer captured during verify bound to A after B has started and completed", async () => {
  const f = fixture(), first = f.owner.bootstrap("recover", undefined, f.deadline, f.controller.signal);
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
  const f = fixture(), original = f.owner.identity(f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  expect(() => f.owner.observeCall(Promise.resolve())).toThrow("Unknown");
  expect(f.owner.observeCurrentCall()).toBe(observation); expect(f.owner.status().failed).toBe(false);
  f.verified.resolve(); await original; expect(await observation.outcome).toEqual({ status: "fulfilled" });
});
it("verify-without-dispatch retains its original rejected IO and original deadline outcome separately", async () => {
  const f = fixture(), original = f.owner.identity(f.deadline, f.controller.signal), observation = f.owner.observeCall(original);
  const failure = original.catch(error => error); f.controller.abort(); const originalFailure = await failure;
  const binding = await observation.binding;
  expect(binding.verification).toBe(f.verified.promise); expect(binding.operation).toBeNull(); expect(binding.native).toEqual({ state: "none" });
  const ioFailure = new Error("Late original verify rejection"); f.verified.reject(ioFailure);
  expect(await Promise.allSettled([binding.verification])).toEqual([{ status: "rejected", reason: ioFailure }]);
  expect(await observation.outcome).toEqual({ status: "rejected", reason: originalFailure });
  expect(f.operations.identity).not.toHaveBeenCalled();
});
it("observation lookup failure is unavailable after dispatch rather than no-operation or safe close", async () => {
  const f = fixture(), reason = new Error("Synthetic observer lookup failure");
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
  const f = fixture(); let observation: ReturnType<typeof f.owner.observeCurrentCall>;
  f.onVerify.callback = () => { observation = f.owner.observeCurrentCall(); expect(observation).toBeDefined(); };
  const original = f.owner.identity(f.deadline, f.controller.signal);
  expect(f.owner.observeCall(original)).toBe(observation); f.verified.resolve(); await original;
  expect((await observation!.binding).operation).toBe(f.operations.identity.mock.results[0]!.value);
});
