# Source-only recipe. Running this script builds private artifacts; it never selects a runtime.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$self = [Diagnostics.Process]::GetCurrentProcess()
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal
$self.ProcessorAffinity = [IntPtr]1
$self.Refresh()
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Build process limits did not apply.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$buildRoot = Join-Path $projectRoot ('.artifacts/native/backend-runtime/builds/build-' + [Guid]::NewGuid().ToString('N'))

function Assert-CanonicalPath([string]$Path, [bool]$Directory, [bool]$AllowMissing = $false) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full.StartsWith('\\') -or $full -match '[%"\r\n!^&|<>]') { throw 'Unsupported build path.' }
  $current = $full; $leaf = $true
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($leaf -and $item.PSIsContainer -ne $Directory) -or (!$leaf -and !$item.PSIsContainer)) { throw 'Redirected build path or incorrect file type.' }
      if ([IO.Path]::GetFullPath($item.FullName) -cne $current) { throw 'Noncanonical build path.' }
    } elseif (!$AllowMissing -or !$leaf) { throw 'Required build path is missing.' }
    $parent = [IO.Path]::GetDirectoryName($current)
    if (!$parent -or $parent -eq $current) { break }
    $current = $parent; $leaf = $false
  }
}
function Assert-PrivateOutput([string]$Path, [bool]$Directory, [bool]$AllowMissing = $false) {
  $full = [IO.Path]::GetFullPath($Path)
  if ($full -ne $buildRoot -and !$full.StartsWith($buildRoot + '\', [StringComparison]::Ordinal)) { throw 'Output escaped the fresh build root.' }
  Assert-CanonicalPath $full $Directory $AllowMissing
}
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Assert-BuildRootPolicy {
  Assert-CanonicalPath $buildRoot $true
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $actual = [IO.Directory]::GetAccessControl($buildRoot, $sections)
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $ownerSid.Value -or !$actual.AreAccessRulesProtected) { throw 'Build root owner or protected DACL differs.' }
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { throw 'Build root must grant exactly owner and SYSTEM.' }
  $seen = @{}
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if (($sid -cne $ownerSid.Value -and $sid -cne $systemSid.Value) -or $seen.ContainsKey($sid) -or $rule.IsInherited -or
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Build root DACL differs from the exact owner/SYSTEM policy.' }
    $seen[$sid] = $true
  }
}
function New-ProtectedBuildRoot {
  Assert-PrivateOutput $buildRoot $true $true
  if (Test-Path -LiteralPath $buildRoot) { throw 'Build root must be fresh.' }
  if ($ownerSid.Value -ceq $systemSid.Value) { throw 'Build requires the ordinary owning user.' }
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($ownerSid); $security.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @($ownerSid, $systemSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
  }
  # Windows PowerShell/.NET Framework supplies this protected DACL at directory birth.
  # The overload may return an existing directory after a race: verify owner, exact
  # DACL and emptiness before CREATE_NEW ownership marker. Same-user/admin are trusted.
  [IO.Directory]::CreateDirectory($buildRoot, $security) | Out-Null
  Assert-BuildRootPolicy
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($buildRoot)) { throw 'New build root must be empty before ownership is claimed.' }
}
function New-PrivateDirectory([string]$Path) {
  Assert-BuildRootPolicy
  Assert-PrivateOutput $Path $true $true
  if (Test-Path -LiteralPath $Path) { throw 'Build directory must be fresh.' }
  [IO.Directory]::CreateDirectory($Path) | Out-Null
  Assert-PrivateOutput $Path $true
}
function Write-Fresh([string]$Path, [string]$Text) {
  Assert-BuildRootPolicy
  Assert-PrivateOutput $Path $false $true
  $bytes = $utf8.GetBytes($Text)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Read-Utf8([string]$Path) { return [IO.File]::ReadAllText($Path, $utf8) }
function Hash-File([string]$Path) {
  Assert-CanonicalPath $Path $false
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Invoke-Limited([string]$File, [string]$Arguments, [string]$Name, [string]$WorkingDirectory) {
  Assert-BuildRootPolicy
  $self.Refresh()
  if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::BelowNormal -or $self.ProcessorAffinity.ToInt64() -ne 1) { throw 'Build process limits changed.' }
  $stdout = Join-Path $buildRoot ('logs/' + $Name + '.stdout.txt')
  $stderr = Join-Path $buildRoot ('logs/' + $Name + '.stderr.txt')
  Assert-PrivateOutput $stdout $false $true; Assert-PrivateOutput $stderr $false $true
  if ((Test-Path -LiteralPath $stdout) -or (Test-Path -LiteralPath $stderr)) { throw 'Build logs already exist.' }
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru
  # Holding the actual process handle preserves ExitCode even for short-lived children.
  $null = $process.Handle
  $process.WaitForExit(); $process.Refresh()
  $code = $process.ExitCode
  if ($null -eq $code -or $code -ne 0) { throw ($Name + ' failed (exit ' + $code + '). Diagnostics: ' + $stderr) }
}

Assert-CanonicalPath $projectRoot $true
$artifactParent = $projectRoot
foreach ($component in @('.artifacts', 'native', 'backend-runtime', 'builds')) {
  $artifactParent = Join-Path $artifactParent $component
  if (!(Test-Path -LiteralPath $artifactParent)) {
    Assert-CanonicalPath $artifactParent $true $true
    [IO.Directory]::CreateDirectory($artifactParent) | Out-Null
  }
  Assert-CanonicalPath $artifactParent $true
}
New-ProtectedBuildRoot
Write-Fresh (Join-Path $buildRoot 'owner.marker') "TAHTIAPURI_BACKEND_BUILD_V1`n"
New-PrivateDirectory (Join-Path $buildRoot 'logs')
$toolchainPath = Join-Path $projectRoot 'scripts/dev/toolchain.json'
Assert-CanonicalPath $toolchainPath $false
$tools = (Read-Utf8 $toolchainPath) | ConvertFrom-Json
$archiveHash = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
$nodeHash = '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9'
if ($tools.node.version -ne '24.22.2' -or $tools.node.archive -ne 'node-v24.22.2-win-x64.zip' -or $tools.node.sha256 -ne $archiveHash) { throw 'Locked Node toolchain differs.' }
$node = Join-Path $projectRoot '.local/toolchain/node-v24.22.2-win-x64/node.exe'
$archive = Join-Path $projectRoot '.local/cache/downloads/node-v24.22.2-win-x64.zip'
if ((Hash-File $node) -ne $nodeHash -or (Hash-File $archive) -ne $archiveHash) { throw 'Existing pinned Node/archive failed verification.' }
$tsc = Join-Path $projectRoot 'node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/lib/tsc.js'
Assert-CanonicalPath $tsc $false
$collector = Join-Path $PSScriptRoot 'collect-backend-runtime.mjs'
Assert-CanonicalPath $collector $false

# Source snapshots cover both identities and the complete relevant path set.
function Add-SourceTree([string]$Relative, [int]$Depth = 0) {
  if ($Depth -gt 16) { throw 'Source depth limit exceeded.' }
  $full = Join-Path $projectRoot $Relative
  Assert-CanonicalPath $full $true
  foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($full)) {
    $script:sourceNodes++
    if ($script:sourceNodes -gt 1024) { throw 'Source node limit exceeded.' }
    $item = Get-Item -LiteralPath $entryPath -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected source tree.' }
    $child = $Relative + '/' + $item.Name
    if ($item.PSIsContainer) { Add-SourceTree $child ($Depth + 1) }
    elseif ($item.Name -match '\.(ts|cts|h|cpp)$' -and $item.Name -notmatch '\.test\.ts$') { $script:sourcePaths.Add($child) }
  }
}
function Get-SourcePathSet {
  $script:sourcePaths = [Collections.Generic.List[string]]::new()
  $script:sourceNodes = 0
  foreach ($path in @('scripts/native/build-backend-runtime.ps1', 'scripts/native/collect-backend-runtime.mjs', 'scripts/dev/toolchain.json',
    'package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'packages/windows-runtime/native/common.h')) { $script:sourcePaths.Add($path) }
  foreach ($area in @('apps/backend', 'packages/backend-transport', 'packages/domain', 'packages/validation')) {
    Add-SourceTree ($area + '/src')
    $script:sourcePaths.Add($area + '/package.json'); $script:sourcePaths.Add($area + '/tsconfig.json')
  }
  Add-SourceTree 'apps/backend/native'
  foreach ($path in @('node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/lib/tsc.js',
    'node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/lib/getExePath.js',
    'node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/package.json',
    'node_modules/.pnpm/@typescript+typescript-win32-x64@7.0.2/node_modules/@typescript/typescript-win32-x64/package.json',
    'node_modules/.pnpm/@typescript+typescript-win32-x64@7.0.2/node_modules/@typescript/typescript-win32-x64/lib/tsc.exe')) { $script:sourcePaths.Add($path) }
  return @($script:sourcePaths | Sort-Object -Unique)
}
function Assert-NoShadowHeader {
  $count = 0
  foreach ($path in [IO.Directory]::EnumerateFileSystemEntries((Join-Path $projectRoot 'apps/backend/native'))) {
    if (++$count -gt 128) { throw 'Native source node limit exceeded.' }
    if ([IO.Path]::GetFileName($path) -ieq 'backend-runtime-pins.h') { throw 'Source-directory header would shadow the generated runtime pins.' }
  }
}
function Assert-SourceSnapshot {
  $current = @(Get-SourcePathSet)
  if (($current -join "`n") -cne ($sourcePathSet -join "`n")) { throw 'Source path set changed during the build.' }
  foreach ($pin in $sourcePins) { if ((Hash-File (Join-Path $projectRoot $pin.path)) -ne $pin.sha256) { throw 'Source changed during the build.' } }
}
function Assert-GeneratedSnapshot {
  foreach ($pin in $generatedPins) { if ((Hash-File (Join-Path $buildRoot $pin.path)) -ne $pin.sha256) { throw 'Generated runtime trust anchor changed during the build.' } }
}
Assert-NoShadowHeader
$sourcePathSet = @(Get-SourcePathSet)
$sourcePins = @()
foreach ($path in $sourcePathSet) { $sourcePins += [ordered]@{ path = $path; sha256 = (Hash-File (Join-Path $projectRoot $path)) } }
Write-Fresh (Join-Path $buildRoot 'logs/source-manifest.json') (([ordered]@{ schema = 1; files = $sourcePins } | ConvertTo-Json -Depth 6) + "`n")

$trustedSystemRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
Assert-CanonicalPath $trustedSystemRoot $true
$trustedSystem32 = Join-Path $trustedSystemRoot 'System32'
$nodeDirectory = Split-Path -Parent $node
Assert-CanonicalPath $trustedSystem32 $true
Assert-CanonicalPath $nodeDirectory $true
$whereExecutable = Join-Path $trustedSystem32 'where.exe'
Assert-CanonicalPath $whereExecutable $false
$scopedBuildPath = $nodeDirectory + ';' + $trustedSystem32 + ';' + $trustedSystemRoot

# Changes are process-local and restored even when a compiler or collection step fails.
$savedEnvironment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
  if ($entry.Key -match '^(NODE_|ELECTRON_|UV_|OPENSSL_|INSPECTOR|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|CL$|_CL_$|LINK$|_LINK_$|INCLUDE$|LIB$|LIBPATH$|GOMAXPROCS$)') {
    $savedEnvironment[$entry.Key] = $entry.Value; [Environment]::SetEnvironmentVariable($entry.Key, $null, 'Process')
  }
}
$previousPath = $env:Path
try {
  $env:Path = $scopedBuildPath
  $env:GOMAXPROCS = '1'
  Invoke-Limited $node ('--max-old-space-size=512 "' + $tsc + '" -b --force "' + (Join-Path $projectRoot 'apps/backend') + '"') 'typescript' $projectRoot
  Invoke-Limited $node ('--max-old-space-size=512 "' + $collector + '" --build-root "' + $buildRoot + '"') 'collect' $projectRoot
  $generatedPins = @()
  foreach ($path in @('backend-runtime-pins.h', 'package/runtime-manifest.json')) { $generatedPins += [ordered]@{ path = $path; sha256 = (Hash-File (Join-Path $buildRoot $path)) } }
  $prepared = (Read-Utf8 (Join-Path $buildRoot 'logs/collect.stdout.txt')) | ConvertFrom-Json
  if ($prepared.buildRoot -cne $buildRoot -or $prepared.runtimePackageDigest -notmatch '^[a-f0-9]{64}$') { throw 'Collector returned unexpected output.' }
  $manifestPath = Join-Path $buildRoot 'package/runtime-manifest.json'
  if ((Hash-File $manifestPath) -ne $prepared.runtimePackageDigest) { throw 'Staged manifest digest differs.' }
  $runtime = (Read-Utf8 $manifestPath) | ConvertFrom-Json
  if ($runtime.schema -ne 1 -or $runtime.protocol -ne 2 -or $runtime.node.executableSha256 -ne $nodeHash) { throw 'Runtime provenance differs.' }

  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  Assert-CanonicalPath $vswhere $false
  Invoke-Limited $vswhere '-utf8 -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath' 'vswhere' $projectRoot
  $installation = (Read-Utf8 (Join-Path $buildRoot 'logs/vswhere.stdout.txt')).Trim()
  $environmentScript = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat'
  Assert-CanonicalPath $environmentScript $false
  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
  Assert-CanonicalPath $sdkRoot $true
  $sdkVersion = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Include') -Directory | Where-Object { $_.Name -match '^10\.[0-9]+\.[0-9]+\.[0-9]+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'um/Windows.h')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  if (!$sdkVersion) { throw 'Existing x64 Windows SDK is required; nothing is installed.' }
  $sdkInclude = Join-Path $sdkRoot ('Include/' + $sdkVersion.Name)
  $sdkLib = Join-Path $sdkRoot ('Lib/' + $sdkVersion.Name)
  foreach ($relative in @('um/x64/kernel32.lib', 'um/x64/userenv.lib', 'um/x64/advapi32.lib', 'um/x64/bcrypt.lib', 'um/x64/ws2_32.lib', 'um/x64/OneCoreUAP.lib', 'ucrt/x64/ucrt.lib')) { Assert-CanonicalPath (Join-Path $sdkLib $relative) $false }
  Assert-CanonicalPath $sdkInclude $true
  New-PrivateDirectory (Join-Path $buildRoot 'bin')
  $source = Join-Path $projectRoot 'apps/backend/native/backend-broker.cpp'
  $binary = Join-Path $buildRoot 'bin/backend-broker.exe'
  $object = Join-Path $buildRoot 'backend-broker.obj'
  $compilerPathFile = Join-Path $buildRoot 'compiler-path.txt'
  $lines = @('@echo off', ('set "PATH=' + $scopedBuildPath + '"'), ('call "' + $environmentScript + '" >nul'), 'if errorlevel 1 exit /b 1',
    ('set "PATH=%PATH%;' + $trustedSystem32 + ';' + $trustedSystemRoot + '"'),
    ('set "INCLUDE=' + $sdkInclude + '\um;' + $sdkInclude + '\shared;' + $sdkInclude + '\ucrt;%INCLUDE%"'),
    ('set "LIB=' + $sdkLib + '\um\x64;' + $sdkLib + '\ucrt\x64;%LIB%"'),
    ('"' + $whereExecutable + '" cl.exe > "' + $compilerPathFile + '"'), 'if errorlevel 1 exit /b 1',
    ('cl.exe /nologo /std:c++17 /EHsc /utf-8 /O2 /W4 /WX /MT /guard:cf /DUNICODE /D_UNICODE /I"' + $buildRoot + '" "' + $source + '" /Fo:"' + $object + '" /Fe:"' + $binary + '" /link /INCREMENTAL:NO /DYNAMICBASE /NXCOMPAT userenv.lib advapi32.lib bcrypt.lib ws2_32.lib OneCoreUAP.lib'),
    'exit /b %errorlevel%')
  $command = Join-Path $buildRoot 'build.cmd'
  Write-Fresh $command ($lines -join "`r`n")
  $wrapper = Join-Path $buildRoot 'launch-build.cmd'
  Write-Fresh $wrapper ('@echo off' + "`r`n%SystemRoot%\System32\chcp.com 65001 >nul`r`ncall " + '"' + $command + '"' + "`r`nexit /b %errorlevel%`r`n")
  Assert-BuildRootPolicy; Assert-NoShadowHeader; Assert-SourceSnapshot; Assert-GeneratedSnapshot
  Invoke-Limited (Join-Path $trustedSystem32 'cmd.exe') ('/d /s /c ""' + $wrapper + '""') 'native' $buildRoot
  Assert-NoShadowHeader; Assert-GeneratedSnapshot
  $compiler = ((Read-Utf8 $compilerPathFile) -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
  Assert-CanonicalPath $compiler $false
  Assert-SourceSnapshot
  $inputManifest = (Read-Utf8 (Join-Path $buildRoot 'runtime-inputs.json')) | ConvertFrom-Json
  foreach ($pin in $inputManifest.files) { if ((Hash-File (Join-Path $projectRoot $pin.path)) -ne $pin.sha256) { throw 'Runtime input changed during compilation.' } }
  foreach ($pin in $runtime.files) {
    $path = Join-Path $buildRoot ('package/' + $pin.path)
    if ((Hash-File $path) -ne $pin.sha256 -or (Get-Item -LiteralPath $path).Length -ne $pin.bytes) { throw 'Staged package changed during compilation.' }
  }
  Assert-GeneratedSnapshot
  $brokerHash = Hash-File $binary
  # Run this tagged recipe only after the process-witness source is reviewed;
  # the complete native source set and hashes are checked around compilation.
  $buildManifest = [ordered]@{ schema = 1; protocol = 2; safetyPolicy = 'process-witness-observing-v1'; affinity = 1; priority = 'BelowNormal'; maxNodeHeapMiB = 512;
    sdk = $sdkVersion.Name; compiler = $compiler; compilerSha256 = (Hash-File $compiler); environmentSha256 = (Hash-File $environmentScript);
    node = $runtime.node; runtimePackageDigest = $prepared.runtimePackageDigest; generatedTrustAnchors = $generatedPins;
    files = @('logs/source-manifest.json', 'runtime-inputs.json', 'backend-runtime-pins.h', 'package/runtime-manifest.json', 'build.cmd', 'launch-build.cmd', 'bin/backend-broker.exe') | ForEach-Object { [ordered]@{ path = $_; sha256 = (Hash-File (Join-Path $buildRoot $_)) } } }
  Write-Fresh (Join-Path $buildRoot 'build-manifest.json') (($buildManifest | ConvertTo-Json -Depth 8) + "`n")
  Assert-BuildRootPolicy; Assert-NoShadowHeader; Assert-SourceSnapshot; Assert-GeneratedSnapshot
  $descriptor = [ordered]@{ schema = 1; protocol = 2; id = 'tahtiapuri-native-backend-v2'; safetyPolicy = 'process-witness-observing-v1';
    broker = [ordered]@{ path = 'bin/backend-broker.exe'; sha256 = $brokerHash; bytes = (Get-Item -LiteralPath $binary).Length };
    package = [ordered]@{ path = 'package'; manifest = 'runtime-manifest.json'; digest = $prepared.runtimePackageDigest };
    buildManifest = [ordered]@{ path = 'build-manifest.json'; sha256 = (Hash-File (Join-Path $buildRoot 'build-manifest.json')) } }
  Write-Fresh (Join-Path $buildRoot 'runtime-descriptor.json') (($descriptor | ConvertTo-Json -Depth 8) + "`n")
} finally {
  $env:Path = $previousPath
  [Environment]::SetEnvironmentVariable('GOMAXPROCS', $null, 'Process')
  foreach ($entry in $savedEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
}
Write-Output ('Private backend runtime build prepared: ' + $buildRoot)
Write-Output 'No broker or worker was launched; runtime selection and delivery require separate integration.'
