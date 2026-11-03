// Fixed, synthetic Electron Node probe: no network or application data API.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const life = process.argv[8];
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (!root || !['once', 'hold', 'fail'].includes(life)) throw new Error('Invalid fixed probe arguments.');
emit({ type: 'runtime', pid: process.pid, electron: process.versions.electron, node: process.versions.node, arch: process.arch, execArgv: process.execArgv });
async function operation(name, action) {
  try { await action(); emit({ type: 'runtime-operation', name, ok: true }); }
  catch (error) { emit({ type: 'runtime-operation', name, ok: false, code: error.code, errno: error.errno }); }
}
await operation('package-read', async () => { if ((await fs.readFile(join(root, 'package/allowed.txt'), 'utf8')) !== 'SYNTHETIC ALLOWED\n') throw new Error('Fixture mismatch.'); });
await operation('scratch-write', async () => { await fs.writeFile(join(root, 'scratch/runtime.txt'), 'SYNTHETIC WRITABLE\n', { flag: 'wx' }); });
await operation('outside-read', async () => { await fs.readFile(join(root, 'private/secret.txt')); });
await operation('outside-write', async () => { await fs.writeFile(join(root, 'private/runtime.txt'), 'SYNTHETIC OUTSIDE\n', { flag: 'wx' }); });
await operation('code-write', async () => { const handle = await fs.open(join(root, 'package/module.mjs'), 'r+'); try { await handle.write('X'); } finally { await handle.close(); } });
if (life === 'fail') { emit({ type: 'runtime-failure', kind: 'deliberate-js-error' }); throw new Error('Deliberate synthetic JS failure.'); }
emit({ type: 'runtime-ready' });
if (life === 'hold') setInterval(() => {}, 1000);
