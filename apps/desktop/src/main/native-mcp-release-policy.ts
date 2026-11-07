import type { NativeConnectionOutcome } from "./native-main-connection.js";

export type NativeMcpReleaseOperation = "release-pristine" | "release-clean";
export interface NativeMcpReleaseDecision {
  readonly operation: NativeMcpReleaseOperation | undefined;
  readonly brokerCleanupReported: boolean;
  readonly failed: boolean;
}
/** Requests a fixed native check; never grants deletion or rearm authority.
 * stop() and the connection's close callback may return the SAME frozen result.
 * Distinct authenticated results must never be coalesced by matching values. */
export function assessNativeMcpRelease(outcomes: readonly NativeConnectionOutcome[]): NativeMcpReleaseDecision {
  const distinct = [...new Set(outcomes)], owners = distinct.filter(outcome => outcome.authenticated);
  const brokerCleanupReported = owners.some(outcome => outcome.brokerCleanupReported);
  const invalid = distinct.some(outcome => outcome.failed || !outcome.streamClosed || !outcome.descriptorConsumptionSettled
    || !outcome.authenticated && outcome.brokerCleanupReported);
  let operation: NativeMcpReleaseOperation | undefined;
  if (!invalid) {
    if (owners.length === 0) operation = "release-pristine";
    else if (owners.length === 1) {
      const owner = owners[0]!;
      if (owner.brokerCleanupReported && owner.backendDetachSettled && owner.epochRevoked) operation = "release-clean";
    }
  }
  return Object.freeze({ operation, brokerCleanupReported, failed: invalid || operation === undefined });
}
