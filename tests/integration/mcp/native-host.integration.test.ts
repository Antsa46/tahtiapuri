import { securePrivateDirectory } from "../../../apps/desktop/src/main/private-directory.js";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { NativeMcpHostResources } from "../../../apps/desktop/src/main/native-mcp-resources.js";
import { NativeDevelopmentHost, type NativeDevelopmentResourceLoader, type NativeDevelopmentResources } from "../../../apps/desktop/src/main/native-development-host.js";
import { DevelopmentHost } from "../../../apps/desktop/src/main/development-host.js";
import type { NativeMcpHelpers } from "../../../apps/desktop/src/main/native-mcp-helpers.js";
import { NativeBootstrapProcessError } from "../../../apps/desktop/src/main/native-bootstrap-operation.js";
import { decodeNativeBootstrap, NATIVE_PIPE_PREFIX } from "../../../apps/desktop/src/main/native-development-bootstrap.js";
import { ControlKind, NativeControlReader, encodeControlFrame, type ControlFrame } from "../../../apps/desktop/src/main/native-development-wire.js";
import { DevelopmentService } from "../../../apps/backend/src/modules/development/application/development-service.js";
import { AssistantService } from "../../../apps/backend/src/modules/assistant/application/assistant-service.js";
import { isDevelopmentIdentity, isDevelopmentInvocation } from "@tahtiapuri/validation/development";
import type { BackendController } from "../../../apps/desktop/src/main/backend-controller.js";

// All resource/close records are synthetic controller fixtures. Real Node
// files and local pipes exercise Host ordering, not ACL/native/Worker proofs.
const enabled = process.platform === "win32";
const test = enabled ? it : it.skip;
let base: string, helpers: NativeMcpHelpers;
import { syntheticHostResources, observeSyntheticHostWork, withSyntheticTaskSettlement } from "../../support/mcp/synthetic-host-resources.js";
const actorGuard = vi.hoisted(() => {
  let attempts = 0; return { attempts: () => attempts, invoke: () => { ++attempts; throw new Error("Application actor forbidden in Host fixture"); } };
});
vi.mock("node:child_process", () => ({ spawn: actorGuard.invoke, execFile: actorGuard.invoke }));
vi.mock("node:worker_threads", () => ({ Worker: actorGuard.invoke }));
vi.mock("../../../apps/desktop/src/main/private-directory.js", () => ({
  securePrivateDirectory: async (path: string, signal?: AbortSignal) => { signal?.throwIfAborted(); await mkdir(path, { recursive: true }); },
}));
const cleanups: (() => Promise<void>)[] = [];
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const absent = async (path: string) => expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeAll(async () => {
  if (!enabled) return;
  await mkdir(".artifacts/tests", { recursive: true });
  base = await mkdtemp(join(process.cwd(), ".artifacts/tests/mcp-host-"));
  helpers = {
    identity: async signal => { signal?.throwIfAborted(); return { pid: process.pid, creationTime: 1n }; },
    operate: async (operation, file, bytes, signal) => {
      signal?.throwIfAborted();
      // Minimal file effects chosen by the test port, not a JS implementation
      // of native publication, checksums, grants, ACLs or recovery.
      if (operation === "publish") await writeFile(file, bytes!, { flag: "wx" });
      if (operation === "consume") await unlink(file);
    },
  };
}, 30000);
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(async () => { expect(actorGuard.attempts()).toBe(0); if (base) await rm(base, { recursive: true, force: true }); });
function backend() {
  const assistant = new AssistantService({ run: async () => ({ text: "Synthetic", info: null, error: null }), cancel: () => {} });
  const service = new DevelopmentService(assistant), operations: string[] = [];
  const development: BackendController["development"] = async (operation, value) => {
    operations.push(operation);
    if (operation === "development.status") return service.status();
    if (operation === "development.configure" && (typeof value === "string" || value === null)) return service.configure(value);
    if (operation === "development.attach" && isDevelopmentIdentity(value)) return service.attach(value);
    if (operation === "development.detach" && isDevelopmentIdentity(value)) return service.detach(value);
    if (operation === "development.invoke" && isDevelopmentInvocation(value)) return service.invoke(value);
    throw new Error("Unexpected test operation");
  };
  cleanups.push(async () => { service.configure(null); assistant.dispose(); });
  return { port: { development }, service, operations };
}
// All actual application actors are replaced by explicit synthetic ports.
const syntheticResources = (file: string, custom: NativeMcpHelpers, prepareWorker: NativeMcpHostResources["prepareWorker"] = async () => {},
  session: NativeMcpHostResources["session"] = async (operation, target, bytes, signal) => {
    signal.throwIfAborted(); if (operation === "publish") await custom.operate("publish", target, bytes, signal);
  }) => syntheticHostResources(file, custom, prepareWorker, session);
