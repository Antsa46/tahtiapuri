# Windows bootstrap tests. Only fresh synthetic fixture ACLs change; no model, profiles, network or persistent services.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Test process limits not applied.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$out = Join-Path $root ('.artifacts/tests/native-mcp-bootstrap/run-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($out) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
function Run-Bounded([string]$File, [string]$Arguments, [string]$Name, [int]$Timeout) {
  $args = @{ FilePath = $File; WorkingDirectory = $out; NoNewWindow = $true; PassThru = $true;
    RedirectStandardOutput = (Join-Path $out ($Name + '.stdout.txt')); RedirectStandardError = (Join-Path $out ($Name + '.stderr.txt')) }
  if ($Name -eq 'test') { $args.WorkingDirectory = $root }
  if ($Arguments) { $args.ArgumentList = $Arguments }
  $p = Start-Process @args; $null = $p.Handle
  if (!$p.WaitForExit($Timeout)) {
    # A trusted compiler test only: this is a bounded tree-termination attempt,
    # not Job containment or independent proof that every descendant exited.
    $p.Refresh()
    $cleanup = [ordered]@{ deadline = $Name; rootAlreadyExited = $p.HasExited; taskkillExitCode = $null; rootExited = $false; descendantsVerified = $false }
    if (!$p.HasExited) {
      $killer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/taskkill.exe') -ArgumentList ('/PID ' + $p.Id + ' /T /F') -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $out 'cleanup.stdout.txt') -RedirectStandardError (Join-Path $out 'cleanup.stderr.txt')
      $null = $killer.Handle
      if (!$killer.WaitForExit(3000)) { $killer.Kill(); $null = $killer.WaitForExit(1000) }
      if ($killer.HasExited) { $killer.WaitForExit(); $killer.Refresh(); $cleanup.taskkillExitCode = $killer.ExitCode }
    }
    $cleanup.rootExited = $p.WaitForExit(3000)
    [IO.File]::WriteAllText((Join-Path $out 'cleanup-uncertain.json'), ($cleanup | ConvertTo-Json) + "`n", $utf8)
    throw ($Name + ' deadline exceeded; descendant cleanup is not independently verified. No success receipt. Logs: ' + $out)
  }
  $p.WaitForExit(); $p.Refresh()
  if ($null -eq $p.ExitCode -or $p.ExitCode -ne 0) { throw ($Name + ' failed. Preserved logs: ' + $out) }
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
Run-Bounded $vswhere '-utf8 -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath' 'vswhere' 10000
$installation = [IO.File]::ReadAllText((Join-Path $out 'vswhere.stdout.txt'), $utf8).Trim()
if (!$installation -or $installation.Contains("`n") -or $installation.Contains("`r")) { throw 'One C++ toolchain location required.' }
$vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { $_.Name -match '^10\.[0-9]+\.[0-9]+\.[0-9]+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'um/Windows.h')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$sdkVersion) { throw 'Existing Windows SDK required; nothing is installed.' }
$sdkInclude = Join-Path $sdkRoot ('Include/' + $sdkVersion.Name)
$sdkLib = Join-Path $sdkRoot ('Lib/' + $sdkVersion.Name)
foreach ($name in @('CL','_CL_','LINK','_LINK_','INCLUDE','LIB','LIBPATH')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
$source = Join-Path $PSScriptRoot 'native-bootstrap-probe.cpp'
$binary = Join-Path $out 'native-bootstrap-probe.exe'
$object = Join-Path $out 'native-bootstrap-probe.obj'
$identitySource = Join-Path $root 'apps/mcp/native/main-identity.cpp'
$identityBinary = Join-Path $out 'main-identity.exe'
$identityObject = Join-Path $out 'main-identity.obj'
$node = Join-Path $root '.local/toolchain/node-v24.22.2-win-x64/node.exe'
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9') { throw 'Pinned Node differs.' }
$wrapper = Join-Path $out 'build.cmd'
foreach ($path in @($root, $out, $vcvars, $source, $binary, $object, $wrapper, $sdkInclude, $sdkLib, $identitySource, $identityBinary, $identityObject, $node)) {
  if ($path -match '[%"\r\n!^&|<>]') { throw 'Unsupported build path.' }
}
$inputs = @('apps/mcp/native/main-bootstrap.h','apps/mcp/native/main-peer.h','packages/windows-runtime/native/common.h',
  'apps/mcp/native/bootstrap-file.h','apps/mcp/native/main-identity.cpp',
  'tests/integration/mcp/native-bootstrap-probe.cpp','tests/integration/mcp/run-native-bootstrap.ps1',
  'tests/integration/mcp/native-bootstrap.integration.test.ts','apps/desktop/src/main/native-main-identity.ts',
  'apps/desktop/src/main/native-development-bootstrap.ts','apps/desktop/src/main/private-directory.ts','apps/desktop/src/main/child-environment.ts')
$before = @{}
foreach ($path in $inputs) { $before[$path] = (Get-FileHash -LiteralPath (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant() }
$body = @('@echo off', ('call "' + $vcvars + '" > nul'), 'if errorlevel 1 exit /b 1',
  ('set "INCLUDE=' + $sdkInclude + '\um;' + $sdkInclude + '\shared;' + $sdkInclude + '\ucrt;%INCLUDE%"'),
  ('set "LIB=' + $sdkLib + '\um\x64;' + $sdkLib + '\ucrt\x64;%LIB%"'),
  ('"%SystemRoot%\System32\where.exe" cl.exe > "' + (Join-Path $out 'compiler-path.txt') + '"'), 'if errorlevel 1 exit /b 1',
  ('cl.exe /nologo /std:c++17 /EHsc /utf-8 /O2 /W4 /WX /MT /guard:cf "' + $source + '" /Fo:"' + $object + '" /Fe:"' + $binary + '" /link /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT bcrypt.lib advapi32.lib'), 'if errorlevel 1 exit /b 1',
  ('cl.exe /nologo /std:c++17 /EHsc /utf-8 /O2 /W4 /WX /MT /guard:cf "' + $identitySource + '" /Fo:"' + $identityObject + '" /Fe:"' + $identityBinary + '" /link /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT advapi32.lib'), 'exit /b %errorlevel%') -join "`r`n"
[IO.File]::WriteAllText($wrapper, $body + "`r`n", $utf8)
$launch = Join-Path $out 'launch.cmd'
[IO.File]::WriteAllText($launch, ('@echo off' + "`r`n%SystemRoot%\System32\chcp.com 65001 >nul`r`ncall " + '"' + $wrapper + '"' + "`r`nexit /b %errorlevel%`r`n"), $utf8)
Run-Bounded (Join-Path $env:SystemRoot 'System32/cmd.exe') ('/d /s /c ""' + $launch + '""') 'build' 60000
foreach ($path in $inputs) { if ((Get-FileHash -LiteralPath (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before[$path]) { throw 'Source changed during build.' } }
$env:TAHTIAPURI_NATIVE_BOOTSTRAP_PROBE = $binary
$env:TAHTIAPURI_NATIVE_IDENTITY_HELPER = $identityBinary
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
$vitest = Join-Path $root 'node_modules/vitest/vitest.mjs'
$report = Join-Path $out 'tests.json'
# Vitest must resolve the repository configuration; Run-Bounded supplies a fixed build cwd.
Run-Bounded $node ('--max-old-space-size=384 "' + $vitest + '" run --root "' + $root + '" tests/integration/mcp/native-bootstrap.integration.test.ts --maxWorkers=1 --no-file-parallelism --testTimeout=30000 --outputFile="' + $report + '"') 'test' 120000
$result = [IO.File]::ReadAllText($report, $utf8) | ConvertFrom-Json
if ($result.numPassedTests -ne 22 -or $result.numFailedTests -ne 0 -or $result.numPendingTests -ne 0) { throw 'Native bootstrap test result incomplete.' }
foreach ($path in $inputs) { if ((Get-FileHash -LiteralPath (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before[$path]) { throw 'Source changed during tests.' } }
$compiler = [IO.File]::ReadAllLines((Join-Path $out 'compiler-path.txt'), $utf8)[0]
$receipt = @{ source = $before; probeSha256 = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();
  identityHelperSha256 = (Get-FileHash -LiteralPath $identityBinary -Algorithm SHA256).Hash.ToLowerInvariant();
  compiler = $compiler; compilerSha256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant();
  passed = $result.numPassedTests; failed = $result.numFailedTests; pending = $result.numPendingTests }
[IO.File]::WriteAllText((Join-Path $out 'receipt.json'), ($receipt | ConvertTo-Json -Depth 6) + "`n", $utf8)
Write-Output $out
Write-Output ('Passed native bootstrap tests: ' + $result.numPassedTests)
