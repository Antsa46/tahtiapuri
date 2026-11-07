import { expect, it } from "vitest";
import { cancelNativeLaunchGate, commitNativeLaunchGate, createNativeLaunchGate, nativeLaunchGateState } from "./native-launch-gate.js";
it("commits an open gate once", () => {
  const gate = createNativeLaunchGate(); expect(commitNativeLaunchGate(gate, 10n, () => 0n)).toBe(true);
  expect(commitNativeLaunchGate(gate, 10n, () => 0n)).toBe(false);
  expect(nativeLaunchGateState(gate)).toEqual({ cancelled: false, committed: true });
});
it("a cancellation winning CAS prevents commitment", () => {
  const gate = createNativeLaunchGate(); cancelNativeLaunchGate(gate);
  expect(commitNativeLaunchGate(gate, 10n, () => 0n)).toBe(false);
  expect(nativeLaunchGateState(gate)).toEqual({ cancelled: true, committed: false });
});
it("later cancellation preserves the possibility of delivery", () => {
  const gate = createNativeLaunchGate(); expect(commitNativeLaunchGate(gate, 10n, () => 0n)).toBe(true);
  cancelNativeLaunchGate(gate); expect(nativeLaunchGateState(gate)).toEqual({ cancelled: true, committed: true });
});
it("an expired deadline cancels without commitment", () => {
  const gate = createNativeLaunchGate(); expect(commitNativeLaunchGate(gate, 10n, () => 10n)).toBe(false);
  expect(nativeLaunchGateState(gate)).toEqual({ cancelled: true, committed: false });
});
it("expiration after CAS withholds IO while retaining commitment", () => {
  const gate = createNativeLaunchGate(); let calls = 0;
  expect(commitNativeLaunchGate(gate, 10n, () => calls++ ? 10n : 0n)).toBe(false);
  expect(nativeLaunchGateState(gate)).toEqual({ cancelled: true, committed: true });
});
it("rejects an invalid gate shape", () => {
  expect(() => nativeLaunchGateState(new SharedArrayBuffer(8))).toThrow("Invalid native launch gate");
});
it("rejects corrupted gate bits", () => {
  const gate = createNativeLaunchGate(); Atomics.store(new Int32Array(gate), 0, 4);
  expect(() => commitNativeLaunchGate(gate, 10n, () => 0n)).toThrow("Invalid native launch gate state");
});