async function fixture(custom: NativeMcpHelpers = helpers, root?: string, prepareWorker?: NativeMcpHostResources["prepareWorker"], session?: NativeMcpHostResources["session"],
  loaderHook?: (resources: NativeDevelopmentResources, deadline: number, signal: AbortSignal) => Promise<NativeDevelopmentResources>) {
  const b = backend(), directory = root ?? await mkdtemp(join(base, "host-"));
  // The fixture replaces directory ACL preparation with mkdir. No ACL claim.
  const control = join(directory, "control"), resources = syntheticResources(join(control, "main-bootstrap.bin"), custom, prepareWorker, session);
  const load = vi.fn<NativeDevelopmentResourceLoader>((deadline, signal) => loaderHook ? loaderHook(resources, deadline, signal) : Promise.resolve(resources));
  const host = new NativeDevelopmentHost(b.port, control, load);
  cleanups.push(async () => { await host.stop(); await observeSyntheticHostWork(resources); });
  return { ...b, host, load, resources, directory, control, file: join(control, "main-bootstrap.bin"), reservation: join(control, "native-session-reserved") };
}
async function peer(file: string) {
  const bytes = await readFile(file), value = decodeNativeBootstrap(bytes);
  const socket = createConnection(NATIVE_PIPE_PREFIX + value.pipeNonce);
  const frames: ControlFrame[] = [];
  const reader = new NativeControlReader("from-main", frame => frames.push(frame), () => {});
  socket.on("error", () => {}); socket.on("data", data => reader.write(data));
  const closed = new Promise<void>(resolve => socket.once("close", resolve));
  cleanups.push(async () => { reader.stop(); socket.destroy(); await closed; });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let sequence = 1;
  const send = (kind: typeof ControlKind[keyof typeof ControlKind], body = Buffer.alloc(0)) =>
    socket.write(encodeControlFrame({ kind, body }, sequence++, "to-main"));
  const next = async () => {
    const deadline = Date.now() + 4000;
    while (!frames.length && Date.now() < deadline && !socket.destroyed) await tick();
    if (!frames.length) throw new Error("Test frame deadline");
    return frames.shift()!;
  };
  return { socket, frames, send, next, closed, hello: () => send(ControlKind.hello, bytes.subarray(48)) };
}
test("joins descriptor helpers, local pipe and backend; CLEAN requests native retirement", async () => {
  const f = await fixture(); expect(await f.host.setEnabled(true, performance.now() + 60000)).toMatchObject({ ok: true, status: { enabled: true } });
  const client = await peer(f.file); client.hello(); expect((await client.next()).kind).toBe(ControlKind.accept);
  await absent(f.file); expect(f.service.status()).toMatchObject({ status: { connected: true } });
  client.send(ControlKind.request, Buffer.from(JSON.stringify({ id: randomUUID(), operation: "status", input: null })));
  expect((await client.next()).kind).toBe(ControlKind.response);
  const stopped = f.host.stop(); expect((await client.next()).kind).toBe(ControlKind.stop); client.send(ControlKind.clean);
  expect(await stopped).toMatchObject({ failed: false, descriptorRemoved: true, helperExitVerified: true,
    backendRevoked: true, listenerClosed: true, brokerCleanupReported: true, reservationCreated: true, reservationReleased: true });
  await access(f.reservation); expect(f.operations.slice(-2)).toEqual(["development.detach", "development.configure"]);
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  const restarted = await fixture(helpers, f.directory);
  expect((await restarted.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  expect(restarted.operations).not.toContain("development.configure"); await access(f.reservation);
});
test("an invalid unauthenticated peer does not consume the valid ticket", async () => {
  const f = await fixture(); await f.host.setEnabled(true, performance.now() + 60000);
  const bad = await peer(f.file); bad.send(ControlKind.hello, Buffer.alloc(48)); await bad.closed;
  await access(f.file);
  const good = await peer(f.file); good.hello(); expect((await good.next()).kind).toBe(ControlKind.accept);
  good.send(ControlKind.clean); await good.closed;
  expect((await f.host.stop()).failed).toBe(false);
});
test("disable before authentication removes the descriptor and requests native pristine release", async () => {
  const f = await fixture(); await f.host.setEnabled(true, performance.now() + 60000);
  expect(await f.host.setEnabled(false)).toMatchObject({ ok: true, status: { enabled: false } });
  expect(await f.host.stop()).toMatchObject({ failed: false, descriptorRemoved: true, brokerCleanupReported: false, reservationReleased: true });
  // The synthetic session port acknowledges release but performs no deletion.
  await absent(f.file); await access(f.reservation);
});
test("a peer discovering the renamed file waits for publisher close before consumption and ACCEPT", async () => {
  const published = gate(), release = gate(), calls: string[] = [];
  const wrapped: NativeMcpHelpers = { identity: helpers.identity, operate: async (...args) => {
    calls.push(args[0]); await helpers.operate(...args);
    if (args[0] === "publish") { published.resolve(); await release.promise; }
  }};
  const f = await fixture(wrapped), opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await published.promise; const client = await peer(f.file); client.hello(); await tick(); await tick();
    expect(client.frames).toEqual([]); expect(calls).not.toContain("consume");
    release.resolve(); await opening; expect((await client.next()).kind).toBe(ControlKind.accept);
    expect(calls).toEqual(["recover", "publish", "consume"]);
    client.send(ControlKind.clean); await client.closed; expect((await f.host.stop()).failed).toBe(false);
  } finally { release.resolve(); }
});
test("stop during publication retains original settlement and forbids mutation after owner failure", async () => {
  const published = gate(), release = gate(), calls: string[] = [];
  const wrapped: NativeMcpHelpers = { identity: helpers.identity, operate: async (...args) => {
    calls.push(args[0]); await helpers.operate(...args);
    if (args[0] === "publish") { published.resolve(); await release.promise; }
  }};
  const f = await fixture(wrapped), opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await published.promise; const closing = f.host.stop();
    await tick(); expect(calls).toEqual(["recover", "publish"]);
    release.resolve(); await opening;
    expect(await closing).toMatchObject({ failed: true, descriptorRemoved: false, listenerClosed: true, brokerCleanupReported: false, resourceOwnerHealthy: false });
    expect(calls).toEqual(["recover", "publish"]); await access(f.file); await access(f.reservation);
  } finally { release.resolve(); }
});
test("uncertain publisher exit prevents a second helper operation and preserves evidence", async () => {
  const calls: string[] = [];
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => {
    calls.push(args[0]); if (args[0] === "publish") throw new NativeBootstrapProcessError(false);
    await helpers.operate(...args);
  }});
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, helperExitVerified: false, descriptorRemoved: false, listenerClosed: true });
  expect(calls).toEqual(["recover", "publish"]); await access(f.reservation);
});
test("legacy and native hosts cannot share a backend even while disabled or after stop", async () => {
  const b = backend(), root = join(base, "exclusive"); const host = new NativeDevelopmentHost(b.port, root, async () => syntheticResources(join(root, "main-bootstrap.bin"), helpers));
  expect(() => new DevelopmentHost(b.port, root)).toThrow("already has an owner");
  await host.stop(); expect(() => new NativeDevelopmentHost(b.port, root, async () => syntheticResources(join(root, "main-bootstrap.bin"), helpers))).toThrow("already has an owner");
  const other = backend(); new DevelopmentHost(other.port, root);
  expect(() => new NativeDevelopmentHost(other.port, root, async () => syntheticResources(join(root, "main-bootstrap.bin"), helpers))).toThrow("already has an owner");
});
// Six legacy helper-package oracles moved to native-mcp-helpers.test.ts,
// where source verification is tested with synthetic bytes and mocked calls.

