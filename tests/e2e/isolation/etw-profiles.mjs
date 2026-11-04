import assert from 'node:assert/strict';
// Closed development profiles. Report contents cannot select their own policy.
export function etwProfile(id='ac',kind='normal'){
  assert(['normal','error','launcher-kill','owner-kill'].includes(kind));
  assert(['ac','lpac-registry-read'].includes(id),'Unknown ETW profile.');
  const candidate=id==='lpac-registry-read';
  return Object.freeze({id,kind,candidate,mode:candidate?'lpac':'ac',
    capabilityPolicy:candidate?'registryRead':'none',
    verb:candidate?'run-lpac-candidate':'run',
    caseLabel:`${id}-${kind}`,
    scenario:candidate?(kind==='normal'?'observe-lpac-registry-read':`observe-lpac-registry-read-${kind}`):kind==='normal'?'observe':`observe-${kind}`,
    scope:candidate?(kind==='normal'?'native-lpac-registry-read-bound-loopback-receive-v2':'native-lpac-registry-read-bound-loopback-lifecycle-receive-v2'):kind==='normal'?'native-ac-bound-loopback-receive-v2':'native-ac-bound-loopback-lifecycle-receive-v2'});
}
