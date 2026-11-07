import { securePrivateDirectory } from "../../../apps/desktop/src/main/private-directory.js";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { access, copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { NativeMcpHostResources } from "../../../apps/desktop/src/main/native-mcp-resources.js";
import { NativeDevelopmentHost } from "../../../apps/desktop/src/main/native-development-host.js";
import { DevelopmentHost } from "../../../apps/desktop/src/main/development-host.js";
import { loadNativeMcpHelpers, type NativeMcpHelpers, type NativeMcpHelperPins } from "../../../apps/desktop/src/main/native-mcp-helpers.js";
import { NativeBootstrapProcessError } from "../../../apps/desktop/src/main/native-bootstrap-operation.js";
import { decodeNativeBootstrap, NATIVE_PIPE_PREFIX } from "../../../apps/desktop/src/main/native-development-bootstrap.js";
import { ControlKind, NativeControlReader, encodeControlFrame, type ControlFrame } from "../../../apps/desktop/src/main/native-development-wire.js";
import { DevelopmentService } from "../../../apps/backend/src/modules/development/application/development-service.js";
import { AssistantService } from "../../../apps/backend/src/modules/assistant/application/assistant-service.js";
import { isDevelopmentIdentity, isDevelopmentInvocation } from "@tahtiapuri/validation/development";
import type { BackendController } from "../../../apps/desktop/src/main/backend-controller.js";

const enabled = process.platform === "win32" && !!process.env.TAHTIAPURI_NATIVE_IDENTITY_HELPER && !!process.env.TAHTIAPURI_NATIVE_BOOTSTRAP_HELPER;
const test = enabled ? it : it.skip;
let base: string, helpers: NativeMcpHelpers, pins: NativeMcpHelperPins;
const cleanups: (() => Promise<void>)[] = [];
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const absent = async (path: string) => expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeAll(async () => {
  if (!enabled) return;
  await mkdir(".artifacts/tests", { recursive: true });
  base = await mkdtemp(join(process.cwd(), ".artifacts/tests/mcp-host-"));
  const root = join(base, "helpers"); await mkdir(root);
  const entries = await Promise.all((["main-identity.exe", "main-bootstrap.exe"] as const).map(async name => {
    await copyFile(process.env[name === "main-identity.exe" ? "TAHTIAPURI_NATIVE_IDENTITY_HELPER" : "TAHTIAPURI_NATIVE_BOOTSTRAP_HELPER"]!, join(root, name));
    const bytes = await readFile(join(root, name));
    return [name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
  }));
  // The driver separately pins original binaries to the accepted build receipt.
  pins = Object.fromEntries(entries) as NativeMcpHelperPins; helpers = await loadNativeMcpHelpers(root, pins);
}, 30000);
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });
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
// These controller tests substitute native session preparation and the worker.
// Only descriptor publication/consumption use the generic real helper. They do
// not prove the new native session boundary; the real-broker fixture does.
const syntheticResources = (custom: NativeMcpHelpers, prepareWorker: NativeMcpHostResources["prepareWorker"] = async () => {},
  session: NativeMcpHostResources["session"] = async (operation, file, bytes, signal) => {
    signal.throwIfAborted(); if (operation === "publish") await custom.operate("publish", file, bytes, signal);
  }): NativeMcpHostResources => ({ helpers: custom, prepareWorker, session });
