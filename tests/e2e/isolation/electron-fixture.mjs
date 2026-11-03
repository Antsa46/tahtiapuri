import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './package-stager.mjs';
import { collect, bounded } from './process-harness.mjs';
export async function prepareElectronFixture(root, destination) {
  const tools = JSON.parse(await fs.readFile(join(root, 'scripts/dev/toolchain.json'), 'utf8'));
  const archive = join(root, '.local/cache/downloads', tools.electron.file);
  const checksum = await sha256(archive); assert.equal(checksum, tools.electron.sha256, 'Existing Electron archive checksum differs. Nothing was downloaded.');
  const script = fileURLToPath(new URL('./extract-electron.ps1', import.meta.url));
  const unpack = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Archive',archive,'-Destination',destination], { stdio: ['ignore','pipe','pipe'], windowsHide: true });
  const report = collect(unpack);
  try { const exit = await bounded(report.exited, 90000, 'Local archive extraction timeout.'); report.checkComplete(); assert.equal(exit.code, 0, report.stderr); }
  finally { if (unpack.exitCode === null && unpack.signalCode === null) unpack.kill(); unpack.stdout.destroy(); unpack.stderr.destroy(); }
  return { version: tools.electron.version, archiveSha256: checksum };
}
