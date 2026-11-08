import { expect, it, vi } from "vitest";
import { createNativeCallRecord } from "./native-launch-call-record.js";
import { NativeDevelopmentResourceCall } from "./native-development-resource-call.js";
import type { NativeLaunchResourceBinding } from "./native-launch-resource-owner.js";
import type { NativeLaunchTaskBinding } from "./native-launch-operations.js";
import type { NativeLaunchResult, NativeLaunchSettlement } from "./native-launch-supervisor.js";
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const closed: NativeLaunchSettlement = { childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: false, uncertain: false };
function fixture(kind: "task" | "stage" | "no-task" | "unavailable" = "task") {
  const original = deferred<void>(), io = deferred<void>(), result = deferred<NativeLaunchResult>(), settled = deferred<NativeLaunchSettlement>();
  const native = createNativeCallRecord<NativeLaunchTaskBinding>({ kind: "no-task" }); native.attach(original.promise);
  native.bind(kind === "task" ? { kind, result: result.promise, settled: settled.promise } : { kind: "no-task" });
  const record = createNativeCallRecord<NativeLaunchResourceBinding>({ kind: "stage", staging: null, verification: null, operation: null, native: { state: "none" } });
  record.attach(original.promise);
  const missing = new Error("Synthetic unavailable native observation");
  record.bind(kind === "stage" ? { kind, staging: io.promise, verification: null, operation: null, native: { state: "none" } }
    : { kind: "native", staging: null, verification: Promise.resolve(), operation: original.promise,
      native: kind === "unavailable" ? { state: "unavailable", reason: missing } : { state: "bound", observation: native.observation } });
  const owner = { observeCall: vi.fn((key: Promise<unknown>) => { expect(key).toBe(original.promise); return record.observation; }) };
  const call = new NativeDevelopmentResourceCall(original.promise);
  return { original, io, result, settled, owner, call, missing };
}
it("captures the original before lookup and requires all original native observations", async () => {
  const f = fixture(); expect(f.owner.observeCall).not.toHaveBeenCalled();
  f.call.bind(f.owner); expect(f.call.original).toBe(f.original.promise);
  expect(() => f.call.bind(f.owner)).toThrow("already bound");
  f.original.resolve(); await f.call.result; expect(f.call.settled).toBe(false);
  f.result.resolve({ stdout: Buffer.from("synthetic"), authorityCommitted: false }); f.settled.resolve(closed);
  await f.call.observed; expect(f.call.settled).toBe(true); expect(f.call.exitVerified).toBe(true); expect(f.call.failed).toBe(false); expect(f.call.physicalSettled).toBe(true);
});
it.each([undefined, 0, new Error("Synthetic lookup failure")])("lookup throwing %s retains the late original rejection without inventing settlement", async reason => {
  const f = fixture(), owner = { observeCall: () => { throw reason; } }; f.call.bind(owner);
  expect(f.call.observationAvailable).toBe(false); await f.call.observed;
  const originalReason = new Error("Original result rejected after failed lookup"); f.original.reject(originalReason);
  await expect(f.call.result).rejects.toBe(originalReason);
  expect(f.call.originalOutcome).toEqual({ status: "rejected", reason: originalReason });
  expect(f.call.settled).toBe(false); expect(f.call.exitVerified).toBe(false); expect(f.call.failed).toBe(true); expect(f.call.physicalSettled).toBe(false);
});
it("stage process absence does not settle still-pending original file IO", async () => {
  const f = fixture("stage"); f.call.bind(f.owner);
  const reason = Object.assign(new Error("Public staging timeout"), { exitVerified: true }); f.original.reject(reason);
  await expect(f.call.result).rejects.toBe(reason); expect(f.call.settled).toBe(false); expect(f.call.exitVerified).toBe(false); expect(f.call.physicalSettled).toBe(false);
  f.io.resolve(); await f.call.observed;
  expect(f.call.settled).toBe(true); expect(f.call.exitVerified).toBe(true); expect(f.call.failed).toBe(true);
  expect(f.call.originalOutcome).toEqual({ status: "rejected", reason }); expect(f.call.physicalSettled).toBe(true);
});
it("retains a rejected original task settlement instead of laundering allSettled fulfillment", async () => {
  const f = fixture(); f.call.bind(f.owner); const failure = Object.assign(new Error("Original failure"), { exitVerified: false });
  const rawFailure = new Error("Raw settlement rejected"); f.original.reject(failure); f.result.reject(failure); f.settled.reject(rawFailure);
  await f.call.result.catch(() => {}); await f.call.observed;
  expect(f.call.originalOutcomes?.some(item => item.status === "rejected" && item.reason === rawFailure)).toBe(true);
  expect(f.call.exitVerified).toBe(false); expect(f.call.failed).toBe(true); expect(f.call.physicalSettled).toBe(false);
});
it("a later known close never upgrades the original explicit exit uncertainty", async () => {
  const f = fixture(); f.call.bind(f.owner); const failure = Object.assign(new Error("Unknown original exit"), { exitVerified: false });
  f.original.reject(failure); f.result.reject(failure); await f.call.result.catch(() => {});
  expect(f.call.physicalSettled).toBe(false);
  f.settled.resolve({ ...closed, uncertain: true }); await f.call.observed;
  expect(f.call.settled).toBe(true); expect(f.call.exitVerified).toBe(false); expect(f.call.failed).toBe(true);
  expect(f.call.physicalSettled).toBe(true);
});
it("an old call keeps its own observations after a new call fails", async () => {
  const a = fixture(); a.call.bind(a.owner); a.original.resolve(); a.result.resolve({ stdout: Buffer.alloc(0), authorityCommitted: false }); a.settled.resolve(closed);
  await a.call.observed;
  const b = fixture("no-task"); b.call.bind(b.owner); const reason = Object.assign(new Error("New uncertain start"), { exitVerified: false }); b.original.reject(reason);
  await b.call.result.catch(() => {}); await b.call.observed;
  expect(a.call.exitVerified).toBe(true); expect(b.call.exitVerified).toBe(false);
  expect(a.call.physicalSettled).toBe(true); expect(b.call.physicalSettled).toBe(false); expect(b.call.originalOutcome).toEqual({ status: "rejected", reason });
});
it("a rejected raw task result remains failure even if the outer result incorrectly fulfills", async () => {
  const f = fixture(); f.call.bind(f.owner); const reason = new Error("Raw native result rejected");
  f.original.resolve(); f.result.reject(reason); f.settled.resolve(closed); await f.call.observed;
  expect(f.call.failed).toBe(true); expect(f.call.originalOutcomes?.some(item => item.status === "rejected" && item.reason === reason)).toBe(true);
});
it("an early no-task binding waits for this original result's no-start evidence", async () => {
  const f = fixture("no-task"); f.call.bind(f.owner); await Promise.resolve();
  const reason = Object.assign(new Error("Rejected before any actor start"), { exitVerified: true }); f.original.reject(reason);
  await f.call.result.catch(() => {}); await f.call.observed;
  expect(f.call.settled).toBe(true); expect(f.call.exitVerified).toBe(true); expect(f.call.failed).toBe(true); expect(f.call.physicalSettled).toBe(true);
});
it("unavailable native observation remains unknown after the original operation finishes", async () => {
  const f = fixture("unavailable"); f.call.bind(f.owner); f.original.resolve(); await f.call.observed;
  expect(f.call.physicalSettled).toBe(false); expect(f.call.observationError).toBe(f.missing); expect(f.call.settled).toBe(false); expect(f.call.exitVerified).toBe(false);
});

