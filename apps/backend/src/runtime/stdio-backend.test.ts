import { afterEach, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { BoundedWriter, FrameReader, KINDS, TRANSPORT_POLICY, decodeJson, encodeJson, frame } from "@tahtiapuri/backend-transport";
import { failStdioBackend, packagedCatalogDirectory, runStdioBackend, validStdioLaunch, validateBackendDataRoot } from "./stdio-backend.js";
import { JsonPlacesRepository } from "../modules/observing/adapters/json-places-repository.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, lstat: vi.fn(original.lstat), realpath: vi.fn(original.realpath) };
});

const nonce = "c".repeat(64), session = "d".repeat(64);
type Message = Record<string, unknown>;
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(now = Date.now, catalogDirectory?: string) {
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "tahtiapuri-stdio-"))); roots.push(dataRoot);
  const input = new PassThrough(), messages: Message[] = [], waiters: (() => void)[] = [];
  const reader = new FrameReader({ nonce, allowedKinds: [KINDS.APP], maxPayloadBytes: TRANSPORT_POLICY.childOutputBytes });
  const output = new Writable({ write(bytes: Buffer, _encoding, callback) {
    try { reader.push(bytes, record => { messages.push(decodeJson(record.body) as Message); for (const wake of waiters.splice(0)) wake(); }); callback(); }
    catch (error) { callback(error as Error); }
  } });
  const owner = new BoundedWriter(input, { nonce, allowedKinds: [KINDS.APP], maxPayloadBytes: TRANSPORT_POLICY.ownerInputBytes });
  // Missing catalog is an ordinary real SkyQueries error path, never a mocked service.
  const done = runStdioBackend({ dataRoot, catalogDirectory: catalogDirectory ?? join(dataRoot, "missing-catalog"), nonce, input, output, now, monotonicNow: now });
  const settled = Promise.allSettled([done]);
  async function next(predicate: (message: Message) => boolean): Promise<Message> {
    while (true) {
      const result = messages.find(predicate); if (result) return result;
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  }
  const send = (message: unknown) => owner.send(KINDS.APP, encodeJson(message, TRANSPORT_POLICY.ownerInputBytes));
  async function request(operation: string, inputValue?: unknown): Promise<Message> {
    const id = randomUUID();
    await send({ type: "request", protocol: 1, session, id, operation, expiresAtUnixMs: now() + 2500,
      ...(inputValue === undefined ? {} : { input: inputValue }) });
    return next(message => message.type === "response" && message.id === id);
  }
  async function initialize() { await send({ type: "initialize", protocol: 1, session }); return next(message => message.type === "ready"); }
  async function shutdown() { const response = await request("runtime.shutdown"); await owner.end(); await done; reader.finish(); return response; }
  return { dataRoot, input, output, messages, done, settled, initialize, shutdown, request, send, next, owner };
}

