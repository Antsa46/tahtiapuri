param([switch]$DetachedControlDiagnostic,[switch]$DetachedCandidate,[switch]$DetachedMatrix)
$ErrorActionPreference = 'Stop'
if (([int]$DetachedControlDiagnostic.IsPresent + [int]$DetachedCandidate.IsPresent + [int]$DetachedMatrix.IsPresent) -gt 1) { throw 'Choose one native build mode.' }
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Compiler limits did not apply.' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$nativeVariant = if ($DetachedControlDiagnostic) { 'native-detached-control' } elseif ($DetachedCandidate) { 'native-detached-candidate' } elseif ($DetachedMatrix) { 'native-detached-matrix' } else { 'native' }
$creationMode = if ($DetachedControlDiagnostic) { 'detached-control-diagnostic' } elseif ($DetachedCandidate) { 'detached-normal-candidate' } elseif ($DetachedMatrix) { 'detached-matrix-candidate' } else { 'no-window-candidate' }
$outputRoot = Join-Path $projectRoot ('.artifacts/tests/isolation/node-stdio/' + $nativeVariant)
New-Item -ItemType Directory -Force -Path (Join-Path $outputRoot 'bin') | Out-Null
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
$packageJson='{"type":"module","private":true}'
$allowedText="SYNTHETIC ALLOWED`n"
function Hash-Text([string]$value) { $sha=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLowerInvariant() } finally {$sha.Dispose()} }
$pins=@('#pragma once','struct StdioPin { const wchar_t* name; const char* hash; };','inline const StdioPin stdioPins[] = {')
$pins += '{L"node.exe","' + $nodeHash + '"},'
foreach ($name in @('node-stdio-probe.mjs','node-stdio-wire.mjs')) { $pins += '{L"' + $name + '","' + (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant() + '"},' }
$pins += '{L"package.json","' + (Hash-Text $packageJson) + '"},'
$pins += '{L"allowed.txt","' + (Hash-Text $allowedText) + '"},'
$pins += '};'
[IO.File]::WriteAllText((Join-Path $outputRoot 'node-stdio-pins.h'),($pins -join "`n"),[Text.UTF8Encoding]::new($false))
$lines = @('@echo off', ('call "' + $environmentScript + '" >nul'), 'if errorlevel 1 exit /b 1')
$lines += 'set "INCLUDE=' + $sdkInclude + '\um;' + $sdkInclude + '\shared;' + $sdkInclude + '\ucrt;%INCLUDE%"'
$lines += 'set "LIB=' + $sdkLib + '\um\x64;' + $sdkLib + '\ucrt\x64;%LIB%"'
$source = Join-Path $PSScriptRoot 'native/node-stdio-host.cpp'
$binary = Join-Path $outputRoot 'bin/node-stdio-host.exe'
$object = Join-Path $outputRoot 'node-stdio-host.obj'
$diagnosticDefine = if ($DetachedControlDiagnostic) { '/DNODE_STDIO_DETACHED_DIAGNOSTIC ' } elseif ($DetachedCandidate) { '/DNODE_STDIO_DETACHED_CANDIDATE ' } elseif ($DetachedMatrix) { '/DNODE_STDIO_DETACHED_MATRIX ' } else { '' }
$lines += 'cl.exe ' + $diagnosticDefine + '/nologo /std:c++17 /EHsc /utf-8 /O2 /W4 /WX /MT /guard:cf /DUNICODE /D_UNICODE /I"' + $outputRoot + '" "' + $source + '" /Fo:"' + $object + '" /Fe:"' + $binary + '" /link /DYNAMICBASE /NXCOMPAT userenv.lib advapi32.lib ws2_32.lib bcrypt.lib OneCoreUAP.lib'
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
$entries = @()
foreach ($relative in @('tests/e2e/isolation/native/node-stdio-host.cpp','tests/e2e/isolation/native/capability-diagnostic.h','tests/e2e/isolation/native/common.h','tests/e2e/isolation/node-stdio-probe.mjs','tests/e2e/isolation/node-stdio-wire.mjs','tests/e2e/isolation/build-node-stdio.ps1','scripts/dev/toolchain.json') + @('common.h','transport-wire.h','transport-resources.h','isolated-launcher.h','owner-input.h' | ForEach-Object { 'packages/windows-runtime/native/' + $_ }) + @(('.artifacts/tests/isolation/node-stdio/' + $nativeVariant + '/bin/node-stdio-host.exe'),('.artifacts/tests/isolation/node-stdio/' + $nativeVariant + '/node-stdio-pins.h'))) {
 $entries += @{path=$relative;sha256=(Get-FileHash -LiteralPath (Join-Path $projectRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant()}
}
[IO.File]::WriteAllText((Join-Path $outputRoot 'build-manifest.json'), (@{schema=1; creationMode=$creationMode; affinity=1; priority='BelowNormal'; files=$entries; nodeSha256=$nodeHash; archiveSha256=$tools.node.sha256; packageJson=$packageJson; allowedText=$allowedText} | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Write-Output 'Synthetic Node stdio broker compiled with one processor; no worker was launched.'
