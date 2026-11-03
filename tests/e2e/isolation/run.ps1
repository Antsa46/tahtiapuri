param([switch]$SkipBuild, [ValidateSet("native", "electron")][string]$Probe = "native")
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if (!$SkipBuild) {
  $build = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'build.ps1') + '"') -NoNewWindow -Wait -PassThru
  if ($build.ExitCode -ne 0) { throw 'Synthetic native probe build failed.' }
}
$tools = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev/toolchain.json') -Raw | ConvertFrom-Json
$node = Join-Path $projectRoot ('.local/toolchain/node-v' + $tools.node.version + '-win-x64/node.exe')
if (!(Test-Path -LiteralPath $node)) { throw 'The existing pinned project Node runtime is required. Nothing was installed.' }
$entry = if ($Probe -eq 'electron') { 'run-electron.mjs' } else { 'run-synthetic.mjs' }
$run = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $PSScriptRoot $entry) + '"') -WorkingDirectory $projectRoot -NoNewWindow -Wait -PassThru
if ($run.ExitCode -ne 0) { throw 'Synthetic isolation probe failed. Read the ignored local artifacts.' }
