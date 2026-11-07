import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeRecoveryProbe } from "../../support/mcp/native-recovery-probe.js";

const prefix = Buffer.from([84, 77, 66, 79, 79, 84, 49, 0]), grant = Buffer.from("THREC001");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let now = 0;
  const children: (ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> })[] = [];
  const receipts = new Map<string, unknown>(), sent: Buffer[] = [];
  const state = { pending: undefined as Buffer | undefined, createGate: undefined as Promise<void> | undefined,
    autoRespond: false, closeOnKill: true, code: 1, stdout: undefined as string | undefined,
    onLaunch: undefined as ((child: ChildProcessWithoutNullStreams) => void) | undefined, removed: 0 };
  const launch = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { pid: 7000 + children.length,
      stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(chunk, _encoding, callback) { sent.push(Buffer.from(chunk)); callback(); } }),
      kill: vi.fn(() => {
        if (state.closeOnKill) queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return true;
      }) });
    child.stdin.once("finish", () => {
      if (!state.autoRespond) return;
      queueMicrotask(() => {
        if (state.code === 0) state.pending = undefined;
        if (state.stdout !== undefined) child.stdout.write(state.stdout);
        else if (state.code === 0) child.stdout.write("descriptor-absent\n");
        else child.stderr.write("bootstrap-input-size:13\r\n");
        child.emit("close", state.code, null);
      });
    });
    const typed = child as unknown as ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> };
    children.push(typed); state.onLaunch?.(typed); return typed;
  });
  const probe = new NativeRecoveryProbe({
    async absent(which) { if (which === "pending" && state.pending) throw new Error("Synthetic fixture exists"); },
    async createPending() { state.pending = Buffer.from(prefix); await state.createGate; },
    async readPending() { if (!state.pending) throw new Error("Synthetic fixture missing"); return Buffer.from(state.pending); },
    async removePending() { ++state.removed; state.pending = undefined; },
    async diagnostic(name, value) { if (receipts.has(name)) throw new Error("Duplicate receipt"); receipts.set(name, value); },
  }, launch, () => now);
  return { probe, state, launch, children, receipts, sent, setNow: (value: number) => { now = value; },
    advance: async (value: number) => { now += value; await vi.advanceTimersByTimeAsync(value); },
    dispose: () => { for (const child of children) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); } } };
}
const active: ReturnType<typeof fixture>[] = [];
const create = () => { const f = fixture(); active.push(f); return f; };
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => { for (const f of active.splice(0)) f.dispose(); vi.useRealTimers(); });