test("stop closes the listener and revokes the backend while publication settlement is still pending", async () => {
  const published = gate(), release = gate();
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => {
    await helpers.operate(...args);
    if (args[0] === "publish") { published.resolve(); await release.promise; }
  }});
  const opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await published.promise; const bytes = decodeNativeBootstrap(await readFile(f.file));
    const closing = f.host.stop();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const result = f.service.status(); if (result.ok && "status" in result && !result.status.enabled) break;
      await tick();
    }
    expect(f.service.status()).toMatchObject({ status: { enabled: false } });
    const socket = createConnection(NATIVE_PIPE_PREFIX + bytes.pipeNonce);
    let connected = false;
    socket.once("connect", () => { connected = true; socket.destroy(); });
    socket.on("error", () => {});
    await new Promise<void>(resolve => socket.once("close", resolve));
    expect(connected).toBe(false);
    release.resolve(); await opening;
    expect(await closing).toMatchObject({ backendRevoked: true, listenerClosed: true });
  } finally { release.resolve(); await opening; }
});
test("synchronous abort reentry shares one stop promise without failed-owner cleanup", async () => {
  const published = gate(), release = gate(); let reentered: ReturnType<NativeDevelopmentHost["stop"]> | undefined;
  let consumes = 0, f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ identity: helpers.identity, operate: async (...args) => {
    if (args[0] === "consume") consumes++;
    await helpers.operate(...args);
    if (args[0] === "publish") {
      args[3]!.addEventListener("abort", () => { reentered = f.host.stop(); }, { once: true });
      published.resolve(); await release.promise;
    }
  }});
  const opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await published.promise; const closing = f.host.stop(); expect(reentered).toBe(closing);
    release.resolve(); await opening; expect((await closing).descriptorRemoved).toBe(false); expect(consumes).toBe(0); await access(f.file);
  } finally { release.resolve(); await opening; }
});
test("stop before opening does not claim a created reservation or examined descriptor", async () => {
  const f = await fixture(); expect(await f.host.stop()).toMatchObject({
    failed: false, reservationCreated: false, reservationReleased: false, descriptorRemoved: false,
  }); await absent(f.control);
});

test("a rejected synthetic recovery never reports an existing descriptor as removed", async () => {
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => {
    if (args[0] === "recover") throw new NativeBootstrapProcessError(true);
    await helpers.operate(...args);
  } });
  await securePrivateDirectory(f.control); await writeFile(f.file, "malformed descriptor");
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, descriptorRemoved: false, reservationCreated: true });
  expect(await readFile(f.file, "utf8")).toBe("malformed descriptor"); await access(f.reservation);
});
test("listener bounds total live unauthenticated connections to four", async () => {
  const f = await fixture(); await f.host.setEnabled(true, performance.now() + 60000);
  const peers = []; for (let i = 0; i < 4; i++) peers.push(await peer(f.file));
  const bytes = decodeNativeBootstrap(await readFile(f.file));
  const extra = createConnection(NATIVE_PIPE_PREFIX + bytes.pipeNonce);
  extra.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { extra.destroy(); reject(new Error("Extra connection remained live")); }, 1000);
    extra.once("close", () => { clearTimeout(timer); resolve(); });
  });
  expect(peers.every(client => !client.socket.destroyed)).toBe(true);
  const closed = f.host.stop(); await Promise.all(peers.map(client => client.closed));
  expect((await closed).listenerClosed).toBe(true);
});
test("a fixed accept window closes the host after sixteen rejected peers", async () => {
  const f = await fixture(); await f.host.setEnabled(true, performance.now() + 60000);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    for (let i = 0; i < 17; i++) {
      const client = await peer(f.file);
      if (i < 16) client.send(ControlKind.hello, Buffer.alloc(48));
      await client.closed;
    }
    expect(await f.host.stop()).toMatchObject({ failed: true, listenerClosed: true, backendRevoked: true });
  } finally { clock.mockRestore(); }
});

test("terminal stop timeout forbids a late publisher from starting another helper", async () => {
  const published = gate(), release = gate(), calls: string[] = [];
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => {
    calls.push(args[0]);
    if (args[0] === "consume") return; // Observe the forbidden dispatch without starting a late test process.
    await helpers.operate(...args);
    if (args[0] === "publish") { published.resolve(); await release.promise; }
  }});
  const opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await published.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = f.host.stop(); await vi.advanceTimersByTimeAsync(30001);
    expect(await closing).toMatchObject({ failed: true, helperExitVerified: false });
    release.resolve(); await opening; await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers(); await tick(); await tick();
    expect(calls).toEqual(["recover", "publish"]); await access(f.reservation);
  } finally { vi.useRealTimers(); release.resolve(); await opening; }
});


