import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNativeMcpHelpers } from "./native-mcp-helpers.js";
import { queryNativeMainIdentity } from "./native-main-identity.js";
import { runNativeBootstrapOperation } from "./native-bootstrap-operation.js";
vi.mock("./native-bootstrap-operation.js", () => ({ runNativeBootstrapOperation: vi.fn(async () => {}) }));
vi.mock("./native-main-identity.js", () => ({ queryNativeMainIdentity: vi.fn(async () => ({ pid: process.pid, creationTime: 1n })) }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>(); return { ...real, lstat: vi.fn(real.lstat) };
});
const roots: string[] = [];
afterEach(async () => {
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstat).mockImplementation(real.lstat); vi.mocked(queryNativeMainIdentity).mockClear(); vi.mocked(runNativeBootstrapOperation).mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function packageFixture() {
  await mkdir(".artifacts/tests", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".artifacts/tests/mcp-helper-cancel-")); roots.push(root);
  const helpers = join(root, "helpers"); await mkdir(helpers);
  const bytes = Buffer.from("synthetic helper bytes: never executed");
  for (const name of ["main-identity.exe", "main-bootstrap.exe"]) await writeFile(join(helpers, name), bytes);
  const pin = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { root, helpers, pins: { "main-identity.exe": pin, "main-bootstrap.exe": pin } };
}
async function fixture() {
  const value = await packageFixture(); return loadNativeMcpHelpers(value.helpers, value.pins);
}
it("does not query identity when already cancelled", async () => {
  const helper = await fixture(), abort = new AbortController(); abort.abort();
  await expect(helper.identity(abort.signal)).rejects.toThrow();
  expect(queryNativeMainIdentity).not.toHaveBeenCalled();
});
it("does not launch identity after cancellation during package verification", async () => {
  const helper = await fixture(), abort = new AbortController();
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(lstat).mockImplementationOnce(async (...args) => { entered(); await gate; return real.lstat(...args); });
  const result = helper.identity(abort.signal);
  await observed; abort.abort(); release();
  await expect(result).rejects.toThrow(); expect(queryNativeMainIdentity).not.toHaveBeenCalled();
});

it("does not dispatch consume when its deadline expires during verification", async () => {
  const helper = await fixture(), real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const observed = new Promise<void>(done => { entered = done; }), resumed = new Promise<void>(done => { release = done; });
  vi.mocked(lstat).mockImplementationOnce(async (...args) => { entered(); await resumed; return real.lstat(...args); });
  const deadline = performance.now() + 60000;
  const result = helper.operate("consume", "C:\\synthetic\\main-bootstrap.bin", Buffer.alloc(96), undefined, deadline).catch(error => error);
  let restore: (() => void) | undefined;
  try {
    await observed;
    const clock = vi.spyOn(performance, "now").mockReturnValue(deadline + 1); restore = () => { clock.mockRestore(); };
    release(); expect(await result).toMatchObject({ exitVerified: true }); expect(runNativeBootstrapOperation).not.toHaveBeenCalled();
  } finally { restore?.(); release(); await result; }
});

// Six package-validation oracles migrated from the old Host integration suite.
// All binaries are synthetic bytes and all invocation methods remain mocked.
it.each(["extra", "missing", "bytes", "hash", "hardlink"] as const)("helper package rejects %s before invocation", async mutation => {
  const f = await packageFixture(); let pins = f.pins;
  if (mutation === "extra") await writeFile(join(f.helpers, "extra"), "extra");
  if (mutation === "missing") await rm(join(f.helpers, "main-identity.exe"));
  if (mutation === "bytes") await writeFile(join(f.helpers, "main-identity.exe"), "changed");
  if (mutation === "hash") pins = { ...pins, "main-identity.exe": { ...pins["main-identity.exe"], sha256: "0".repeat(64) } };
  if (mutation === "hardlink") await link(join(f.helpers, "main-identity.exe"), join(f.root, "retained-link"));
  await expect(loadNativeMcpHelpers(f.helpers, pins)).rejects.toThrow();
  expect(queryNativeMainIdentity).not.toHaveBeenCalled(); expect(runNativeBootstrapOperation).not.toHaveBeenCalled();
});
it("an already loaded helper package is rechecked before each invocation", async () => {
  const f = await packageFixture(), helper = await loadNativeMcpHelpers(f.helpers, f.pins);
  await writeFile(join(f.helpers, "extra"), "unexpected");
  await expect(helper.identity()).rejects.toThrow("package rejected");
  expect(queryNativeMainIdentity).not.toHaveBeenCalled(); expect(runNativeBootstrapOperation).not.toHaveBeenCalled();
});
