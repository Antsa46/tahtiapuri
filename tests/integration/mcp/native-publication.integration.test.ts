import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { access, link, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { securePrivateDirectory } from "../../../apps/desktop/src/main/private-directory.js";
import { queryNativeMainIdentity } from "../../../apps/desktop/src/main/native-main-identity.js";
import { encodeNativeBootstrap } from "../../../apps/desktop/src/main/native-development-bootstrap.js";
import { createNativeRecoveryGrant } from "../../../apps/desktop/src/main/native-recovery-grant.js";
import { runNativeBootstrapOperation } from "../../../apps/desktop/src/main/native-bootstrap-operation.js";

const execute = promisify(execFile);
const helper = process.env.TAHTIAPURI_NATIVE_BOOTSTRAP_HELPER;
const identityHelper = process.env.TAHTIAPURI_NATIVE_IDENTITY_HELPER;
const probe = process.env.TAHTIAPURI_NATIVE_BOOTSTRAP_PROBE;
const enabled = process.platform === "win32" && !!helper && !!identityHelper && !!probe;
const test = enabled ? it : it.skip;
const base = join(process.cwd(), ".artifacts/tests/native-publication-fixtures", randomUUID());
let bytes: Buffer;
const absent = async (path: string) => expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
async function powershell(script: string, path: string, extra: Record<string, string> = {}) {
  return execute(ps, ["-NoProfile", "-NonInteractive", "-Command", '$ErrorActionPreference="Stop"; ' + script], {
    windowsHide: true, timeout: 15000, maxBuffer: 4096,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TAHTIAPURI_TEST_PATH: path, ...extra },
  });
}
async function setup() {
  const directory = join(base, randomUUID()); await securePrivateDirectory(directory);
  return { directory, file: join(directory, "main-bootstrap.bin"), pending: join(directory, "main-bootstrap.pending") };
}
async function raw(mode: string, path: string, input: Buffer, closeOutput = false, leaveInputOpen = false) {
  const child = spawn(helper!, [mode, path], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
  let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill(), 8000);
  try {
    child.stdin.on("error", () => {}); child.stdout.on("error", () => {});
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 128) child.kill(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); if (stderr.length > 256) child.kill(); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    if (closeOutput) child.stdout.destroy();
    if (leaveInputOpen) child.stdin.write(input); else child.stdin.end(input);
    const code = await closed; expect(child.killed).toBe(false); return { code, stdout, stderr };
  } finally { clearTimeout(timer); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); }
}
beforeAll(async () => {
  if (!enabled) return;
  await mkdir(base, { recursive: true });
  console.info("Publication setup: private fixture parent ready; querying identity.");
  bytes = encodeNativeBootstrap({ main: await queryNativeMainIdentity(identityHelper!), pipeNonce: "11".repeat(16),
    ticket: { generation: "22".repeat(16), token: "33".repeat(32) } });
  console.info("Publication setup: identity query completed.");
}, 30000);
afterAll(async () => { if (enabled) await rm(base, { recursive: true, force: true }); });
test("publishes through the actual helper, native reader accepts inherited ACL, and consumes exact bytes", async () => {
  const f = await setup();
  await runNativeBootstrapOperation(helper!, "publish", f.file, bytes);
  expect(await readFile(f.file)).toEqual(bytes); await absent(f.pending);
  const read = await execute(probe!, ["--read-valid", f.file], { windowsHide: true, timeout: 3000, maxBuffer: 128 });
  expect(read.stdout).toBe('{"passed":true}\r\n'); expect(read.stderr).toBe("");
  await runNativeBootstrapOperation(helper!, "consume", f.file, bytes); await absent(f.file);
});
test("never overwrites an existing final descriptor", async () => {
  const f = await setup(); await writeFile(f.file, bytes, { flag: "wx" });
  const next = Buffer.from(bytes); next[64] = 0x44;
  expect((await raw("--publish", f.file, next)).code).toBe(1);
  expect(await readFile(f.file)).toEqual(bytes); await absent(f.pending);
});
test("wrong expected bytes cannot consume another token", async () => {
  const f = await setup(); await runNativeBootstrapOperation(helper!, "publish", f.file, bytes);
  const wrong = Buffer.from(bytes); wrong[95]! ^= 1;
  const result = await raw("--consume", f.file, wrong); expect(result.code).toBe(1); expect(result.stderr).toContain("wrong-generation");
  expect(await readFile(f.file)).toEqual(bytes);
});
test("live Main blocks stale recovery and keeps its descriptor", async () => {
  const f = await setup(); await writeFile(f.file, bytes, { flag: "wx" });
  const result = await raw("--recover", f.file, createNativeRecoveryGrant()); expect(result.code).toBe(1); expect(result.stderr).toContain("main-live");
  expect(await readFile(f.file)).toEqual(bytes);
});
test("different creation time is stale even while that PID is live", async () => {
  const f = await setup(), stale = Buffer.from(bytes); stale.writeBigUInt64LE(bytes.readBigUInt64LE(24) + 1n, 24);
  await writeFile(f.file, stale, { flag: "wx" });
  await runNativeBootstrapOperation(helper!, "recover", f.file); await absent(f.file);
});
test("an absent PID is stale", async () => {
  const f = await setup(), stale = Buffer.from(bytes); stale.writeUInt32LE(0xffffffff, 16);
  await writeFile(f.file, stale, { flag: "wx" }); await runNativeBootstrapOperation(helper!, "recover", f.file); await absent(f.file);
});
test("an exited Main is stale even while an external process handle retains the process object", async () => {
  const f = await setup();
  const result = await powershell(
    '$p=Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList "-NoProfile -NonInteractive -Command Start-Sleep -Milliseconds 500" -PassThru -WindowStyle Hidden; ' +
    '$held=$p.Handle; $created=$p.StartTime.ToUniversalTime().ToFileTimeUtc(); $b=[Convert]::FromBase64String($env:TAHTIAPURI_TEST_BYTES); ' +
    '[BitConverter]::GetBytes([uint32]$p.Id).CopyTo($b,16); [BitConverter]::GetBytes([uint64]$created).CopyTo($b,24); [IO.File]::WriteAllBytes($env:TAHTIAPURI_TEST_PATH,$b); ' +
    'if(!$p.WaitForExit(3000)){throw "Synthetic child deadline"}; ' +
    '$psi=[Diagnostics.ProcessStartInfo]::new(); $psi.FileName=$env:TAHTIAPURI_TEST_HELPER; $psi.Arguments="--recover " + [char]34 + $env:TAHTIAPURI_TEST_PATH + [char]34; ' +
    '$psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardInput=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true; ' +
    '$h=[Diagnostics.Process]::Start($psi); $null=$h.Handle; $grant=[Text.Encoding]::ASCII.GetBytes("THREC001"); $h.StandardInput.BaseStream.Write($grant,0,$grant.Length); $h.StandardInput.Close(); if(!$h.WaitForExit(7000)){ $h.Kill(); throw "Helper deadline" }; ' +
    '$h.WaitForExit(); if($h.ExitCode -ne 0 -or $h.StandardOutput.ReadToEnd() -ne ("descriptor-absent" + [char]10) -or $h.StandardError.ReadToEnd() -ne ""){throw "Recovery failed"}; ' +
    '$p.Dispose(); $h.Dispose(); [Console]::Write("passed")', f.file,
    { TAHTIAPURI_TEST_BYTES: bytes.toString("base64"), TAHTIAPURI_TEST_HELPER: helper! });
  expect(result.stdout).toBe("passed"); await absent(f.file);
});
for (const size of [0, 8, 31]) test("recovers reserved valid incomplete scratch of " + size + " bytes", async () => {
  const f = await setup(); await writeFile(f.pending, bytes.subarray(0, size), { flag: "wx" });
  await runNativeBootstrapOperation(helper!, "recover", f.file); await absent(f.pending); await absent(f.file);
});
test("preserves a complete pending identity while its Main is live", async () => {
  const f = await setup(); await writeFile(f.pending, bytes, { flag: "wx" });
  expect((await raw("--recover", f.file, createNativeRecoveryGrant())).code).toBe(1); expect(await readFile(f.pending)).toEqual(bytes);
});
for (const content of [Buffer.from("wrong"), Buffer.alloc(97)]) test("preserves malformed or oversized reserved scratch: " + content.length, async () => {
  const f = await setup(); await writeFile(f.pending, content, { flag: "wx" });
  expect((await raw("--recover", f.file, createNativeRecoveryGrant())).code).toBe(1); expect(await readFile(f.pending)).toEqual(content);
});
test("an open publisher-style writer blocks scratch recovery", async () => {
  const f = await setup(); await writeFile(f.pending, bytes.subarray(0, 8));
  const writer = await open(f.pending, "r+");
  try { expect((await raw("--recover", f.file, createNativeRecoveryGrant())).code).toBe(1); }
  finally { await writer.close(); }
  expect(await readFile(f.pending)).toEqual(bytes.subarray(0, 8));
  await runNativeBootstrapOperation(helper!, "recover", f.file); await absent(f.pending);
});
test("hardlinks are preserved rather than consumed or recovered", async () => {
  const f = await setup(); await writeFile(f.file, bytes); await link(f.file, join(f.directory, "alias.bin"));
  expect((await raw("--consume", f.file, bytes)).code).toBe(1);
  expect((await raw("--recover", f.file, createNativeRecoveryGrant())).code).toBe(1);
  expect(await readFile(f.file)).toEqual(bytes);
});
for (const size of [95, 97]) test("rejects stdin length before creating scratch: " + size, async () => {
  const f = await setup(); const input = Buffer.alloc(size); bytes.copy(input);
  expect((await raw("--publish", f.file, input)).code).toBe(1); await absent(f.file); await absent(f.pending);
});
test("stalled stdin is terminated by the helper's own deadline without publication", async () => {
  const f = await setup(); const result = await raw("--publish", f.file, bytes.subarray(0, 1), false, true);
  expect(result.code).toBe(70); await absent(f.file); await absent(f.pending);
});
test("publication acknowledgement failure preserves the published descriptor", async () => {
  const f = await setup(); const result = await raw("--publish", f.file, bytes, true);
  expect(result.code).toBe(1); expect(result.stderr).toContain("write-report");
  expect(await readFile(f.file)).toEqual(bytes); await absent(f.pending);
});
test("consumption acknowledgement failure does not restore a consumed descriptor", async () => {
  const f = await setup(); await writeFile(f.file, bytes);
  const result = await raw("--consume", f.file, bytes, true);
  expect(result.code).toBe(1); expect(result.stderr).toContain("write-report"); await absent(f.file);
});
test("does not recover a malformed final descriptor", async () => {
  const f = await setup(); const malformed = Buffer.alloc(96); await writeFile(f.file, malformed);
  expect((await raw("--recover", f.file, createNativeRecoveryGrant())).code).toBe(1); expect(await readFile(f.file)).toEqual(malformed);
});
test("does not create or repair an unprotected root", async () => {
  const directory = join(base, randomUUID()); await mkdir(directory);
  const file = join(directory, "main-bootstrap.bin");
  expect((await raw("--publish", file, bytes)).code).toBe(1); await absent(file); await absent(join(directory, "main-bootstrap.pending"));
});

