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
$buildRoot = Join-Path $projectRoot ('.artifacts/native/mcp-runtime/builds/build-' + [Guid]::NewGuid().ToString('N'))

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
  if (!$process.WaitForExit(120000)) {
    $process.Kill()
    if (!$process.WaitForExit(10000)) { throw 'Owned builder termination unresolved; preserve the build root.' }
    throw 'Owned builder exceeded its deadline; preserved failed build logs.'
  }
  $process.WaitForExit(); $process.Refresh()
  $code = $process.ExitCode
  if ($null -eq $code -or $code -ne 0) { throw ($Name + ' failed (exit ' + $code + '). Diagnostics: ' + $stderr) }
}

Assert-CanonicalPath $projectRoot $true
$artifactParent = $projectRoot
foreach ($component in @('.artifacts', 'native', 'mcp-runtime', 'builds')) {
  $artifactParent = Join-Path $artifactParent $component
  if (!(Test-Path -LiteralPath $artifactParent)) {
    Assert-CanonicalPath $artifactParent $true $true
    [IO.Directory]::CreateDirectory($artifactParent) | Out-Null
  }
  Assert-CanonicalPath $artifactParent $true
}
New-ProtectedBuildRoot
Write-Fresh (Join-Path $buildRoot 'owner.marker') "TAHTIAPURI_MCP_BUILD_V1`n"
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
$collector = Join-Path $PSScriptRoot 'collect-mcp-runtime.mjs'
Assert-CanonicalPath $collector $false
$env:RAYON_NUM_THREADS = '2'
# No inherited Node hooks, search paths or inspector options in the build child.
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
Invoke-Limited $node ('--max-old-space-size=384 "' + $collector + '" --build-root "' + $buildRoot + '"') 'collect' $projectRoot
Assert-BuildRootPolicy
Write-Output (Read-Utf8 (Join-Path $buildRoot 'logs/collect.stdout.txt'))