async function fixture(custom: NativeMcpHelpers = helpers, root?: string, prepareWorker?: NativeMcpHostResources["prepareWorker"], session?: NativeMcpHostResources["session"]) {
  const b = backend(), directory = root ?? await mkdtemp(join(base, "host-"));
  // securePrivateDirectory creates a new child with its required protected ACL.
  const control = join(directory, "control");
  const host = new NativeDevelopmentHost(b.port, control, syntheticResources(custom, prepareWorker, session));
  cleanups.push(async () => { await host.stop(); });
  return { ...b, host, directory, control, file: join(control, "main-bootstrap.bin"), reservation: join(control, "native-session-reserved") };
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
test("joins real helpers, protected descriptor, local pipe and backend; CLEAN retains the recovery reservation", async () => {
  const f = await fixture(); expect(await f.host.setEnabled(true)).toMatchObject({ ok: true, status: { enabled: true } });
  const client = await peer(f.file); client.hello(); expect((await client.next()).kind).toBe(ControlKind.accept);
  await absent(f.file); expect(f.service.status()).toMatchObject({ status: { connected: true } });
  client.send(ControlKind.request, Buffer.from(JSON.stringify({ id: randomUUID(), operation: "status", input: null })));
  expect((await client.next()).kind).toBe(ControlKind.response);
  const stopped = f.host.stop(); expect((await client.next()).kind).toBe(ControlKind.stop); client.send(ControlKind.clean);
  expect(await stopped).toMatchObject({ failed: false, descriptorRemoved: true, helperExitVerified: true,
    backendRevoked: true, listenerClosed: true, brokerCleanupReported: true, reservationCreated: true, reservationReleased: false });
  await access(f.reservation); expect(f.operations.slice(-2)).toEqual(["development.detach", "development.configure"]);
  expect((await f.host.setEnabled(true)).ok).toBe(false);
  const restarted = await fixture(helpers, f.directory);
  expect((await restarted.host.setEnabled(true)).ok).toBe(false);
  expect(restarted.operations).not.toContain("development.configure"); await access(f.reservation);
});
test("an invalid unauthenticated peer does not consume the valid ticket", async () => {
  const f = await fixture(); await f.host.setEnabled(true);
  const bad = await peer(f.file); bad.send(ControlKind.hello, Buffer.alloc(48)); await bad.closed;
  await access(f.file);
  const good = await peer(f.file); good.hello(); expect((await good.next()).kind).toBe(ControlKind.accept);
  good.send(ControlKind.clean); await good.closed;
  expect((await f.host.stop()).failed).toBe(false);
});
test("disable before authentication removes the exact descriptor and retains reservation", async () => {
  const f = await fixture(); await f.host.setEnabled(true);
  expect(await f.host.setEnabled(false)).toMatchObject({ ok: true, status: { enabled: false } });
  expect(await f.host.stop()).toMatchObject({ failed: false, descriptorRemoved: true, brokerCleanupReported: false });
  await absent(f.file); await access(f.reservation);
});
test("a peer discovering the renamed file waits for publisher close before consumption and ACCEPT", async () => {
  const published = gate(), release = gate(), calls: string[] = [];
  const wrapped: NativeMcpHelpers = { identity: helpers.identity, operate: async (...args) => {
    calls.push(args[0]); await helpers.operate(...args);
    if (args[0] === "publish") { published.resolve(); await release.promise; }
  }};
  const f = await fixture(wrapped), opening = f.host.setEnabled(true);
  try {
    await published.promise; const client = await peer(f.file); client.hello(); await tick(); await tick();
    expect(client.frames).toEqual([]); expect(calls).not.toContain("consume");
    release.resolve(); await opening; expect((await client.next()).kind).toBe(ControlKind.accept);
    expect(calls).toEqual(["recover", "publish", "consume"]);
    client.send(ControlKind.clean); await client.closed; expect((await f.host.stop()).failed).toBe(false);
  } finally { release.resolve(); }
});
test("stop during publication waits for settlement before exact cleanup and never accepts a peer", async () => {
  const published = gate(), release = gate(), calls: string[] = [];
  const wrapped: NativeMcpHelpers = { identity: helpers.identity, operate: async (...args) => {
    calls.push(args[0]); await helpers.operate(...args);
    if (args[0] === "publish") { published.resolve(); await release.promise; }
  }};
  const f = await fixture(wrapped), opening = f.host.setEnabled(true);
  try {
    await published.promise; const closing = f.host.stop();
    await tick(); expect(calls).toEqual(["recover", "publish"]);
    release.resolve(); await opening;
    expect(await closing).toMatchObject({ descriptorRemoved: true, listenerClosed: true, brokerCleanupReported: false });
    expect(calls).toEqual(["recover", "publish", "consume"]); await absent(f.file); await access(f.reservation);
  } finally { release.resolve(); }
});
test("uncertain publisher exit prevents a second helper operation and preserves evidence", async () => {
  const calls: string[] = [];
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => {
    calls.push(args[0]); if (args[0] === "publish") throw new NativeBootstrapProcessError(false);
    await helpers.operate(...args);
  }});
  expect((await f.host.setEnabled(true)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, helperExitVerified: false, descriptorRemoved: false, listenerClosed: true });
  expect(calls).toEqual(["recover", "publish"]); await access(f.reservation);
});
test("legacy and native hosts cannot share a backend even while disabled or after stop", async () => {
  const b = backend(), root = join(base, "exclusive"); const host = new NativeDevelopmentHost(b.port, root, syntheticResources(helpers));
  expect(() => new DevelopmentHost(b.port, root)).toThrow("already has an owner");
  await host.stop(); expect(() => new NativeDevelopmentHost(b.port, root, syntheticResources(helpers))).toThrow("already has an owner");
  const other = backend(); new DevelopmentHost(other.port, root);
  expect(() => new NativeDevelopmentHost(other.port, root, syntheticResources(helpers))).toThrow("already has an owner");
});
for (const mutation of ["extra", "missing", "bytes", "hash", "hardlink"] as const)
  test("helper package rejects " + mutation, async () => {
    const root = await mkdtemp(join(base, "rejected-"));
    for (const name of ["main-identity.exe", "main-bootstrap.exe"]) await copyFile(join(base, "helpers", name), join(root, name));
    let expected = pins;
    if (mutation === "extra") await writeFile(join(root, "extra"), "extra");
    if (mutation === "missing") await rm(join(root, "main-identity.exe"));
    if (mutation === "bytes") await writeFile(join(root, "main-identity.exe"), "changed");
    if (mutation === "hash") expected = { ...pins, "main-identity.exe": { ...pins["main-identity.exe"], sha256: "0".repeat(64) } };
    if (mutation === "hardlink") await link(join(root, "main-identity.exe"), join(base, "retained-link"));
    await expect(loadNativeMcpHelpers(root, expected)).rejects.toThrow();
  });
