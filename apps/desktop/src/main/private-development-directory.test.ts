import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { secureDevelopmentDirectory } from "./private-development-directory.js";
const run = promisify(execFile);
it("creates a Windows owner-only descriptor directory and rejects noninheriting existing ACLs", async () => {
  await mkdir(".artifacts/tests", { recursive: true });
  const directory = resolve(".artifacts/tests/acl-" + randomUUID());
  try {
    await secureDevelopmentDirectory(directory);
    await secureDevelopmentDirectory(directory);
    await writeFile(join(directory, "synthetic.txt"), "synthetic");
    const program = `
$ErrorActionPreference = "Stop"
$p = $env:TAHTIAPURI_MCP_DIR
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
$actual = (Get-Item -LiteralPath (Join-Path $p "synthetic.txt")).GetAccessControl()
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2 -or @($rules | Where-Object { !$_.IsInherited -or ($_.IdentityReference.Value -ne $sid.Value -and $_.IdentityReference.Value -ne $system.Value) }).Count -ne 0) { throw "Child ACL not private" }
[System.IO.File]::Delete((Join-Path $p "synthetic.txt"))
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)
foreach ($who in @($sid, $system)) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($who, "FullControl", "Allow"))) }
(Get-Item -LiteralPath $p).SetAccessControl($acl)
`;
    await run(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", program], { timeout: 10_000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot, TAHTIAPURI_MCP_DIR: directory } });
    await expect(secureDevelopmentDirectory(directory)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
