import { expect, it, vi } from "vitest";
import { NativeLaunchOperations } from "./native-launch-operations.js";
import { NativeLaunchFailure, type NativeLaunchRequest, type NativeLaunchResult, type NativeLaunchSettlement } from "./native-launch-supervisor.js";
import { encodeNativeBootstrap } from "./native-development-bootstrap.js";
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
};
const descriptor = (pid = process.pid) => encodeNativeBootstrap({ main: { pid, creationTime: 1n }, pipeNonce: "11".repeat(16),
  ticket: { generation: "22".repeat(16), token: "33".repeat(32) } });
function fixture() {
  let ticks = 0n, onStart: (() => void) | undefined;
  const result = deferred<NativeLaunchResult>(), settled = deferred<NativeLaunchSettlement>();
  const start = vi.fn((_request: NativeLaunchRequest, _deadline: bigint, _signal?: AbortSignal) => {
    onStart?.(); return { result: result.promise, settled: settled.promise };
  });
  const ownerStatus = vi.fn(() => ({ pending: false, uncertain: false }));
  const bridge = new NativeLaunchOperations({ start, status: ownerStatus }, () => ticks);
  const controller = new AbortController(), deadline = 10_000_000_000n;
  const done = (text = "descriptor-absent\n", authority = true, overrides: Partial<NativeLaunchSettlement> = {}) => {
    result.resolve({ stdout: Buffer.from(text), authorityCommitted: authority });
    settled.resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: authority,
      uncertain: false, ...overrides });
  };
  return { bridge, result, settled, start, ownerStatus, controller, deadline, done, tick: (value: bigint) => { ticks = value; },
    onStart: (value: () => void) => { onStart = value; } };
}
const turn = async () => { await Promise.resolve(); await Promise.resolve(); };
it("decodes the exact identity receipt only after the known clean task settlement", async () => {
  const f = fixture(), done = f.bridge.identity(f.deadline, f.controller.signal);
  f.done('{"pid":' + process.pid + ',"creationTime":"fedcba9876543210"}\r\n', false);
  expect(await done).toEqual({ pid: process.pid, creationTime: 0xfedcba9876543210n });
  expect(f.start.mock.calls[0]![0]).toEqual({ kind: "identity" });
  expect(f.bridge.status()).toMatchObject({ pending: false, failed: false });
});
it("accepts only the exact receipt for each finite bootstrap and session operation", async () => {
  for (const [operation, receipt] of [["publish", "published\n"], ["consume", "consumed\n"], ["recover", "descriptor-absent\n"]] as const) {
    const f = fixture(), done = f.bridge.bootstrap(operation, operation === "recover" ? undefined : descriptor(), f.deadline, f.controller.signal);
    f.done(receipt); await done;
  }
  for (const [operation, receipt] of [["prepare", "session-prepared\n"], ["seal", "session-sealed\n"], ["publish", "published\n"],
    ["release-pristine", "session-released\n"], ["release-clean", "session-clean-released\n"]] as const) {
    const f = fixture(), done = f.bridge.session(operation, descriptor(), f.deadline, f.controller.signal); f.done(receipt); await done;
  }
});
it("passes the shorter original owner deadline and caps a longer one at twenty seconds", async () => {
  for (const [ownerDeadline, expected] of [[5_000_000_000n, 5_000_000_000n], [50_000_000_000n, 20_000_000_000n]]) {
    const f = fixture(), done = f.bridge.bootstrap("recover", undefined, ownerDeadline!, f.controller.signal);
    expect(f.start.mock.calls[0]![1]).toBe(expected); f.done(); await done;
  }
});
it("copies and validates its own descriptor before dispatch and clears its copy after completion", async () => {
  const f = fixture(), input = descriptor(), original = Buffer.from(input);
  const done = f.bridge.session("prepare", input, f.deadline, f.controller.signal);
  const request = f.start.mock.calls[0]![0];
  if (!("input" in request)) throw new Error("Missing fixture input");
  expect(request.input).not.toBe(input); input.fill(0); expect(request.input).toEqual(original);
  f.done("session-prepared\n"); await done; expect(request.input).toEqual(Buffer.alloc(96));
});
it("does not hand semantic success out from result alone", async () => {
  const f = fixture(); let completed = false;
  const done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal).then(() => { completed = true; });
  f.result.resolve({ stdout: Buffer.from("descriptor-absent\n"), authorityCommitted: true }); await turn();
  expect(completed).toBe(false); expect(f.bridge.status().pending).toBe(true);
  f.settled.resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: true, uncertain: false });
  await done; expect(completed).toBe(true);
});
it("reserves the bridge before a start callback can reenter another dispatch", async () => {
  const f = fixture(); let rejected: Promise<unknown> | undefined;
  f.onStart(() => { rejected = f.bridge.identity(f.deadline, f.controller.signal).catch(error => error); });
  const done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  expect(f.start).toHaveBeenCalledTimes(1); f.done(); await done;
  expect(await rejected).toMatchObject({ exitVerified: false });
});
it("preserves the original transport failure while retaining a later settlement and blocking new work", async () => {
  const f = fixture(), failure = new NativeLaunchFailure(false, true);
  const done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal).catch(error => error);
  f.result.reject(failure); expect(await done).toBe(failure);
  expect(f.bridge.status()).toMatchObject({ pending: true, failed: true });
  f.settled.resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: true, uncertain: true });
  await turn(); expect(failure.exitVerified).toBe(false); expect(failure.authorityCommitted).toBe(true);
  expect(f.bridge.status()).toMatchObject({ pending: false, failed: true });
  await expect(f.bridge.identity(f.deadline, f.controller.signal)).rejects.toThrow(); expect(f.start).toHaveBeenCalledTimes(1);
});
it("distinguishes a wrong receipt after known close and permanently fences later calls", async () => {
  const f = fixture(), done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  f.done("published\n"); await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: true });
  expect(f.bridge.status()).toMatchObject({ pending: false, failed: true });
  await expect(f.bridge.identity(f.deadline, f.controller.signal)).rejects.toThrow(); expect(f.start).toHaveBeenCalledTimes(1);
});
it("rejects cross-operation, normalized, extra-line and high-bit receipts", async () => {
  for (const receipt of ["session-sealed\n", "published\r\n", "published\n\n", "published\u00f0\n"]) {
    const f = fixture(), done = f.bridge.bootstrap("publish", descriptor(), f.deadline, f.controller.signal);
    f.done(receipt); await expect(done).rejects.toMatchObject({ exitVerified: true });
  }
});
it("rejects wrong lengths, shared buffers, invalid headers and foreign Main descriptors before dispatch", async () => {
  const invalid = [Buffer.alloc(95), Buffer.alloc(97), new Uint8Array(new SharedArrayBuffer(96)), Buffer.alloc(96), descriptor(process.pid + 1)];
  for (const input of invalid) {
    const f = fixture(); await expect(f.bridge.session("prepare", input, f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: true });
    expect(f.start).not.toHaveBeenCalled(); expect(f.bridge.status().failed).toBe(true);
  }
  const f = fixture(); await expect(f.bridge.bootstrap("recover", descriptor(), f.deadline, f.controller.signal)).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled();
});
it("rejects an expired original deadline or initial abort without dispatch", async () => {
  for (const reason of ["deadline", "abort"]) {
    const f = fixture(); if (reason === "deadline") f.tick(f.deadline); else f.controller.abort();
    await expect(f.bridge.identity(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
    expect(f.start).not.toHaveBeenCalled();
  }
});
it("does not renew the deadline between the transport result and semantic handoff", async () => {
  const f = fixture(), done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  f.result.resolve({ stdout: Buffer.from("descriptor-absent\n"), authorityCommitted: true }); await turn(); f.tick(f.deadline);
  f.settled.resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: true, uncertain: false });
  await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: true });
});
it("honors abort between the transport result and semantic handoff", async () => {
  const f = fixture(), done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  f.result.resolve({ stdout: Buffer.from("descriptor-absent\n"), authorityCommitted: true }); await turn(); f.controller.abort();
  f.settled.resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: true, uncertain: false });
  await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: true });
});
it("cannot turn an uncertain settlement into semantic success", async () => {
  const f = fixture(), done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  f.done("descriptor-absent\n", true, { uncertain: true });
  await expect(done).rejects.toMatchObject({ exitVerified: false, authorityCommitted: true }); expect(f.bridge.status().failed).toBe(true);
});
it("preserves possible authority when the two transport observations contradict each other", async () => {
  const f = fixture(), done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  f.done("descriptor-absent\n", false, { authorityCommitted: true });
  await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: true });
});
it("rejects invalid operation names without dispatching a native operation", async () => {
  const f = fixture();
  await expect(f.bridge.session("anything" as "prepare", descriptor(), f.deadline, f.controller.signal)).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled();
});