test("does not publish until the required worker preparation settles", async () => {
  const entered = gate(), release = gate(), calls: string[] = []; let prepared = false, expectedReservation: string | undefined;
  const wrapped: NativeMcpHelpers = {
    identity: async signal => { calls.push("identity"); expect(prepared).toBe(false); return helpers.identity(signal); },
    operate: async (...args) => { calls.push(args[0]); if (args[0] === "publish") expect(prepared).toBe(true); await helpers.operate(...args); },
  };
  const f = await fixture(wrapped, undefined, async (reservation, signal) => {
    expect(reservation).toBe(expectedReservation); signal.throwIfAborted(); entered.resolve(); await release.promise;
    signal.throwIfAborted(); prepared = true;
  });
  expectedReservation = f.reservation; const opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await entered.promise;
    expect(calls).toEqual(["recover", "identity"]); expect(f.operations).not.toContain("development.configure");
    await absent(f.file); await absent(join(f.control, "main-bootstrap.pending"));
    release.resolve(); expect(await opening).toMatchObject({ ok: true, status: { enabled: true } });
    expect(calls).toEqual(["recover", "identity", "publish"]); await access(f.file);
  } finally { release.resolve(); await opening; }
});
for (const late of ["resolve", "reject"] as const)
  test("stop during preparation blocks late " + late + " from publishing or configuring", async () => {
    const entered = gate(), release = gate(), calls: string[] = []; let observedSignal: AbortSignal | undefined;
    const wrapped: NativeMcpHelpers = {
      identity: async signal => { calls.push("identity"); return helpers.identity(signal); },
      operate: async (...args) => { calls.push(args[0]); await helpers.operate(...args); },
    };
    const f = await fixture(wrapped, undefined, async (reservation, signal) => {
      observedSignal = signal; await mkdir(join(reservation, "worker"));
      await writeFile(join(reservation, "worker/partial.bin"), "partial synthetic stage");
      entered.resolve(); await release.promise;
      if (late === "reject") throw new Error("Late synthetic stage failure");
    });
    const opening = f.host.setEnabled(true, performance.now() + 60000);
    try {
      await entered.promise; const closing = f.host.stop();
      expect(observedSignal?.aborted).toBe(true); release.resolve();
      expect((await opening).ok).toBe(false);
      expect(await closing).toMatchObject({ descriptorRemoved: true, listenerClosed: true, reservationCreated: true, reservationReleased: false });
      expect(calls).toEqual(["recover", "identity"]); expect(f.operations).not.toContain("development.configure");
      await absent(f.file); await absent(join(f.control, "main-bootstrap.pending"));
      expect(await readFile(join(f.reservation, "worker/partial.bin"), "utf8")).toBe("partial synthetic stage");
    } finally { release.resolve(); await opening; }
  });
test("a failed partial stage is retained and cannot be reopened or bypassed", async () => {
  let attempts = 0; const calls: string[] = [];
  const wrapped: NativeMcpHelpers = { identity: helpers.identity, operate: async (...args) => { calls.push(args[0]); await helpers.operate(...args); } };
  const f = await fixture(wrapped, undefined, async reservation => {
    ++attempts; await mkdir(join(reservation, "worker")); await writeFile(join(reservation, "worker/partial.bin"), "retained");
    throw new Error("Synthetic copy failure");
  });
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, descriptorRemoved: true, reservationCreated: true, reservationReleased: false });
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false); expect(attempts).toBe(1); expect(calls).toEqual(["recover"]);
  expect(f.operations).not.toContain("development.configure"); await absent(f.file);
  expect(await readFile(join(f.reservation, "worker/partial.bin"), "utf8")).toBe("retained");
  const restarted = await fixture(wrapped, f.directory, async () => { throw new Error("Existing reservation bypassed"); });
  expect((await restarted.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false); expect(calls).toEqual(["recover"]);
});
test("an immediate stop never begins worker preparation", async () => {
  let attempts = 0;
  const f = await fixture(helpers, undefined, async () => { ++attempts; });
  const opening = f.host.setEnabled(true, performance.now() + 60000), closing = f.host.stop();
  expect((await opening).ok).toBe(false); await closing;
  expect(attempts).toBe(0); expect(f.operations).not.toContain("development.configure"); await absent(f.file);
});


test("retains an overdue preparation promise after the full close deadline and never publishes late", async () => {
  const entered = gate(), release = gate(), calls: string[] = [];
  const wrapped: NativeMcpHelpers = {
    identity: async signal => { calls.push("identity"); return helpers.identity(signal); },
    operate: async (...args) => { calls.push(args[0]); await helpers.operate(...args); },
  };
  const f = await fixture(wrapped, undefined, async reservation => {
    await mkdir(join(reservation, "worker")); await writeFile(join(reservation, "worker/partial.bin"), "overdue stage");
    entered.resolve(); await release.promise;
  });
  const opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await entered.promise; vi.useFakeTimers();
    const closing = f.host.stop(); await vi.advanceTimersByTimeAsync(30001);
    const outcome = await closing;
    expect(outcome).toMatchObject({ failed: true, descriptorRemoved: false, reservationCreated: true, reservationReleased: false });
    expect(calls).toEqual(["recover", "identity"]); expect(f.operations).not.toContain("development.configure");
    await absent(f.file); await absent(join(f.control, "main-bootstrap.pending"));
    release.resolve(); expect((await opening).ok).toBe(false); expect(await f.host.stop()).toBe(outcome);
    expect(calls).toEqual(["recover", "identity"]); expect(f.operations).not.toContain("development.configure");
    expect(await readFile(join(f.reservation, "worker/partial.bin"), "utf8")).toBe("overdue stage");
    await absent(f.file);
  } finally { vi.useRealTimers(); release.resolve(); await opening; }
});

