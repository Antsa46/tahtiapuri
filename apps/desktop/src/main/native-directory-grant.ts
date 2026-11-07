/** Fixed trusted Windows script and raw authorization frame. No caller text,
 * executable, script path or directory argument is interpreted as a command.
 * System PowerShell is a separate trusted OS resource, not a native package pin. */
export const NATIVE_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$grantStream = [Console]::OpenStandardInput()
$expected = [Text.Encoding]::ASCII.GetBytes("THDIR001")
$received = New-Object byte[] 8
try {
  $used = 0
  while ($used -lt 8) {
    $count = $grantStream.Read($received, $used, 8 - $used)
    if ($count -eq 0) { throw "Missing directory grant" }
    $used += $count
  }
  for ($i = 0; $i -lt 8; $i++) {
    if ($received[$i] -ne $expected[$i]) { throw "Invalid directory grant" }
  }
  if ($grantStream.ReadByte() -ne -1) { throw "Trailing directory grant input" }
} finally { [Array]::Clear($received, 0, 8); $grantStream.Dispose() }
# No intentional filesystem mutation occurs above this grant/EOF boundary.
$path = [IO.Path]::GetFullPath($env:TAHTIAPURI_PRIVATE_DIR)
$parent = [IO.Path]::GetDirectoryName($path)
if (!$parent -or ![IO.Directory]::Exists($parent)) { throw "Missing immediate directory parent" }
$part = $path
while ($part) {
  $exists = $true
  try { $attributes = [IO.File]::GetAttributes($part) }
  catch [IO.FileNotFoundException] { $exists = $false }
  catch [IO.DirectoryNotFoundException] { $exists = $false }
  if ($exists) {
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw "Invalid directory chain" }
  } elseif ($part -ne $path) { throw "Missing directory ancestor" }
  $next = [IO.Path]::GetDirectoryName($part)
  if (!$next -or $next -eq $part) { break }; $part = $next
}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($sid, $system)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
  $acl.AddAccessRule($rule)
}

function Assert-PrivateDirectory([string]$target) {
  $dir = [IO.DirectoryInfo]::new($target)
  if (!$dir.Exists -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Invalid directory" }
  $actual = $dir.GetAccessControl()
  if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$actual.AreAccessRulesProtected) { throw "Invalid owner or DACL" }
  $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 2) { throw "Unexpected access rules" }
  $seen = @{}
  foreach ($rule in $rules) {
    $identity = $rule.IdentityReference.Value
    if ($seen.ContainsKey($identity)) { throw "Duplicate access identity" }; $seen[$identity] = $true
    if ($rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $rule.PropagationFlags -ne "None") { throw "Invalid inheritance" }
    if ($rule.IsInherited -or $rule.AccessControlType -ne "Allow" -or $rule.FileSystemRights -ne "FullControl" -or ($identity -ne $sid.Value -and $identity -ne $system.Value)) { throw "Invalid access rule" }
  }
  if (!$seen.ContainsKey($sid.Value) -or !$seen.ContainsKey($system.Value)) { throw "Missing access identity" }
}
# The immediate parent must already be Main-private; never repair its ACL.
# Trusted Main composition also owns the non-redirected ancestor chain. These
# checks are not a native handle pin against same-user/admin path replacement.
Assert-PrivateDirectory $parent
if ([IO.Directory]::Exists($path)) { Assert-PrivateDirectory $path }
$null = [IO.Directory]::CreateDirectory($path, $acl)
Assert-PrivateDirectory $path
[Console]::Out.Write("directory-ready" + [char]10)
`;
export function createNativeDirectoryGrant(): Buffer { return Buffer.from("THDIR001", "ascii"); }
