$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Compiler limits did not apply.' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$outputRoot = Join-Path $projectRoot '.artifacts/tests/isolation/native-model/native'
function Assert-OwnedPath($Path,[bool]$Directory) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ne $projectRoot -and !$full.StartsWith($projectRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Build path escaped project.' }
  $here = $full; $leaf = $true
  while ($here.Length -ge $projectRoot.Length) {
    if (Test-Path -LiteralPath $here) {
      $item = Get-Item -LiteralPath $here -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($leaf -and $item.PSIsContainer -ne $Directory) -or (!$leaf -and !$item.PSIsContainer)) { throw 'Build path is redirected or has unexpected type.' }
    }
    if ($here -eq $projectRoot) { return }; $leaf = $false; $here = Split-Path -Parent $here
  }
  throw 'Build root was not reached.'
}
function Write-Owned($Path,[byte[]]$Bytes) {
  Assert-OwnedPath $Path $false
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temporary = Join-Path $parent ('.stage-' + [Guid]::NewGuid().ToString('N'))
  $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($Bytes,0,$Bytes.Length) } finally { $stream.Dispose() }
  Assert-OwnedPath $Path $false
  # Replace the directory entry rather than modifying an existing hardlink's contents.
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary,$Path) }
}
$workRoot = Join-Path $outputRoot ('runs/' + [Guid]::NewGuid().ToString('N'))
Assert-OwnedPath $workRoot $true
if (Test-Path -LiteralPath $workRoot) { throw 'Build directory must be fresh.' }
New-Item -ItemType Directory -Force -Path (Join-Path $workRoot 'bin') | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw 'Existing Visual Studio C++ Build Tools are required. Nothing was installed.' }
$discovery = Join-Path $workRoot 'vswhere.txt'
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
$runtime = Join-Path $projectRoot '.local/native/llama-v0.9.0-source-cpu'
$receiptPath = Join-Path $projectRoot '.artifacts/tests/isolation/native-source-runtime/runtime-manifest.json'
$profilePath = Join-Path $projectRoot 'resources/runtimes/llama-cpp-source-cpu.json'
$manifest = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
$profile = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.id -ne 'llama-cpp-v0.9.0-source-cpu' -or $manifest.revision -ne $profile.revision -or
    $manifest.backend -ne 'ggml-cpu.dll' -or !$manifest.sourceVerifiedBeforeAndAfter) { throw 'Unexpected source-built CPU runtime.' }
