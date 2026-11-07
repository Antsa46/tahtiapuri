import { Duplex } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { DevelopmentResult } from "@tahtiapuri/validation/development";
import { NativeDevelopmentAdmission, type NativeLaunchTicket } from "./native-development-admission.js";
import { NativeMainConnection } from "./native-main-connection.js";
import { ControlKind, NativeControl, encodeControlFrame } from "./native-development-wire.js";

const epoch = "a".repeat(64);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (connected = true): DevelopmentResult => ({ ok: true, status: { enabled: true, connected,
  protocolVersion: 1, modelId: "qwen3-4b-q4-k-m", engineVersion: "3.22.2" } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Wire extends Duplex {
  readonly sent: Buffer[] = [];
  readonly held: ((error?: Error) => void)[] = [];
  hold = false;
  react: ((bytes: Buffer) => void) | undefined;
  constructor() { super({ highWaterMark: 1 }); }
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    const bytes = Buffer.from(chunk); this.sent.push(bytes); this.react?.(bytes);
    if (this.hold) this.held.push(callback); else callback();
  }
}
const fixtures: { stream: Wire }[] = [];
function fixture() {
  const stream = new Wire();
  const development = vi.fn(async (operation: string): Promise<DevelopmentResult> => status(operation !== "development.detach"));
  const admission = new NativeDevelopmentAdmission({ development }, epoch, 50);
  const ticket = admission.issueTicket()!;
  const owner = { consume: vi.fn(async (_ticket: NativeLaunchTicket, _signal: AbortSignal, _deadline: number) => {}), revoke: vi.fn(async () => true) };
  const connection = new NativeMainConnection(stream, admission, owner);
  let sequence = 1;
  const send = (kind: typeof ControlKind[keyof typeof ControlKind], body = Buffer.alloc(0)) =>
    stream.emit("data", encodeControlFrame({ kind, body }, sequence++, "to-main"));
  const hello = (token = ticket.token) => send(ControlKind.hello, Buffer.from(ticket.generation + token, "hex"));
  const request = (i = 1, extra: Record<string, unknown> = {}) => send(ControlKind.request,
    Buffer.from(JSON.stringify({ id: "00000000-0000-4000-8000-" + String(i).padStart(12, "0"), operation: "status", input: null, ...extra })));
  const f = { stream, development, admission, ticket, owner, connection, send, hello, request };
  fixtures.push(f); return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.stream.destroy();
    for (const release of f.stream.held.splice(0)) release();
  }
  await tick(); vi.useRealTimers();
});
async function ready(f: ReturnType<typeof fixture>) { f.hello(); await tick(); expect(f.stream.sent[0]?.[5]).toBe(ControlKind.accept); }
it("requires descriptor removal and actual attach before ACK, then dispatches a bounded request", async () => {
  const f = fixture(), removed = deferred<void>(), attached = deferred<DevelopmentResult>();
  f.owner.consume.mockImplementation(() => removed.promise);
  f.development.mockImplementation(op => op === "development.attach" ? attached.promise : Promise.resolve(status(op !== "development.detach")));
  f.hello(); await tick(); expect(f.stream.sent).toHaveLength(0);
  removed.resolve(); await tick(); expect(f.stream.sent).toHaveLength(0);
  attached.resolve(status()); await tick(); expect(f.stream.sent[0]?.[5]).toBe(ControlKind.accept);
  expect(f.stream.sent[0]!.subarray(16).toString("hex")).toBe(f.ticket.generation);
  f.request(); await tick(); expect(f.stream.sent[1]?.[5]).toBe(ControlKind.response);
  expect(JSON.parse(f.stream.sent[1]!.subarray(16).toString())).toMatchObject({ result: { ok: true } });
  f.send(ControlKind.clean);
  expect(await f.connection.closed).toEqual({ authenticated: true, brokerCleanupReported: true, backendDetachSettled: true,
    descriptorConsumptionSettled: true, epochRevoked: true, streamClosed: true, failed: false });
  expect(f.admission.issueTicket()).toBeUndefined(); expect(f.owner.revoke).toHaveBeenCalledTimes(1);
});
it("allows a peer reacting to ACK before its physical callback", async () => {
  const f = fixture(); f.stream.react = bytes => { if (bytes[5] === ControlKind.accept) f.request(); };
  await ready(f); await tick(); expect(f.stream.sent[1]?.[5]).toBe(ControlKind.response);
  f.send(ControlKind.clean); expect((await f.connection.closed).failed).toBe(false);
});
it("rejects the legacy epoch and leaves an unclaimed ticket usable by the rightful broker", async () => {
  const f = fixture(); f.hello(epoch);
  expect(await f.connection.closed).toMatchObject({ authenticated: false, epochRevoked: false, backendDetachSettled: false }); expect(f.development).not.toHaveBeenCalled();
  expect(f.owner.consume).not.toHaveBeenCalled(); expect(f.owner.revoke).not.toHaveBeenCalled();
  expect(f.admission.phase).toBe("available"); await f.admission.disable();
});
it("rejects request pipelining before descriptor consumption", async () => {
  const f = fixture(), removed = deferred<void>(); f.owner.consume.mockImplementation(() => removed.promise);
  f.hello(); f.request(); removed.resolve();
  const result = await f.connection.closed;
  expect(result.failed).toBe(true); expect(result.authenticated).toBe(false); expect(f.stream.sent).toHaveLength(0);
  expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(false);
});
it("does not consume a descriptor after synchronous user stop during HELLO", async () => {
  const f = fixture(); f.hello(); const result = f.connection.stop();
  expect((await result).authenticated).toBe(false); expect(f.owner.consume).not.toHaveBeenCalled();
  expect(f.admission.phase).toBe("disabled"); expect(f.owner.revoke).toHaveBeenCalledTimes(1);
});
it("waits for an in-flight descriptor operation and never ACKs after stop", async () => {
  const f = fixture(), removed = deferred<void>(); f.owner.consume.mockImplementation(() => removed.promise);
  f.hello(); await tick(); const closed = f.connection.stop(); let settled = false; void closed.then(() => { settled = true; });
  await tick(); expect(settled).toBe(false); removed.resolve();
  expect((await closed).descriptorConsumptionSettled).toBe(true); expect(f.stream.sent).toHaveLength(0);
});
it("reports uncertain descriptor settlement instead of reopening after the deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture(), removed = deferred<void>(); f.owner.consume.mockImplementation(() => removed.promise);
  f.hello(); await tick(); const closed = f.connection.stop(); await tick();
  await vi.advanceTimersByTimeAsync(NativeControl.authenticationTimeoutMs);
  expect(await closed).toMatchObject({ descriptorConsumptionSettled: false, failed: true });
  removed.resolve(); await tick(); expect(f.admission.issueTicket()).toBeUndefined(); expect(f.stream.sent).toHaveLength(0);
});
it("descriptor failure burns the token and revokes the epoch", async () => {
  const f = fixture(); f.owner.consume.mockRejectedValue(new Error("Synthetic removal failure")); f.hello();
  expect(await f.connection.closed).toMatchObject({ authenticated: false, failed: true, epochRevoked: true });
  expect(f.admission.issueTicket()).toBeUndefined(); expect(f.stream.sent).toHaveLength(0);
});
it("attach failure never sends ACCEPT", async () => {
  const f = fixture(); f.development.mockImplementation(op => Promise.resolve(op === "development.attach" ? { ok: false, code: "ENGINE_UNAVAILABLE" } : status(false)));
  f.hello(); expect(await f.connection.closed).toMatchObject({ authenticated: false, failed: true }); expect(f.stream.sent).toHaveLength(0);
});
it("user STOP revokes immediately, awaits broker CLEAN, and ignores late backend results", async () => {
  const f = fixture(); await ready(f); const result = deferred<DevelopmentResult>();
  f.development.mockImplementation(op => op === "development.invoke" ? result.promise : Promise.resolve(status(false)));
  f.request(); await tick(); const closed = f.connection.stop(); await tick();
  expect(f.admission.phase).toBe("disabled"); expect(f.stream.sent.at(-1)?.[5]).toBe(ControlKind.stop);
  result.resolve(status()); await tick(); expect(f.stream.sent.map(x => x[5])).toEqual([ControlKind.accept, ControlKind.stop]);
  f.send(ControlKind.clean); expect((await closed).failed).toBe(false);
});
it("CLEAN followed by another REQUEST in the same chunk is a protocol violation", async () => {
  const f = fixture(); await ready(f);
  const clean = encodeControlFrame({ kind: ControlKind.clean, body: Buffer.alloc(0) }, 2, "to-main");
  const request = encodeControlFrame({ kind: ControlKind.request, body: Buffer.from("{}") }, 3, "to-main");
  f.stream.emit("data", Buffer.concat([clean, request])); expect((await f.connection.closed).failed).toBe(true);
});
it("CLEAN followed by another CLEAN is a protocol violation", async () => {
  const f = fixture(); await ready(f);
  f.stream.emit("data", Buffer.concat([2, 3].map(sequence => encodeControlFrame({ kind: ControlKind.clean, body: Buffer.alloc(0) }, sequence, "to-main"))));
  expect((await f.connection.closed).failed).toBe(true);
});
it("worker-shaped JSON cannot impersonate a control CLEAN", async () => {
  const f = fixture(); await ready(f);
  f.send(ControlKind.request, Buffer.from('{"kind":"clean"}'));
  expect(await f.connection.closed).toMatchObject({ brokerCleanupReported: false, failed: true });
});
it("unauthenticated CLEAN is rejected without attaching", async () => {
  const f = fixture(); f.send(ControlKind.clean);
  expect((await f.connection.closed).failed).toBe(true); expect(f.development).not.toHaveBeenCalled();
});
for (const problem of ["invalid-utf8", "bom", "unknown-operation", "duplicate-id"] as const)
  it("rejects malformed or replayed request: " + problem, async () => {
    const f = fixture(); await ready(f);
    if (problem === "invalid-utf8") f.send(ControlKind.request, Buffer.from([0xff]));
    if (problem === "bom") f.send(ControlKind.request, Buffer.from("\ufeff{}"));
    if (problem === "unknown-operation") f.request(1, { operation: "settings" });
    if (problem === "duplicate-id") { f.request(); await tick(); f.request(); }
    expect((await f.connection.closed).failed).toBe(true);
  });
