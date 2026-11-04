param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
# This is a short-lived development launcher, never the interactive shell.
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) {
  throw 'Preparation launcher limits did not apply. No experiment was started.'
}
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$tools = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev/toolchain.json') -Raw | ConvertFrom-Json
$node = Join-Path $projectRoot ('.local/toolchain/node-v' + $tools.node.version + '-win-x64/node.exe')
if (!(Test-Path -LiteralPath $node)) { throw 'The existing pinned Node runtime is required.' }
$arguments = '"' + (Join-Path $PSScriptRoot 'run-model.mjs') + '"'
if ($CheckOnly) { $arguments += ' --check-limits' }
$child = $null
try {
  $child = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -NoNewWindow -PassThru
  $null = $child.Handle
  $child.WaitForExit()
  $child.Refresh()
  if ($child.ExitCode -ne 0) { throw 'Bounded model experiment failed; read the retained local evidence.' }
} finally {
  if ($null -ne $child) {
    $child.Refresh()
    if (!$child.HasExited) {
      $child.Kill()
      if (!$child.WaitForExit(5000)) { throw 'Owned preparation driver did not stop.' }
    }
    $child.Dispose()
  }
}
