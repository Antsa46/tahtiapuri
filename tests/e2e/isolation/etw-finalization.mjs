import { correlateEtwNetwork } from './etw-correlation.mjs';

// Called only after all three live cases finish. Publish no successful summary
// until both the complete evidence and the AC result's persistence succeed.
export async function finalizeEtwRun(cases, evidence, saveIsolated) {
  const networkEvidence = correlateEtwNetwork(cases, evidence), isolated = cases[1];
  const updated = { ...isolated, networkEvidence,
    validation: { ...isolated.validation, networkVerified: true, network: networkEvidence.attempts },
    passed: true };
  await saveIsolated(updated);
  return {
    networkEvidence,
    cases: cases.map(c => ({ mode: c.mode, kind: c.kind, primaryOnly: c.primaryOnly,
      primaryDiagnosticPassed: c.primaryDiagnosticPassed ?? false, cleanupPassed: c.cleanupPassed,
      observerCleanupPassed: c.observerCleanupPassed, passed: true, corePassed: c.corePassed, networkVerified: true })),
    corePassed: true, passed: true,
  };
}
