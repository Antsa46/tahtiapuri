import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { encodeNativeBootstrap } from "./native-development-bootstrap.js";
import { loadNativeMcpRuntime, loadNativeMcpLaunchPackage } from "./native-mcp-resources.js";

const processGuard = vi.hoisted(() => {
  let attempts = 0;
  return { attempts: () => attempts, invoke: vi.fn(() => { ++attempts; throw new Error("Unit fixture must never start a process"); }) };
});
vi.mock("node:child_process", () => ({ execFile: processGuard.invoke, spawn: processGuard.invoke }));
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>(); return { ...real, copyFile: vi.fn(real.copyFile), open: vi.fn(real.open), mkdir: vi.fn(real.mkdir) };
});
const roots: string[] = [];
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const signal = () => new AbortController().signal;
const node = { version: "24.22.2", archive: "node-v24.22.2-win-x64.zip",
  archiveSha256: "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2",
  executableSha256: "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9",
  licenseSha256: "ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9" };
beforeEach(async () => {
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(copyFile).mockImplementation(real.copyFile); vi.mocked(copyFile).mockClear();
  vi.mocked(open).mockImplementation(real.open); vi.mocked(open).mockClear();
  vi.mocked(mkdir).mockImplementation(real.mkdir); vi.mocked(mkdir).mockClear();
});
afterEach(async () => {
  try { expect(processGuard.attempts()).toBe(0); }
  finally { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); }
});
afterAll(() => { expect(processGuard.attempts()).toBe(0); expect(processGuard.invoke).not.toHaveBeenCalled(); });
async function fixture() {
  await mkdir(".artifacts/tests", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".artifacts/tests/mcp-resources-")); roots.push(root);
  const runtime = join(root, "runtime"), pkg = join(runtime, "package");
  for (const path of [runtime, pkg, join(pkg, "licenses"), join(runtime, "bin"), join(runtime, "helpers")]) await mkdir(path);
  for (const name of ["mcp-core", "mcp-server", "zod"]) await writeFile(join(pkg, "licenses/" + name + "-LICENSE.txt"), "Synthetic fixture license " + name);
  // Reuse only the already running pinned Node and its adjacent distribution
  // license. No download, model, broker or helper is run by these unit tests.
  await copyFile(process.execPath, join(pkg, "node.exe"));
  await copyFile(join(dirname(process.execPath), "LICENSE"), join(pkg, "licenses/node-LICENSE.txt"));
  await writeFile(join(pkg, "mcp-worker.mjs"), "// synthetic worker: never run\n");
  await writeFile(join(pkg, "package.json"), '{"type":"module","private":true}\n');
  const names = ["licenses/mcp-core-LICENSE.txt", "licenses/mcp-server-LICENSE.txt", "licenses/node-LICENSE.txt",
    "licenses/zod-LICENSE.txt", "mcp-worker.mjs", "node.exe", "package.json"];
  const files = await Promise.all(names.map(async path => { const bytes = await readFile(join(pkg, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; }));
  expect(files.find(file => file.path === "node.exe")?.sha256).toBe(node.executableSha256);
  expect(files.find(file => file.path === "licenses/node-LICENSE.txt")?.sha256).toBe(node.licenseSha256);
  const manifest = { schema: 1, protocol: "TMCP/1", node, entry: "mcp-worker.mjs", files };
  const binary = Buffer.from("Synthetic binary placeholder; never execute");
  for (const path of ["bin/mcp-broker.exe", "helpers/main-bootstrap.exe", "helpers/main-identity.exe"]) await writeFile(join(runtime, path), binary);
  await writeFile(join(runtime, "build-manifest.json"), "{}\n");
  const pin = { bytes: binary.length, sha256: sha(binary) };
  const descriptor = { schema: 1, id: "tahtiapuri-native-mcp-v1", protocols: ["TMCT/1", "TMCP/1"], broker: pin,
    helpers: { "main-bootstrap.exe": pin, "main-identity.exe": pin },
    package: { path: "package", manifest: "runtime-manifest.json", digest: "" }, buildManifestSha256: sha("{}\n") };
  const save = async () => {
    const text = JSON.stringify(manifest, null, 2) + "\n"; await writeFile(join(pkg, "runtime-manifest.json"), text);
    descriptor.package.digest = sha(text); await writeFile(join(runtime, "runtime-descriptor.json"), JSON.stringify(descriptor));
    return { runtimeRoot: runtime, descriptorSha256: sha(JSON.stringify(descriptor)) };
  };
  const config = await save();
  const reservation = join(root, "control/native-session-reserved"); await mkdir(dirname(reservation)); await mkdir(reservation);
  vi.mocked(copyFile).mockClear();
  return { root, runtime, pkg, reservation, manifest, descriptor, save, config };
}
it("loads only the externally pinned closed package and stages eight exact files without a process", async () => {
  const f = await fixture(), runtime = await loadNativeMcpRuntime(f.config, signal());
  expect(runtime.broker).toBe(join(f.runtime, "bin/mcp-broker.exe"));
  expect(await readdir(f.reservation)).toEqual([]); await runtime.prepareWorker(f.reservation, signal());
  expect(await readdir(f.reservation)).toEqual(["worker"]);
  expect((await readdir(join(f.reservation, "worker"))).sort()).toEqual(["package", "scratch"]);
  expect(await readdir(join(f.reservation, "worker/scratch"))).toEqual([]); expect(copyFile).toHaveBeenCalledTimes(8);
  expect(await readFile(join(f.reservation, "worker/package/runtime-manifest.json"))).toEqual(await readFile(join(f.pkg, "runtime-manifest.json")));
  await expect(runtime.prepareWorker(f.reservation, signal())).rejects.toThrow(); expect(copyFile).toHaveBeenCalledTimes(8);
});
it("rejects a wrong external descriptor pin before staging", async () => {
  const f = await fixture(); await expect(loadNativeMcpRuntime({ ...f.config, descriptorSha256: "0".repeat(64) }, signal())).rejects.toThrow("rejected");
  expect(await readdir(f.reservation)).toEqual([]); expect(copyFile).not.toHaveBeenCalled();
});
it.each(["extra", "missing", "bytes", "hardlink", "junction"] as const)("rejects worker package %s", async mutation => {
  const f = await fixture();
  if (mutation === "extra") await writeFile(join(f.pkg, "extra"), "extra");
  if (mutation === "missing") await rm(join(f.pkg, "mcp-worker.mjs"));
  if (mutation === "bytes") await writeFile(join(f.pkg, "mcp-worker.mjs"), "changed");
  if (mutation === "hardlink") await link(join(f.pkg, "mcp-worker.mjs"), join(f.root, "retained-link"));
  if (mutation === "junction") { const outside = join(f.root, "other-licenses"); await rename(join(f.pkg, "licenses"), outside); await symlink(outside, join(f.pkg, "licenses"), "junction"); }
  await expect(loadNativeMcpRuntime(f.config, signal())).rejects.toThrow(); expect(copyFile).not.toHaveBeenCalled();
  expect(await readdir(f.reservation)).toEqual([]);
});
it.each(["descriptor-shape", "protocol", "manifest-extra", "node-policy"] as const)("rejects trusted-but-incompatible metadata %s", async mutation => {
  const f = await fixture();
  if (mutation === "descriptor-shape") Object.assign(f.descriptor, { extra: true });
  if (mutation === "protocol") f.manifest.protocol = "TMCP/2";
  if (mutation === "manifest-extra") Object.assign(f.manifest, { extra: true });
  if (mutation === "node-policy") f.manifest.node = { ...node, version: "0.0.0" };
  await expect(loadNativeMcpRuntime(await f.save(), signal())).rejects.toThrow("rejected"); expect(copyFile).not.toHaveBeenCalled();
});
it("rechecks admitted source bytes before any staging write", async () => {
  const f = await fixture(), runtime = await loadNativeMcpRuntime(f.config, signal());
  await writeFile(join(f.pkg, "mcp-worker.mjs"), "changed after load");
  await expect(runtime.prepareWorker(f.reservation, signal())).rejects.toThrow("rejected");
  expect(await readdir(f.reservation)).toEqual([]); expect(copyFile).not.toHaveBeenCalled();
});
it("rejects extra broker-directory content before any staging", async () => {
  const f = await fixture(); await writeFile(join(f.runtime, "bin/extra.dll"), "extra");
  await expect(loadNativeMcpRuntime(f.config, signal())).rejects.toThrow("rejected"); expect(copyFile).not.toHaveBeenCalled();
});
it("does not begin staging for an already aborted caller", async () => {
  const f = await fixture(), runtime = await loadNativeMcpRuntime(f.config, signal()), abort = new AbortController(); abort.abort();
  await expect(runtime.prepareWorker(f.reservation, abort.signal)).rejects.toThrow();
  expect(await readdir(f.reservation)).toEqual([]); expect(copyFile).not.toHaveBeenCalled();
});
it("retains a partial stage when a copy fails and never merges a retry", async () => {
  const f = await fixture(), runtime = await loadNativeMcpRuntime(f.config, signal());
  vi.mocked(copyFile).mockRejectedValueOnce(new Error("Synthetic copy failure"));
  await expect(runtime.prepareWorker(f.reservation, signal())).rejects.toThrow("Synthetic copy failure");
  expect(await readdir(f.reservation)).toEqual(["worker"]); expect(copyFile).toHaveBeenCalledOnce();
  await expect(runtime.prepareWorker(f.reservation, signal())).rejects.toThrow(); expect(copyFile).toHaveBeenCalledOnce();
});
it("retains corrupted destination bytes and does not continue copying", async () => {
  const f = await fixture(), runtime = await loadNativeMcpRuntime(f.config, signal());
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(copyFile).mockImplementationOnce(async (source, target, flags) => { await real.copyFile(source, target, flags); await writeFile(target, "corrupt"); });
  await expect(runtime.prepareWorker(f.reservation, signal())).rejects.toThrow("rejected");
  expect(copyFile).toHaveBeenCalledOnce(); expect(await readFile(join(f.reservation, "worker/package/licenses/mcp-core-LICENSE.txt"), "utf8")).toBe("corrupt");
});
it("an aborted late copy never starts the next copy and preserves its evidence", async () => {
  const f = await fixture(), runtime = await loadNativeMcpRuntime(f.config, signal()), abort = new AbortController();
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(copyFile).mockImplementationOnce(async (source, target, flags) => { await real.copyFile(source, target, flags); abort.abort(); });
  await expect(runtime.prepareWorker(f.reservation, abort.signal)).rejects.toThrow(); expect(copyFile).toHaveBeenCalledOnce();
  expect((await lstat(join(f.reservation, "worker/package/licenses/mcp-core-LICENSE.txt"))).isFile()).toBe(true);
  expect(await readdir(join(f.reservation, "worker/package/licenses"))).toEqual(["mcp-core-LICENSE.txt"]);
});

it("reverifies the bound broker before every native owner operation", async () => {
  const f = await fixture(), runtime = await loadNativeMcpRuntime(f.config, signal());
  await writeFile(runtime.broker, "changed after load");
  const bytes = encodeNativeBootstrap({ main: { pid: process.pid, creationTime: 1n }, pipeNonce: "11".repeat(16),
    ticket: { generation: "22".repeat(16), token: "33".repeat(32) } });
  try {
    for (const operation of ["prepare", "seal", "publish", "release-pristine", "release-clean"] as const)
      await expect(runtime.session(operation, join(f.root, "control/main-bootstrap.bin"), bytes, signal())).rejects.toThrow("rejected");
  } finally { bytes.fill(0); }
  expect(processGuard.attempts()).toBe(0);
});

it("an owner deadline expiring during broker verification prevents dispatch", async () => {
  const f = await fixture(), runtime = await loadNativeMcpRuntime(f.config, signal());
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(done => { entered = done; }), resumed = new Promise<void>(done => { release = done; });
  vi.mocked(open).mockImplementation(async (...args) => {
    if (args[0] === runtime.broker) { entered(); await resumed; }
    return real.open(...args);
  });
  const bytes = encodeNativeBootstrap({ main: { pid: process.pid, creationTime: 1n }, pipeNonce: "11".repeat(16),
    ticket: { generation: "22".repeat(16), token: "33".repeat(32) } });
  const deadline = performance.now() + 60000;
  const result = runtime.session("release-pristine", join(f.root, "control/main-bootstrap.bin"), bytes, signal(), deadline).catch(error => error);
  let restore: (() => void) | undefined;
  try {
    await waiting;
    const clock = vi.spyOn(performance, "now").mockReturnValue(deadline + 1); restore = () => { clock.mockRestore(); };
    release(); expect(await result).toMatchObject({ exitVerified: true }); expect(processGuard.attempts()).toBe(0);
  } finally { restore?.(); release(); await result; bytes.fill(0); vi.mocked(open).mockImplementation(real.open); }
});

it("exposes a readonly launch source from the same external descriptor without staging or execution", async () => {
  const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
  expect(source.runtimeRoot).toBe(f.runtime); expect(source.descriptorSha256).toBe(f.config.descriptorSha256);
  expect(source.programs).toEqual({ identity: f.descriptor.helpers["main-identity.exe"],
    bootstrap: f.descriptor.helpers["main-bootstrap.exe"], broker: f.descriptor.broker });
  expect(Object.isFrozen(source)).toBe(true); expect(Object.isFrozen(source.programs)).toBe(true);
  expect(Object.isFrozen(source.programs.identity)).toBe(true);
  await source.verifyLaunch(signal()); expect(await readdir(f.reservation)).toEqual([]);
  expect(copyFile).not.toHaveBeenCalled(); expect(processGuard.attempts()).toBe(0);
});
it.each(["runtime-descriptor.json", "build-manifest.json", "helpers/main-identity.exe", "helpers/main-bootstrap.exe", "bin/mcp-broker.exe"] as const)(
  "readonly launch revalidation rejects changed %s before any native dispatch", async changed => {
    const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
    await writeFile(join(f.runtime, changed), "Changed synthetic launch source; never execute");
    await expect(source.verifyLaunch(signal())).rejects.toThrow();
    expect(copyFile).not.toHaveBeenCalled(); expect(await readdir(f.reservation)).toEqual([]);
    expect(processGuard.attempts()).toBe(0);
  });
it("an aborted readonly launch verification does not start file reads or dispatch", async () => {
  const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
  vi.mocked(open).mockClear(); const abort = new AbortController(); abort.abort();
  await expect(source.verifyLaunch(abort.signal)).rejects.toThrow();
  expect(open).not.toHaveBeenCalled(); expect(copyFile).not.toHaveBeenCalled(); expect(processGuard.attempts()).toBe(0);
});

it("stages only the same approved eight files through the explicit original-deadline capability", async () => {
  const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
  const deadline = process.hrtime.bigint() + 60_000_000_000n;
  await source.stageWorker(f.reservation, signal(), deadline);
  expect(copyFile).toHaveBeenCalledTimes(8);
  expect(await readdir(join(f.reservation, "worker/scratch"))).toEqual([]);
  expect(await readFile(join(f.reservation, "worker/package/runtime-manifest.json"))).toEqual(await readFile(join(f.pkg, "runtime-manifest.json")));
  await expect(source.stageWorker(f.reservation, signal(), deadline)).rejects.toThrow();
  expect(copyFile).toHaveBeenCalledTimes(8); expect(processGuard.attempts()).toBe(0);
});
it("missing or expired explicit staging deadlines forbid the first file operation", async () => {
  const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
  vi.mocked(open).mockClear(); vi.mocked(mkdir).mockClear();
  for (const deadline of [0n, undefined as unknown as bigint])
    await expect(source.stageWorker(f.reservation, signal(), deadline)).rejects.toMatchObject({ exitVerified: true });
  expect(open).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(copyFile).not.toHaveBeenCalled();
  expect(await readdir(f.reservation)).toEqual([]);
});
it("a staging deadline expiring in verification forbids all mkdir and copy operations without timer dispatch", async () => {
  const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(done => { enter = done; }), resumed = new Promise<void>(done => { resume = done; });
  const deadline = process.hrtime.bigint() + 60_000_000_000n;
  vi.mocked(mkdir).mockClear();
  vi.mocked(open).mockImplementation(async (...args) => {
    if (args[0] === join(f.runtime, "bin/mcp-broker.exe")) { enter(); await resumed; }
    return real.open(...args);
  });
  const original = source.stageWorker(f.reservation, signal(), deadline), failure = original.catch(error => error);
  let restore: (() => void) | undefined;
  try {
    await entered;
    const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValue(deadline + 1n); restore = () => { clock.mockRestore(); };
    resume(); expect(await failure).toMatchObject({ exitVerified: true });
    expect(mkdir).not.toHaveBeenCalled(); expect(copyFile).not.toHaveBeenCalled();
  } finally { restore?.(); resume(); await failure; vi.mocked(open).mockImplementation(real.open); }
  expect(await readdir(f.reservation)).toEqual([]);
});
it("an original deadline crossed by mkdir leaves one partial directory and admits no later mkdir or copy", async () => {
  const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const deadline = process.hrtime.bigint() + 60_000_000_000n; let restore: (() => void) | undefined;
  vi.mocked(mkdir).mockClear();
  vi.mocked(mkdir).mockImplementationOnce(async (...args) => {
    const result = await real.mkdir(...args);
    const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValue(deadline + 1n); restore = () => { clock.mockRestore(); }; return result;
  });
  try {
    await expect(source.stageWorker(f.reservation, signal(), deadline)).rejects.toMatchObject({ exitVerified: true });
    expect(mkdir).toHaveBeenCalledOnce(); expect(copyFile).not.toHaveBeenCalled();
  } finally { restore?.(); vi.mocked(mkdir).mockImplementation(real.mkdir); }
  expect(await readdir(f.reservation)).toEqual(["worker"]);
  expect(await readdir(join(f.reservation, "worker"))).toEqual([]);
});
it.each(["abort", "deadline"] as const)("a copy completing after %s never begins the next copy", async mode => {
  const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
  const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"), abort = new AbortController();
  const deadline = process.hrtime.bigint() + 60_000_000_000n; let restore: (() => void) | undefined;
  vi.mocked(copyFile).mockImplementationOnce(async (...args) => {
    await real.copyFile(...args);
    if (mode === "abort") abort.abort();
    else { const clock = vi.spyOn(process.hrtime, "bigint").mockReturnValue(deadline + 1n); restore = () => { clock.mockRestore(); }; }
  });
  try {
    await expect(source.stageWorker(f.reservation, abort.signal, deadline)).rejects.toThrow(); expect(copyFile).toHaveBeenCalledOnce();
  } finally { restore?.(); vi.mocked(copyFile).mockImplementation(real.copyFile); }
  expect(await readdir(join(f.reservation, "worker/package/licenses"))).toEqual(["mcp-core-LICENSE.txt"]);
});
it("an unbound staging reservation name is rejected before writes", async () => {
  const f = await fixture(), source = await loadNativeMcpLaunchPackage(f.config, signal());
  vi.mocked(mkdir).mockClear();
  await expect(source.stageWorker(join(dirname(f.reservation), "other"), signal(), process.hrtime.bigint() + 60_000_000_000n)).rejects.toThrow();
  expect(mkdir).not.toHaveBeenCalled(); expect(copyFile).not.toHaveBeenCalled(); expect(await readdir(f.reservation)).toEqual([]);
});