test("native session prepares and seals before backend configuration and publication", async () => {
  const calls: string[] = []; let prepared = false, f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(helpers, undefined, async () => { calls.push("stage"); prepared = true; }, async (operation, file, bytes, signal) => {
    calls.push(operation);
    if (operation === "prepare" || operation === "seal") expect(f.operations).not.toContain("development.configure");
    if (operation === "seal") expect(prepared).toBe(true);
    if (operation === "publish") {
      expect(prepared).toBe(true); expect(f.operations).toContain("development.configure");
      await helpers.operate("publish", file, bytes, signal);
    }
  });
  expect(await f.host.setEnabled(true, performance.now() + 60000)).toMatchObject({ ok: true, status: { enabled: true } });
  expect(calls).toEqual(["prepare", "stage", "seal", "publish"]);
  expect(await f.host.stop()).toMatchObject({ failed: false, descriptorRemoved: true });
});
for (const operation of ["prepare", "seal"] as const)
  test("stop during native " + operation + " forbids later configuration or publication", async () => {
    const entered = gate(), release = gate(), calls: string[] = [];
    const f = await fixture(helpers, undefined, undefined, async (step, _file, _bytes, signal) => {
      calls.push(step);
      if (step === operation) { entered.resolve(); await release.promise; expect(signal.aborted).toBe(true); }
      if (step === "release-pristine") { expect(operation).toBe("seal"); expect(signal.aborted).toBe(false); }
    });
    const opening = f.host.setEnabled(true, performance.now() + 60000);
    try {
      await entered.promise; const closing = f.host.stop(); release.resolve();
      expect((await opening).ok).toBe(false);
      // The new owner is sticky-failed after abort. A late synthetic seal
      // success cannot authorize cleanup through that same failed owner.
      expect(await closing).toMatchObject({ failed: true, descriptorRemoved: true, reservationReleased: false, resourceOwnerHealthy: false });
      expect(f.operations).not.toContain("development.configure"); expect(calls).not.toContain("publish");
      expect(calls).toEqual(operation === "prepare" ? ["prepare"] : ["prepare", "seal"]);
      await absent(f.file); await access(f.reservation);
    } finally { release.resolve(); await opening; }
  });
for (const operation of ["prepare", "seal"] as const)
  test("uncertain native " + operation + " exit blocks every later session operation", async () => {
    const calls: string[] = [];
    const f = await fixture(helpers, undefined, undefined, async step => {
      calls.push(step); if (step === operation) throw new NativeBootstrapProcessError(false);
    });
    expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
    expect(await f.host.stop()).toMatchObject({ failed: true, helperExitVerified: false, reservationReleased: false });
    expect(calls).toEqual(operation === "prepare" ? ["prepare"] : ["prepare", "seal"]);
    expect(f.operations).not.toContain("development.configure"); await absent(f.file); await access(f.reservation);
  });


test("pristine release follows descriptor removal, listener close and backend revoke", async () => {
  const calls: string[] = []; let f!: Awaited<ReturnType<typeof fixture>>, input: Buffer | undefined;
  f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
    calls.push(operation); signal.throwIfAborted();
    if (operation === "publish") { await helpers.operate("publish", file, bytes, signal); return; }
    if (operation !== "release-pristine") return;
    await absent(file); expect(f.service.status()).toMatchObject({ status: { enabled: false, connected: false } });
    expect(f.operations.at(-1)).toBe("development.configure");
    const decoded = decodeNativeBootstrap(bytes);
    const socket = createConnection(NATIVE_PIPE_PREFIX + decoded.pipeNonce);
    const refused = new Promise<void>((resolve, reject) => {
      socket.once("connect", () => { socket.destroy(); reject(new Error("Listener still accepts during release")); });
      socket.once("error", () => resolve());
    });
    await refused; socket.destroy(); input = bytes; expect(bytes.some(byte => byte !== 0)).toBe(true);
  });
  await f.host.setEnabled(true, performance.now() + 60000);
  expect(await f.host.stop()).toMatchObject({ failed: false, reservationReleased: true, helperExitVerified: true });
  expect(calls).toEqual(["prepare", "seal", "publish", "release-pristine"]);
  expect(input?.every(byte => byte === 0)).toBe(true); expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
});
test("concurrent stop waits for one native release result", async () => {
  const entered = gate(), release = gate(), calls: string[] = [];
  const f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
    calls.push(operation);
    if (operation === "publish") await helpers.operate("publish", file, bytes, signal);
    if (operation === "release-pristine") { entered.resolve(); await release.promise; }
  });
  await f.host.setEnabled(true, performance.now() + 60000); const first = f.host.stop();
  try {
    await entered.promise; expect(f.host.stop()).toBe(first);
    let settled = false; void first.then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
    release.resolve(); expect(await first).toMatchObject({ failed: false, reservationReleased: true });
    expect(calls.filter(value => value === "release-pristine")).toHaveLength(1);
  } finally { release.resolve(); await first; }
});
for (const verified of [true, false])
  test("failed native pristine release preserves uncertainty: " + verified, async () => {
    const calls: string[] = [];
    const f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
      calls.push(operation);
      if (operation === "publish") await helpers.operate("publish", file, bytes, signal);
      if (operation === "release-pristine") throw new NativeBootstrapProcessError(verified);
    });
    await f.host.setEnabled(true, performance.now() + 60000);
    const result = await f.host.stop(); expect(result).toMatchObject({ failed: true, reservationReleased: false, helperExitVerified: verified });
    expect(await f.host.stop()).toBe(result); expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
    expect(calls.filter(value => value === "release-pristine")).toHaveLength(1); await access(f.reservation);
  });
