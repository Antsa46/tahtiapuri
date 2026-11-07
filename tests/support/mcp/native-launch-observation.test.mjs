import { afterEach, expect, it, vi } from "vitest";
import { NativeLaunchObservation } from "./native-launch-observation.mjs";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const close = Object.freeze({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: false, uncertain: true });
function fixture(write = vi.fn(async () => {})) {
  const result = deferred(), settled = deferred(); let clock = 0, firstFailure = { reason: "original-deadline" };
  const fail = vi.fn(reason => { firstFailure ??= { reason }; }), now = vi.fn(() => clock);
  const observer = new NativeLaunchObservation({ result: result.promise, settled: settled.promise }, {
    label: "identity", write, fail, event: vi.fn(), now, firstFailure: () => firstFailure,
  });
  return { result, settled, observer, write, fail, now, first: () => firstFailure, clock: value => { clock = value; } };
}
async function failed(f) { f.result.reject(Object.assign(new Error("original"), { exitVerified: false, authorityCommitted: false })); await f.observer.result.catch(() => {}); }
afterEach(() => vi.useRealTimers());
it("observes both original promises before waiting and needs no late file for a known settlement", async () => {
  const f = fixture(); f.result.resolve({ stdout: Buffer.from("ok"), authorityCommitted: false }); f.settled.resolve(close);
  await f.observer.result; await f.observer.settled;
  expect(f.observer.sealPrimary()).toMatchObject({ resultSettled: true, settlementObserved: true });
  expect(f.write).not.toHaveBeenCalled(); expect(f.observer.task.result).toBe(f.result.promise);
});
it("writes one late close receipt without replacing the original failure or primary snapshot", async () => {
  const f = fixture(); await failed(f); const primary = f.observer.sealPrimary();
  expect(primary.settlementObserved).toBe(false); f.settled.resolve(close);
  await f.observer.settled; await f.observer.lateFinished;
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.write.mock.calls[0][0]).toMatchObject({ upgradesOriginalResult: false, originalReceiptUnchanged: true,
    firstFailure: { reason: "original-deadline" }, task: { error: { exitVerified: false }, settlementObserved: true, settlement: close } });
  expect(primary.settlementObserved).toBe(false); expect(f.first()).toEqual({ reason: "original-deadline" });
  expect(f.observer.lateState).toEqual({ status: "written", originalWriteSettled: true });
});
it("a late diagnostic write rejection remains a failure and never upgrades original exit proof", async () => {
  const f = fixture(vi.fn(async () => { throw new Error("synthetic write failure"); })); await failed(f);
  const primary = f.observer.sealPrimary(); f.settled.resolve(close); await f.observer.settled; await f.observer.lateFinished;
  expect(f.fail).toHaveBeenCalledWith("late-diagnostic-write-error");
  expect(f.observer.lateState.status).toBe("write-error"); expect(primary.error.exitVerified).toBe(false);
  expect(f.first().reason).toBe("original-deadline");
});
it("retains an outstanding late write beyond its own cap and does not turn late completion into success", async () => {
  vi.useFakeTimers(); const write = deferred(), f = fixture(vi.fn(() => write.promise)); await failed(f);
  const primary = f.observer.sealPrimary(); f.settled.resolve(close); await f.observer.settled;
  f.clock(1001); await vi.advanceTimersByTimeAsync(1000); await f.observer.lateFinished;
  expect(f.observer.lateState).toEqual({ status: "timeout", originalWriteSettled: false });
  expect(f.observer.lateOriginal).not.toBeNull(); write.resolve(); await f.observer.lateOriginal; await Promise.resolve();
  expect(f.observer.lateState).toEqual({ status: "timeout", originalWriteSettled: true });
  expect(primary.error.exitVerified).toBe(false); expect(f.first().reason).toBe("original-deadline");
});
it("settlement rejection produces no invented close receipt", async () => {
  const f = fixture(); await failed(f); const primary = f.observer.sealPrimary();
  f.settled.reject(new Error("synthetic missing settlement")); await f.observer.settled.catch(() => {});
  expect(f.fail).toHaveBeenCalledWith("identity:settlement-rejected"); expect(f.write).not.toHaveBeenCalled();
  expect(primary.settlementObserved).toBe(false); expect(f.observer.snapshot().settlementObserved).toBe(false);
});
it("primary observation cannot be resealed or cause another diagnostic", async () => {
  const f = fixture(); await failed(f); f.observer.sealPrimary();
  expect(() => f.observer.sealPrimary()).toThrow("already sealed");
  f.settled.resolve(close); await f.observer.settled; await f.observer.lateFinished;
  f.observer.writeLateOnce(); expect(f.write).toHaveBeenCalledTimes(1);
});

it("withholds a queued diagnostic write after its monotonic deadline without timer dispatch", async () => {
  vi.useFakeTimers(); const f = fixture(); await failed(f); f.observer.sealPrimary();
  f.now.mockReturnValueOnce(0).mockReturnValue(1001);
  f.settled.resolve(close); await f.observer.settled; await f.observer.lateFinished;
  expect(f.write).not.toHaveBeenCalled();
  expect(f.observer.lateState).toEqual({ status: "timeout", originalWriteSettled: true });
  expect(f.first().reason).toBe("original-deadline"); expect(f.fail).toHaveBeenCalledWith("late-diagnostic-timeout");
});