it("retains all four request reservations until physical response completion", async () => {
  const f = fixture(); await ready(f); f.stream.hold = true;
  for (let i = 1; i <= 4; i++) f.request(i);
  await tick(); expect(f.development.mock.calls.filter(([op]) => op === "development.invoke")).toHaveLength(4);
  expect(f.stream.held).toHaveLength(1); f.request(5); expect((await f.connection.closed).failed).toBe(true);
});
it("bounds per-second request rate even with promptly completed responses", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture(); await ready(f);
  for (let i = 1; i <= 60; i++) { f.request(i); await tick(); }
  expect(f.stream.sent).toHaveLength(61); f.request(61);
  expect((await f.connection.closed).failed).toBe(true);
});
it("does not accept oversized backend output", async () => {
  const f = fixture(); await ready(f);
  f.development.mockImplementation(op => Promise.resolve(op === "development.invoke"
    ? { ok: true, status: { text: "x".repeat(NativeControl.responseBytes) } } as unknown as DevelopmentResult : status(false)));
  f.request(); expect((await f.connection.closed).failed).toBe(true);
  expect(f.stream.sent).toHaveLength(1);
});
it("requires physical ACK completion within a fixed timeout", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture(); f.stream.hold = true; f.hello(); await tick();
  await vi.advanceTimersByTimeAsync(NativeControl.ioTimeoutMs);
  expect(await f.connection.closed).toMatchObject({ brokerCleanupReported: false, failed: true });
});
it("does not treat EOF or stream close as broker cleanup", async () => {
  const f = fixture(); await ready(f); f.stream.emit("end");
  expect(await f.connection.closed).toMatchObject({ brokerCleanupReported: false, streamClosed: true, failed: true });
});
it("times out a broker that never reports CLEAN after STOP", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture(); await ready(f); const closed = f.connection.stop(); await tick();
  await vi.advanceTimersByTimeAsync(NativeControl.shutdownTimeoutMs);
  expect(await closed).toMatchObject({ brokerCleanupReported: false, failed: true });
});
it("keeps failed epoch revocation visible even when CLEAN arrives", async () => {
  const f = fixture(); await ready(f); f.owner.revoke.mockResolvedValue(false); f.send(ControlKind.clean);
  expect(await f.connection.closed).toMatchObject({ brokerCleanupReported: true, epochRevoked: false, failed: true });
});
it("a stuck epoch revocation cannot make shutdown unbounded", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture(); await ready(f); const revoked = deferred<boolean>(); f.owner.revoke.mockImplementation(() => revoked.promise);
  f.send(ControlKind.clean); await tick(); await vi.advanceTimersByTimeAsync(NativeControl.authenticationTimeoutMs);
  expect(await f.connection.closed).toMatchObject({ epochRevoked: false, failed: true }); revoked.resolve(true);
});
it("reports an unobserved stream close instead of equating destroy with exit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture(); await ready(f); let destroy!: (error?: Error | null) => void;
  f.stream._destroy = (_error, callback) => { destroy = callback; };
  f.send(ControlKind.clean); await tick(); await vi.advanceTimersByTimeAsync(NativeControl.ioTimeoutMs);
  expect(await f.connection.closed).toMatchObject({ streamClosed: false, failed: true }); destroy();
});