foreach ($check in @(@{path=$profilePath;hash=$manifest.sourceProfileSha256},
  @{path=(Join-Path $PSScriptRoot 'build-native-runtime.ps1');hash=$manifest.recipeSha256},
  @{path=(Join-Path $PSScriptRoot 'prepare-native-runtime.ps1');hash=$manifest.prepareSha256})) {
  if ((Get-FileHash -LiteralPath $check.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $check.hash) { throw 'Runtime build recipe differs.' }
}
$dlls = @('ggml-base.dll','ggml.dll','llama.dll','ggml-cpu.dll')
$headers = @('ggml.h','gguf.h','ggml-opt.h','ggml-backend.h','ggml-alloc.h','ggml-cpu.h','llama.h')
$expected = @($dlls | ForEach-Object { 'bin/' + $_ }) + @($headers | ForEach-Object { 'include/' + $_ }) + @('licenses/LICENSE-llama.cpp')
if (($profile.dlls -join ',') -ne ($dlls -join ',') -or
    (Compare-Object ($expected | Sort-Object) ($manifest.files.PSObject.Properties.Name | Sort-Object))) { throw 'Unexpected runtime file closure.' }
$pins = @('#pragma once','namespace native_model {','struct RuntimePin { const wchar_t* name; const char* hash; };','constexpr RuntimePin runtimePins[] = {')
foreach ($entry in $manifest.files.PSObject.Properties) {
  if ($entry.Value.sha256 -notmatch '^[0-9a-f]{64}$' -or $entry.Value.bytes -le 0 -or $entry.Value.bytes -gt 16MB) { throw 'Invalid runtime identity.' }
  $path = Join-Path $runtime $entry.Name
  Assert-OwnedPath $path $false
  if ((Get-Item -LiteralPath $path).Length -ne $entry.Value.bytes -or
      (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value.sha256) { throw 'Pinned runtime file differs.' }
  if (!$entry.Name.StartsWith('bin/') -and $entry.Value.sha256 -ne $profile.headersAndLicense.($entry.Name).sha256) { throw 'Runtime ABI header differs.' }
}
foreach ($name in $dlls) {
  $pin = $manifest.files.('bin/' + $name)
  if (!$pin.resourceDirectoryAbsent) { throw 'Manifest-free library check is missing.' }
  $pins += '{L"' + $name + '","' + $pin.sha256 + '"},'
}
$pins += '};'; $pins += '}'
Write-Owned (Join-Path $outputRoot 'native-model-runtime-pins.h') ([Text.UTF8Encoding]::new($false).GetBytes(($pins -join "`n")))
$sourcePaths = @('common.h','isolated-launcher.h','transport-wire.h','transport-resources.h','native-model-protocol.h','native-model-pins.h','native-model-fixture.h','native-model-engine.h','native-model-host.cpp','native-model-worker.cpp') | ForEach-Object { 'tests/e2e/isolation/native/' + $_ }
$sourcePaths += @('common.h','transport-wire.h','transport-resources.h','isolated-launcher.h') | ForEach-Object { 'packages/windows-runtime/native/' + $_ }
$sourcePaths += @('.artifacts/tests/isolation/native-source-runtime/runtime-manifest.json','resources/runtimes/llama-cpp-source-cpu.json','resources/models/qwen3-4b.json','tests/fixtures/native-cpu-prompt.json','tests/e2e/isolation/build-native-model.ps1','tests/e2e/isolation/build-native-runtime.ps1','tests/e2e/isolation/prepare-native-runtime.ps1','.artifacts/tests/isolation/native-model/native/native-model-runtime-pins.h')
$inputHashes = @{}
foreach ($relative in $sourcePaths) {
  $path = Join-Path $projectRoot $relative
  Assert-OwnedPath $path $false
  $inputHashes[$relative] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$lines = @('@echo off', ('call "' + $environmentScript + '" >nul'), 'if errorlevel 1 exit /b 1')
$lines += 'set "INCLUDE=' + $sdkInclude + '\um;' + $sdkInclude + '\shared;' + $sdkInclude + '\ucrt;%INCLUDE%"'
$lines += 'set "LIB=' + $sdkLib + '\um\x64;' + $sdkLib + '\ucrt\x64;%LIB%"'
foreach ($name in @('native-model-host', 'native-model-worker')) {
  $source = Join-Path $PSScriptRoot "native/$name.cpp"
  $binary = Join-Path $workRoot "bin/$name.exe"
  $object = Join-Path $workRoot "$name.obj"
  $lines += 'cl.exe /nologo /std:c++17 /EHsc /utf-8 /O2 /W4 /WX /MT /guard:cf /DUNICODE /D_UNICODE /I"' + $outputRoot + '" /I"' + (Join-Path $runtime 'include') + '" "' + $source + '" /Fo:"' + $object + '" /Fe:"' + $binary + '" /link /DYNAMICBASE /NXCOMPAT userenv.lib advapi32.lib ws2_32.lib bcrypt.lib'
  $lines += 'if errorlevel 1 exit /b 1'
}
$lines += 'exit /b 0'
$command = Join-Path $workRoot 'build.cmd'
# cmd uses the active Windows code page; UTF-8 is selected locally for paths.
[IO.File]::WriteAllText($command, ($lines -join "`r`n"), [Text.UTF8Encoding]::new($false))
$wrapper = Join-Path $workRoot 'launch-build.cmd'
[IO.File]::WriteAllText($wrapper, ('@echo off' + "`r`n%SystemRoot%\System32\chcp.com 65001 >nul`r`ncall " + '"' + $command + '"' + "`r`nexit /b %errorlevel%"), [Text.UTF8Encoding]::new($false))
$stdout = Join-Path $workRoot 'build.stdout.txt'
$stderr = Join-Path $workRoot 'build.stderr.txt'
$previousPath = $env:Path
$env:Path = "$($env:SystemRoot)\System32;$($env:SystemRoot);$previousPath"
try {
$p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/cmd.exe') -ArgumentList ('/d /s /c ""' + $wrapper + '""') -WorkingDirectory $workRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru
# Wait for cmd itself: Start-Process -Wait also follows a persistent console host.
$null = $p.Handle
$p.WaitForExit()
$p.Refresh()
} finally { $env:Path = $previousPath }
Get-Content -LiteralPath $stdout
Get-Content -LiteralPath $stderr
if ($p.ExitCode -ne 0) { throw "Native probe compilation failed (exit $($p.ExitCode))." }
$entries = @()
foreach ($relative in $sourcePaths) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $projectRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $inputHashes[$relative]) { throw 'Wrapper inputs changed during compilation.' }
  $entries += @{path=$relative;sha256=$actual}
}
$runtimeEntries = @()
foreach ($entry in $manifest.files.PSObject.Properties) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $runtime $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.Value.sha256) { throw 'Runtime inputs changed during compilation.' }
  $runtimeEntries += @{path=$entry.Name;sha256=$actual}
}
foreach ($name in @('native-model-host','native-model-worker')) {
  $relative = '.artifacts/tests/isolation/native-model/native/bin/' + $name + '.exe'
  Write-Owned (Join-Path $projectRoot $relative) ([IO.File]::ReadAllBytes((Join-Path $workRoot ('bin/' + $name + '.exe'))))
  $entries += @{path=$relative; sha256=(Get-FileHash -LiteralPath (Join-Path $projectRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant()}
}
Write-Owned (Join-Path $outputRoot 'build-manifest.json') ([Text.UTF8Encoding]::new($false).GetBytes((@{schema=1; affinity=1; priority='BelowNormal'; sdk=$sdkVersion.Name; files=$entries; runtimeFiles=$runtimeEntries} | ConvertTo-Json -Depth 5)))
Write-Output 'Native CPU model probe compiled with one processor; no model was loaded.'