test("verified helper package is rechecked before each invocation", async () => {
  const root = await mkdtemp(join(base, "changed-"));
  for (const name of ["main-identity.exe", "main-bootstrap.exe"]) await copyFile(join(base, "helpers", name), join(root, name));
  const verified = await loadNativeMcpHelpers(root, pins);
  await writeFile(join(root, "extra"), "unexpected");
  await expect(verified.identity()).rejects.toThrow("package rejected");
});

test("stop closes the listener and revokes the backend while publication settlement is still pending", async () => {
  const published = gate(), release = gate();
  const f = await fixture({ identity: helpers.identity, operate: async (...args) => {
    await helpers.operate(...args);
    if (args[0] === "publish") { published.resolve(); await release.promise; }
  }});
  const opening = f.host.setEnabled(true);
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
test("synchronous abort reentry shares one stop promise and one descriptor cleanup", async () => {
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
  const opening = f.host.setEnabled(true);
  try {
    await published.promise; const closing = f.host.stop(); expect(reentered).toBe(closing);
    release.resolve(); await opening; expect((await closing).descriptorRemoved).toBe(true); expect(consumes).toBe(1);
  } finally { release.resolve(); await opening; }
});
test("stop before opening does not claim a created reservation or examined descriptor", async () => {
  const f = await fixture(); expect(await f.host.stop()).toMatchObject({
    failed: false, reservationCreated: false, reservationReleased: false, descriptorRemoved: false,
  }); await absent(f.control);
});

test("failed recovery never reports an existing malformed descriptor as removed", async () => {
  const f = await fixture();
  await securePrivateDirectory(f.control); await writeFile(f.file, "malformed descriptor");
  expect((await f.host.setEnabled(true)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, descriptorRemoved: false, reservationCreated: true });
  expect(await readFile(f.file, "utf8")).toBe("malformed descriptor"); await access(f.reservation);
});
test("listener bounds total live unauthenticated connections to four", async () => {
  const f = await fixture(); await f.host.setEnabled(true);
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
  const f = await fixture(); await f.host.setEnabled(true);
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
  const opening = f.host.setEnabled(true);
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
  expectedReservation = f.reservation; const opening = f.host.setEnabled(true);
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
    const opening = f.host.setEnabled(true);
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
  expect((await f.host.setEnabled(true)).ok).toBe(false);
  expect(await f.host.stop()).toMatchObject({ failed: true, descriptorRemoved: true, reservationCreated: true, reservationReleased: false });
  expect((await f.host.setEnabled(true)).ok).toBe(false); expect(attempts).toBe(1); expect(calls).toEqual(["recover"]);
  expect(f.operations).not.toContain("development.configure"); await absent(f.file);
  expect(await readFile(join(f.reservation, "worker/partial.bin"), "utf8")).toBe("retained");
  const restarted = await fixture(wrapped, f.directory, async () => { throw new Error("Existing reservation bypassed"); });
  expect((await restarted.host.setEnabled(true)).ok).toBe(false); expect(calls).toEqual(["recover"]);
});
test("an immediate stop never begins worker preparation", async () => {
  let attempts = 0;
  const f = await fixture(helpers, undefined, async () => { ++attempts; });
  const opening = f.host.setEnabled(true), closing = f.host.stop();
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
  const opening = f.host.setEnabled(true);
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
    if (operation !== "publish") expect(f.operations).not.toContain("development.configure");
    if (operation === "seal") expect(prepared).toBe(true);
    if (operation === "publish") {
      expect(prepared).toBe(true); expect(f.operations).toContain("development.configure");
      await helpers.operate("publish", file, bytes, signal);
    }
  });
  expect(await f.host.setEnabled(true)).toMatchObject({ ok: true, status: { enabled: true } });
  expect(calls).toEqual(["prepare", "stage", "seal", "publish"]);
  expect(await f.host.stop()).toMatchObject({ failed: false, descriptorRemoved: true });
});
for (const operation of ["prepare", "seal"] as const)
  test("stop during native " + operation + " forbids later configuration or publication", async () => {
    const entered = gate(), release = gate(), calls: string[] = [];
    const f = await fixture(helpers, undefined, undefined, async (step, _file, _bytes, signal) => {
      calls.push(step);
      if (step === operation) { entered.resolve(); await release.promise; expect(signal.aborted).toBe(true); }
    });
    const opening = f.host.setEnabled(true);
    try {
      await entered.promise; const closing = f.host.stop(); release.resolve();
      expect((await opening).ok).toBe(false);
      expect(await closing).toMatchObject({ descriptorRemoved: true, reservationReleased: false });
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
    expect((await f.host.setEnabled(true)).ok).toBe(false);
    expect(await f.host.stop()).toMatchObject({ failed: true, helperExitVerified: false, reservationReleased: false });
    expect(calls).toEqual(operation === "prepare" ? ["prepare"] : ["prepare", "seal"]);
    expect(f.operations).not.toContain("development.configure"); await absent(f.file); await access(f.reservation);
  });