for (const trailing of [1, 7, 15]) it("rejects CLEAN followed by a partial header of " + trailing + " bytes", async () => {
  const f = fixture(); await ready(f);
  const clean = encodeControlFrame({ kind: ControlKind.clean, body: Buffer.alloc(0) }, 2, "to-main");
  f.stream.emit("data", Buffer.concat([clean, Buffer.alloc(trailing)]));
  expect((await f.connection.closed).failed).toBe(true);
});
it("rejects any later chunk after CLEAN while detach is still pending", async () => {
  const f = fixture(); await ready(f); const detached = deferred<DevelopmentResult>();
  f.development.mockImplementation(() => detached.promise);
  f.send(ControlKind.clean); f.stream.emit("data", Buffer.from([0]));
  detached.resolve(status(false)); expect((await f.connection.closed).failed).toBe(true);
});
it("settles detach before revoking the epoch and reports negative detach independently", async () => {
  const f = fixture(); await ready(f); const detached = deferred<DevelopmentResult>();
  f.development.mockImplementation(() => detached.promise); f.send(ControlKind.clean); await tick();
  expect(f.owner.revoke).not.toHaveBeenCalled(); detached.resolve({ ok: false, code: "ENGINE_UNAVAILABLE" });
  expect(await f.connection.closed).toMatchObject({ backendDetachSettled: false, epochRevoked: true, failed: true });
});

