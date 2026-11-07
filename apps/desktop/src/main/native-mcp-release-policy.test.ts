import { expect, it } from "vitest";
import type { NativeConnectionOutcome } from "./native-main-connection.js";
import { assessNativeMcpRelease } from "./native-mcp-release-policy.js";

const owner = (change: Partial<NativeConnectionOutcome> = {}): NativeConnectionOutcome => Object.freeze({
  authenticated: true, brokerCleanupReported: true, backendDetachSettled: true,
  descriptorConsumptionSettled: true, epochRevoked: true, streamClosed: true, failed: false, ...change,
});
const unauthenticated = (change: Partial<NativeConnectionOutcome> = {}): NativeConnectionOutcome => owner({
  authenticated: false, brokerCleanupReported: false, backendDetachSettled: false, epochRevoked: false, ...change,
});
const denied = (outcomes: readonly NativeConnectionOutcome[]) => {
  expect(assessNativeMcpRelease(outcomes)).toMatchObject({ operation: undefined, failed: true });
};
it("selects pristine when no connection owned the generation", () => {
  expect(assessNativeMcpRelease([])).toEqual({ operation: "release-pristine", brokerCleanupReported: false, failed: false });
});
it("allows a closed unauthenticated peer without treating it as an owner", () => {
  expect(assessNativeMcpRelease([unauthenticated()])).toEqual({ operation: "release-pristine", brokerCleanupReported: false, failed: false });
});
it("selects clean only for the complete authenticated owner", () => {
  const original = owner(), result = assessNativeMcpRelease([original]);
  expect(result).toEqual({ operation: "release-clean", brokerCleanupReported: true, failed: false });
  expect(Object.isFrozen(result)).toBe(true); expect(original).toEqual(owner());
});
for (const field of ["brokerCleanupReported", "backendDetachSettled", "descriptorConsumptionSettled", "epochRevoked", "streamClosed"] as const)
  it("refuses an incomplete authenticated gate: " + field, () => { denied([owner({ [field]: false })]); });
it("refuses a failed owner even when CLEAN was reported", () => { denied([owner({ failed: true })]); });
it("refuses a failed unauthenticated peer alongside a complete owner", () => { denied([owner(), unauthenticated({ failed: true })]); });
it("refuses an unauthenticated CLEAN claim", () => { denied([unauthenticated({ brokerCleanupReported: true })]); });
it("refuses an unclosed unauthenticated peer", () => { denied([unauthenticated({ streamClosed: false })]); });
it("refuses unsettled descriptor work on an unauthenticated peer", () => { denied([unauthenticated({ descriptorConsumptionSettled: false })]); });
it("deduplicates only repeated references to the same terminal result", () => {
  const terminal = owner(); expect(assessNativeMcpRelease([terminal, terminal])).toMatchObject({ operation: "release-clean", failed: false });
});
it("refuses distinct owner results even when all values match", () => {
  const first = owner(), second = owner(); expect(first).not.toBe(second); denied([first, second]);
});
it("keeps one complete owner when a harmless unauthenticated peer also closed", () => {
  expect(assessNativeMcpRelease([owner(), unauthenticated()])).toMatchObject({ operation: "release-clean", failed: false });
});