it("composes the actual backend and emits only application ready/request replies", async () => {
  const f = await fixture(); expect(await f.initialize()).toEqual({ type: "ready", protocol: 1, session });
  expect(await f.request("runtime.status")).toMatchObject({ operation: "runtime.status", result: { state: "ready", model: "managed-separately", protocolVersion: 1 } });
  expect(await f.request("observing.read")).toMatchObject({ operation: "observing.read", result: { ok: true } });
  expect(await f.shutdown()).toMatchObject({ type: "response", operation: "runtime.shutdown", result: null });
  expect(f.messages.every(message => ["ready", "response"].includes(message.type as string))).toBe(true);
  expect(f.messages.some(message => String(message.type).startsWith("probe."))).toBe(false);
});
it("serves more than 256 real backend requests in one session", async () => {
  const f = await fixture(); await f.initialize();
  for (let count = 0; count < 300; count++) expect(await f.request("runtime.ping")).toMatchObject({ operation: "runtime.ping", result: null });
  await f.shutdown();
});
it("derives catalog location from the closed staging entry layout", () => {
  const packageRoot = resolve("synthetic-package");
  expect(packagedCatalogDirectory(join(packageRoot, "backend", "dist", "runtime", "stdio-backend.js"))).toBe(join(packageRoot, "resources", "catalogs"));
});
it("returns a real successful sky snapshot from the repository catalog", async () => {
  const catalogDirectory = fileURLToPath(new URL("../../../../resources/catalogs/", import.meta.url));
  const f = await fixture(Date.now, catalogDirectory); await f.initialize();
  const observation = { atUtc: "2024-01-01T00:00:00.000Z", timeZone: "UTC", observer: { latitudeDeg: 0, longitudeDeg: 0, elevationMeters: 0 } };
  const response = await f.request("sky.snapshot", observation);
  expect(response).toMatchObject({ operation: "sky.snapshot", result: { ok: true, snapshot: { context: observation } } });
  const result = response.result as { snapshot: { objects: unknown[]; sources: unknown[] } };
  expect(result.snapshot.objects.length).toBeGreaterThan(0); expect(result.snapshot.sources.length).toBeGreaterThan(0); await f.shutdown();
});
it("routes model progress and terminal replies through the real parent engine and assistant", async () => {
  const f = await fixture(); await f.initialize();
  const submitted = await f.request("assistant.submit", { prompt: "Synteettinen kysymys", backend: "cpu" });
  const job = (submitted.result as { ok: true; job: { id: string } }).job;
  expect(await f.next(message => message.type === "model.run")).toMatchObject({ session, id: job.id, input: { prompt: "Synteettinen kysymys", backend: "cpu" } });
  await f.send({ type: "model.progress", session, id: job.id });
  expect(await f.request("assistant.get", job.id)).toMatchObject({ result: { ok: true, job: { state: "running" } } });
  await f.send({ type: "model.result", session, id: job.id, reply: { text: "", error: "ENGINE_UNAVAILABLE", info: null } });
  expect(await f.request("assistant.get", job.id)).toMatchObject({ result: { ok: true, job: { state: "error", error: "ENGINE_UNAVAILABLE" } } });
  await f.shutdown();
});
it("disposes an active real model job during shutdown without a post-shutdown model cancel or timer", async () => {
  vi.useFakeTimers();
  const f = await fixture(); await f.initialize(); await f.request("assistant.submit", { prompt: "Synteettinen", backend: "cpu" });
  expect(vi.getTimerCount()).toBeGreaterThan(1);
  await f.shutdown();
  expect(f.messages.at(-1)).toMatchObject({ operation: "runtime.shutdown" }); expect(vi.getTimerCount()).toBe(0);
});
it("expires accepted shutdown after two seconds when the owner leaves input open", async () => {
  vi.useFakeTimers(); let clock = 1000;
  const f = await fixture(() => clock); await f.initialize(); await f.request("assistant.submit", { prompt: "Synteettinen", backend: "cpu" });
  await f.request("runtime.shutdown");
  clock += 1999; await vi.advanceTimersByTimeAsync(1999); expect(vi.getTimerCount()).toBeGreaterThan(0);
  clock++; await vi.advanceTimersByTimeAsync(1); await expect(f.done).rejects.toThrow("shutdown deadline");
  expect(vi.getTimerCount()).toBe(0); f.input.end(); expect((await f.settled)[0]!.status).toBe("rejected");
});
it("includes pending real PlacesService.close work in the same shutdown deadline", async () => {
  vi.useFakeTimers(); let clock = Date.now(), releaseLoad!: (value: Awaited<ReturnType<JsonPlacesRepository["load"]>>) => void, entered!: () => void;
  const loading = new Promise<void>(resolveEntered => { entered = resolveEntered; });
  const heldLoad = new Promise<Awaited<ReturnType<JsonPlacesRepository["load"]>>>(resolveLoad => { releaseLoad = resolveLoad; });
  vi.spyOn(JsonPlacesRepository.prototype, "load").mockImplementation(() => { entered(); return heldLoad; });
  const f = await fixture(() => clock); await f.initialize();
  await f.send({ type: "request", protocol: 1, session, id: randomUUID(), operation: "observing.read", expiresAtUnixMs: clock + 2500 });
  await loading; await f.request("runtime.shutdown"); await f.owner.end();
  clock += 2000; await vi.advanceTimersByTimeAsync(2000); await expect(f.done).rejects.toThrow("shutdown deadline"); expect(vi.getTimerCount()).toBe(0);
  releaseLoad({ state: { revision: 0, places: [], activePlaceId: null }, token: null }); await Promise.resolve(); await Promise.resolve();
  expect((await f.settled)[0]!.status).toBe("rejected"); expect(f.messages.at(-1)).toMatchObject({ operation: "runtime.shutdown" });
});
it("rejects unexpected owner EOF and consumes late input/output errors", async () => {
  const f = await fixture(); await f.initialize(); await f.owner.end();
  await expect(f.done).rejects.toThrow("Unexpected owner EOF");
  expect(() => { f.input.emit("error", new Error("late input")); f.output.emit("error", new Error("late output")); }).not.toThrow();
  expect((await f.settled)[0]!.status).toBe("rejected");
});
it("fails when either stream closes before the shutdown/EOF handshake", async () => {
  for (const side of ["input", "output"] as const) {
    const f = await fixture(); await f.initialize(); f[side].destroy();
    await expect(f.done).rejects.toThrow(); expect((await f.settled)[0]!.status).toBe("rejected");
  }
});
it("rejects partial EOF, invalid UTF-8 and a second initialize even after earlier valid messages", async () => {
  for (const bad of ["partial", "utf8", "initialize"]) {
    const f = await fixture(); await f.initialize();
    if (bad === "partial") { f.input.write(frame(KINDS.APP, 2n, nonce, Buffer.from("{}")).subarray(0, 30)); f.input.end(); }
    else if (bad === "utf8") f.input.write(frame(KINDS.APP, 2n, nonce, Buffer.from([255])));
    else await f.send({ type: "initialize", protocol: 1, session });
    await expect(f.done).rejects.toThrow(); expect(f.messages).toHaveLength(1);
  }
});
it("rejects a message following shutdown in the same chunk instead of accepting later success", async () => {
  const f = await fixture(); await f.initialize();
  const request = (operation: string) => encodeJson({ type: "request", protocol: 1, session, id: randomUUID(), operation, expiresAtUnixMs: Date.now() + 2500 }, 65_536);
  f.input.write(Buffer.concat([frame(KINDS.APP, 2n, nonce, request("runtime.shutdown")), frame(KINDS.APP, 3n, nonce, request("runtime.ping"))]));
  f.input.end(); await expect(f.done).rejects.toThrow("after shutdown"); expect((await f.settled)[0]!.status).toBe("rejected");
});
it("allows a long session with regular owner pings and fails only after heartbeat inactivity", async () => {
  vi.useFakeTimers(); let now = 1000;
  const f = await fixture(() => now); await f.initialize();
  for (let turn = 0; turn < 8; turn++) { now += 9000; await f.request("runtime.ping"); await vi.advanceTimersByTimeAsync(9000); }
  now += 10_001; await vi.advanceTimersByTimeAsync(1000); await expect(f.done).rejects.toThrow("heartbeat expired"); expect(vi.getTimerCount()).toBe(0);
});
it("independently rejects relative, noncanonical, file, volume-root and symlink data roots", async () => {
  const f = await fixture(); await f.initialize();
  await expect(validateBackendDataRoot(f.dataRoot)).resolves.toBe(f.dataRoot);
  for (const path of ["relative", join(f.dataRoot, "missing"), f.dataRoot + "/..", f.dataRoot + "\0", "/"]) await expect(validateBackendDataRoot(path)).rejects.toThrow();
  const file = join(f.dataRoot, "file"); await writeFile(file, "synthetic"); await expect(validateBackendDataRoot(file)).rejects.toThrow();
  // Directory junctions do not require Windows developer-mode symlink privileges.
  const link = join(f.dataRoot, "link"); await symlink(f.dataRoot, link, process.platform === "win32" ? "junction" : "dir");
  await expect(validateBackendDataRoot(link)).rejects.toThrow(); await f.shutdown();
});
it("accepts a nested canonical root using only its metadata and rejects an ancestor junction before backend startup", async () => {
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "tahtiapuri-root-check-"))); roots.push(fixtureRoot);
  const realParent = join(fixtureRoot, "realParent"), dataRoot = join(realParent, "data");
  await mkdir(dataRoot, { recursive: true });
  vi.mocked(lstat).mockClear(); vi.mocked(realpath).mockClear();
  await expect(validateBackendDataRoot(dataRoot)).resolves.toBe(dataRoot);
  expect(lstat).toHaveBeenCalledExactlyOnceWith(dataRoot); expect(realpath).toHaveBeenCalledExactlyOnceWith(dataRoot);
  const aliasParent = join(fixtureRoot, "aliasParent");
  await symlink(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  const redirectedRoot = join(aliasParent, "data");
  await expect(validateBackendDataRoot(redirectedRoot)).rejects.toThrow("Noncanonical backend data root");
  const input = new PassThrough(), output = new PassThrough(), write = vi.spyOn(output, "write");
  await expect(runStdioBackend({ dataRoot: redirectedRoot, catalogDirectory: join(fixtureRoot, "missing-catalog"), nonce, input, output }))
    .rejects.toThrow("Noncanonical backend data root");
  expect(input.listenerCount("data")).toBe(0); expect(write).not.toHaveBeenCalled();
});
it("closes the production CLI argument/runtime/environment contract", () => {
  const runtime: Pick<NodeJS.Process, "argv" | "execArgv" | "versions" | "arch" | "env"> = { argv: ["node", "stdio-backend.js", "/synthetic/data", nonce], execArgv: ["--preserve-symlinks", "--preserve-symlinks-main"],
    versions: { node: "24.22.2" } as NodeJS.ProcessVersions, arch: "x64", env: {} };
  expect(validStdioLaunch(runtime)).toBe(true);
  expect(validStdioLaunch({ ...runtime, argv: [...runtime.argv, "extra"] })).toBe(false);
  expect(validStdioLaunch({ ...runtime, execArgv: ["--inspect"] })).toBe(false);
  expect(validStdioLaunch({ ...runtime, versions: { ...runtime.versions, electron: "42" } })).toBe(false);
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "UV_THREADPOOL_SIZE", "OPENSSL_CONF", "INSPECTOR_OPTIONS", "http_proxy", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"])
    expect(validStdioLaunch({ ...runtime, env: { [key]: "synthetic" } })).toBe(false);
});