it("does not add shutdown work after an abort listener synchronously completes CLEAN", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture();
  f.owner.consume.mockImplementation(async (_ticket, signal) => {
    signal.addEventListener("abort", () => f.send(ControlKind.clean), { once: true });
  });
  await ready(f); const closed = f.connection.stop();
  expect((await closed).failed).toBe(false); expect(vi.getTimerCount()).toBe(0);
});
for (const failure of ["throw", "callback"] as const)
  it("does not hide a physical write " + failure + " after reentrant CLEAN", async () => {
    const f = fixture();
    vi.spyOn(f.stream, "write").mockImplementation((...args: unknown[]) => {
      f.send(ControlKind.clean);
      if (failure === "throw") throw new Error("Synthetic physical write failure");
      (args.at(-1) as (error: Error) => void)(new Error("Synthetic physical callback failure")); return true;
    });
    f.hello(); expect(await f.connection.closed).toMatchObject({ brokerCleanupReported: true, failed: true });
  });


it("discards a valid in-flight request reacting to STOP before its write callback", async () => {
  const f = fixture(); await ready(f);
  f.stream.react = bytes => { if (bytes[5] === ControlKind.stop) f.request(); };
  const closed = f.connection.stop(); await tick();
  expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(false);
  expect(f.stream.sent.map(x => x[5])).toEqual([ControlKind.accept, ControlKind.stop]);
  f.send(ControlKind.clean); expect((await closed).failed).toBe(false);
});
it("discards eight valid late requests without invoking and still accepts CLEAN", async () => {
  const f = fixture(); await ready(f); const closed = f.connection.stop();
  for (let i = 1; i <= 8; i++) f.request(i);
  f.send(ControlKind.clean); expect((await closed).failed).toBe(false);
  expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(false);
});
it("rejects the ninth request during STOP without reopening admission", async () => {
  const f = fixture(); await ready(f); const closed = f.connection.stop();
  for (let i = 1; i <= 9; i++) f.request(i);
  expect(await closed).toMatchObject({ failed: true, brokerCleanupReported: false });
  expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(false);
});
for (const problem of ["schema", "utf8", "replay"] as const)
  it("still rejects invalid late requests during STOP: " + problem, async () => {
    const f = fixture(); await ready(f); const closed = f.connection.stop();
    if (problem === "schema") f.request(1, { operation: "settings" });
    if (problem === "utf8") f.send(ControlKind.request, Buffer.from([0xff]));
    if (problem === "replay") { f.request(1); f.request(1); }
    expect((await closed).failed).toBe(true);
    expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(false);
  });