test("an authenticated peer requests only native clean release after CLEAN", async () => {
  const calls: string[] = [];
  const f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
    calls.push(operation); if (operation === "publish") await helpers.operate("publish", file, bytes, signal);
  });
  await f.host.setEnabled(true, performance.now() + 60000); const client = await peer(f.file);
  client.hello(); expect((await client.next()).kind).toBe(ControlKind.accept);
  const closing = f.host.stop(); expect((await client.next()).kind).toBe(ControlKind.stop); client.send(ControlKind.clean);
  expect(await closing).toMatchObject({ failed: false, reservationReleased: true, brokerCleanupReported: true });
  expect(calls.filter(value => value === "release-clean")).toHaveLength(1);
  expect(calls).not.toContain("release-pristine"); await access(f.reservation); // Synthetic port, no deletion.
});
test("a release completing after the whole stop deadline never upgrades its result", async () => {
  const entered = gate(), release = gate(), calls: string[] = []; let releaseSignal: AbortSignal | undefined;
  const f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
    calls.push(operation);
    if (operation === "publish") await helpers.operate("publish", file, bytes, signal);
    if (operation === "release-pristine") { releaseSignal = signal; entered.resolve(); await release.promise; }
  });
  await f.host.setEnabled(true, performance.now() + 60000);
  const started = performance.now(), closing = f.host.stop();
  let restoreClock: (() => void) | undefined;
  try {
    await entered.promise;
    // Settle work first with a monotonic time beyond the deadline. This
    // reproduces a delayed timer callback without waiting on the wall clock.
    const clock = vi.spyOn(performance, "now").mockReturnValue(started + 60000);
    restoreClock = () => { clock.mockRestore(); }; release.resolve();
    const result = await closing; expect(result).toMatchObject({ failed: true, reservationReleased: false });
    expect(releaseSignal?.aborted).toBe(true); expect(await f.host.stop()).toBe(result);
    expect(calls.filter(value => value === "release-pristine")).toHaveLength(1);
  } finally { restoreClock?.(); release.resolve(); await closing; }
});

test("a consume settling after the stop deadline cannot dispatch pristine release", async () => {
  const entered = gate(), release = gate(); let releaseCalls = 0;
  const custom: NativeMcpHelpers = { identity: helpers.identity, operate: async (...args) => {
    await helpers.operate(...args);
    if (args[0] === "consume") { entered.resolve(); await release.promise; }
  } };
  const f = await fixture(custom, undefined, undefined, async (operation, file, bytes, signal) => {
    if (operation === "publish") await custom.operate("publish", file, bytes, signal);
    if (operation === "release-pristine") ++releaseCalls;
  });
  await f.host.setEnabled(true, performance.now() + 60000); const started = performance.now(), closing = f.host.stop();
  let restore: (() => void) | undefined;
  try {
    await entered.promise;
    const clock = vi.spyOn(performance, "now").mockReturnValue(started + 60000); restore = () => { clock.mockRestore(); };
    release.resolve(); const result = await closing;
    expect(result).toMatchObject({ failed: true, reservationReleased: false }); expect(releaseCalls).toBe(0);
    expect(await f.host.stop()).toBe(result); await access(f.reservation);
  } finally { restore?.(); release.resolve(); await closing; }
});

test("clean release follows descriptor removal, closed listener, backend revoke and one stop", async () => {
  const calls: string[] = []; let f!: Awaited<ReturnType<typeof fixture>>, input: Buffer | undefined;
  let reentered: ReturnType<NativeDevelopmentHost["stop"]> | undefined, forwardedDeadline: number | undefined;
  f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal, deadline) => {
    calls.push(operation); signal.throwIfAborted();
    if (operation === "publish") { await helpers.operate("publish", file, bytes, signal); return; }
    if (operation !== "release-clean") return;
    forwardedDeadline = deadline; reentered = f.host.stop(); await absent(file);
    expect(f.service.status()).toMatchObject({ status: { enabled: false, connected: false } });
    expect(f.operations.at(-1)).toBe("development.configure"); expect(signal.aborted).toBe(false);
    const decoded = decodeNativeBootstrap(bytes), socket = createConnection(NATIVE_PIPE_PREFIX + decoded.pipeNonce);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("Listener refusal deadline")); }, 1000);
        socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error("Listener still accepts during clean release")); });
        socket.once("error", () => { clearTimeout(timer); resolve(); });
      });
    } finally { socket.destroy(); }
    input = bytes; expect(bytes.some(byte => byte !== 0)).toBe(true);
  });
  await f.host.setEnabled(true, performance.now() + 60000); const client = await peer(f.file);
  client.hello(); expect((await client.next()).kind).toBe(ControlKind.accept);
  const closing = f.host.stop(); expect((await client.next()).kind).toBe(ControlKind.stop); client.send(ControlKind.clean);
  const result = await closing;
  expect(reentered).toBe(closing); expect(f.host.stop()).toBe(closing);
  expect(result).toMatchObject({ failed: false, reservationReleased: true, helperExitVerified: true });
  expect(forwardedDeadline).toBeTypeOf("number"); expect(forwardedDeadline!).toBeGreaterThan(performance.now());
  expect(calls).toEqual(["prepare", "seal", "publish", "release-clean"]);
  expect(input?.every(byte => byte === 0)).toBe(true); expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
});
for (const verified of [true, false])
  test("failed clean release never falls back or rearms: " + verified, async () => {
    const calls: string[] = [];
    const f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
      calls.push(operation); if (operation === "publish") await helpers.operate("publish", file, bytes, signal);
      if (operation === "release-clean") throw new NativeBootstrapProcessError(verified);
    });
    await f.host.setEnabled(true, performance.now() + 60000); const client = await peer(f.file);
    client.hello(); expect((await client.next()).kind).toBe(ControlKind.accept);
    const closing = f.host.stop(); expect((await client.next()).kind).toBe(ControlKind.stop); client.send(ControlKind.clean);
    expect(await closing).toMatchObject({ failed: true, reservationReleased: false, helperExitVerified: verified });
    expect(f.host.stop()).toBe(closing); expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
    expect(calls.filter(value => value === "release-clean")).toHaveLength(1); expect(calls).not.toContain("release-pristine");
    await access(f.reservation);
  });
