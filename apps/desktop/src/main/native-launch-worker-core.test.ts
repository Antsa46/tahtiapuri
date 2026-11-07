import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeLaunchWorkerCore, type NativeLaunchWorkerIo } from "./native-launch-worker-core.js";
import { createNativeLaunchGate, cancelNativeLaunchGate, nativeLaunchGateState } from "./native-launch-gate.js";
import { NativeLaunchSupervisor, type NativeLaunchPort, type NativeLaunchMetadata } from "./native-launch-supervisor.js";

const config = () => ({ schema: 1, pid: process.pid, identity: "C:\\synthetic\\runtime\\helpers\\main-identity.exe",
  bootstrap: "C:\\synthetic\\runtime\\helpers\\main-bootstrap.exe", broker: "C:\\synthetic\\runtime\\bin\\mcp-broker.exe",
  controlFile: "C:\\synthetic\\control\\main-bootstrap.bin", env: { SystemRoot: "C:\\Windows" } });
const id = "11".repeat(16), grant = Buffer.from("THREC001");
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let now = 0n, releaseWrite: (() => void) | undefined;
  const sent: Buffer[] = [], references: Buffer[] = [], messages: Record<string, unknown>[] = [], retire = vi.fn();
  const options = { onSpawn: undefined as (() => void) | undefined, heldWrite: false };
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, callback) {
      references.push(chunk as Buffer); sent.push(Buffer.from(chunk));
      if (options.heldWrite) releaseWrite = callback; else callback();
    } }), kill: vi.fn(() => true) }) as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  const spawn = vi.fn<NativeLaunchWorkerIo["spawn"]>(() => { options.onSpawn?.(); return child; });
  const io: NativeLaunchWorkerIo = { spawn, post: value => messages.push(structuredClone(value) as Record<string, unknown>), retire };
  const core = new NativeLaunchWorkerCore(config(), io, () => now);
  const gate = createNativeLaunchGate();
  const start = (request: NativeLaunchMetadata = { kind: "bootstrap", operation: "recover" }) => core.receive({
    type: "start", version: 1, id, request, deadline: 1_000_000_000n, gate,
  });
  const authorize = (input: ArrayBuffer = Uint8Array.from(grant).buffer) => { core.receive({ type: "authorize", id, input }); return input; };
  return { core, io, spawn, child, gate, options, sent, references, messages, retire, start, authorize,
    setNow: (value: bigint) => { now = value; }, release: () => releaseWrite?.(),
    close: (code = 0, signal: NodeJS.Signals | null = null) => child.emit("close", code, signal) };
}
const fixtures: ReturnType<typeof fixture>[] = [];
const make = () => { const f = fixture(); fixtures.push(f); return f; };
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => { for (const f of fixtures.splice(0)) { f.child.stdin.destroy(); f.child.stdout.destroy(); f.child.stderr.destroy(); } vi.useRealTimers(); });