function failureOutput() {
  const writes: Buffer[] = [];
  let flush!: (error?: Error | null) => void;
  const output = new Writable({ highWaterMark: 1, write(bytes: Buffer, _encoding, callback) {
    writes.push(Buffer.from(bytes)); flush = callback;
  } });
  const exit = vi.fn<(code: number) => void>();
  return { output, writes, exit, flush: (error?: Error) => flush(error),
    record: () => JSON.parse(Buffer.concat(writes).toString("utf8")) as Record<string, unknown> };
}

it("prints only bounded failure fields and preserves the CLI exit selection", () => {
  vi.useFakeTimers();
  for (const exitCode of [64, 65, 67, 68, 69, 512]) {
    const f = failureOutput();
    const error = Object.assign(new Error("synthetic private message"), {
      exitCode, code: "EACCES", syscall: "lstat", path: "synthetic/private/path", stack: "private stack",
      commandLine: "private command", session: "private session", phase: "data-root-root-lstat",
      toJSON: () => { throw new Error("Must not serialize the failure object."); }
    });
    failStdioBackend(error, f.output, f.exit);
    expect(f.record()).toEqual({ type: "tahti-backend-failure", exitCode: exitCode <= 255 ? exitCode : null,
      code: "EACCES", syscall: "lstat", phase: "runtime" });
    expect(f.writes).toHaveLength(1); expect(f.writes[0]!.byteLength).toBeLessThanOrEqual(256);
    expect(f.writes[0]!.toString()).not.toContain("private"); expect(f.exit).not.toHaveBeenCalled();
    f.output.emit("close"); expect(f.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
    expect(vi.getTimerCount()).toBe(0);
  }
  const f = failureOutput(); failStdioBackend({ exitCode: 69 }, f.output, f.exit);
  expect(f.record()).toMatchObject({ exitCode: 65, code: "UNKNOWN", syscall: "none" });
  f.output.emit("close"); expect(f.exit).toHaveBeenCalledExactlyOnceWith(65);
});

it("allows only fixed errno and syscall values without reading private getters", () => {
  vi.useFakeTimers();
  for (const code of ["EACCES", "EPERM", "ENOENT", "ELOOP", "ENOTDIR", "EINVAL", "EBADF"]) {
    for (const syscall of ["lstat", "realpath", "open", "read", "write", "none"]) {
      const f = failureOutput(); failStdioBackend(Object.assign(new Error(), { code, syscall }), f.output, f.exit);
      expect(f.record()).toMatchObject({ code, syscall }); f.output.emit("close");
    }
  }
  for (const value of ["private/path\nprivate message", {}, 7, null]) {
    const f = failureOutput(); failStdioBackend({ code: value, syscall: value }, f.output, f.exit);
    expect(f.record()).toMatchObject({ code: "UNKNOWN", syscall: null }); f.output.emit("close");
  }
  const error = new Error();
  const forbidden = vi.fn(() => { throw new Error("private getter"); });
  for (const key of ["stack", "message", "path", "commandLine", "session", "phase"])
    Object.defineProperty(error, key, { get: forbidden });
  for (const key of ["code", "syscall", "exitCode"])
    Object.defineProperty(error, key, { get: () => { throw new Error("private getter"); } });
  const f = failureOutput(); expect(() => failStdioBackend(error, f.output, f.exit)).not.toThrow();
  expect(f.record()).toEqual({ type: "tahti-backend-failure", exitCode: 65, code: "UNKNOWN", syscall: "none", phase: "runtime" });
  expect(forbidden).not.toHaveBeenCalled(); f.output.emit("close");
});

it("reports the program-owned root metadata phase and rethrows the same filesystem error", async () => {
  vi.useFakeTimers();
  const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "tahtiapuri-diagnostic-"))); roots.push(dataRoot);
  for (const phase of ["data-root-root-lstat", "data-root-root-realpath"]) {
    const syscall = phase.endsWith("-lstat") ? "lstat" : "realpath";
    const error = Object.assign(new Error("synthetic private failure"), { code: "EACCES", syscall });
    if (phase === "data-root-root-lstat") vi.mocked(lstat).mockRejectedValueOnce(error);
    if (phase === "data-root-root-realpath") vi.mocked(realpath).mockRejectedValueOnce(error);
    await expect(validateBackendDataRoot(dataRoot)).rejects.toBe(error);
    const f = failureOutput(); failStdioBackend(error, f.output, f.exit);
    expect(f.record()).toMatchObject({ code: "EACCES", syscall, phase });
    expect(f.writes[0]!.byteLength).toBeLessThanOrEqual(256); f.output.emit("close");
  }
});

