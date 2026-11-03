$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$outputRoot = Join-Path $projectRoot '.artifacts/tests/isolation/native'
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
$lines = @('@echo off', ('call "' + $environmentScript + '" >nul'), 'if errorlevel 1 exit /b 1')
$lines += 'set "INCLUDE=' + $sdkInclude + '\um;' + $sdkInclude + '\shared;' + $sdkInclude + '\ucrt;%INCLUDE%"'
$lines += 'set "LIB=' + $sdkLib + '\um\x64;' + $sdkLib + '\ucrt\x64;%LIB%"'
foreach ($name in @('host', 'probe', 'pipe-probe')) {
  $source = Join-Path $PSScriptRoot "native/$name.cpp"
  $binary = Join-Path $outputRoot "bin/$name.exe"
  $object = Join-Path $outputRoot "$name.obj"
  $lines += 'cl.exe /nologo /std:c++17 /EHsc /utf-8 /O2 /W4 /WX /MT /guard:cf /DUNICODE /D_UNICODE "' + $source + '" /Fo:"' + $object + '" /Fe:"' + $binary + '" /link /DYNAMICBASE /NXCOMPAT userenv.lib advapi32.lib ws2_32.lib user32.lib'
  $lines += 'if errorlevel 1 exit /b 1'
}
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
Write-Output 'Synthetic native probes compiled; no AppContainer was launched.'
