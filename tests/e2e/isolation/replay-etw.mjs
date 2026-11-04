import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEtwEvidence } from './etw-observation.mjs';
import { etwProfile } from './etw-profiles.mjs';
import { verifyObservedNetwork } from './etw-correlation.mjs';

// Read-only replay of trusted local development artifacts. Never changes old results.
export async function replayEtwRun(runRoot, kind = 'normal', {profile='ac',method='etw-drop'}={}) {
  assert(['normal', 'error', 'launcher-kill', 'owner-kill'].includes(kind), 'Unsupported ETW lifecycle.');
  const selected = etwProfile(profile,kind);
  const cases = [];
  for (const name of ['control-normal', selected.caseLabel, 'control-inherit-normal']) {
    const path = join(runRoot, name, 'result.json'), maximum = 1024 * 1024;
    const stat = await fs.stat(path); assert(stat.isFile() && stat.size <= maximum, 'Oversized case file.');
    const text = await fs.readFile(path, 'utf8'); assert(Buffer.byteLength(text) <= maximum, 'Oversized case file.');
    cases.push(JSON.parse(text));
  }
  return verifyObservedNetwork(cases, await readEtwEvidence(runRoot, cases[1].observerExit),{profile,method});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert([3, 4, 5, 6].includes(process.argv.length) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(process.argv[2]), 'Supply one local run UUID.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  console.log(JSON.stringify(await replayEtwRun(join(root, '.artifacts/tests/isolation/runs', process.argv[2]), process.argv[3],{profile:process.argv[4]??'ac',method:process.argv[5]??'etw-drop'}), null, 2));
}
