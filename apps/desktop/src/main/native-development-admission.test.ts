import { afterEach, expect, it, vi } from "vitest";
import type { DevelopmentResult, BridgeCommand } from "@tahtiapuri/validation/development";
import { NativeDevelopmentAdmission } from "./native-development-admission.js";

const epoch = "a".repeat(64);
const status = (connected: boolean): DevelopmentResult => ({ ok: true, status: { enabled: true, connected,
  protocolVersion: 1, modelId: "qwen3-4b-q4-k-m", engineVersion: "3.22.2" } });
const command: BridgeCommand = { id: "00000000-0000-4000-8000-000000000001", operation: "status", input: null };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const development = vi.fn(async (op: string): Promise<DevelopmentResult> => status(op !== "development.detach"));
  const admission = new NativeDevelopmentAdmission({ development }, epoch, 50);
  const ticket = admission.issueTicket()!;
  return { development, admission, ticket, claim: () => admission.claim(ticket.generation, ticket.token)! };
}
afterEach(() => vi.useRealTimers());
it("issues one independent ticket and atomically rejects duplicate and legacy claims", async () => {
  const f = fixture(); expect(f.ticket.token).not.toBe(epoch); expect(f.admission.issueTicket()).toBeUndefined();
  expect(f.admission.claim(f.ticket.generation, epoch)).toBeUndefined();
  expect(f.admission.claim("wrong-generation", f.ticket.token)).toBeUndefined();
  const lease = f.claim(); expect(f.claim()).toBeUndefined(); expect(f.admission.phase).toBe("attaching");
  expect(await lease.ready).toBe(true); expect(f.admission.phase).toBe("active");
  expect(await lease.invoke(command)).toEqual(status(true)); expect(await lease.close()).toBe(true);
  const next = f.admission.issueTicket()!; expect(next.token).not.toBe(f.ticket.token); expect(f.claim()).toBeUndefined();
  await f.admission.disable(); expect(f.development.mock.calls.filter(([op]) => op === "development.attach")).toHaveLength(1);
});
it("disconnect during attach waits for attach and detach before any replacement ticket", async () => {
  const attach = deferred<DevelopmentResult>(), detach = deferred<DevelopmentResult>(), f = fixture();
  f.development.mockImplementation(op => op === "development.attach" ? attach.promise : detach.promise);
  const lease = f.claim(), closed = lease.close(); expect(lease.close()).toBe(closed);
  expect(f.admission.issueTicket()).toBeUndefined(); await Promise.resolve();
  expect(f.development.mock.calls.map(([op]) => op)).toEqual(["development.attach"]);
  attach.resolve(status(true)); expect(await lease.ready).toBe(false); await Promise.resolve();
  expect(f.admission.issueTicket()).toBeUndefined(); expect(f.admission.phase).toBe("detaching");
  detach.resolve(status(false)); expect(await closed).toBe(true); expect(f.admission.issueTicket()).toBeDefined();
  await f.admission.disable();
});
it("slow detach keeps the single-client slot occupied and old lease cannot invoke", async () => {
  const f = fixture(), detach = deferred<DevelopmentResult>(), lease = f.claim(); expect(await lease.ready).toBe(true);
  f.development.mockImplementation(op => op === "development.detach" ? detach.promise : Promise.resolve(status(true)));
  const close = lease.close(); expect(f.admission.issueTicket()).toBeUndefined();
  expect(await lease.invoke(command)).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
  detach.resolve(status(false)); expect(await close).toBe(true); const next = f.admission.issueTicket()!;
  const newer = f.admission.claim(next.generation, next.token)!; expect(await newer.ready).toBe(true);
  expect(await lease.close()).toBe(true); expect(f.admission.phase).toBe("active");
  await newer.close(); await f.admission.disable();
});
it("disable before claim burns the unpublished or outstanding ticket", async () => {
  const f = fixture(); expect(await f.admission.disable()).toBe(true);
  expect(f.claim()).toBeUndefined(); expect(f.admission.issueTicket()).toBeUndefined(); expect(f.development).not.toHaveBeenCalled();
});
it("disable during attach cannot publish an active lease or revive the generation", async () => {
  const f = fixture(), attach = deferred<DevelopmentResult>();
  f.development.mockImplementation(op => op === "development.attach" ? attach.promise : Promise.resolve(status(false)));
  const lease = f.claim(), stopped = f.admission.disable(); attach.resolve(status(true));
  expect(await lease.ready).toBe(false); expect(await stopped).toBe(true); expect(f.admission.phase).toBe("disabled");
  expect(f.admission.issueTicket()).toBeUndefined(); expect(f.claim()).toBeUndefined();
});
for (const failure of ["negative", "reject", "malformed"] as const) it("failed attachment never restores its ticket: " + failure, async () => {
  const f = fixture(); f.development.mockImplementation(op => op !== "development.attach" ? Promise.resolve(status(false))
    : failure === "reject" ? Promise.reject(new Error("synthetic failure"))
    : Promise.resolve(failure === "negative" ? { ok: false, code: "ENGINE_UNAVAILABLE" } : status(false)));
  const lease = f.claim(); expect(await lease.ready).toBe(false); await lease.close();
  expect(f.admission.phase).toBe("disabled"); expect(f.admission.issueTicket()).toBeUndefined(); expect(f.claim()).toBeUndefined();
});
it("attach timeout fences the generation and late attach is still followed by detach", async () => {
  vi.useFakeTimers(); const f = fixture(), attach = deferred<DevelopmentResult>();
  f.development.mockImplementation(op => op === "development.attach" ? attach.promise : Promise.resolve(status(false)));
  const lease = f.claim(); await vi.advanceTimersByTimeAsync(50); expect(await lease.ready).toBe(false);
  const closed = lease.close(); await vi.advanceTimersByTimeAsync(50); expect(await closed).toBe(false);
  attach.resolve(status(true)); await vi.runAllTimersAsync();
  expect(f.development.mock.calls.map(([op]) => op)).toEqual(["development.attach", "development.detach"]);
  expect(f.admission.phase).toBe("disabled"); expect(f.admission.issueTicket()).toBeUndefined();
});
it("uncertain detach never releases the client slot, even after a late success", async () => {
  vi.useFakeTimers(); const f = fixture(), lease = f.claim(); expect(await lease.ready).toBe(true);
  const detach = deferred<DevelopmentResult>(); f.development.mockImplementation(() => detach.promise);
  const closed = lease.close(); await vi.advanceTimersByTimeAsync(50); expect(await closed).toBe(false);
  detach.resolve(status(false)); await vi.runAllTimersAsync();
  expect(f.admission.phase).toBe("disabled"); expect(f.admission.issueTicket()).toBeUndefined(); expect(await f.admission.disable()).toBe(false);
});
it("disable between invocation admission and dispatch prevents backend work", async () => {
  const f = fixture(), lease = f.claim(); expect(await lease.ready).toBe(true);
  const result = lease.invoke(command), stopped = f.admission.disable();
  expect(await result).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" }); await stopped;
  expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(false);
});
it("bounds pending calls and withholds a late result after disconnect", async () => {
  const f = fixture(), lease = f.claim(); expect(await lease.ready).toBe(true);
  const pending = deferred<DevelopmentResult>();
  f.development.mockImplementation(op => op === "development.invoke" ? pending.promise : Promise.resolve(status(false)));
  const calls = Array.from({ length: 4 }, () => lease.invoke(command));
  expect(await lease.invoke(command)).toEqual({ ok: false, code: "BUSY" }); await Promise.resolve();
  expect(await lease.close()).toBe(true); pending.resolve(status(true));
  expect(await Promise.all(calls)).toEqual(Array.from({ length: 4 }, () => ({ ok: false, code: "ENGINE_UNAVAILABLE" })));
  await f.admission.disable();
});
it("validates the development operation before dispatching it", async () => {
  const f = fixture(), lease = f.claim(); expect(await lease.ready).toBe(true);
  expect(await lease.invoke({ ...command, operation: "settings" } as unknown as BridgeCommand)).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
  expect(f.development.mock.calls.some(([op]) => op === "development.invoke")).toBe(false); await lease.close();
});

