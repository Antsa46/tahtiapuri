$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Compiler limits did not apply.' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$outputRoot = Join-Path $projectRoot '.artifacts/tests/isolation/backend-probe/native'
if (Test-Path -LiteralPath $outputRoot) {
  # Preserve earlier builds, including failed diagnostics, before rebuilding.
  Move-Item -LiteralPath $outputRoot -Destination ($outputRoot + '-prior-' + [Guid]::NewGuid().ToString('N'))
}
New-Item -ItemType Directory -Path (Join-Path $outputRoot 'bin') | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'Existing Visual Studio C++ Build Tools are required. Nothing was installed.' }
$discovery = Join-Path $outputRoot 'vswhere.txt'
$p = Start-Process -FilePath $vswhere -ArgumentList '-latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath' -RedirectStandardOutput $discovery -NoNewWindow -PassThru -Wait
if ($p.ExitCode -ne 0) { throw 'Compiler discovery failed.' }
$installation = (Get-Content -LiteralPath $discovery -Raw).Trim()
$environmentScript = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
if (!(Test-Path -LiteralPath $environmentScript)) { throw 'Existing x64 compiler environment was not found.' }
foreach ($path in @($environmentScript, $projectRoot, $outputRoot)) {
  if ($path -match '[%"\r\n!^&|<>]') { throw 'Unsupported character in build path.' }
}
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um/Windows.h') } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$sdkVersion) { throw 'An existing Windows 10+ SDK is required.' }
$sdkInclude = Join-Path $sdkRoot ('Include/' + $sdkVersion.Name)
$sdkLib = Join-Path $sdkRoot ('Lib/' + $sdkVersion.Name)
foreach ($required in @('um/x64/kernel32.lib', 'ucrt/x64/ucrt.lib')) {
  if (!(Test-Path -LiteralPath (Join-Path $sdkLib $required))) { throw 'Existing SDK x64 libraries are incomplete.' }
}
$tools = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts/dev/toolchain.json') -Raw | ConvertFrom-Json
$archive = Join-Path $projectRoot ('.local/cache/downloads/' + $tools.node.archive)
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $tools.node.sha256) { throw 'Existing official archive hash mismatch.' }
$node = Join-Path $projectRoot ('.local/toolchain/node-v' + $tools.node.version + '-win-x64/node.exe')
$nodeHash = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
 $entry = $zip.GetEntry('node-v' + $tools.node.version + '-win-x64/node.exe')
 if (!$entry) { throw 'Official Node entry missing.' }
 $stream=$entry.Open(); $sha=[Security.Cryptography.SHA256]::Create()
 try { $archivedHash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally {$stream.Dispose();$sha.Dispose()}
 if ($archivedHash -ne $nodeHash) { throw 'Existing node.exe differs from locked archive.' }
} finally {$zip.Dispose()}

