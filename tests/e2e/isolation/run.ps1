param([switch]$SkipBuild, [ValidateSet("native", "electron", "sdk", "sdk-lpac", "pipe", "network", "etw", "etw-lpac", "etw-lpac-socket", "startup", "resources", "registry", "registry-read", "startup-registry-read")][string]$Probe = "native", [ValidateSet("electron", "official", "local-unpatched", "local-patched")][string]$SdkRuntime = "electron", [ValidateSet("normal", "error", "launcher-kill", "owner-kill")][string]$EtwCase = "normal")
$ErrorActionPreference = 'Stop'
if ($Probe -notin @('etw','etw-lpac','etw-lpac-socket') -and $EtwCase -ne 'normal') { throw 'EtwCase applies only to the ETW probe.' }
if ($Probe -notin @('sdk','sdk-lpac') -and $SdkRuntime -ne 'electron') { throw 'SdkRuntime applies only to the SDK probe.' }
if ($Probe -eq 'sdk-lpac' -and $SdkRuntime -ne 'local-patched') { throw 'The named SDK candidate requires the existing local-patched runtime.' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
if (!$SkipBuild) {
  $build = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'build.ps1') + '"') -NoNewWindow -PassThru
  $null=$build.Handle; $build.WaitForExit(); $build.Refresh()
  if ($build.ExitCode -ne 0) { throw 'Synthetic native probe build failed.' }
}
$tools = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev/toolchain.json') -Raw | ConvertFrom-Json
$node = Join-Path $projectRoot ('.local/toolchain/node-v' + $tools.node.version + '-win-x64/node.exe')
if (!(Test-Path -LiteralPath $node)) { throw 'The existing pinned project Node runtime is required. Nothing was installed.' }
$entry = if ($Probe -in @('resources','registry','registry-read')) { 'run-resources.mjs' } elseif ($Probe -in @('startup','startup-registry-read')) { 'run-startup.mjs' } elseif ($Probe -eq 'pipe') { 'run-pipe.mjs' } elseif ($Probe -in @('sdk','sdk-lpac')) { 'run-sdk.mjs' } elseif ($Probe -eq 'electron') { 'run-electron.mjs' } else { 'run-synthetic.mjs' }
$nodeArguments = '"' + (Join-Path $PSScriptRoot $entry) + '"'
if ($Probe -in @('registry-read','startup-registry-read')) { $nodeArguments += ' registry-read' }
if ($Probe -eq 'registry') { $nodeArguments += ' registry' }
if ($Probe -in @('sdk','sdk-lpac')) { $nodeArguments += ' ' + $SdkRuntime }
if ($Probe -eq 'sdk-lpac') { $nodeArguments += ' lpac-registry-read' }
if ($Probe -eq 'network') { $nodeArguments += ' observe-network' }
if ($Probe -eq 'etw') { $nodeArguments += ' observe-etw ' + $EtwCase }
if ($Probe -eq 'etw-lpac') { $nodeArguments += ' observe-etw-lpac ' + $EtwCase }
if ($Probe -eq 'etw-lpac-socket') { $nodeArguments += ' observe-etw-lpac-socket ' + $EtwCase }
$run = Start-Process -FilePath $node -ArgumentList $nodeArguments -WorkingDirectory $projectRoot -NoNewWindow -PassThru
$null=$run.Handle; $run.WaitForExit(); $run.Refresh()
if ($run.ExitCode -ne 0) { throw 'Synthetic isolation probe failed. Read the ignored local artifacts.' }
