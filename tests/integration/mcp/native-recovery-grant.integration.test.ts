import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeRecoveryGrant } from "../../../apps/desktop/src/main/native-recovery-grant.js";
import { loadNativeMcpRuntime } from "../../../apps/desktop/src/main/native-mcp-resources.js";
import { childEnvironment } from "../../../apps/desktop/src/main/child-environment.js";
import { NativeRecoveryProbe, type RecoveryInputMode } from "../../support/mcp/native-recovery-probe.js";

const root = process.env.TAHTIAPURI_NATIVE_RECOVERY_GRANT_RUN_ROOT;
const runtimeRoot = process.env.TAHTIAPURI_NATIVE_RECOVERY_GRANT_RUNTIME;
const digest = process.env.TAHTIAPURI_NATIVE_RECOVERY_GRANT_DESCRIPTOR;
const enabled = process.platform === "win32" && !!root && !!runtimeRoot && !!digest;
const test = enabled ? it : it.skip;
const pendingBytes = Buffer.from([84, 77, 66, 79, 79, 84, 49, 0]);
const file = (which: "pending" | "final") => join(root!, which === "pending" ? "main-bootstrap.pending" : "main-bootstrap.bin");
let ready = false, helper = "";
const probe = new NativeRecoveryProbe({
  async absent(which) {
    try { await access(file(which)); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error; }
    throw new Error("Synthetic recovery fixture unexpectedly exists");
  },
  createPending: () => writeFile(file("pending"), pendingBytes, { flag: "wx" }),
  readPending: () => readFile(file("pending")),
  removePending: () => unlink(file("pending")),
  async diagnostic(name, value) {
    if (name !== "teardown.json" && !/^case-(0[1-9]|1[0-3])(?:-process)?\.json$/.test(name))
      throw new Error("Invalid recovery diagnostic name");
    await writeFile(join(root!, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  },
}, () => spawn(helper, ["--recover", file("final")], {
  windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: childEnvironment(process.env),
}));
beforeAll(async () => {
  if (!enabled) return;
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  expect(resolve(root!)).toBe(root);
  expect(dirname(root!)).toBe(join(project, ".artifacts/tests/native-recovery-grant"));
  expect(basename(root!)).toMatch(/^run-[a-f0-9]{32}$/);
  // Own and observe the original read-only verification promise. Its late
  // completion cannot initialize a usable helper after the 10s preparation cap.
  await probe.prepare(() => loadNativeMcpRuntime({ runtimeRoot: runtimeRoot!, descriptorSha256: digest! }, AbortSignal.timeout(10000)));
  helper = join(runtimeRoot!, "helpers/main-bootstrap.exe"); ready = true;
}, 15000);
afterAll(async () => {
  if (!enabled) return;
  ready = false;
  const final = await probe.teardown(); // Stops admission before all waits.
  expect(final.failed).toBe(false);
  expect(final.drainedWithinBudget).toBe(true);
  expect(final.eventsOverflow).toBe(false);
  expect(final.pendingWork).toEqual([]);
  expect(final.contexts).toHaveLength(13);
  expect(final.contexts.every(context => context.operationSettled && context.childCloseObserved)).toBe(true);
}, 5000);
function scenario(input: Buffer, mode: RecoveryInputMode, accepted: boolean, expectedCode: number) {
  if (!ready) return Promise.reject(new Error("Recovery package not ready or fixture teardown started"));
  return probe.run(input, mode, accepted, expectedCode);
}
for (let size = 0; size < 8; ++size)
  test("rejects EOF after only " + size + " recovery grant bytes before descriptor mutation", async () => {
    await scenario(createNativeRecoveryGrant().subarray(0, size), "eof", false, 1);
  }, 10000);
test("rejects a wrong complete recovery grant", async () => {
  await scenario(Buffer.from("THREC002"), "eof", false, 1);
}, 10000);
test("rejects trailing recovery grant bytes", async () => {
  await scenario(Buffer.concat([createNativeRecoveryGrant(), Buffer.from([0])]), "eof", false, 1);
}, 10000);
test("complete grant without EOF remains within the original native watchdog and does not recover", async () => {
  await scenario(createNativeRecoveryGrant(), "hold", false, 70);
}, 10000);
test("recovers only after the complete grant and EOF", async () => {
  await scenario(createNativeRecoveryGrant(), "eof", true, 0);
}, 10000);
test("closing the pipe after a complete grant may recover and is not revocation", async () => {
  await scenario(createNativeRecoveryGrant(), "close", true, 0);
}, 10000);
