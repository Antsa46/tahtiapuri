param([switch]$Smoke,[switch]$UnitOnly,[switch]$DetachedControlDiagnostic,[switch]$DetachedCandidate,[switch]$DetachedMatrix)
$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Node stdio launcher limits did not apply.' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tools = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev/toolchain.json') -Raw | ConvertFrom-Json
$node = Join-Path $projectRoot ('.local/toolchain/node-v' + $tools.node.version + '-win-x64/node.exe')
if (!(Test-Path -LiteralPath $node)) { throw 'Existing pinned Node runtime is required.' }
$arguments = '"' + (Join-Path $PSScriptRoot 'run-node-stdio.mjs') + '"'
if (([int]$Smoke.IsPresent + [int]$UnitOnly.IsPresent + [int]$DetachedControlDiagnostic.IsPresent + [int]$DetachedCandidate.IsPresent + [int]$DetachedMatrix.IsPresent) -gt 1) { throw 'Choose one probe mode.' }
if ($Smoke) { $arguments += ' --smoke' }
if ($DetachedControlDiagnostic) { $arguments += ' --detached-control-only' }
if ($DetachedCandidate) { $arguments += ' --detached-candidate-smoke' }
if ($DetachedMatrix) { $arguments += ' --detached-matrix' }
if ($UnitOnly) { $arguments = '--test --test-concurrency=1 "' + (Join-Path $PSScriptRoot 'node-stdio-wire.test.mjs') + '" "' + (Join-Path $PSScriptRoot 'node-stdio-probe.test.mjs') + '" "' + (Join-Path $PSScriptRoot 'node-stdio-results.test.mjs') + '"' }
$child = $null
try {
  $child = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -NoNewWindow -PassThru
  $null = $child.Handle
  $child.WaitForExit()
  $child.Refresh()
  if ($child.ExitCode -ne 0) { throw 'Node stdio experiment failed; read retained private evidence.' }
} finally {
  if ($null -ne $child) {
    $child.Refresh()
    if (!$child.HasExited) { $child.Kill(); if (!$child.WaitForExit(5000)) { throw 'Owned driver did not stop.' } }
    $child.Dispose()
  }
}
