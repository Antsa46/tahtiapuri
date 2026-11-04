import assert from 'node:assert/strict';

// Shared by the live driver and offline ETW correlation; no process or filesystem access.
export function validateNativeCase(report, mode, counts, accepted, primaryOnly = false, observeNetwork = false) {
  const network = [];
  assert(!report.some(row => row.type === 'error' || row.type === 'probe-error'), 'Native error record.');
  const launched = report.find(row => row.type === 'launched'); assert(launched?.job); assert.equal(launched.requestedPolicy, mode); assert.equal(launched.aclsVerified, true); assert.equal(launched.sentinelInherited, mode === 'control-inherit');
  const profile = report.find(row => row.type === 'profile');
  for (const phase of primaryOnly ? ['primary'] : ['primary', 'descendant']) {
    const token = report.find(row => row.type === 'token' && row.phase === phase); assert(token?.job, `${phase} Job membership`);
    assert.equal(token.appContainer, ['ac', 'lpac'].includes(mode)); if (token.lpac === null) assert.equal(token.lpacQueryError, 87, 'Unknown LPAC query must retain observed error.');
    else { assert.equal(token.lpac, mode === 'lpac'); if (token.appContainer) assert.equal(token.lpacQueryBytes, 4); } assert.equal(token.capabilities, 0);
    if (observeNetwork && mode.startsWith('control')) assert.equal(token.integrity, 8192, 'Observation controls must run at ordinary medium integrity.');
    if (['ac', 'lpac'].includes(mode)) { assert.equal(token.integrity, 4096); assert.equal(token.sid, profile.sid); }
    const operation = name => { const row = report.find(row => row.type === 'operation' && row.phase === phase && row.name === name); assert(row, `${phase}/${name}`); return row; };
    for (const name of ['package-read', 'weights-read', 'scratch-write']) assert.equal(operation(name).ok, true, `${phase}/${name}`);
    assert.equal(operation('aap-read').ok, mode !== 'lpac');
    if (mode === 'lpac') assert.equal(operation('aap-read').code, 5);
    for (const name of ['outside-read', 'outside-write', 'resource-write', 'code-write']) {
      const row = operation(name); assert.equal(row.ok, !['ac', 'lpac'].includes(mode), `${phase}/${name}`);
      if (['ac', 'lpac'].includes(mode)) assert.equal(row.code, 5, `${phase}/${name}: require ERROR_ACCESS_DENIED`);
    }
    for (const name of ['tcp4', 'tcp6', 'udp4', 'udp6']) {
      const row = operation(name); assert.equal(row.ok, !['ac', 'lpac'].includes(mode), `${phase}/${name}`);
      if (['ac', 'lpac'].includes(mode)) {
        if (row.attempted === false) {
          const failure = report.find(item => item.type === 'network-startup' && item.phase === phase);
          assert(failure && failure.code !== 0 && failure.code === row.code, 'Unattempted networking must retain startup failure.');
          network.push({ phase, name, code: row.code, evidence: 'startup-unavailable' }); continue;
        }
        assert.equal(row.attempted, true);
        assert([10013, 10060].includes(row.code), `${phase}/${name}: unexpected network failure`);
        const detail = report.find(item => item.type === 'network-detail' && item.phase === phase && item.name === name);
        network.push({ phase, name, code: row.code, evidence: detail?.stage === 'bind' ? 'bind-failed-before-connect' : row.code === 10013 ? 'os-access-denied' : 'timeout-unresolved' });
      }
    }
  }
  if (!primaryOnly) { const breakaway = report.find(row => row.name === 'breakaway'); assert.equal(breakaway?.ok, false); assert.equal(breakaway?.code, 5); }
  else assert(!report.some(row => row.type === 'descendant'));
  for (const name of Object.keys(counts)) assert.equal(counts[name], !['ac', 'lpac'].includes(mode) ? 2 : 0, `${name} observed requests`);
  for (const name of Object.keys(accepted)) assert.equal(accepted[name], !['ac', 'lpac'].includes(mode) ? 2 : 0, `${name} accepted sockets`);
  return { network, networkVerified: (!observeNetwork || mode.startsWith('control')) && network.every(row => row.evidence === 'os-access-denied') };
}