$resourcesFile=Join-Path $outputRoot 'resources-manifest.json'
$prepareStdout=Join-Path $outputRoot 'prepare.stdout.txt'
$prepareStderr=Join-Path $outputRoot 'prepare.stderr.txt'
$prepareArguments='"' + (Join-Path $PSScriptRoot 'run-backend-probe.mjs') + '" --prepare-pins "' + $resourcesFile + '"'
$p=Start-Process -FilePath $node -ArgumentList $prepareArguments -WorkingDirectory $projectRoot -RedirectStandardOutput $prepareStdout -RedirectStandardError $prepareStderr -NoNewWindow -PassThru
$null=$p.Handle
$p.WaitForExit()
$p.Refresh()
if ($p.ExitCode -ne 0) { Get-Content -LiteralPath $prepareStderr; throw 'Fixed backend resource collection failed.' }
$resources=Get-Content -LiteralPath $resourcesFile -Raw | ConvertFrom-Json
if ($resources.schema -ne 1 -or $resources.nodeSha256 -ne $nodeHash -or $resources.archiveSha256 -ne $tools.node.sha256 -or $resources.files.Count -gt 64) { throw 'Unexpected fixed backend resource manifest.' }
$pins=@('#pragma once','#include <cstdint>','struct BackendPin { const wchar_t* name; const char* hash; uint64_t bytes; };','inline const BackendPin backendPins[] = {')
$seen=@{}
foreach ($file in $resources.files) {
 if ($file.path -notmatch '^[A-Za-z0-9@_.\/-]{1,240}$' -or $file.path.Contains('..') -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or $seen.ContainsKey($file.path)) { throw 'Invalid fixed backend pin.' }
 $seen[$file.path]=$true
 if ($file.bytes -lt 0 -or $file.bytes -gt 167772160) { throw 'Invalid backend resource length.' }
 $pins += '{L"' + $file.path + '","' + $file.sha256 + '",' + [string]$file.bytes + 'ULL},'
}
$pins += '};'
[IO.File]::WriteAllText((Join-Path $outputRoot 'backend-probe-pins.h'),($pins -join "`n"),[Text.UTF8Encoding]::new($false))
$lines = @('@echo off', ('call "' + $environmentScript + '" >nul'), 'if errorlevel 1 exit /b 1')
$lines += 'set "INCLUDE=' + $sdkInclude + '\um;' + $sdkInclude + '\shared;' + $sdkInclude + '\ucrt;%INCLUDE%"'
$lines += 'set "LIB=' + $sdkLib + '\um\x64;' + $sdkLib + '\ucrt\x64;%LIB%"'
$source = Join-Path $PSScriptRoot 'native/backend-probe-host.cpp'
$binary = Join-Path $outputRoot 'bin/backend-probe-host.exe'
$object = Join-Path $outputRoot 'backend-probe-host.obj'
$lines += 'cl.exe /nologo /std:c++17 /EHsc /utf-8 /O2 /W4 /WX /MT /guard:cf /DUNICODE /D_UNICODE /I"' + $outputRoot + '" "' + $source + '" /Fo:"' + $object + '" /Fe:"' + $binary + '" /link /DYNAMICBASE /NXCOMPAT userenv.lib advapi32.lib ws2_32.lib bcrypt.lib OneCoreUAP.lib'
$lines += 'if errorlevel 1 exit /b 1'
$lines += 'exit /b 0'
$command = Join-Path $outputRoot 'build.cmd'
# cmd uses the active Windows code page; UTF-8 is selected locally for paths.
[IO.File]::WriteAllText($command, ($lines -join "`r`n"), [Text.UTF8Encoding]::new($false))
$wrapper = Join-Path $outputRoot 'launch-build.cmd'
[IO.File]::WriteAllText($wrapper, ('@echo off' + "`r`n%SystemRoot%\System32\chcp.com 65001 >nul`r`ncall " + '"' + $command + '"' + "`r`nexit /b %errorlevel%"), [Text.UTF8Encoding]::new($false))
$stdout = Join-Path $outputRoot 'build.stdout.txt'
$stderr = Join-Path $outputRoot 'build.stderr.txt'
$previousPath = $env:Path
$env:Path = "$($env:SystemRoot)\System32;$($env:SystemRoot);$previousPath"
try {
$p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/cmd.exe') -ArgumentList ('/d /s /c ""' + $wrapper + '""') -WorkingDirectory $outputRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru
# Wait for cmd itself: Start-Process -Wait also follows a persistent console host.
$null = $p.Handle
$p.WaitForExit()
$p.Refresh()
} finally { $env:Path = $previousPath }
Get-Content -LiteralPath $stdout
Get-Content -LiteralPath $stderr
if ($p.ExitCode -ne 0) { throw "Native probe compilation failed (exit $($p.ExitCode))." }

$inputs=@('tests/e2e/isolation/native/backend-probe-host.cpp','tests/e2e/isolation/native/backend-probe-resources.h','tests/e2e/isolation/native/backend-probe-wire.h','tests/e2e/isolation/native/capability-diagnostic.h','tests/e2e/isolation/native/common.h','tests/e2e/isolation/backend-worker.mjs','tests/e2e/isolation/backend-codec.mjs','tests/e2e/isolation/backend-port.mjs','tests/e2e/isolation/backend-resources.mjs','tests/e2e/isolation/run-backend-probe.mjs','tests/e2e/isolation/build-backend-probe.ps1','scripts/dev/toolchain.json')
$inputs+=@('tests/e2e/isolation/backend-lifecycle-owner.mjs','tests/e2e/isolation/backend-lifecycle-results.mjs','tests/e2e/isolation/run-backend-lifecycle-probe.mjs','tests/e2e/isolation/run-backend-lifecycle-limited.ps1')
$inputs+=@('tests/e2e/isolation/backend-adverse-contract.mjs','tests/e2e/isolation/backend-adverse-owner.mjs','tests/e2e/isolation/backend-adverse-results.mjs','tests/e2e/isolation/run-backend-adverse-probe.mjs','tests/e2e/isolation/run-backend-adverse-limited.ps1')
$inputs+=@('apps/desktop/src/main/backend-controller.ts','apps/desktop/dist/main/backend-controller.js','apps/backend/src/runtime/backend.ts','apps/backend/dist/runtime/backend.js','tests/e2e/isolation/run-backend-probe-limited.ps1')
$inputs+=@('common.h','transport-wire.h','transport-resources.h','isolated-launcher.h' | ForEach-Object { 'packages/windows-runtime/native/' + $_ })
$inputs+=@('.artifacts/tests/isolation/backend-probe/native/bin/backend-probe-host.exe','.artifacts/tests/isolation/backend-probe/native/backend-probe-pins.h','.artifacts/tests/isolation/backend-probe/native/resources-manifest.json')
$entries=@()
foreach ($relative in $inputs) { $entries+=@{path=$relative;sha256=(Get-FileHash -LiteralPath (Join-Path $projectRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant()} }
$manifest=@{schema=1;creationMode='detached-backend-probe';affinity=1;priority='BelowNormal';nodeSha256=$nodeHash;archiveSha256=$tools.node.sha256;files=$entries}
[IO.File]::WriteAllText((Join-Path $outputRoot 'build-manifest.json'),($manifest | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
Write-Output 'Synthetic backend broker compiled with one processor; no worker was launched.'