test("an authenticated close without CLEAN dispatches neither release kind", async () => {
  const calls: string[] = [];
  const f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
    calls.push(operation); if (operation === "publish") await helpers.operate("publish", file, bytes, signal);
  });
  await f.host.setEnabled(true, performance.now() + 60000); const client = await peer(f.file);
  client.hello(); expect((await client.next()).kind).toBe(ControlKind.accept);
  const closing = f.host.stop(); expect((await client.next()).kind).toBe(ControlKind.stop); client.socket.destroy();
  expect(await closing).toMatchObject({ failed: true, reservationReleased: false, brokerCleanupReported: false });
  expect(calls.filter(value => value.startsWith("release-"))).toEqual([]); await access(f.reservation);
});
test("concurrent stop waits for one clean release request", async () => {
  const entered = gate(), release = gate(), calls: string[] = [];
  const f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
    calls.push(operation); if (operation === "publish") await helpers.operate("publish", file, bytes, signal);
    if (operation === "release-clean") { entered.resolve(); await release.promise; }
  });
  await f.host.setEnabled(true, performance.now() + 60000); const client = await peer(f.file);
  client.hello(); expect((await client.next()).kind).toBe(ControlKind.accept);
  const first = f.host.stop(); expect((await client.next()).kind).toBe(ControlKind.stop); client.send(ControlKind.clean);
  try {
    await entered.promise; expect(f.host.stop()).toBe(first); let settled = false; void first.then(() => { settled = true; });
    await tick(); expect(settled).toBe(false); release.resolve();
    expect(await first).toMatchObject({ failed: false, reservationReleased: true });
    expect(calls.filter(value => value === "release-clean")).toHaveLength(1); expect(calls).not.toContain("release-pristine");
  } finally { release.resolve(); await first; }
});
test("late clean release never upgrades the shared stop result", async () => {
  const entered = gate(), release = gate(), calls: string[] = []; let releaseSignal: AbortSignal | undefined;
  const f = await fixture(helpers, undefined, undefined, async (operation, file, bytes, signal) => {
    calls.push(operation); if (operation === "publish") await helpers.operate("publish", file, bytes, signal);
    if (operation === "release-clean") { releaseSignal = signal; entered.resolve(); await release.promise; }
  });
  await f.host.setEnabled(true, performance.now() + 60000); const client = await peer(f.file);
  client.hello(); expect((await client.next()).kind).toBe(ControlKind.accept);
  const started = performance.now(), closing = f.host.stop(); expect((await client.next()).kind).toBe(ControlKind.stop); client.send(ControlKind.clean);
  let restore: (() => void) | undefined;
  try {
    await entered.promise; const clock = vi.spyOn(performance, "now").mockReturnValue(started + 60000); restore = () => { clock.mockRestore(); };
    release.resolve(); const result = await closing; expect(result).toMatchObject({ failed: true, reservationReleased: false });
    expect(releaseSignal?.aborted).toBe(true); expect(f.host.stop()).toBe(closing);
    expect(calls.filter(value => value === "release-clean")).toHaveLength(1); expect(calls).not.toContain("release-pristine");
  } finally { restore?.(); release.resolve(); await closing; }
});


