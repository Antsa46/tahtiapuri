import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEtwEvidence } from './etw-observation.mjs';
import { correlateEtwNetwork } from './etw-correlation.mjs';

// Read-only replay of trusted local development artifacts. Never changes old results.
export async function replayEtwRun(runRoot, kind = 'normal') {
  assert(['normal', 'error', 'launcher-kill', 'owner-kill'].includes(kind), 'Unsupported ETW lifecycle.');
  const cases = [];
  for (const name of ['control-normal', `ac-${kind}`, 'control-inherit-normal']) {
    const path = join(runRoot, name, 'result.json'), maximum = 1024 * 1024;
    const stat = await fs.stat(path); assert(stat.isFile() && stat.size <= maximum, 'Oversized case file.');
    const text = await fs.readFile(path, 'utf8'); assert(Buffer.byteLength(text) <= maximum, 'Oversized case file.');
    cases.push(JSON.parse(text));
  }
  return correlateEtwNetwork(cases, await readEtwEvidence(runRoot, cases[1].observerExit));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert([3, 4].includes(process.argv.length) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(process.argv[2]), 'Supply one local run UUID.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  console.log(JSON.stringify(await replayEtwRun(join(root, '.artifacts/tests/isolation/runs', process.argv[2]), process.argv[3]), null, 2));
}
