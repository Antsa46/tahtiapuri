import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNativeMcpHelpers } from "./native-mcp-helpers.js";
import { queryNativeMainIdentity } from "./native-main-identity.js";
vi.mock("./native-main-identity.js", () => ({ queryNativeMainIdentity: vi.fn(async () => ({ pid: process.pid, creationTime: 1n })) }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>(); return { ...real, lstat: vi.fn(real.lstat) };
});
const roots: string[] = [];
afterEach(async () => {
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstat).mockImplementation(real.lstat); vi.mocked(queryNativeMainIdentity).mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  await mkdir(".artifacts/tests", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".artifacts/tests/mcp-helper-cancel-")); roots.push(root);
  const bytes = Buffer.from("synthetic helper bytes: never executed");
  for (const name of ["main-identity.exe", "main-bootstrap.exe"]) await writeFile(join(root, name), bytes);
  const pin = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return loadNativeMcpHelpers(root, { "main-identity.exe": pin, "main-bootstrap.exe": pin });
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
