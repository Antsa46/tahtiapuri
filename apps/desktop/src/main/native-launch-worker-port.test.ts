import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const state = vi.hoisted(() => ({ opened: [] as string[], closed: 0, workerCalls: 0,
  corrupt: undefined as string | undefined, reparse: undefined as string | undefined,
  pathError: undefined as { leaf: string; code: string } | undefined, nonDirectory: undefined as string | undefined,
  hold: undefined as Promise<void> | undefined }));
const bytes = (path: string) => Buffer.from("Synthetic non-executable fixture: " + basename(path));
vi.mock("node:worker_threads", () => ({ Worker: class {
  constructor() { ++state.workerCalls; throw new Error("A native-launch loader unit test must never construct a Worker"); }
} }));
vi.mock("node:fs/promises", () => {
  const file = (path: string) => /\.(exe|js)$/.test(path);
  const info = (path: string) => ({ dev: 1, ino: path.length, size: file(path) ? bytes(path).length : 0,
    nlink: 1, mtimeMs: 1, ctimeMs: 1, isFile: () => file(path), isDirectory: () => !file(path) && basename(path) !== state.nonDirectory,
    isSymbolicLink: () => basename(path) === state.reparse });
  return {
    lstat: async (path: string) => { if (basename(path) === state.pathError?.leaf) throw Object.assign(new Error("Synthetic path failure"), { code: state.pathError.code }); return info(path); },
    realpath: async (path: string) => path,
    open: async (path: string) => {
      state.opened.push(path);
      return {
        stat: async () => info(path),
        read: async (target: Buffer, offset: number, length: number, position: number) => {
          await state.hold;
          const content = bytes(path); if (basename(path) === state.corrupt) content[0]! ^= 1;
          const count = Math.max(0, Math.min(length, content.length - position));
          content.copy(target, offset, position, position + count); return { bytesRead: count, buffer: target };
        },
        close: async () => { ++state.closed; },
      };
    },
  };
});
const config = () => ({ schema: 1 as const, pid: process.pid,
  identity: "C:\\synthetic\\runtime\\helpers\\main-identity.exe",
  bootstrap: "C:\\synthetic\\runtime\\helpers\\main-bootstrap.exe",
  broker: "C:\\synthetic\\runtime\\bin\\mcp-broker.exe",
  controlFile: "C:\\synthetic\\control\\main-bootstrap.bin", env: { SystemRoot: "C:\\Windows" } });
async function setup() {
  const module = await import("./native-launch-worker-port.js");
  const pin = (path: string) => ({ bytes: bytes(path).length, sha256: createHash("sha256").update(bytes(path)).digest("hex") });
  const input = { config: config(), recoverProtocol: "THREC001" as const,
    programs: { identity: pin("main-identity.exe"), bootstrap: pin("main-bootstrap.exe"), broker: pin("mcp-broker.exe") },
    compiled: Object.fromEntries(module.NATIVE_LAUNCH_WORKER_FILES.map(name => [name, pin(name)])) as Record<typeof module.NATIVE_LAUNCH_WORKER_FILES[number], ReturnType<typeof pin>> };
  return { module, input };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => { vi.resetModules(); state.opened = []; state.closed = 0; state.workerCalls = 0; state.corrupt = undefined; state.reparse = undefined; state.hold = undefined; state.pathError = undefined; state.nonDirectory = undefined; });
afterEach(() => { expect(state.workerCalls).toBe(0); });
const test = process.platform === "win32" ? it : it.skip;
test("verifies the three program bytes and six compiled runtime files without starting a Worker", async () => {
  const f = await setup(), owner = await f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal);
  expect(owner.status()).toEqual({ pending: false, uncertain: false });
  expect(state.opened.map(path => basename(path)).sort()).toEqual([
    "main-identity.exe", "main-bootstrap.exe", "mcp-broker.exe", ...f.module.NATIVE_LAUNCH_WORKER_FILES].sort());
  expect(state.closed).toBe(9); expect(Object.isFrozen(f.module.NATIVE_LAUNCH_WORKER_FILES)).toBe(true);
});
test("failed program verification closes its file and permanently claims this Main lifetime", async () => {
  const f = await setup(); state.corrupt = "main-identity.exe";
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow("bytes differ");
  expect(state.closed).toBe(1); state.corrupt = undefined;
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow("already claimed");
  expect(state.opened).toHaveLength(1);
});
test("a missing compiled dependency pin fails closed before file work", async () => {
  const f = await setup(); delete (f.input.compiled as Partial<typeof f.input.compiled>)["native-recovery-grant.js"];
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow("build pins");
  expect(state.opened).toEqual([]);
});
test("changed compiled bytes are rejected after all opened verification handles close", async () => {
  const f = await setup(); state.corrupt = "native-recovery-grant.js";
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow("bytes differ");
  expect(state.opened).toHaveLength(8); expect(state.closed).toBe(8);
});
test("abort during an outstanding read retains the original claim until the read settles and its handle closes", async () => {
  const f = await setup(), abort = new AbortController();
  let release!: () => void; state.hold = new Promise<void>(resolve => { release = resolve; });
  const result = f.module.loadNativeLaunchWorkerSupervisor(f.input, abort.signal).catch(error => error);
  await turn(); expect(state.opened).toHaveLength(1); expect(state.closed).toBe(0);
  abort.abort();
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow("already claimed");
  release(); expect(await result).toBeInstanceOf(Error); expect(state.closed).toBe(1);
});
test("rejects redirected program files without opening them", async () => {
  const f = await setup(); state.reparse = "main-identity.exe";
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow();
  expect(state.opened).toEqual([]);
});

test("only an absent control leaf with an existing parent is allowed before directory preparation", async () => {
  const f = await setup(); state.pathError = { leaf: "control", code: "ENOENT" };
  const owner = await f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal);
  expect(owner.status()).toEqual({ pending: false, uncertain: false }); expect(state.closed).toBe(9);
});
for (const [leaf, code] of [["synthetic", "ENOENT"], ["control", "EACCES"], ["control", "EIO"]] as const)
  test("directory loader rejects " + leaf + " " + code + " without starting a Worker", async () => {
    const f = await setup(); state.pathError = { leaf, code };
    await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toMatchObject({ code });
    expect(state.opened).toEqual([]);
  });
test("an existing non-directory control leaf is rejected", async () => {
  const f = await setup(); state.nonDirectory = "control";
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow("Redirected"); expect(state.opened).toEqual([]);
});
test("an existing redirected control leaf is rejected", async () => {
  const f = await setup(); state.reparse = "control";
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow("Redirected"); expect(state.opened).toEqual([]);
});
test("directory script bytes require their own approved compiled pin", async () => {
  const f = await setup(); state.corrupt = "native-directory-grant.js";
  await expect(f.module.loadNativeLaunchWorkerSupervisor(f.input, new AbortController().signal)).rejects.toThrow("bytes differ");
  expect(state.opened).toHaveLength(9); expect(state.closed).toBe(9);
});