it("retains unknown ownership when settled rejects after a transport result and blocks another dispatch", async () => {
  const f = fixture(), done = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  f.result.resolve({ stdout: Buffer.from("descriptor-absent\n"), authorityCommitted: true }); await turn();
  f.settled.reject(new Error("Synthetic missing settlement"));
  await expect(done).rejects.toMatchObject({ exitVerified: false, authorityCommitted: true });
  expect(f.bridge.status()).toMatchObject({ pending: true, failed: true });
  await expect(f.bridge.identity(f.deadline, f.controller.signal)).rejects.toThrow(); expect(f.start).toHaveBeenCalledTimes(1);
});
it("refuses dispatch against an already pending or uncertain owner and stays fenced", async () => {
  for (const status of [{ pending: true, uncertain: false }, { pending: false, uncertain: true }]) {
    const f = fixture(); f.ownerStatus.mockReturnValue(status);
    await expect(f.bridge.identity(f.deadline, f.controller.signal)).rejects.toMatchObject({ exitVerified: false });
    expect(f.start).not.toHaveBeenCalled(); expect(f.bridge.status().failed).toBe(true);
    await expect(f.bridge.identity(f.deadline, f.controller.signal)).rejects.toThrow(); expect(f.start).not.toHaveBeenCalled();
  }
});

