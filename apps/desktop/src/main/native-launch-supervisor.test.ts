import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeLaunchFailure, NativeLaunchSupervisor, type NativeLaunchCommand, type NativeLaunchPort, type NativeLaunchRequest } from "./native-launch-supervisor.js";
import { commitNativeLaunchGate, nativeLaunchGateState } from "./native-launch-gate.js";

class Peer implements NativeLaunchPort {
  commands: NativeLaunchCommand[] = [];
  message!: (value: unknown) => void; error!: () => void; exited!: (code: number) => void;
  onMessage(listener: (value: unknown) => void) { this.message = listener; }
  onError(listener: () => void) { this.error = listener; }
  onExit(listener: (code: number) => void) { this.exited = listener; }
  postMessage(value: NativeLaunchCommand, transfer: ArrayBuffer[] = []) {
    this.commands.push(structuredClone(value, { transfer }));
  }
  get start() {
    const value = this.commands.find(command => command.type === "start");
    if (!value || value.type !== "start") throw new Error("Missing test start");
    return value;
  }
  started() { this.message({ type: "started", id: this.start.id }); }
  commit(now: () => bigint) { return commitNativeLaunchGate(this.start.gate, this.start.deadline, now); }
  closed(overrides: Record<string, unknown> = {}) {
    this.message({ type: "closed", id: this.start.id, code: 0, signal: null,
      stdout: Buffer.from("published\n"), stderrBytes: 0, failed: false, ...overrides });
  }
  authorizations() { return this.commands.filter(command => command.type === "authorize"); }
}
function fixture(onCreate?: () => void) {
  let ticks = 0n; const peers: Peer[] = [];
  const factory = vi.fn(() => { onCreate?.(); const peer = new Peer(); peers.push(peer); return peer; });
  const clock = () => ticks, owner = new NativeLaunchSupervisor(factory, clock);
  return { owner, peers, factory, clock, tick: (value: bigint) => { ticks = value; },
    launch: (request: NativeLaunchRequest = { kind: "bootstrap", operation: "publish", input: Buffer.alloc(96, 0x5a) }, signal?: AbortSignal) => {
      const task = owner.start(request, 1_000_000_000n, signal); return { task, peer: peers.at(-1)! };
    } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("sends no authority in the launch request and preserves the absolute deadline", async () => {
  const f = fixture(), { task, peer } = f.launch();
  expect(peer.start.request).toEqual({ kind: "bootstrap", operation: "publish" });
  expect(peer.start.deadline).toBe(1_000_000_000n); expect(peer.authorizations()).toEqual([]);
  peer.started(); expect(peer.commit(f.clock)).toBe(true); peer.closed(); peer.exited(0);
  expect((await task.result).stdout.toString()).toBe("published\n");
  expect(await task.settled).toMatchObject({ childCloseObserved: true, workerExited: true, uncertain: false });
});
it("copies authority synchronously before the factory can mutate the caller buffer", async () => {
  const input = Buffer.alloc(96, 0x5a), f = fixture(() => input.fill(0));
  const { task, peer } = f.launch({ kind: "session", operation: "seal", input });
  peer.started(); const authorization = peer.authorizations()[0]!;
  expect(authorization.type).toBe("authorize");
  if (authorization.type !== "authorize") throw new Error("Missing authorization");
  expect([...new Uint8Array(authorization.input)]).toEqual(Array(96).fill(0x5a));
  expect(authorization.input.byteLength).toBe(96);
  peer.commit(f.clock); peer.closed(); peer.exited(0); await task.result; await task.settled;
});
it("waits for worker exit after actual child close before reporting success", async () => {
  const f = fixture(), { task, peer } = f.launch(); let resolved = false;
  void task.result.then(() => { resolved = true; });
  peer.started(); peer.commit(f.clock); peer.closed(); await Promise.resolve();
  expect(resolved).toBe(false); expect(f.owner.status().pending).toBe(true);
  peer.exited(0); await task.result; await task.settled; expect(resolved).toBe(true);
});
it("rejects a second outstanding request without launching another worker", async () => {
  const f = fixture(), { task, peer } = f.launch();
  expect(() => f.launch()).toThrow(NativeLaunchFailure); expect(f.factory).toHaveBeenCalledTimes(1);
  peer.started(); peer.commit(f.clock); peer.closed(); peer.exited(0); await task.result; await task.settled;
});
it("allows a new request only after a fully known clean settlement", async () => {
  const f = fixture();
  for (let i = 0; i < 2; ++i) {
    const { task, peer } = f.launch(); peer.started(); peer.commit(f.clock); peer.closed(); peer.exited(0);
    await task.result; await task.settled;
  }
  expect(f.factory).toHaveBeenCalledTimes(2);
});
it("rejects invalid or expired deadlines before worker creation", () => {
  const f = fixture();
  for (const deadline of [0n, 20_000_000_001n])
    expect(() => f.owner.start({ kind: "identity" }, deadline)).toThrow(NativeLaunchFailure);
  expect(f.factory).not.toHaveBeenCalled();
});
it("rejects an already cancelled request before worker creation", () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  expect(() => f.launch(undefined, controller.signal)).toThrow(NativeLaunchFailure);
  expect(f.factory).not.toHaveBeenCalled();
});
it("does not accept command, environment or executable fields", () => {
  const f = fixture();
  expect(() => f.launch({ kind: "identity", argv: ["anything"] } as unknown as NativeLaunchRequest)).toThrow("Invalid native launch request");
  expect(f.factory).not.toHaveBeenCalled();
});
it("cancellation before started withholds authority and keeps late close uncertain", async () => {
  const f = fixture(), controller = new AbortController(), { task, peer } = f.launch(undefined, controller.signal);
  const failure = task.result.catch(error => error); controller.abort(); peer.started();
  expect(peer.authorizations()).toEqual([]);
  expect(nativeLaunchGateState(peer.start.gate)).toEqual({ cancelled: true, committed: false });
  peer.closed({ code: null, signal: "SIGTERM", failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: false, authorityCommitted: false });
  expect(await task.settled).toMatchObject({ childCloseObserved: true, workerExited: true, uncertain: true });
  expect(() => f.launch()).toThrow(NativeLaunchFailure);
});
it("an expired clock with no timer dispatch still withholds authority", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  f.tick(1_000_000_000n); peer.started(); expect(peer.authorizations()).toEqual([]);
  peer.closed({ code: 1, failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: false }); await task.settled;
});
it("timeout can return while ownership remains pending, without worker termination", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  f.tick(1_000_000_000n); await vi.advanceTimersByTimeAsync(1000);
  expect(await failure).toMatchObject({ exitVerified: false });
  expect(f.owner.status()).toEqual({ pending: true, uncertain: true });
  peer.started(); expect(peer.authorizations()).toEqual([]);
  peer.closed({ code: 1, failed: true }); peer.exited(0);
  expect(await task.settled).toMatchObject({ childCloseObserved: true, uncertain: true });
  expect(await task.result.catch(error => error)).toBe(await failure);
});
it("a cancellation before CAS prevents native delivery even after authorize was sent", async () => {
  const f = fixture(), controller = new AbortController(), { task, peer } = f.launch(undefined, controller.signal);
  const failure = task.result.catch(error => error); peer.started(); controller.abort();
  expect(peer.authorizations()).toHaveLength(1); expect(peer.commit(f.clock)).toBe(false);
  peer.closed({ code: 1, failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ authorityCommitted: false }); await task.settled;
});
it("a commit before cancellation never claims authority was withheld", async () => {
  const f = fixture(), controller = new AbortController(), { task, peer } = f.launch(undefined, controller.signal);
  const failure = task.result.catch(error => error); peer.started(); expect(peer.commit(f.clock)).toBe(true); controller.abort();
  peer.closed({ code: 1, failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ authorityCommitted: true }); await task.settled;
});
it("recover authorizes only its own fixed eight-byte frame after started", async () => {
  const f = fixture(), { task, peer } = f.launch({ kind: "bootstrap", operation: "recover" });
  peer.started(); const command = peer.authorizations()[0]!;
  expect(command.type === "authorize" && command.input.byteLength).toBe(8);
  if (command.type !== "authorize") throw new Error("Missing recovery grant");
  expect(Buffer.from(command.input).toString("ascii")).toBe("THREC001");
  expect(peer.commit(f.clock)).toBe(true); peer.closed({ stdout: Buffer.from("descriptor-absent\n") }); peer.exited(0);
  expect((await task.result).authorityCommitted).toBe(true); await task.settled;
});
it("identity is read-only at launch and never receives an stdin authorization", async () => {
  const f = fixture(), { task, peer } = f.launch({ kind: "identity" }); peer.started();
  expect(peer.authorizations()).toEqual([]); peer.closed({ stdout: Buffer.from("identity\n") }); peer.exited(0);
  expect((await task.result).authorityCommitted).toBe(false); await task.settled;
});
it("worker exit without a child close proof fences future requests", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error); peer.exited(1);
  expect(await failure).toMatchObject({ exitVerified: false });
  expect(await task.settled).toMatchObject({ childCloseObserved: false, workerExited: true, uncertain: true });
  expect(() => f.launch()).toThrow(NativeLaunchFailure);
});
it("worker error preserves uncertainty despite a later known close", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  peer.started(); peer.error(); peer.closed({ code: 1, failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: false });
  expect(await task.settled).toMatchObject({ childCloseObserved: true, uncertain: true });
});
it("wrong request ids fail and do not release authority", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  peer.message({ type: "started", id: (peer.start.id[0] === "0" ? "1" : "0") + peer.start.id.slice(1) }); peer.started();
  expect(peer.authorizations()).toEqual([]); peer.closed({ code: 1, failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: false }); await task.settled;
});
it("duplicate started messages cannot authorize twice", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  peer.started(); peer.started(); expect(peer.authorizations()).toHaveLength(1);
  peer.closed({ code: 1, failed: true }); peer.exited(0); await failure; await task.settled;
});
it("a fully known failed helper exit is failure with a proved settlement", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  peer.started(); peer.closed({ code: 1, stderrBytes: 1, failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: true }); expect(await task.settled).toMatchObject({ uncertain: false });
});
it("invalid final output cannot become a success receipt", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  peer.started(); peer.message({ type: "closed", id: peer.start.id, code: 0, signal: null,
    stdout: Buffer.alloc(129), stderrBytes: 0, failed: false }); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: false });
  expect(await task.settled).toMatchObject({ childCloseObserved: false, uncertain: true });
});
it("factory failure leaves the lifetime owner fenced", async () => {
  const owner = new NativeLaunchSupervisor(() => { throw new Error("synthetic constructor error"); }, () => 0n);
  const task = owner.start({ kind: "identity" }, 1_000_000_000n);
  await expect(task.result).rejects.toMatchObject({ exitVerified: false });
  expect(await task.settled).toMatchObject({ workerExited: false, uncertain: true });
  expect(() => owner.start({ kind: "identity" }, 1_000_000_000n)).toThrow(NativeLaunchFailure);
});