it("does not start a process from construction or workerData", () => {
  const f = make(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.messages).toEqual([]);
});
it("uses only the nine fixed role and argument forms including its own Main PID", () => {
  const roles: NativeLaunchMetadata[] = [{ kind: "identity" },
    ...(["publish", "consume", "recover"] as const).map(operation => ({ kind: "bootstrap" as const, operation })),
    ...(["prepare", "seal", "publish", "release-pristine", "release-clean"] as const).map(operation => ({ kind: "session" as const, operation }))];
  for (const role of roles) {
    const f = make(); f.start(role);
    const [file, args, options] = f.spawn.mock.calls[0]!;
    expect(file).toBe(role.kind === "identity" ? config().identity : role.kind === "bootstrap" ? config().bootstrap : config().broker);
    expect(args).toEqual(role.kind === "identity" ? ["--identity", String(process.pid)] : ["--" + role.operation, config().controlFile]);
    expect(options).toEqual({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: config().env });
    expect(f.sent).toEqual([]); f.close(1);
  }
});
it("announces launch return but waits for explicit authority before stdin", () => {
  const f = make(); f.start();
  expect(f.messages).toEqual([{ type: "started", id }]); expect(f.sent).toEqual([]);
  f.authorize(); expect(f.sent).toEqual([grant]);
  expect(nativeLaunchGateState(f.gate)).toEqual({ cancelled: false, committed: true }); f.close();
});
it("waits for actual close rather than native output or exit", () => {
  const f = make(); f.start(); f.authorize(); f.child.stdout.write("descriptor-absent\n"); f.child.emit("exit", 0);
  expect(f.messages).toHaveLength(1); expect(f.retire).not.toHaveBeenCalled();
  f.close(); expect(f.messages[1]).toMatchObject({ type: "closed", code: 0, failed: false });
  expect(Buffer.from(f.messages[1]!.stdout as Uint8Array).toString()).toBe("descriptor-absent\n");
  expect(f.retire).toHaveBeenCalledWith(false);
});
it("retains a private input copy until the queued write callback rather than zeroing it early", async () => {
  const f = make(); f.options.heldWrite = true; f.start();
  const wire = f.authorize();
  expect(new Uint8Array(wire)).toEqual(new Uint8Array(8));
  expect(f.references[0]).toEqual(grant);
  f.release(); await turn(); expect(f.references[0]).toEqual(Buffer.alloc(8)); f.close();
});
it("preserves possible authority delivery after commit and cancellation", () => {
  const f = make(); f.options.heldWrite = true; f.start(); f.authorize();
  f.core.receive({ type: "cancel", id });
  expect(nativeLaunchGateState(f.gate)).toEqual({ cancelled: true, committed: true });
  expect(f.references[0]).toEqual(grant); expect(f.retire).not.toHaveBeenCalled();
  f.close(1); expect(f.references[0]).toEqual(Buffer.alloc(8)); expect(f.messages[1]).toMatchObject({ failed: true });
});
it("withholds input after a late synchronous launch even without timer dispatch", () => {
  const f = make(); f.options.onSpawn = () => f.setNow(1_000_000_001n); f.start(); f.authorize();
  expect(f.sent).toEqual([]); expect(f.child.kill).toHaveBeenCalledTimes(1);
  expect(nativeLaunchGateState(f.gate)).toEqual({ cancelled: true, committed: false });
  expect(f.retire).not.toHaveBeenCalled(); f.close(1); expect(f.messages[1]).toMatchObject({ failed: true });
});
it("withholds authority cancelled before authorize and requests owned stop once", () => {
  const f = make(); f.start(); cancelNativeLaunchGate(f.gate); f.authorize();
  f.core.peerFailed(); f.core.receive({ type: "cancel", id });
  expect(f.sent).toEqual([]); expect(f.child.kill).toHaveBeenCalledTimes(1);
  expect(nativeLaunchGateState(f.gate).committed).toBe(false); f.close(1);
});
it("withholds a queued authorization whose original deadline already passed", () => {
  const f = make(); f.start(); f.setNow(1_000_000_001n); f.authorize();
  expect(f.sent).toEqual([]); expect(f.child.kill).toHaveBeenCalledTimes(1); f.close(1);
});
it("does not launch for expired or cancelled initial metadata", () => {
  for (const reason of ["deadline", "cancelled"] as const) {
    const f = make(); if (reason === "deadline") f.setNow(1_000_000_001n); else cancelNativeLaunchGate(f.gate);
    f.start(); expect(f.spawn).not.toHaveBeenCalled(); expect(f.retire).toHaveBeenCalledWith(true);
  }
});
it("rejects wrong, partial, oversized and shared recovery inputs before commit", () => {
  for (const bytes of [new ArrayBuffer(7), new ArrayBuffer(9), Uint8Array.from(Buffer.from("THREC002")).buffer, new SharedArrayBuffer(8)]) {
    const f = make(); f.start(); f.core.receive({ type: "authorize", id, input: bytes });
    expect(f.sent).toEqual([]); expect(nativeLaunchGateState(f.gate).committed).toBe(false);
    expect(f.child.kill).toHaveBeenCalledTimes(1); f.close(1);
  }
});
it("rejects duplicate authorization without a second write", () => {
  const f = make(); f.start(); f.authorize(); f.authorize();
  expect(f.sent).toHaveLength(1); expect(f.child.kill).toHaveBeenCalledTimes(1);
  expect(nativeLaunchGateState(f.gate).committed).toBe(true); f.close(1);
});
it("rejects duplicate start without replacing the original child", () => {
  const f = make(); f.start(); f.start();
  expect(f.spawn).toHaveBeenCalledTimes(1); expect(f.child.kill).toHaveBeenCalledTimes(1);
  expect(f.retire).not.toHaveBeenCalled(); f.close(1);
});
it("a synchronous stdin failure retains the child until actual close", () => {
  const f = make(); f.start();
  vi.spyOn(f.child.stdin, "end").mockImplementation(() => { throw new Error("Synthetic stdin failure"); });
  f.authorize(); expect(f.child.kill).toHaveBeenCalledTimes(1); expect(f.retire).not.toHaveBeenCalled();
  expect(nativeLaunchGateState(f.gate).committed).toBe(true);
  f.close(1); expect(f.messages[1]).toMatchObject({ failed: true }); expect(f.retire).toHaveBeenCalledWith(false);
});
it("peer failure while child is alive cannot retire or forget it", () => {
  const f = make(); f.start(); f.core.peerFailed();
  expect(f.retire).not.toHaveBeenCalled(); expect(f.child.kill).toHaveBeenCalledTimes(1);
  f.close(1); expect(f.messages[1]).toMatchObject({ failed: true });
});
it("bounds stdout and stderr and observes close after overflow", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const f = make(); f.start(); f.child[stream].write(Buffer.alloc(stream === "stdout" ? 129 : 130));
    expect(f.child.kill).toHaveBeenCalledTimes(1); expect(f.retire).not.toHaveBeenCalled(); f.close(1);
    expect((f.messages[1]!.stdout as Uint8Array).length).toBeLessThanOrEqual(128);
    expect(f.messages[1]!.stderrBytes as number).toBeLessThanOrEqual(129);
    expect(f.messages[1]!.failed).toBe(true);
  }
});
it("a timer expiry stops only its own retained child", async () => {
  const f = make(); f.start(); f.setNow(1_000_000_001n);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.child.kill).toHaveBeenCalledTimes(1); expect(f.retire).not.toHaveBeenCalled();
  f.close(1); expect(f.messages[1]!.failed).toBe(true);
});
it("read-only identity rejects any stdin authorization", () => {
  const f = make(); f.start({ kind: "identity" }); f.authorize();
  expect(f.sent).toEqual([]); expect(nativeLaunchGateState(f.gate).committed).toBe(false); f.close(1);
});
it("rejects coerced operations, extra command fields and wrong IDs", () => {
  const invalid = [{ kind: "bootstrap", operation: new String("publish") }, { kind: "identity", argv: [] }];
  for (const request of invalid) {
    const f = make(); f.core.receive({ type: "start", version: 1, id, request, deadline: 1_000_000_000n, gate: f.gate });
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.retire).toHaveBeenCalledWith(true);
  }
  const f = make(); f.start(); f.core.receive({ type: "authorize", id: "22".repeat(16), input: new ArrayBuffer(8) });
  expect(f.sent).toEqual([]); f.close(1);
});
it("late callbacks after terminal close cannot mutate the shared gate or send another result", () => {
  const f = make(); f.start(); f.authorize(); f.close();
  const state = nativeLaunchGateState(f.gate);
  f.child.emit("error", new Error("Late synthetic child event")); f.core.peerFailed(); f.close();
  expect(nativeLaunchGateState(f.gate)).toEqual(state); expect(f.messages).toHaveLength(2);
  expect(f.retire).toHaveBeenCalledTimes(1);
});
it("connects the same worker core to the Main supervisor handshake", async () => {
  const f = make(); let onMessage!: (value: unknown) => void, onExit!: (value: number) => void;
  f.io.post = value => onMessage(structuredClone(value));
  f.io.retire = uncertain => onExit(uncertain ? 1 : 0);
  const port: NativeLaunchPort = { onMessage: listener => { onMessage = listener; }, onError: () => {},
    onExit: listener => { onExit = listener; },
    postMessage: (value, transfer = []) => f.core.receive(structuredClone(value, { transfer })) };
  const supervisor = new NativeLaunchSupervisor(() => port, () => 0n);
  const task = supervisor.start({ kind: "bootstrap", operation: "recover" }, 1_000_000_000n);
  expect(f.sent).toEqual([grant]); f.child.stdout.write("descriptor-absent\n"); f.close();
  expect((await task.result).stdout.toString()).toBe("descriptor-absent\n");
  expect(await task.settled).toMatchObject({ childCloseObserved: true, workerExited: true, authorityCommitted: true, uncertain: false });
});

it("accepts at most the original twenty-second cold-launch cap without releasing authority", () => {
  const exact = make();
  exact.core.receive({ type: "start", version: 1, id, request: { kind: "bootstrap", operation: "recover" },
    deadline: 20_000_000_000n, gate: exact.gate });
  expect(exact.spawn).toHaveBeenCalledTimes(1); expect(exact.sent).toEqual([]); exact.close(1);
  const over = make();
  over.core.receive({ type: "start", version: 1, id, request: { kind: "bootstrap", operation: "recover" },
    deadline: 20_000_000_001n, gate: over.gate });
  expect(over.spawn).not.toHaveBeenCalled(); expect(over.retire).toHaveBeenCalledWith(true);
});