it("late requests do not renew the STOP deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = fixture(); await ready(f); const closed = f.connection.stop();
  await vi.advanceTimersByTimeAsync(NativeControl.shutdownTimeoutMs - 1); f.request();
  await vi.advanceTimersByTimeAsync(1); expect((await closed).failed).toBe(true);
});

async function withAuthenticationClock(run: (advance: (value: number) => void) => Promise<void>) {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try { await run(value => { clock.mockReturnValue(value); }); } finally { clock.mockRestore(); }
}
it("passes the constructor-owned authentication deadline through a delayed HELLO without renewing it", async () => {
  await withAuthenticationClock(async advance => {
    const f = fixture(); advance(2000); await ready(f);
    expect(f.owner.consume.mock.calls[0]![2]).toBe(NativeControl.authenticationTimeoutMs);
    f.send(ControlKind.clean); expect((await f.connection.closed).failed).toBe(false);
  });
});
it("rejects an expired HELLO before claim or consume even without timer dispatch", async () => {
  await withAuthenticationClock(async advance => {
    const f = fixture(); advance(NativeControl.authenticationTimeoutMs); f.hello();
    expect((await f.connection.closed).failed).toBe(true); expect(f.owner.consume).not.toHaveBeenCalled();
    expect(f.development.mock.calls.some(([op]) => op === "development.attach")).toBe(false);
  });
});
it("a queue delay after HELLO cannot start consume or backend attachment after the original deadline", async () => {
  await withAuthenticationClock(async advance => {
    const f = fixture(); f.hello(); advance(NativeControl.authenticationTimeoutMs + 1);
    await tick(); expect((await f.connection.closed).failed).toBe(true);
    expect(f.owner.consume).not.toHaveBeenCalled();
    expect(f.development.mock.calls.some(([op]) => op === "development.attach")).toBe(false);
    expect(f.stream.sent).toEqual([]);
  });
});
it("a late consume result cannot send ACCEPT without a timer callback", async () => {
  await withAuthenticationClock(async advance => {
    const f = fixture(), consumed = deferred<void>(); f.owner.consume.mockImplementation(() => consumed.promise);
    f.hello(); await tick(); expect(f.owner.consume).toHaveBeenCalledOnce();
    advance(NativeControl.authenticationTimeoutMs + 1); consumed.resolve();
    expect((await f.connection.closed).failed).toBe(true); expect(f.stream.sent).toEqual([]);
  });
});
for (const next of ["request", "callback"] as const)
  it("an unfinished physical ACK remains fenced by the original authentication deadline: " + next, async () => {
    await withAuthenticationClock(async advance => {
      const f = fixture(); f.stream.hold = true; f.hello(); await tick();
      expect(f.stream.sent.map(x => x[5])).toEqual([ControlKind.accept]);
      advance(NativeControl.authenticationTimeoutMs + 1);
      if (next === "request") f.request(); else f.stream.held.shift()!();
      expect((await f.connection.closed).failed).toBe(true);
      expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(false);
      expect(f.stream.sent).toHaveLength(1);
    });
  });