test("the loader receives the original deadline before directory preparation", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>, originalDeadline = 0;
  f = await fixture(helpers, undefined, undefined, undefined, async (resources, deadline, signal) => {
    expect(deadline).toBe(originalDeadline); expect(signal.aborted).toBe(false); await absent(f.control); return resources;
  });
  originalDeadline = performance.now() + 60000;
  expect((await f.host.setEnabled(true, originalDeadline)).ok).toBe(true); expect(f.load).toHaveBeenCalledOnce();
  expect(await f.host.stop()).toMatchObject({ failed: false, originalResourceWorkSettled: true, resourceOwnerHealthy: true });
});
for (const invalid of [0, NaN, Infinity]) test("invalid opening deadline forbids directory and loader IO: " + invalid, async () => {
  const f = await fixture(); expect((await f.host.setEnabled(true, invalid)).ok).toBe(false);
  await f.host.stop(); expect(f.load).not.toHaveBeenCalled(); await absent(f.control);
});
test("reentrant stop inside the loader retains the original work and forbids reservation creation after late return", async () => {
  const entered = gate(), release = gate(); let f!: Awaited<ReturnType<typeof fixture>>, reentered: ReturnType<NativeDevelopmentHost["stop"]> | undefined;
  f = await fixture(helpers, undefined, undefined, undefined, async resources => {
    entered.resolve(); reentered = f.host.stop(); await release.promise; return resources;
  });
  const opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await entered.promise; expect((await opening).ok).toBe(false); let closed = false;
    void reentered!.then(() => { closed = true; }); await tick(); expect(closed).toBe(false);
    release.resolve(); expect(await reentered).toMatchObject({ failed: true, reservationCreated: false });
    expect(f.load).toHaveBeenCalledOnce(); await absent(f.reservation);
  } finally { release.resolve(); await opening; }
});
test("a late loader return is rejected by the original clock without timer dispatch", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>, deadline = 0, restore: (() => void) | undefined;
  f = await fixture(helpers, undefined, undefined, undefined, async resources => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(deadline + 1); restore = () => { clock.mockRestore(); }; return resources;
  });
  deadline = performance.now() + 60000;
  try {
    expect((await f.host.setEnabled(true, deadline)).ok).toBe(false);
    expect(await f.host.stop()).toMatchObject({ failed: true, reservationCreated: false }); await absent(f.reservation);
  } finally { restore?.(); }
});
test("a loader cannot bind a different control file before the first resource operation", async () => {
  const calls: string[] = [];
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => { calls.push(args[0]); await helpers.operate(...args); } },
    undefined, undefined, undefined, async resources => ({ ...resources, controlFile: resources.controlFile.replace("main-bootstrap", "different") }));
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, resourceOwnerHealthy: false, reservationCreated: false });
  expect(calls).toEqual([]); await absent(f.reservation);
});
test("backend ownership is already claimed when the loader reenters construction", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(helpers, undefined, undefined, undefined, async resources => {
    expect(() => new NativeDevelopmentHost(f.port, f.control, async () => resources)).toThrow("already has an owner"); return resources;
  });
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(true);
  expect((await f.host.stop()).failed).toBe(false);
});
test("an unavailable staging observation retains the original work and never permits cleanup", async () => {
  const entered = gate(), release = gate(), calls: string[] = [];
  const f = await fixture(helpers, undefined, async reservation => {
    await writeFile(join(reservation, "unobserved-stage.bin"), "Synthetic retained work"); entered.resolve(); await release.promise;
  }, async operation => { calls.push(operation); }, async resources => {
    let target: Promise<unknown> | undefined;
    return { ...resources, prepareWorker: (deadline, signal) => { const original = resources.prepareWorker(deadline, signal); target = original; return original; },
      observeCall: original => { if (original === target) throw 0; return resources.observeCall(original); } };
  });
  const opening = f.host.setEnabled(true, performance.now() + 60000);
  try {
    await entered.promise; expect((await opening).ok).toBe(false); const outcome = await f.host.stop();
    expect(outcome).toMatchObject({ failed: true, originalResourceWorkSettled: false, helperExitVerified: false, reservationReleased: false });
    release.resolve(); await observeSyntheticHostWork(f.resources); expect(await f.host.stop()).toBe(outcome);
    expect(calls).toEqual(["prepare"]); expect(await readFile(join(f.reservation, "unobserved-stage.bin"), "utf8")).toBe("Synthetic retained work");
  } finally { release.resolve(); await opening; }
});
test("cleanup cannot mutate after its original deadline while a task observation is delayed", async () => {
  let resolve!: (value: { childCloseObserved: boolean; workerExited: boolean; workerExitCode: number; authorityCommitted: boolean; uncertain: boolean }) => void;
  const settled = new Promise<Parameters<typeof resolve>[0]>(done => { resolve = done; }), published = gate(), calls: string[] = [];
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => { calls.push(args[0]); await helpers.operate(...args); if (args[0] === "publish") published.resolve(); } },
    undefined, undefined, undefined, async resources => withSyntheticTaskSettlement(resources, "publish", settled));
  const opening = f.host.setEnabled(true, performance.now() + 60000); let restore: (() => void) | undefined;
  try {
    await published.promise; const began = performance.now(), closing = f.host.stop();
    const clock = vi.spyOn(performance, "now").mockReturnValue(began + 60000); restore = () => { clock.mockRestore(); };
    resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: true, uncertain: false });
    const outcome = await closing; expect(outcome).toMatchObject({ failed: true, descriptorRemoved: false, reservationReleased: false });
    expect(calls).toEqual(["recover", "publish"]); expect(await f.host.stop()).toBe(outcome); await access(f.file);
  } finally { restore?.(); resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: true, uncertain: false }); await opening; }
});
test("a rejected original native settlement blocks cleanup even if current owner status appears healthy", async () => {
  const reason = new Error("Synthetic original task settlement rejected"), settled = Promise.reject(reason); void settled.catch(() => {});
  const calls: string[] = [];
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => { calls.push(args[0]); await helpers.operate(...args); } },
    undefined, undefined, undefined, async resources => withSyntheticTaskSettlement(resources, "identity", settled));
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, resourceOwnerHealthy: false, helperExitVerified: false, reservationReleased: false });
  expect(calls).toEqual(["recover"]);
});

test("a fulfilled uncertain task settlement never authorizes cleanup from an apparently healthy owner", async () => {
  const calls: string[] = [];
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => { calls.push(args[0]); await helpers.operate(...args); } },
    undefined, undefined, undefined, async resources => withSyntheticTaskSettlement(resources, "publish", Promise.resolve({
      childCloseObserved: false, workerExited: false, workerExitCode: null, authorityCommitted: true, uncertain: true,
    })));
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, resourceOwnerHealthy: false, helperExitVerified: false, descriptorRemoved: false, reservationReleased: false });
  expect(calls).toEqual(["recover", "publish"]); await access(f.file);
});

test("load and immutable binding check precede the one directory preparation under the original deadline", async () => {
  const calls: string[] = []; let deadline = 0, f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(helpers, undefined, undefined, undefined, async resources => {
    calls.push("load"); await absent(f.control);
    return { ...resources, prepareDirectory: (originalDeadline, signal) => {
      calls.push("directory"); expect(originalDeadline).toBe(deadline); return resources.prepareDirectory(originalDeadline, signal);
    }, bootstrap: (operation, bytes, originalDeadline, signal) => {
      calls.push(operation); return resources.bootstrap(operation, bytes, originalDeadline, signal);
    } };
  });
  deadline = performance.now() + 60000; expect((await f.host.setEnabled(true, deadline)).ok).toBe(true);
  expect(calls.slice(0, 3)).toEqual(["load", "directory", "recover"]); await access(f.reservation);
  expect(await f.host.stop()).toMatchObject({ failed: false, originalResourceWorkSettled: true, resourceOwnerHealthy: true });
});
test("reentrant stop before directory dispatch never creates a control directory or reservation", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>, stop: ReturnType<NativeDevelopmentHost["stop"]> | undefined;
  f = await fixture(helpers, undefined, undefined, undefined, async resources => ({ ...resources,
    prepareDirectory: (deadline, signal) => { stop = f.host.stop(); return resources.prepareDirectory(deadline, signal); },
  }));
  expect((await f.host.setEnabled(true, performance.now() + 60000)).ok).toBe(false);
  expect(await stop).toMatchObject({ failed: true, reservationCreated: false }); await absent(f.control); await absent(f.reservation);
});