it("a fulfilled but uncertain task settlement is still a failed original observation", async () => {
  const f = fixture(); f.call.bind(f.owner); f.original.resolve(); f.result.resolve({ stdout: Buffer.alloc(0), authorityCommitted: false });
  f.settled.resolve({ childCloseObserved: false, workerExited: false, workerExitCode: null, authorityCommitted: false, uncertain: true });
  await f.call.observed; expect(f.call.settled).toBe(true); expect(f.call.exitVerified).toBe(false); expect(f.call.failed).toBe(true);
});

it.each([1, 17])("known Worker exit %s releases physical ownership without semantic success", async code => {
  const f = fixture(); f.call.bind(f.owner); f.original.resolve();
  f.result.resolve({ stdout: Buffer.alloc(0), authorityCommitted: false });
  f.settled.resolve({ ...closed, workerExitCode: code, uncertain: true }); await f.call.observed;
  expect(f.call.physicalSettled).toBe(true); expect(f.call.exitVerified).toBe(false); expect(f.call.failed).toBe(true);
});
it.each([null, NaN, Infinity])("an invalid original Worker exit %s is not physical evidence", async code => {
  const f = fixture(); f.call.bind(f.owner); f.original.resolve();
  f.result.resolve({ stdout: Buffer.alloc(0), authorityCommitted: false });
  f.settled.resolve({ ...closed, workerExitCode: code }); await f.call.observed;
  expect(f.call.physicalSettled).toBe(false); expect(f.call.exitVerified).toBe(false); expect(f.call.failed).toBe(true);
});
it("rejected original staging IO is physically finished without upgrading its public error", async () => {
  const f = fixture("stage"); f.call.bind(f.owner);
  const reason = Object.assign(new Error("Original stage uncertainty"), { exitVerified: false });
  f.original.reject(reason); await f.call.result.catch(() => {}); expect(f.call.physicalSettled).toBe(false);
  const ioError = new Error("Original IO ended with failure"); f.io.reject(ioError); await f.call.observed;
  expect(f.call.physicalSettled).toBe(true); expect(f.call.exitVerified).toBe(false); expect(f.call.failed).toBe(true);
  expect(f.call.originalOutcomes?.some(item => item.status === "rejected" && item.reason === ioError)).toBe(true);
});
