import assert from 'node:assert/strict';

export function validateRuntimeProfile(runtime) {
  assert(runtime && typeof runtime === 'object');
  assert.deepEqual(Object.keys(runtime).sort(), ['kind', 'sha256', 'variant', 'version']);
  assert(/^[a-f0-9]{64}$/.test(runtime.sha256));
  if (runtime.kind === 'electron') {
    assert.equal(runtime.variant, 'official'); assert.equal(runtime.version, '45.2.1');
  } else {
    assert.equal(runtime.kind, 'node'); assert.equal(runtime.version, '24.22.2');
    assert(['official', 'local-unpatched', 'local-patched'].includes(runtime.variant));
  }
}
export function verifyRuntimeIdentity(runtime, actual) {
  validateRuntimeProfile(runtime);
  assert.equal(actual.platform, 'win32'); assert.equal(actual.arch, 'x64');
  assert.equal(actual.execPath, actual.expectedExecPath);
  assert.equal(actual.sha256, runtime.sha256);
  assert.equal(actual.nodeOptions, undefined); assert.equal(actual.nodePath, undefined);
  if (runtime.kind === 'electron') {
    assert.equal(actual.electron, runtime.version); assert.equal(actual.node, '24.22.1');
    assert.equal(actual.runAsNode, '1'); assert.equal(actual.resolved, 'electron:electron');
  } else {
    assert.equal(actual.node, runtime.version); assert.equal(actual.electron, undefined);
    assert.equal(actual.runAsNode, undefined); assert.equal(actual.resolved, undefined);
  }
  return { runtime, node: actual.node, electron: actual.electron ?? null, uv: actual.uv,
    platform: actual.platform, arch: actual.arch, resolved: actual.resolved ?? null,
    imageVerified: true, artifactVerified: true };
}
export function validateRuntimeEvidence(records, runtime) {
  validateRuntimeProfile(runtime);
  const rows = records.filter(r => r.type === 'sdk-phase' && r.phase === 'runtime-contract');
  assert.equal(rows.length, 1, 'Runtime contract must be unique and complete.');
  const r = rows[0]; assert.equal(r.source, 'worker'); assert.equal(r.passed, true);
  assert.deepEqual(r.runtime, runtime); assert.equal(r.platform, 'win32'); assert.equal(r.arch, 'x64');
  assert.equal(r.imageVerified, true); assert.equal(r.artifactVerified, true);
  assert.equal(r.node, runtime.kind === 'node' ? runtime.version : '24.22.1');
  assert.equal(r.electron, runtime.kind === 'electron' ? runtime.version : null);
  assert.equal(r.resolved, runtime.kind === 'electron' ? 'electron:electron' : null);
}

// A shared hidden console is part of this synthetic Node experiment, not a production boundary.
export function validateConsoleEvidence(records, runtime, { ownerLoss = false } = {}) {
  if (runtime.kind !== 'node') return;
  const consoles = records.filter(row => row.type === 'console-host' && row.source === 'host');
  assert.equal(consoles.length, 1);
  assert.equal(consoles[0].soleClient, true); assert.equal(consoles[0].hidden, true); assert.equal(consoles[0].imageVerified, true);
  if (ownerLoss) return; // Owner transport is intentionally killed; external cleanup must prove console exit.
  const finished = records.filter(row => row.type === 'console-finished' && row.source === 'host');
  assert.equal(finished.length, 1); assert.equal(finished[0].detached, true); assert.equal(finished[0].stopped, true);
}
