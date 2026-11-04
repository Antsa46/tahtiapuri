// Entirely invented local evidence; no captured machine paths, SIDs, times or ports.
const names = ['tcp4', 'tcp6', 'udp4', 'udp6'];
const base = Date.UTC(2024, 0, 1);
const app = name => Buffer.from(`\\device\\synthetic\\${name}.exe\0`, 'utf16le').toString('hex');
const packageSid = 'S-1-15-2-101-102-103-104-105-106-107';
export function syntheticDescriptor() {
  // Self-relative SD with one allow ACE for the public Everyone SID (S-1-1-0).
  const b = Buffer.alloc(60); b[0] = 1; b.writeUInt16LE(0x8004, 2); b.writeUInt32LE(48, 4); b.writeUInt32LE(20, 16);
  b[20] = 2; b.writeUInt16LE(28, 22); b.writeUInt16LE(1, 24);
  b.writeUInt16LE(20, 30); b.writeUInt32LE(1, 32);
  for (const offset of [36, 48]) { b[offset] = 1; b[offset + 1] = 1; b[offset + 7] = 1; }
  return b;
}
export function socketHex(family, port) {
  const b = Buffer.alloc(family === 4 ? 16 : 28);
  b.writeUInt16LE(family === 4 ? 2 : 23); b.writeUInt16BE(port, 2);
  if (family === 4) b.set([127, 0, 0, 1], 4); else b[23] = 1;
  return b.toString('hex');
}
export function correlationFixture() {
  const endpoints = Object.fromEntries(names.map((name, i) => [name, 31001 + i]));
  const cases = ['control', 'ac', 'control-inherit'].map((mode, index) => {
    const restricted = mode === 'ac', start = base + index * 2000, pid = 100 + index * 10;
    const records = [
      { type: 'launched', requestedPolicy: mode, aclsVerified: true, sentinelInherited: mode === 'control-inherit', job: true, pid },
      { type: 'network-identity', code: 0, appIdHex: app(mode) },
      { type: 'descendant', pid: pid + 1 },
      { type: 'finished', ownerGone: false, exitCode: 0, activeProcesses: 0 },
      { type: 'operation', phase: 'primary', name: 'breakaway', ok: false, code: 5, attempted: true },
    ];
    if (restricted) records.push({ type: 'profile', sid: packageSid }, { type: 'cleanup', hresult: 0 });
    for (const [phaseIndex, phase] of ['primary', 'descendant'].entries()) {
      records.push({ type: 'token', phase, pid: pid + phaseIndex, job: true, appContainer: restricted, lpac: false, lpacQueryBytes: 4, capabilities: 0, integrity: restricted ? 4096 : 8192, ...(restricted ? { sid: packageSid } : {}) });
      for (const name of ['package-read', 'weights-read', 'scratch-write', 'aap-read']) records.push({ type: 'operation', phase, name, ok: true, code: 0, attempted: true });
      for (const name of ['outside-read', 'outside-write', 'resource-write', 'code-write']) records.push({ type: 'operation', phase, name, ok: !restricted, code: restricted ? 5 : 0, attempted: true });
      for (const [i, name] of names.entries()) {
        const address = name.endsWith('4') ? '127.0.0.1' : '::1', at = start + 50 + (phaseIndex * 4 + i) * 100;
        records.push({ type: 'network-detail', phase, name, pid: pid + phaseIndex,
          stage: restricted ? (name.startsWith('tcp') ? 'connect-deadline' : 'receive') : 'echo',
          protocol: name.startsWith('tcp') ? 6 : 17, remoteAddress: address, remotePort: endpoints[name],
          startedAtMs: at, finishedAtMs: at + 80, localAddress: address, localPort: 42000 + phaseIndex * 4 + i,
          localEndpointError: 0, ok: !restricted, code: restricted ? 10060 : 0 });
        records.push({ type: 'operation', phase, name, ok: !restricted, code: restricted ? 10060 : 0, attempted: true });
      }
    }
    return { mode, kind: 'normal', primaryOnly: false, corePassed: true, cleanupPassed: true,
      observerCleanupPassed: restricted ? true : undefined, observerExit: restricted ? { code: 0, signal: null } : undefined,
      probeSha256: 'a'.repeat(64), endpoints: { ...endpoints }, records,
      startedAt: new Date(start).toISOString(), finishedAt: new Date(start + 1000).toISOString(), exit: { code: 0 },
      counts: Object.fromEntries(names.map(name => [name, restricted ? 0 : 2])), accepted: { tcp4: restricted ? 0 : 2, tcp6: restricted ? 0 : 2 },
      cleanup: { passed: true, stopped: true, profileClean: true, errors: [], deletionAttempts: [{ attempt: 1, removed: true }] } };
  });
  const events = cases[1].records.filter(r => r.type === 'network-detail').flatMap(d => {
    const family = d.name.endsWith('4') ? 4 : 6, filterId = String(family);
    const event = { kind: 'event', eventId: 1001, version: 2, atMs: d.startedAtMs + 10, timeSource: 'etw-header-system-time', payloadTimestampRaw: '0',
      identityRole: 'endpoint-owner', canonicalAppIdHex: app('receiver'), observedAppIdHex: app('receiver'), appIdMatch: 'nt-path',
      localSocketHex: socketHex(family, d.remotePort), remoteSocketHex: socketHex(family, d.localPort), loopback: 1, direction: 14592,
      filterId, layerId: family === 4 ? 44 : 46,
      filter: { queryCode: 0, id: filterId, name: 'Synthetic filter', provider: 'decc16ca-3f33-4346-be1e-8fb4ae0f3d62',
        layer: family === 4 ? 'e1cd9fe7-f4b5-4273-96c0-592e487b8650' : 'a3b42c97-9f04-4672-b87e-cee9c483257f',
        sublayer: 'ffe221c3-92a8-4564-a59f-dafb70756020', actionType: 4097,
        conditions: [{ field: '632ce23b-5167-435c-86d7-e903684aa80c', match: 6, value: { type: 3, value: 1 } },
          { field: 'af043a0a-b34d-4f86-979c-c90371af6e66', match: 0, value: { type: 14, hex: syntheticDescriptor().toString('hex') } }] } };
    return d.name.startsWith('tcp') ? [event, { ...structuredClone(event), atMs: event.atMs + 10 }] : [event];
  });
  const evidence = { exit: { code: 0, signal: null }, done: { exitCode: 0, guardExitCode: 0 },
    guard: { cleanupPassed: true, sessionAbsent: true, identityVerified: true, timedOut: false },
    records: [{ kind: 'baseline', collect: 1, keywords: '0' }, { kind: 'ready', appIdHex: app('ac'), endpointAppIdHex: app('receiver') }, ...events,
      { kind: 'finished', complete: true, providerDisabled: true, sessionStopped: true, sessionAbsent: true, consumerStopped: true, engineClosed: true, optionsUnchanged: true,
        collectAfter: 1, keywordsAfter: '0', eventsLost: 0, realTimeBuffersLost: 0, logBuffersLost: 0, callbackFailed: false,
        received: events.length, matchedEvents: events.length, providerMismatch: 0, otherEventId: 0, emptyAppId: 0, otherAppId: 0, otherEndpoint: 0, ntMatches: events.length, dosMatches: 0 }] };
  return { cases, evidence };
}
