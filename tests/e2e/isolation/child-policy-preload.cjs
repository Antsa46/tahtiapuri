// Test-only preload for the unchanged SDK binary-test child. No network/API tools.
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(process.cwd());
const operations = [];
function run(name, action) { try { action(); operations.push({ name, ok: true }); } catch (error) { operations.push({ name, ok: false, code: error.code }); } }
run('package-read', () => { if (fs.readFileSync(path.join(root, 'package/allowed.txt'), 'utf8') !== 'SYNTHETIC ALLOWED\n') throw new Error('Fixture mismatch.'); });
run('scratch-write', () => fs.writeFileSync(path.join(root, 'scratch', `child-${process.pid}.txt`), 'SYNTHETIC CHILD\n', { flag: 'wx' }));
run('outside-read', () => fs.readFileSync(path.join(root, 'private/secret.txt')));
run('outside-write', () => fs.writeFileSync(path.join(root, 'private', `child-${process.pid}.txt`), 'SYNTHETIC OUTSIDE\n', { flag: 'wx' }));
run('code-write', () => { const fd = fs.openSync(path.join(root, 'package/module.mjs'), 'r+'); try { fs.writeSync(fd, 'X'); } finally { fs.closeSync(fd); } });
if (typeof process.send !== 'function') throw new Error('SDK child policy probe requires its owning IPC channel.');
process.send({ type: 'probe-policy', pid: process.pid, operations });