it("exits once after a successful or failed write callback and consumes late stream errors", async () => {
  vi.useFakeTimers();
  for (const error of [undefined, new Error("synthetic write error")]) {
    const f = failureOutput(); failStdioBackend(new Error(), f.output, f.exit);
    f.flush(error); await new Promise<void>(resolveTick => process.nextTick(resolveTick));
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(65); expect(vi.getTimerCount()).toBe(0);
    expect(() => { f.output.emit("error", new Error("late")); f.output.emit("close"); }).not.toThrow();
    vi.advanceTimersByTime(200); expect(f.exit).toHaveBeenCalledTimes(1); expect(f.writes).toHaveLength(1);
  }
});

it("bounds a stalled write under backpressure to 200 ms without waiting for drain", () => {
  vi.useFakeTimers();
  const f = failureOutput(); failStdioBackend(new Error(), f.output, f.exit);
  expect(f.output.writableNeedDrain).toBe(true);
  vi.advanceTimersByTime(199); expect(f.exit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(f.exit).toHaveBeenCalledExactlyOnceWith(65); expect(vi.getTimerCount()).toBe(0);
  f.flush(); f.output.emit("drain"); f.output.emit("error", new Error("late")); f.output.emit("close");
  expect(f.exit).toHaveBeenCalledTimes(1); expect(f.writes).toHaveLength(1);
});

it("handles closed, throwing and errored stderr without another write or exit", () => {
  vi.useFakeTimers();
  const closed = failureOutput(); closed.output.destroy(); failStdioBackend(new Error(), closed.output, closed.exit);
  expect(closed.writes).toHaveLength(0); expect(closed.exit).toHaveBeenCalledExactlyOnceWith(65);
  const ended = failureOutput(); ended.output.end(); failStdioBackend(new Error(), ended.output, ended.exit);
  expect(ended.writes).toHaveLength(0); expect(ended.exit).toHaveBeenCalledExactlyOnceWith(65);
  const throwing = failureOutput();
  vi.spyOn(throwing.output, "write").mockImplementation(() => { throw new Error("synthetic write failure"); });
  expect(() => failStdioBackend(new Error(), throwing.output, throwing.exit)).not.toThrow();
  expect(throwing.exit).toHaveBeenCalledExactlyOnceWith(65);
  const errored = failureOutput(); failStdioBackend(new Error(), errored.output, errored.exit);
  expect(() => errored.output.emit("error", new Error("synthetic stderr failure"))).not.toThrow();
  expect(errored.exit).toHaveBeenCalledExactlyOnceWith(65);
  vi.advanceTimersByTime(200); expect(errored.exit).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