it("retains an uncertain worker handle when listener setup fails", async () => {
  const peer = new Peer(); peer.onMessage = () => { throw new Error("synthetic listener failure"); };
  const owner = new NativeLaunchSupervisor(() => peer, () => 0n);
  const task = owner.start({ kind: "identity" }, 1_000_000_000n);
  await expect(task.result).rejects.toMatchObject({ exitVerified: false });
  expect(owner.status()).toEqual({ pending: true, uncertain: true });
  expect(() => owner.start({ kind: "identity" }, 1_000_000_000n)).toThrow(NativeLaunchFailure);
});
it("corrupted shared state fails without throwing out of the message callback", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  Atomics.store(new Int32Array(peer.start.gate), 0, 4);
  expect(() => peer.started()).not.toThrow(); expect(peer.authorizations()).toEqual([]);
  peer.closed({ code: 1, failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: false, authorityCommitted: true });
  expect(await task.settled).toMatchObject({ uncertain: true });
});

it("an old port error cannot poison the next request", async () => {
  const f = fixture(), first = f.launch(); first.peer.started(); first.peer.commit(f.clock); first.peer.closed(); first.peer.exited(0);
  await first.task.result; await first.task.settled;
  const second = f.launch(); first.peer.error();
  expect(f.owner.status()).toEqual({ pending: true, uncertain: false });
  second.peer.started(); second.peer.commit(f.clock); second.peer.closed(); second.peer.exited(0);
  await second.task.result; expect(await second.task.settled).toMatchObject({ uncertain: false });
});
it("a successful mutating close without gate commitment is a protocol failure", async () => {
  const f = fixture(), { task, peer } = f.launch(); const failure = task.result.catch(error => error);
  peer.started(); peer.closed(); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: false });
  expect(await task.settled).toMatchObject({ childCloseObserved: true, uncertain: true });
});
it("identity cannot report a mutating gate commitment", async () => {
  const f = fixture(), { task, peer } = f.launch({ kind: "identity" }); const failure = task.result.catch(error => error);
  peer.started(); peer.commit(f.clock); peer.closed(); peer.exited(0);
  expect(await failure).toMatchObject({ exitVerified: false, authorityCommitted: true });
  expect(await task.settled).toMatchObject({ uncertain: true });
});

