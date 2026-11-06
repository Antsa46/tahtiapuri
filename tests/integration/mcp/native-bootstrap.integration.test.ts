import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { link, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { securePrivateDirectory } from "../../../apps/desktop/src/main/private-directory.js";
import { queryNativeMainIdentity } from "../../../apps/desktop/src/main/native-main-identity.js";
import { encodeNativeBootstrap } from "../../../apps/desktop/src/main/native-development-bootstrap.js";

const execute = promisify(execFile);
const probe = process.env.TAHTIAPURI_NATIVE_BOOTSTRAP_PROBE, identityHelper = process.env.TAHTIAPURI_NATIVE_IDENTITY_HELPER;
const enabled = process.platform === "win32" && !!probe && !!identityHelper;
const test = enabled ? it : it.skip;
const base = join(process.cwd(), ".artifacts/tests/native-bootstrap-fixtures", randomUUID());
const fixture = encodeNativeBootstrap({ main: { pid: 0x01020304, creationTime: 0x0807060504030201n }, pipeNonce: "11".repeat(16), ticket: { generation: "22".repeat(16), token: "33".repeat(32) } });
const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
async function powershell(script: string, path: string, extra: Record<string, string> = {}) {
  return execute(ps, ["-NoProfile", "-NonInteractive", "-Command", '$ErrorActionPreference="Stop"; ' + script], {
    windowsHide: true, timeout: 5000, maxBuffer: 4096,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TAHTIAPURI_TEST_PATH: path, ...extra },
  });
}
async function setup() {
  const directory = join(base, randomUUID()); await securePrivateDirectory(directory);
  const file = join(directory, "main-bootstrap.bin"); await writeFile(file, fixture, { flag: "wx" }); return { directory, file };
}
async function read(path: string, mode = "--read") {
  try { const result = await execute(probe!, [mode, path], { windowsHide: true, timeout: 3000, maxBuffer: 256 });
    expect(result.stderr).toBe(""); return { code: 0, out: result.stdout, error: "" };
  } catch (error) { const failed = error as Error & { code?: number; stderr?: string; stdout?: string; killed?: boolean };
    expect(failed.killed).not.toBe(true); expect(typeof failed.code).toBe("number");
    return { code: failed.code, out: failed.stdout ?? "", error: failed.stderr ?? "" }; }
}
async function denied(path: string, stage: string) {
  const result = await read(path); expect(result.code).toBe(1); expect(result.out).toBe(""); expect(result.error).toContain(stage);
}
beforeAll(async () => { if (enabled) await mkdir(base, { recursive: true }); });
afterAll(async () => { if (enabled) await rm(base, { recursive: true, force: true }); });
test("reads the real private-directory publisher and permits rotation after the read", async () => {
  const f = await setup(); expect(await read(f.file)).toEqual({ code: 0, out: '{"passed":true}\r\n', error: "" });
  expect(await readFile(f.file)).toEqual(fixture);
  await rm(f.file); await writeFile(f.file, fixture, { flag: "wx" }); expect((await read(f.file)).code).toBe(0);
});
test("rejects an extra principal on the protected control directory", async () => {
  const f = await setup();
  await powershell('$a=[IO.Directory]::GetAccessControl($env:TAHTIAPURI_TEST_PATH,[Security.AccessControl.AccessControlSections]::Access); $s=[Security.Principal.SecurityIdentifier]::new("S-1-1-0"); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,"Read","ContainerInherit,ObjectInherit","None","Allow")); [IO.Directory]::SetAccessControl($env:TAHTIAPURI_TEST_PATH,$a)', f.directory);
  await denied(f.file, "bootstrap-dacl");
});
test("rejects a protected leaf instead of the required inherited policy", async () => {
  const f = await setup(); await powershell('$a=Get-Acl -LiteralPath $env:TAHTIAPURI_TEST_PATH; $a.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $env:TAHTIAPURI_TEST_PATH -AclObject $a', f.file);
  await denied(f.file, "bootstrap-dacl");
});
test("rejects a missing SYSTEM principal", async () => {
  const f = await setup(); await powershell('$a=[IO.Directory]::GetAccessControl($env:TAHTIAPURI_TEST_PATH,[Security.AccessControl.AccessControlSections]::Access); $s=[Security.Principal.SecurityIdentifier]::new("S-1-5-18"); $a.PurgeAccessRules($s); [IO.Directory]::SetAccessControl($env:TAHTIAPURI_TEST_PATH,$a)', f.directory);
  await denied(f.file, "bootstrap-dacl");
});
test("rejects a null directory DACL without enabling privileges", async () => {
  const f = await setup();
  const saved = await powershell('$section=[Security.AccessControl.AccessControlSections]::Access; $root=[IO.Directory]::GetAccessControl($env:TAHTIAPURI_TEST_PATH,$section); $file=[IO.File]::GetAccessControl([IO.Path]::Combine($env:TAHTIAPURI_TEST_PATH,"main-bootstrap.bin"),$section); [Console]::Write((@{root=$root.GetSecurityDescriptorSddlForm($section);file=$file.GetSecurityDescriptorSddlForm($section)} | ConvertTo-Json -Compress))', f.directory);
  try {
    await powershell('$a=[IO.Directory]::GetAccessControl($env:TAHTIAPURI_TEST_PATH,[Security.AccessControl.AccessControlSections]::Access); $a.SetSecurityDescriptorSddlForm("D:NO_ACCESS_CONTROL",[Security.AccessControl.AccessControlSections]::Access); [IO.Directory]::SetAccessControl($env:TAHTIAPURI_TEST_PATH,$a)', f.directory);
    await denied(f.file, "bootstrap-dacl");
  } finally {
    // Removing inherited ACEs from the parent can leave an empty child DACL.
    // Restore only this fixture's saved access descriptors before deleting it.
    await powershell('$saved=$env:TAHTIAPURI_TEST_ACL | ConvertFrom-Json; $section=[Security.AccessControl.AccessControlSections]::Access; $root=[Security.AccessControl.DirectorySecurity]::new(); $root.SetSecurityDescriptorSddlForm($saved.root,$section); [IO.Directory]::SetAccessControl($env:TAHTIAPURI_TEST_PATH,$root); $file=[Security.AccessControl.FileSecurity]::new(); $file.SetSecurityDescriptorSddlForm($saved.file,$section); [IO.File]::SetAccessControl([IO.Path]::Combine($env:TAHTIAPURI_TEST_PATH,"main-bootstrap.bin"),$file)', f.directory, { TAHTIAPURI_TEST_ACL: saved.stdout });
  }
});
test("the retained production read guard denies ordinary write and delete access", async () => {
  const f = await setup(); expect((await read(f.file, "--lock")).code).toBe(0);
  expect(await readFile(f.file)).toEqual(fixture); await rm(f.file); // Guard release permits consumption.
});
test("rejects a hardlinked descriptor", async () => { const f = await setup(); await link(f.file, join(f.directory, "linked.bin")); await denied(f.file, "bootstrap-file-type"); });
for (const size of [95, 97]) test("rejects descriptor size " + size, async () => {
  const f = await setup(); await writeFile(f.file, Buffer.alloc(size)); await denied(f.file, "bootstrap-size");
});
test("rejects a malformed exact-sized descriptor", async () => { const f = await setup(); await writeFile(f.file, Buffer.alloc(96)); await denied(f.file, "bootstrap-format"); });
test("rejects a directory at the fixed leaf", async () => { const f = await setup(); await rm(f.file); await mkdir(f.file); await denied(f.file, "bootstrap-open"); });
test("rejects a missing descriptor", async () => { const f = await setup(); await rm(f.file); await denied(f.file, "bootstrap-open"); });
test("rejects an alternate filename even when bytes and ACL are valid", async () => { const f = await setup(); const other = join(f.directory, "other.bin"); await writeFile(other, fixture); await denied(other, "bootstrap-fixed-leaf"); });
test("rejects an open writer without changing its file, then succeeds after close", async () => {
  const f = await setup(); const writer = await open(f.file, "r+");
  try { await denied(f.file, "bootstrap-open"); } finally { await writer.close(); }
  expect((await read(f.file)).code).toBe(0); expect(await readFile(f.file)).toEqual(fixture);
});
test("rejects an ancestor junction without reading through it", async () => {
  const f = await setup(), junction = join(base, randomUUID());
  await powershell('New-Item -ItemType Junction -Path $env:TAHTIAPURI_TEST_PATH -Target $env:TAHTIAPURI_TEST_TARGET | Out-Null', junction, { TAHTIAPURI_TEST_TARGET: f.directory });
  try { await denied(join(junction, "main-bootstrap.bin"), "bootstrap-file-type"); }
  finally { await powershell('[IO.Directory]::Delete($env:TAHTIAPURI_TEST_PATH)', junction); }
  expect(await readFile(f.file)).toEqual(fixture);
});
test("rejects an intermediate ancestor junction before reaching the private root", async () => {
  const parent = join(base, randomUUID()); await mkdir(parent);
  const directory = join(parent, "control"); await securePrivateDirectory(directory);
  const file = join(directory, "main-bootstrap.bin"); await writeFile(file, fixture);
  const junction = join(base, randomUUID());
  await powershell('New-Item -ItemType Junction -Path $env:TAHTIAPURI_TEST_PATH -Target $env:TAHTIAPURI_TEST_TARGET | Out-Null', junction, { TAHTIAPURI_TEST_TARGET: parent });
  try { await denied(join(junction, "control/main-bootstrap.bin"), "bootstrap-file-type"); }
  finally { await powershell('[IO.Directory]::Delete($env:TAHTIAPURI_TEST_PATH)', junction); }
  expect((await read(file)).code).toBe(0);
});
test("queries this live process and preserves the exact independently read FILETIME", async () => {
  const value = await queryNativeMainIdentity(identityHelper!);
  expect(value.pid).toBe(process.pid); expect(value.creationTime).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  const result = await powershell('$p=[Diagnostics.Process]::GetProcessById([int]$env:TAHTIAPURI_TEST_PATH); [Console]::Write($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture))', String(process.pid));
  expect(value.creationTime).toBe(BigInt(result.stdout)); expect(await queryNativeMainIdentity(identityHelper!)).toEqual(value);
});
for (const args of [["--identity", "0"], ["--identity", "01"], ["--other", "1"], ["--identity", "4294967296"], ["--identity", String(process.pid), "extra"]])
  test("identity helper rejects noncanonical arguments: " + args.join(" "), async () => {
    const result = await execute(identityHelper!, args, { windowsHide: true, timeout: 3000, maxBuffer: 128 }).then(() => undefined, error => error);
    expect(result).toBeDefined(); expect(result.code).toBe(64); expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
  });