it("retains pending filesystem work and refuses later launches after the original timeout", async () => {
  const f = create(), gate = deferred<void>(); f.state.createGate = gate.promise;
  const outcome = f.probe.run(Buffer.alloc(0), "eof", false, 1).catch(error => error);
  await turn(); expect(f.probe.snapshot().pendingWork).toEqual([{ kind: "filesystem", operation: "pending-create" }]);
  await f.advance(8500); expect(await outcome).toBeInstanceOf(Error);
  expect(f.launch).not.toHaveBeenCalled(); const original = f.probe.snapshot().originalFailure;
  const teardown = f.probe.teardown(); await f.advance(1000); const result = await teardown;
  expect(result.drainedWithinBudget).toBe(false); expect(result.pendingWork).toHaveLength(1);
  expect(result.contexts[0]).toMatchObject({ spawn: "not-entered", childReturned: false, operationSettled: true });
  gate.resolve(); await turn();
  expect(f.probe.snapshot().originalFailure).toEqual(original);
  expect(f.probe.snapshot().pendingWork).toEqual([]); expect(f.state.removed).toBe(0);
  await expect(f.probe.run(grant, "eof", true, 0)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled(); expect(f.receipts.has("teardown.json")).toBe(true);
});
it("a late synchronous spawn with no timer dispatch receives no input and retains its actual close", async () => {
  const f = create(); f.state.onLaunch = () => f.setNow(12000);
  const outcome = await f.probe.run(grant, "eof", true, 0).catch(error => error);
  expect(outcome).toBeInstanceOf(Error); expect(f.sent).toEqual([]);
  expect(f.children[0]!.kill).toHaveBeenCalledTimes(1);
  const row = f.probe.snapshot();
  expect(row.originalFailure).toMatchObject({ reason: "case-deadline", at: 12000 });
  expect(row.contexts[0]).toMatchObject({ spawn: "returned", childReturned: true,
    inputAttempted: false, childCloseObserved: true, closeAfterOriginalFailure: true });
  expect(f.receipts.get("case-01-process.json")).toMatchObject({ failed: true, closeObserved: true, inputAttempted: false });
  const result = await f.probe.teardown(); expect(result.failed).toBe(true);
});
it("a synchronous stdin exception still waits for the same owned child close", async () => {
  const f = create(); f.state.closeOnKill = false;
  f.state.onLaunch = child => { vi.spyOn(child.stdin, "end").mockImplementation(() => { throw new Error("Synthetic stdin throw"); }); };
  let settled = false;
  const outcome = f.probe.run(grant, "eof", true, 0).catch(error => error).then(value => { settled = true; return value; });
  await turn(); expect(f.children[0]!.kill).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false); expect(f.probe.snapshot().contexts[0]!.childCloseObserved).toBe(false);
  f.children[0]!.emit("close", null, "SIGTERM");
  expect(await outcome).toBeInstanceOf(Error);
  expect(f.receipts.get("case-01-process.json")).toMatchObject({ failed: true, closeObserved: true, inputError: true });
  expect((await f.probe.teardown()).failed).toBe(true);
});
it("a close during teardown is recorded separately and never upgrades the original failure", async () => {
  const f = create(); f.state.closeOnKill = false;
  const outcome = f.probe.run(grant, "eof", true, 0).catch(error => error);
  await turn(); const teardown = f.probe.teardown();
  const original = f.probe.snapshot().originalFailure;
  expect(original).toMatchObject({ reason: "teardown-unsettled" });
  await expect(f.probe.run(grant, "eof", true, 0)).rejects.toThrow();
  setTimeout(() => f.children[0]!.emit("close", null, "SIGTERM"), 500);
  await f.advance(500); expect(await outcome).toBeInstanceOf(Error);
  const result = await teardown;
  expect(result.failed).toBe(true); expect(result.originalFailure).toEqual(original);
  expect(result.drainedWithinBudget).toBe(true);
  expect(result.contexts[0]).toMatchObject({ childCloseObserved: true, closeAfterOriginalFailure: true, operationSettled: true });
  expect(f.children[0]!.kill).toHaveBeenCalledTimes(1);
  expect(f.receipts.get("teardown.json")).toMatchObject({ failed: true, originalFailure: original });
});
it("allows serial completed cases and freezes a clean teardown without a replacement child", async () => {
  const f = create(); f.state.autoRespond = true;
  await expect(f.probe.run(Buffer.alloc(0), "eof", false, 1)).resolves.toMatchObject({ code: 1, killed: false });
  f.state.code = 0;
  await expect(f.probe.run(grant, "eof", true, 0)).resolves.toMatchObject({ code: 0, killed: false });
  expect(f.launch).toHaveBeenCalledTimes(2); expect(f.state.removed).toBe(1);
  const result = await f.probe.teardown();
  expect(result.failed).toBe(false); expect(result.pendingWork).toEqual([]);
  expect(result.contexts.every(context => context.operationSettled && context.childCloseObserved)).toBe(true);
  expect(result.eventsOverflow).toBe(false); expect(result.drainedWithinBudget).toBe(true);
});
it("uses event order when close and a later failure share the same clock tick", async () => {
  const f = create(); f.state.autoRespond = true; f.state.code = 0; f.state.stdout = "wrong\n";
  expect(await f.probe.run(grant, "eof", true, 0).catch(error => error)).toBeInstanceOf(Error);
  const result = await f.probe.teardown();
  expect(result.originalFailure?.at).toBe(0); expect(result.contexts[0]!.childCloseAt).toBe(0);
  expect(result.contexts[0]!.closeAfterOriginalFailure).toBe(false);
});
it("retains a late package verification promise without allowing helper launch", async () => {
  const f = create(), gate = deferred<void>();
  const outcome = f.probe.prepare(() => gate.promise).catch(error => error);
  await f.advance(10000); expect(await outcome).toBeInstanceOf(Error);
  expect(f.probe.snapshot().pendingWork).toEqual([{ kind: "filesystem", operation: "package-verify" }]);
  const teardown = f.probe.teardown(); await f.advance(1000); expect((await teardown).drainedWithinBudget).toBe(false);
  gate.resolve(); await turn();
  expect(f.probe.canStart()).toBe(false); expect(f.launch).not.toHaveBeenCalled();
});