it("completed authentication does not expire an active session at its old authentication deadline", async () => {
  await withAuthenticationClock(async advance => {
    const f = fixture(); await ready(f); advance(NativeControl.authenticationTimeoutMs + 1);
    f.request(); await tick(); expect(f.stream.sent.map(x => x[5])).toEqual([ControlKind.accept, ControlKind.response]);
    expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(true);
    f.send(ControlKind.clean); expect((await f.connection.closed).failed).toBe(false);
  });
});

it("STOP cannot convert an expired unfinished ACK into successful CLEAN", async () => {
  await withAuthenticationClock(async advance => {
    const f = fixture(); f.stream.hold = true; f.hello(); await tick();
    advance(NativeControl.authenticationTimeoutMs + 1); const stopped = f.connection.stop(); f.send(ControlKind.clean);
    expect(await stopped).toMatchObject({ failed: true, brokerCleanupReported: false });
  });
});
it("CLEAN during STOP still obeys the original unfinished authentication deadline", async () => {
  await withAuthenticationClock(async advance => {
    const f = fixture(); f.stream.hold = true; f.hello(); await tick();
    advance(NativeControl.authenticationTimeoutMs - 1); const stopped = f.connection.stop();
    advance(NativeControl.authenticationTimeoutMs + 1); f.send(ControlKind.clean);
    expect(await stopped).toMatchObject({ failed: true, brokerCleanupReported: false });
  });
});
it("timely terminal CLEAN may cancel logical ACK waiting without claiming physical callback completion", async () => {
  await withAuthenticationClock(async () => {
    const f = fixture(); f.stream.hold = true;
    f.stream.react = bytes => { if (bytes[5] === ControlKind.accept) f.send(ControlKind.clean); };
    f.hello();
    expect(await f.connection.closed).toMatchObject({ failed: false, authenticated: true, brokerCleanupReported: true });
    expect(f.stream.held).toHaveLength(1); // Physical callback is deliberately still pending.
  });
});
it("fully authenticated STOP retains its independent shutdown grace after the old authentication deadline", async () => {
  await withAuthenticationClock(async advance => {
    const f = fixture(); await ready(f); advance(NativeControl.authenticationTimeoutMs + 1);
    const stopped = f.connection.stop(); await tick();
    advance(NativeControl.authenticationTimeoutMs + NativeControl.shutdownTimeoutMs - 1); f.send(ControlKind.clean);
    expect(await stopped).toMatchObject({ failed: false, brokerCleanupReported: true });
  });
});