it("recover refuses caller-supplied input before creating a worker", () => {
  const f = fixture();
  expect(() => f.launch({ kind: "bootstrap", operation: "recover", input: Buffer.from("THREC001") } as unknown as NativeLaunchRequest))
    .toThrow("Invalid native launch request");
  expect(f.factory).not.toHaveBeenCalled();
});
it("recover cancelled before started never releases its fixed frame", async () => {
  const f = fixture(), controller = new AbortController();
  const { task, peer } = f.launch({ kind: "bootstrap", operation: "recover" }, controller.signal);
  const failure = task.result.catch(error => error); controller.abort(); peer.started();
  expect(peer.authorizations()).toEqual([]);
  expect(peer.commit(f.clock)).toBe(false);
  peer.closed({ code: 1, failed: true }); peer.exited(0);
  expect(await failure).toMatchObject({ authorityCommitted: false }); await task.settled;
});

it("directory sends only fixed metadata and its exact raw grant after the original start acknowledgement", async () => {
  const f = fixture(), { task, peer } = f.launch({ kind: "directory" });
  expect(peer.start.request).toEqual({ kind: "directory" }); expect(peer.authorizations()).toEqual([]);
  peer.started(); const message = peer.authorizations()[0]!;
  if (message.type !== "authorize") throw new Error("Missing directory authorization");
  expect(Buffer.from(message.input).toString("ascii")).toBe("THDIR001");
  peer.commit(f.clock); peer.closed({ stdout: Buffer.from("directory-ready\n") }); peer.exited(0);
  expect((await task.result).authorityCommitted).toBe(true); expect((await task.settled).uncertain).toBe(false);
});
it("directory cannot obtain a grant from a late start acknowledgement without timer dispatch", async () => {
  const f = fixture(), { task, peer } = f.launch({ kind: "directory" }), rejected = task.result.catch(error => error);
  f.tick(1_000_000_001n); peer.started(); expect(peer.authorizations()).toEqual([]);
  peer.closed({ code: null, signal: "SIGTERM", failed: true }); peer.exited(0);
  expect(await rejected).toMatchObject({ exitVerified: false, authorityCommitted: false });
  expect((await task.settled).uncertain).toBe(true);
});
it("a directory cancellation after grant retains its committed authority and original failed result", async () => {
  const f = fixture(), abort = new AbortController(), { task, peer } = f.launch({ kind: "directory" }, abort.signal);
  const rejected = task.result.catch(error => error); peer.started(); expect(peer.commit(f.clock)).toBe(true); abort.abort();
  peer.closed({ code: null, signal: "SIGTERM", failed: true }); peer.exited(0);
  expect(await rejected).toMatchObject({ exitVerified: false, authorityCommitted: true });
  expect(await task.settled).toMatchObject({ authorityCommitted: true, uncertain: true });
});