it("registers the exact public result promise and rejects a foreign promise without a current fallback", async () => {
  const f = fixture(), original = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  const observation = f.bridge.observeCall(original);
  expect(observation).toBe(f.bridge.observeCurrentCall());
  expect(() => f.bridge.observeCall(Promise.resolve())).toThrow("Unknown");
  expect(f.bridge.observeCall(original)).toBe(observation); f.done(); await original;
  expect(await observation.outcome).toEqual({ status: "fulfilled" });
});
it("binds an observer created inside start to this later-returned task and its original promises", async () => {
  const f = fixture(); let observation: ReturnType<typeof f.bridge.observeCurrentCall>;
  f.onStart(() => { observation = f.bridge.observeCurrentCall(); expect(observation).toBeDefined(); });
  const original = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  expect(f.bridge.observeCall(original)).toBe(observation);
  const binding = await observation!.binding; expect(binding.kind).toBe("task");
  if (binding.kind !== "task") throw new Error("Missing task binding");
  expect(binding.result).toBe(f.result.promise); expect(binding.settled).toBe(f.settled.promise);
  f.done(); await original;
});
it("a new no-task failure never returns the previous successful call settlement", async () => {
  const f = fixture(), first = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  const firstObservation = f.bridge.observeCall(first); f.done(); await first;
  const secondOriginal = f.bridge.identity(0n, f.controller.signal), second = secondOriginal.catch(error => error);
  const secondObservation = f.bridge.observeCall(secondOriginal);
  expect(() => f.bridge.observeCall(second)).toThrow("Unknown");
  expect(f.bridge.observeCurrentCall()).toBe(secondObservation);
  expect(await secondObservation.binding).toEqual({ kind: "no-task" });
  expect((await firstObservation.binding).kind).toBe("task");
  expect(await second).toMatchObject({ exitVerified: true }); expect(f.start).toHaveBeenCalledOnce();
});
it("keeps raw settlement rejection distinct from the original semantic failure", async () => {
  const f = fixture(), original = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal);
  const observation = f.bridge.observeCall(original), failure = original.catch(error => error), reason = new Error("Original missing native settlement");
  f.result.resolve({ stdout: Buffer.from("descriptor-absent\n"), authorityCommitted: true }); f.settled.reject(reason);
  const semantic = await failure, binding = await observation.binding;
  if (binding.kind !== "task") throw new Error("Missing task binding");
  const raw = await Promise.allSettled([binding.settled]);
  expect(raw).toEqual([{ status: "rejected", reason }]);
  expect(await observation.outcome).toEqual({ status: "rejected", reason: semantic });
  expect(semantic).toMatchObject({ exitVerified: false, authorityCommitted: true });
});
it("no-task records preserve an uncertain start error instead of claiming no OS process existed", async () => {
  const f = fixture(), failure = new NativeLaunchFailure(false, true);
  f.start.mockImplementation(() => { throw failure; });
  const original = f.bridge.bootstrap("recover", undefined, f.deadline, f.controller.signal), observation = f.bridge.observeCall(original);
  expect(await original.catch(error => error)).toBe(failure);
  expect(await observation.binding).toEqual({ kind: "no-task" });
  expect(await observation.outcome).toEqual({ status: "rejected", reason: failure }); expect(failure.exitVerified).toBe(false);
});

it("directory retains its original deadline, waits for actual settlement, and verifies the exact receipt", async () => {
  const f = fixture(), original = f.bridge.prepareDirectory(f.deadline, f.controller.signal);
  expect(f.start.mock.calls[0]![0]).toEqual({ kind: "directory" }); expect(f.start.mock.calls[0]![1]).toBe(f.deadline);
  let done = false; void original.then(() => { done = true; });
  f.result.resolve({ stdout: Buffer.from("directory-ready\n"), authorityCommitted: true }); await turn(); expect(done).toBe(false);
  f.settled.resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: true, uncertain: false });
  await original; expect(done).toBe(true); expect((await f.bridge.observeCall(original).binding).kind).toBe("task");
});
it.each(["", "published\n", "directory-ready\nextra"])("directory rejects an invalid receipt %s after the original clean close", async receipt => {
  const f = fixture(), original = f.bridge.prepareDirectory(f.deadline, f.controller.signal); f.done(receipt);
  await expect(original).rejects.toMatchObject({ exitVerified: true, authorityCommitted: true }); expect(f.bridge.status().failed).toBe(true);
});
