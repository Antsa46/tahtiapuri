import assert from 'node:assert/strict';

export const startupKinds = ['startup-child', 'startup-no-inherit', 'startup-winsock'];
const pid = n => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff;
const one = (rows, type, phase) => {
  const found = rows.filter(r => r.type === type && (phase === undefined || r.phase === phase));
  assert.equal(found.length, 1, `Expected one ${phase ?? ''}/${type}.`); return found[0];
};
const childTypes = ['token','startup-handles','startup-read','startup-complete'];
export function decodeStartupChild(text) {
  assert(typeof text === 'string' && Buffer.byteLength(text) <= 16384 && text.endsWith('\n'), 'Incomplete or oversized child receipt.');
  const lines = text.trimEnd().split('\n'); assert.equal(lines.length, 6, 'Unexpected child receipt length.');
  const rows = lines.map(line => {
    const row = JSON.parse(line);
    assert(row && childTypes.includes(row.type) && row.phase === 'descendant', 'Child cannot emit host records.');
    if (row.type === 'token') assert(pid(row.pid), 'Invalid child PID.');
    return { ...row, source: 'child-file' };
  });
  assert.equal(rows[0].type, 'token'); assert.equal(rows.at(-1).type, 'startup-complete', 'Missing terminal child receipt.');
  return rows;
}
export function validateStartupIdentity(row, mode) {
  const restricted = ['ac','lpac'].includes(mode);
  assert.equal(row.job, true); assert.equal(row.appContainer, restricted); assert.equal(row.capabilities, 0);
  assert.equal(row.integrity, restricted ? 4096 : 8192);
  if (row.lpac === null) { assert(restricted); assert.equal(row.lpacQueryError, 87); }
  else { assert.equal(row.lpac, mode === 'lpac'); assert.equal(row.lpacQueryError, 0); if (restricted) assert.equal(row.lpacQueryBytes, 4); }
}
export function validateStartupCase(result) {
  const { mode, kind, records: rows } = result;
  assert(['control','control-inherit','ac','lpac'].includes(mode) && startupKinds.includes(kind), 'Unsupported startup case.');
  assert(Array.isArray(rows) && rows.length <= 60 && !result.error, 'Incomplete startup case.');
  const types = ['profile','network-identity','launched','finished','cleanup','descendant','startup-begin','startup-result','startup-winsock-cleanup','startup-child-exit',...childTypes];
  assert(rows.every(r => types.includes(r.type) && ['pipe','child-file'].includes(r.source)), 'Unexpected native record.');
  assert(rows.filter(r => r.source === 'child-file').every(r => childTypes.includes(r.type) && r.phase === 'descendant'), 'Invalid file provenance.');
  assert.equal(result.exit?.code, 0); assert.equal(result.exit.signal, null);
  const launched = one(rows, 'launched'), finished = one(rows, 'finished');
  validateStartupIdentity(launched, mode); assert.equal(launched.requestedPolicy, mode); assert.equal(launched.aclsVerified, true);
  assert.equal(launched.sentinelInherited, mode === 'control-inherit');
  assert.equal(finished.exitCode, 0); assert.equal(finished.activeProcesses, 0); assert.equal(finished.ownerGone, false);
  const restricted = ['ac','lpac'].includes(mode), profile = restricted ? one(rows, 'profile') : null;
  assert.equal(rows.filter(r => r.type === 'profile').length, restricted ? 1 : 0);
  if (profile) { assert(/^S-1-15-2-(?:\d+-)*\d+$/.test(profile.sid)); assert.equal(one(rows,'cleanup').hresult, 0); }
  const operation = one(rows,'startup-result'), begin = one(rows,'startup-begin');
  assert(rows.indexOf(one(rows,'token','primary')) < rows.indexOf(begin) && rows.indexOf(begin) < rows.indexOf(operation), 'Invalid API call order.');
  assert(rows.indexOf(operation)<rows.indexOf(one(rows,'startup-complete','primary'))&&rows.indexOf(one(rows,'startup-complete','primary'))<rows.indexOf(finished),'Invalid primary completion order.');
  assert.equal(begin.kind, kind); assert.equal(begin.winsockCallsBefore, 0);
  assert(typeof operation.ok === 'boolean' && Number.isSafeInteger(operation.code) && operation.code >= 0 && operation.code <= 0xffffffff);
  assert.equal(operation.ok, operation.code === 0, 'API result/code mismatch.');
  const child = kind !== 'startup-winsock' && operation.ok;
  const phases = child ? ['primary','descendant'] : ['primary'];
  assert.equal(rows.filter(r => r.type === 'token').length, phases.length);
  assert.equal(rows.filter(r => r.type === 'startup-complete').length, phases.length);
  assert.equal(rows.filter(r => r.type === 'startup-handles').length, phases.length);
  assert.equal(rows.filter(r => r.type === 'startup-read').length, phases.length * 3);
  assert.equal(rows.filter(r => r.source === 'child-file').length, child && kind === 'startup-no-inherit' ? 6 : 0);
  const descendants = rows.filter(r => r.type === 'descendant'); assert.equal(descendants.length, child ? 1 : 0);
  const expectedPids = [result.launchedChildPid, launched.pid, ...(child ? [descendants[0].pid] : [])];
  assert([...expectedPids,result.driverPid].every(pid) && new Set([...expectedPids,result.driverPid]).size === expectedPids.length+1, 'Process identities overlap or are missing.');
  for (const phase of phases) {
    const token = one(rows,'token',phase); validateStartupIdentity(token,mode);
    assert.equal(token.pid, phase === 'primary' ? launched.pid : descendants[0].pid);
    if (restricted) assert.equal(token.sid, profile.sid);
    assert.equal(token.lpacQueryAttempted,restricted); assert.equal(token.lpacQueryApi,'GetTokenInformation'); assert.equal(token.lpacBufferBytes,4);
    assert(Number.isInteger(token.lpacInfoClass)&&token.lpacInfoClass>0&&token.lpacInfoClass<=256);
    const source = phase === 'descendant' && kind === 'startup-no-inherit' ? 'child-file' : 'pipe';
    assert(rows.filter(r => r.phase === phase).every(r => r.source === source), 'Wrong phase reporting channel.');
    const handles=one(rows,'startup-handles',phase), inheriting=source!=='child-file';
    // A no-inherit child can start with absent stdio or three character-device
    // handles. Neither shape accepts the parent's stdout/stderr PIPE handles.
    assert(inheriting?handles.validStdio===3:[0,3].includes(handles.validStdio));
    const present=inheriting||handles.validStdio===3;
    assert.deepEqual(handles.handles?.map(h=>h.name),['stdin','stdout','stderr']);
    for(const [index,h] of handles.handles.entries()){
      assert.equal(h.queryOk,present);assert.equal(h.error,present?0:6);
      assert.equal(h.type,inheriting?(index===0?2:3):present?2:0);assert.equal(h.typeError,present?0:6);
      assert(Number.isInteger(h.flags));if(inheriting)assert.equal(h.flags&1,1);else assert.equal(h.flags,present?1:0);
    }
    one(rows,'startup-complete',phase);
    for (const [name, ok] of [['allowed',true],['aap',mode !== 'lpac'],['outside',!restricted]]) {
      const reads=rows.filter(r=>r.type==='startup-read'&&r.phase===phase&&r.name===name); assert.equal(reads.length,1);
      assert.equal(reads[0].ok,ok); assert.equal(reads[0].code,ok?0:5);
    }
  }
  if (kind === 'startup-winsock') {
    assert.equal(operation.api,'WSAStartup'); assert.equal(operation.requestedVersion,514); assert.equal(operation.version,operation.ok?514:null);
    const clean=rows.filter(r=>r.type==='startup-winsock-cleanup'); assert.equal(clean.length,operation.ok?1:0);
    if(operation.ok){assert.equal(clean[0].ok,true);assert.equal(clean[0].code,0);}
    assert.equal(rows.filter(r=>r.type==='startup-child-exit').length,0);
  } else {
    assert.equal(operation.api,'CreateProcessW'); assert.equal(operation.inheritHandles,kind==='startup-child');
    assert.equal(rows.filter(r=>r.type==='startup-winsock-cleanup').length,0);
    const exits=rows.filter(r=>r.type==='startup-child-exit');assert.equal(exits.length,child?1:0);
    if(child){assert.equal(exits[0].pid,descendants[0].pid);assert.equal(exits[0].exitCode,0);}
  }
  const exit=result.processExitObservation;
  assert.equal(exit?.allAbsent,true);assert.equal(exit.beforeCleanup,true);
  assert.deepEqual([...exit.pids].sort((a,b)=>a-b),[...expectedPids].sort((a,b)=>a-b));
  const clean=result.cleanup;
  for(const flag of ['passed','stopped','profileClean'])assert.equal(clean?.[flag],true);
  assert.deepEqual(clean.errors,[]);assert(!clean.emergency);assert.equal(clean.deletionAttempts?.at(-1)?.removed,true);
  if(restricted){assert.equal(clean.teardown?.code,0);assert.equal(one(clean.teardown.records,'cleanup').hresult,0);}
  return {diagnosticComplete:true,operationSucceeded:operation.ok,api:operation.api,code:operation.code,compatible:operation.ok,networkAttempted:false,isolationVerified:false};
}
