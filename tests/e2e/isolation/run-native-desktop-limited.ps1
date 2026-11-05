param([switch]$PrepareOnly,[switch]$QueueOnly)
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
function Invoke-NodeStep([string[]]$Step) {
  $quoted = ($Step | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $process = Start-Process -FilePath $node -ArgumentList $quoted -WorkingDirectory $projectRoot -NoNewWindow -PassThru
  try {
    $null = $process.Handle; $process.WaitForExit(); $process.Refresh()
    if ($process.ExitCode -ne 0) { throw ('Native desktop preparation failed: ' + $Step[0]) }
  } finally { $process.Dispose() }
}
Invoke-NodeStep @('node_modules/typescript/bin/tsc','-b')
Invoke-NodeStep @('node_modules/typescript/bin/tsc','-p','tests/e2e/tsconfig.json')
Invoke-NodeStep @('node_modules/vite/bin/vite.js','build','--config','apps/web/vite.config.ts')
if ($PrepareOnly) { exit 0 }
$arguments = '"' + (Join-Path $projectRoot 'node_modules/@playwright/test/cli.js') + '" test --config playwright.native-model.config.ts'
$priorNativeRun = $env:TAHTIAPURI_NATIVE_E2E_RUN
$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path $projectRoot ('.artifacts/tests/native-desktop/runs/' + $runId)
if (Test-Path -LiteralPath $runRoot) { throw 'Native desktop run root must be fresh.' }
New-Item -ItemType Directory -Path $runRoot | Out-Null
$env:TAHTIAPURI_NATIVE_E2E_RUN = $runId
if ($QueueOnly) { $arguments += ' --grep "share the native queue"' }
Write-Output ('Native desktop report: ' + (Join-Path $runRoot 'report.json'))
$child = $null
try {
  $child = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $projectRoot -NoNewWindow -PassThru
  $null = $child.Handle
  if (!$child.WaitForExit(550000)) { $child.Kill(); throw "Owned native desktop experiment exceeded its deadline." }
  $child.Refresh()
  if ($child.ExitCode -ne 0) { throw 'Transport experiment failed; read retained private evidence.' }
} finally {
  $env:TAHTIAPURI_NATIVE_E2E_RUN = $priorNativeRun
  if ($null -ne $child) {
    $child.Refresh()
    if (!$child.HasExited) { $child.Kill(); if (!$child.WaitForExit(5000)) { throw 'Owned driver did not stop.' } }
    $child.Dispose()
  }
}
