import {etwProfile} from './etw-profiles.mjs';
import { verifyObservedNetwork } from './etw-correlation.mjs';

// Called only after all three live cases finish. Publish no successful summary
// until both the complete evidence and the isolated result's persistence succeed.
export async function finalizeEtwRun(cases, evidence, saveIsolated,{profile='ac',method='etw-drop'}={}) {
  const networkEvidence = verifyObservedNetwork(cases, evidence,{profile,method}), isolated = cases[1];
  const updated = { ...isolated, networkEvidence,
    validation: { ...isolated.validation, networkVerified: true, network: networkEvidence.attempts },
    passed: true };
  await saveIsolated(updated,etwProfile(profile,isolated.kind).caseLabel);
  return {
    networkEvidence,
    cases: cases.map(c => ({ mode: c.mode, kind: c.kind, ...(c.experimentProfile?{experimentProfile:c.experimentProfile,caseLabel:c.caseLabel,capabilityPolicy:c.capabilityPolicy}:{}), primaryOnly: c.primaryOnly,
      primaryDiagnosticPassed: c.primaryDiagnosticPassed ?? false, cleanupPassed: c.cleanupPassed,
      observerCleanupPassed: c.observerCleanupPassed, passed: true, corePassed: c.corePassed, networkVerified: true })),
    corePassed: true, passed: true,
  };
}