for (const failure of ["reject", "timeout"] as const) it("old invocation " + failure + " cannot disable a replacement client", async () => {
  vi.useFakeTimers(); const f = fixture(), old = f.claim(); expect(await old.ready).toBe(true);
  const delayed = deferred<DevelopmentResult>();
  f.development.mockImplementation(op => op === "development.invoke" ? delayed.promise : Promise.resolve(status(op === "development.attach")));
  const oldCall = old.invoke(command); await Promise.resolve(); expect(await old.close()).toBe(true);
  const ticket = f.admission.issueTicket()!, next = f.admission.claim(ticket.generation, ticket.token)!;
  expect(await next.ready).toBe(true);
  if (failure === "reject") delayed.reject(new Error("Late old-client failure"));
  else await vi.advanceTimersByTimeAsync(50);
  expect(await oldCall).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
  expect(f.admission.phase).toBe("active");
  f.development.mockImplementation(op => Promise.resolve(status(op !== "development.detach")));
  expect(await next.invoke(command)).toEqual(status(true));
  expect(await next.close()).toBe(true); expect(f.admission.issueTicket()).toBeDefined(); await f.admission.disable();
  delayed.resolve(status(true)); await vi.runAllTimersAsync();
});
it("a current active invocation timeout disables its generation and detaches its client", async () => {
  vi.useFakeTimers(); const f = fixture(), lease = f.claim(); expect(await lease.ready).toBe(true);
  const delayed = deferred<DevelopmentResult>();
  f.development.mockImplementation(op => op === "development.invoke" ? delayed.promise : Promise.resolve(status(false)));
  const call = lease.invoke(command); await vi.advanceTimersByTimeAsync(50);
  expect(await call).toEqual({ ok: false, code: "ENGINE_UNAVAILABLE" });
  expect(f.admission.phase).toBe("disabled"); expect(await lease.close()).toBe(true);
  expect(f.development.mock.calls.filter(([op]) => op === "development.detach")).toHaveLength(1);
  expect(f.admission.issueTicket()).toBeUndefined(); delayed.resolve(status(true)); await vi.runAllTimersAsync();
});

it("retains the shared call reservations across detach and reconnect until old calls settle", async () => {
  const f = fixture(), old = f.claim(); expect(await old.ready).toBe(true);
  const delayed = deferred<DevelopmentResult>();
  f.development.mockImplementation(op => op === "development.invoke" ? delayed.promise : Promise.resolve(status(op === "development.attach")));
  const oldCalls = Array.from({ length: 4 }, () => old.invoke(command)); await Promise.resolve();
  expect(await old.close()).toBe(true);
  const ticket = f.admission.issueTicket()!, next = f.admission.claim(ticket.generation, ticket.token)!;
  expect(await next.ready).toBe(true);
  expect(await next.invoke(command)).toEqual({ ok: false, code: "BUSY" });
  expect(f.development.mock.calls.filter(([op]) => op === "development.invoke")).toHaveLength(4);
  delayed.resolve(status(true));
  expect(await Promise.all(oldCalls)).toEqual(Array.from({ length: 4 }, () => ({ ok: false, code: "ENGINE_UNAVAILABLE" })));
  f.development.mockImplementation(op => Promise.resolve(status(op !== "development.detach")));
  expect(await next.invoke(command)).toEqual(status(true));
  expect(await next.close()).toBe(true); await f.admission.disable();
});
