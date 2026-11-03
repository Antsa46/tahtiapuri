import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { childEnvironment } from "./child-environment.js";
const execute = promisify(execFile);
// Fixed program text; the path is data in the child environment, never shell text.
const script = `
$ErrorActionPreference = "Stop"
$path = [System.IO.Path]::GetFullPath($env:TAHTIAPURI_MCP_DIR)
$part = $path
while ($part) {
  if ([System.IO.Directory]::Exists($part)) {
    $a = [System.IO.File]::GetAttributes($part)
    if (($a -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point" }
  }
  $parent = [System.IO.Path]::GetDirectoryName($part)
  if ($parent -eq $part) { break }; $part = $parent
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
$dir = [System.IO.Directory]::CreateDirectory($path, $acl)
if (($dir.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point" }
$actual = $dir.GetAccessControl()
if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$actual.AreAccessRulesProtected) { throw "Invalid owner or DACL" }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw "Unexpected access rules" }
$seen = @{}
foreach ($rule in $rules) {
  $seen[$rule.IdentityReference.Value] = $true
  if ($rule.InheritanceFlags -ne ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $rule.PropagationFlags -ne "None") { throw "Invalid inheritance" }
  if ($rule.IsInherited -or $rule.AccessControlType -ne "Allow" -or $rule.FileSystemRights -ne "FullControl" -or ($rule.IdentityReference.Value -ne $sid.Value -and $rule.IdentityReference.Value -ne $system.Value)) { throw "Invalid access rule" }
}
if (!$seen.ContainsKey($sid.Value) -or !$seen.ContainsKey($system.Value)) { throw "Missing access identity" }
`;
export async function secureDevelopmentDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Unsupported development transport.");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Missing Windows runtime.");
  await execute(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 10_000, maxBuffer: 4096,
      env: { ...childEnvironment(process.env), TAHTIAPURI_MCP_DIR: directory } });
}
