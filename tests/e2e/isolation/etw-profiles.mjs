import assert from 'node:assert/strict';
// Closed development profiles. Report contents cannot select their own policy.
export function etwProfile(id='ac',kind='normal'){
  assert(['normal','error','launcher-kill','owner-kill'].includes(kind));
  assert(['ac','lpac-registry-read'].includes(id),'Unknown ETW profile.');
  const candidate=id==='lpac-registry-read';
  if(candidate)assert.equal(kind,'normal','Candidate lifecycle cases require a separate review.');
  return Object.freeze({id,kind,candidate,mode:candidate?'lpac':'ac',
    capabilityPolicy:candidate?'registryRead':'none',
    verb:candidate?'run-lpac-candidate':'run',
    caseLabel:`${id}-${kind}`,
    scenario:candidate?'observe-lpac-registry-read':kind==='normal'?'observe':`observe-${kind}`,
    scope:candidate?'native-lpac-registry-read-bound-loopback-receive-v2':kind==='normal'?'native-ac-bound-loopback-receive-v2':'native-ac-bound-loopback-lifecycle-receive-v2'});
}
