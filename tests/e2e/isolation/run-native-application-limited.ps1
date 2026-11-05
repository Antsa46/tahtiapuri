param([switch]$CancelOnComputing)
$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Transport launcher limits did not apply.' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tools = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev/toolchain.json') -Raw | ConvertFrom-Json
$node = Join-Path $projectRoot ('.local/toolchain/node-v' + $tools.node.version + '-win-x64/node.exe')
if (!(Test-Path -LiteralPath $node)) { throw 'Existing pinned Node runtime is required.' }
$arguments = '"' + (Join-Path $PSScriptRoot 'run-native-application.mjs') + '"'
if ($CancelOnComputing) { $arguments += ' --cancel-on-computing' }
$child = $null
try {
  $child = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -NoNewWindow -PassThru
  $null = $child.Handle
  if (!$child.WaitForExit(250000)) { $child.Kill(); throw "Owned native application experiment exceeded its deadline." }
  $child.Refresh()
  if ($child.ExitCode -ne 0) { throw 'Transport experiment failed; read retained private evidence.' }
} finally {
  if ($null -ne $child) {
    $child.Refresh()
    if (!$child.HasExited) { $child.Kill(); if (!$child.WaitForExit(5000)) { throw 'Owned driver did not stop.' } }
    $child.Dispose()
  }
}
