import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {join} from 'node:path';

export function validatePreparationLimits(value, pid) {
  assert.deepEqual(Object.keys(value).sort(), ['affinity', 'pid', 'priority']);
  assert(Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff);
  assert.equal(value.pid, pid);
  assert.equal(value.affinity, 1);
  assert.equal(value.priority, 'BelowNormal');
  return value;
}

export function verifyPreparationLimits() {
  assert.equal(process.platform, 'win32');
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Query only this driver's process. No setting or model operation is performed.
  const command = `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${process.pid}); $p.Refresh(); @{pid=$p.Id; affinity=$p.ProcessorAffinity.ToInt64(); priority=$p.PriorityClass.ToString()} | ConvertTo-Json -Compress`;
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096
  });
  const value = validatePreparationLimits(JSON.parse(output.trim()), process.pid);
  assert.equal(availableParallelism(), 1);
  return {...value, availableParallelism: 1, readback: true};
}