test("access-denied process query is not treated as a stale descriptor", async () => {
  const f = await setup(), uncertain = Buffer.from(bytes); uncertain.writeUInt32LE(4, 16);
  await writeFile(f.file, uncertain);
  const result = await raw("--recover", f.file, createNativeRecoveryGrant());
  expect(result.code).toBe(1); expect(result.stderr).toContain("bootstrap-main-open:5");
  expect(await readFile(f.file)).toEqual(uncertain);
});
for (const mode of ["--hold-read", "--hold-metadata"]) test("requires actual consumption with " + mode, async () => {
  const f = await setup(); await writeFile(f.file, bytes);
  const child = spawn(probe!, [mode, f.file], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  child.stdin.on("error", () => {}); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Held-handle readiness deadline")), 5000);
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output === "held\r\n") resolve();
        else if (output.length > 32) reject(new Error("Unexpected held-handle output"));
      });
    });
    clearTimeout(timer);
    const result = await raw("--consume", f.file, bytes);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(mode === "--hold-read" ? /bootstrap-open:32/ : /bootstrap-(absence-uncertain|still-present):/);
    if (mode === "--hold-read") expect(await readFile(f.file)).toEqual(bytes);
  } finally {
    clearTimeout(timer); child.stdin.end();
    const exited = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    clearTimeout(timer);
    if (!exited) { child.kill(); await closed; throw new Error("Held test process did not exit normally"); }
    expect(await closed).toBe(0); expect(stderr).toBe("");
  }
  if (mode === "--hold-metadata") await absent(f.file);
});
