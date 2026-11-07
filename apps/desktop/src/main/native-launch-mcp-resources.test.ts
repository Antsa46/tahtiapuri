import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeLaunchBinding } from "./native-launch-worker-port.js";
import type { NativeLaunchMcpResourceConfig } from "./native-launch-mcp-resources.js";
import type { NativeMcpLaunchPackage } from "./native-mcp-resources.js";
import type { NativeLaunchSupervisor, NativeLaunchRequest } from "./native-launch-supervisor.js";
const state = vi.hoisted(() => ({ package: vi.fn(), worker: vi.fn(), handoff: undefined as (() => void) | undefined,
  actor: vi.fn(() => { throw new Error("Actual native/Worker actor forbidden in factory mocks"); }) }));
vi.mock("./native-mcp-resources.js", () => ({ loadNativeMcpLaunchPackage: state.package }));
vi.mock("./native-launch-worker-port.js", () => ({ loadNativeLaunchWorkerSupervisor: state.worker,
  NATIVE_LAUNCH_WORKER_FILES: Object.freeze(["native-launch-worker.js", "native-launch-worker-core.js", "native-launch-worker-config.js", "native-launch-gate.js", "native-recovery-grant.js", "native-directory-grant.js"]) }));
vi.mock("./native-launch-resource-owner.js", async original => {
  const actual = await original<typeof import("./native-launch-resource-owner.js")>();
  return { ...actual, NativeLaunchResourceOwner: class extends actual.NativeLaunchResourceOwner {
    constructor(...args: ConstructorParameters<typeof actual.NativeLaunchResourceOwner>) { super(...args); state.handoff?.(); }
  } };
});
vi.mock("node:child_process", () => ({ spawn: state.actor, execFile: state.actor }));
vi.mock("node:worker_threads", () => ({ Worker: state.actor }));
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve(); };
const root = "C:\\synthetic\\runtime", control = "C:\\synthetic\\control\\main-bootstrap.bin", digest = "a".repeat(64);
const compiledNames = ["native-launch-worker.js", "native-launch-worker-core.js", "native-launch-worker-config.js", "native-launch-gate.js", "native-recovery-grant.js", "native-directory-grant.js"] as const;
const config = (): NativeLaunchMcpResourceConfig => ({ runtimeRoot: root, descriptorSha256: digest, controlFile: control,
  compiled: Object.fromEntries(compiledNames.map(name => [name, { bytes: 100, sha256: "b".repeat(64) }])) as NativeLaunchBinding["compiled"],
  recoveryApproval: { descriptorSha256: digest, protocol: "THREC001" } });
let hr = 0n;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); hr = 0n;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => hr);
  vi.spyOn(performance, "now").mockReturnValue(0);
  state.package.mockReset(); state.worker.mockReset(); state.actor.mockClear(); state.handoff = undefined;
});
afterEach(() => { expect(state.actor).not.toHaveBeenCalled(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture() {
  const packageGate = deferred<NativeMcpLaunchPackage>(), workerGate = deferred<Pick<NativeLaunchSupervisor, "start" | "status">>();
  const pin = Object.freeze({ bytes: 100, sha256: "c".repeat(64) });
  const verify = vi.fn(async (_signal: AbortSignal) => {});
  const staged = deferred<void>(), stageWorker = vi.fn((_reservation: string, _signal: AbortSignal, _deadline: bigint) => staged.promise);
  const source: NativeMcpLaunchPackage = { runtimeRoot: root, descriptorSha256: digest,
    programs: Object.freeze({ identity: pin, bootstrap: pin, broker: pin }), verifyLaunch: verify, stageWorker };
  const start = vi.fn((request: NativeLaunchRequest) => ({ result: Promise.resolve({
    stdout: Buffer.from(request.kind === "directory" ? "directory-ready\n" : '{"pid":' + process.pid + ',"creationTime":"0000000000000001"}\n'), authorityCommitted: request.kind === "directory" }),
    settled: Promise.resolve({ childCloseObserved: true, workerExited: true, workerExitCode: 0, authorityCommitted: request.kind === "directory", uncertain: false }) }));
  const owner = { start, status: () => ({ pending: false, uncertain: false }) };
  state.package.mockImplementation(() => packageGate.promise); state.worker.mockImplementation(() => workerGate.promise);
  const module = await import("./native-launch-mcp-resources.js");
  const controller = new AbortController();
  return { module, controller, packageGate, workerGate, source, owner, start, verify, stageWorker, staged,
    load: (value = config()) => module.loadNativeLaunchMcpResources(value, 10_000, controller.signal) };
}
it("constructs verifier and native pins from the same approved package without running an actor", async () => {
  const f = await fixture(), done = f.load(); f.packageGate.resolve(f.source); await turn();
  expect(state.worker).toHaveBeenCalledOnce();
  const binding = state.worker.mock.calls[0]![0] as NativeLaunchBinding;
  expect(binding.programs).toEqual(f.source.programs); expect(binding.config.controlFile).toBe(control);
  expect(binding.config.identity).toBe(root + "\\helpers\\main-identity.exe"); expect(binding.recoverProtocol).toBe("THREC001");
  f.workerGate.resolve(f.owner); const resource = await done;
  expect(f.start).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  await resource.prepareDirectory(20_000, new AbortController().signal); f.start.mockClear(); f.verify.mockClear();
  expect(await resource.identity(20_000, new AbortController().signal)).toEqual({ pid: process.pid, creationTime: 1n });
  expect(f.verify).toHaveBeenCalledOnce(); expect(f.start).toHaveBeenCalledOnce();
});
it("snapshots caller configuration before package verification awaits", async () => {
  const f = await fixture(), input = config(), done = f.load(input);
  Object.assign(input, { runtimeRoot: "C:\\changed", controlFile: "C:\\changed\\main-bootstrap.bin" });
  Object.assign(input.compiled["native-launch-gate.js"], { sha256: "f".repeat(64) });
  f.packageGate.resolve(f.source); await turn(); f.workerGate.resolve(f.owner); await done;
  const binding = state.worker.mock.calls[0]![0] as NativeLaunchBinding;
  expect(binding.config.controlFile).toBe(control); expect(binding.config.identity).toBe(root + "\\helpers\\main-identity.exe");
  expect(binding.compiled["native-launch-gate.js"].sha256).toBe("b".repeat(64));
});
for (const stage of ["package", "worker"] as const) for (const late of ["resolve", "reject"] as const)
  it("bounds " + stage + " preparation result and retains original work until late " + late, async () => {
    const f = await fixture(), done = f.load().catch(error => error);
    if (stage === "worker") { f.packageGate.resolve(f.source); await turn(); expect(state.worker).toHaveBeenCalledOnce(); }
    hr = 10_000_000_000n; await vi.advanceTimersByTimeAsync(10_000);
    const failure = await done; expect(failure).toMatchObject({ exitVerified: true, authorityCommitted: false });
    if (stage === "package") {
      if (late === "resolve") f.packageGate.resolve(f.source); else f.packageGate.reject(new Error("Late package failure"));
    } else if (late === "resolve") f.workerGate.resolve(f.owner); else f.workerGate.reject(new Error("Late loader failure"));
    await turn(); expect(await done).toBe(failure); expect(f.start).not.toHaveBeenCalled();
    expect(state.worker).toHaveBeenCalledTimes(stage === "package" ? 0 : 1);
    await expect(f.load()).rejects.toThrow("already claimed"); expect(state.package).toHaveBeenCalledOnce();
  });
for (const stage of ["package", "worker"] as const)
  it("rejects late " + stage + " success at handoff even without timer dispatch", async () => {
    const f = await fixture(), done = f.load();
    if (stage === "worker") { f.packageGate.resolve(f.source); await turn(); }
    hr = 10_000_000_001n;
    if (stage === "package") f.packageGate.resolve(f.source); else f.workerGate.resolve(f.owner);
    await expect(done).rejects.toMatchObject({ exitVerified: true });
    expect(f.start).not.toHaveBeenCalled(); expect(state.worker).toHaveBeenCalledTimes(stage === "package" ? 0 : 1);
  });
for (const stage of ["package", "worker"] as const)
  it("caller abort fences pending " + stage + " preparation before later resolution", async () => {
    const f = await fixture(), done = f.load().catch(error => error);
    if (stage === "worker") { f.packageGate.resolve(f.source); await turn(); }
    f.controller.abort(); expect(await done).toMatchObject({ exitVerified: true, authorityCommitted: false });
    if (stage === "package") f.packageGate.resolve(f.source); else f.workerGate.resolve(f.owner);
    await turn(); expect(f.start).not.toHaveBeenCalled();
    expect(state.worker).toHaveBeenCalledTimes(stage === "package" ? 0 : 1);
  });
it("rejects package-root mismatch without constructing a Worker owner", async () => {
  const f = await fixture(), done = f.load();
  f.packageGate.resolve({ ...f.source, runtimeRoot: "C:\\different-package" });
  await expect(done).rejects.toThrow("binding changed"); expect(state.worker).not.toHaveBeenCalled();
  await expect(f.load()).rejects.toThrow("already claimed");
});
it("rejects a recovery approval for a different descriptor before package IO and keeps the claim", async () => {
  const f = await fixture(), bad = config(); Object.assign(bad.recoveryApproval, { descriptorSha256: "d".repeat(64) });
  await expect(f.load(bad)).rejects.toThrow("approval"); expect(state.package).not.toHaveBeenCalled();
  await expect(f.load()).rejects.toThrow("already claimed");
});
it("rejects independent verifier/owner fields instead of accepting a mixed-package cohort", async () => {
  const f = await fixture(), bad = Object.assign(config(), { verify: () => Promise.resolve(), owner: f.owner });
  await expect(f.load(bad)).rejects.toThrow("approval"); expect(state.package).not.toHaveBeenCalled(); expect(state.worker).not.toHaveBeenCalled();
});
it("rejects missing compiled pins before any package work", async () => {
  const f = await fixture(), bad = config(); delete (bad.compiled as Partial<Record<keyof typeof bad.compiled, unknown>>)["native-recovery-grant.js"];
  await expect(f.load(bad)).rejects.toThrow("approval"); expect(state.package).not.toHaveBeenCalled();
});
it("reserves synchronously before a package-loader callback can reenter", async () => {
  const f = await fixture(); let rejected: Promise<unknown> | undefined;
  state.package.mockImplementation(() => { rejected = f.load().catch(error => error); return f.packageGate.promise; });
  const done = f.load(); expect(state.package).toHaveBeenCalledOnce(); expect(await rejected).toBeInstanceOf(Error);
  f.packageGate.resolve(f.source); await turn(); f.workerGate.resolve(f.owner); await done;
});
it("initial cancellation never starts package verification", async () => {
  const f = await fixture(); f.controller.abort(); await expect(f.load()).rejects.toThrow();
  expect(state.package).not.toHaveBeenCalled(); expect(state.worker).not.toHaveBeenCalled();
});
it("invalid preparation signal is a rejected result with no IO or cleanup exception", async () => {
  const f = await fixture();
  await expect(f.module.loadNativeLaunchMcpResources(config(), 10_000, undefined as unknown as AbortSignal)).rejects.toMatchObject({ exitVerified: true });
  expect(state.package).not.toHaveBeenCalled();
});

it("an invalid factory owner deadline rejects before package IO and retains the lifetime claim", async () => {
  const f = await fixture();
  await expect(f.module.loadNativeLaunchMcpResources(config(), NaN, f.controller.signal)).rejects.toMatchObject({ exitVerified: true });
  expect(state.package).not.toHaveBeenCalled(); expect(state.worker).not.toHaveBeenCalled();
  await expect(f.load()).rejects.toThrow("already claimed");
});
it("rejects a package descriptor digest mismatch before constructing the Worker owner", async () => {
  const f = await fixture(), done = f.load(); f.packageGate.resolve({ ...f.source, descriptorSha256: "d".repeat(64) });
  await expect(done).rejects.toThrow("binding changed"); expect(state.worker).not.toHaveBeenCalled();
});
it("checks the final public handoff after preparation completed without a timer callback", async () => {
  const f = await fixture(); state.handoff = () => { hr = 10_000_000_001n; };
  const done = f.load(); f.packageGate.resolve(f.source); await turn(); f.workerGate.resolve(f.owner);
  await expect(done).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.start).not.toHaveBeenCalled(); await expect(f.load()).rejects.toThrow("already claimed");
});

it("binds staging to the same package and original fixed control reservation", async () => {
  const f = await fixture(), input = config(), done = f.load(input);
  Object.assign(input, { controlFile: "C:\\changed\\main-bootstrap.bin" });
  f.packageGate.resolve(f.source); await turn(); f.workerGate.resolve(f.owner); const resources = await done;
  await resources.prepareDirectory(10_000, f.controller.signal); f.start.mockClear(); f.verify.mockClear();
  const original = resources.prepareWorker(10_000, f.controller.signal);
  expect(f.stageWorker).toHaveBeenCalledOnce();
  expect(f.stageWorker.mock.calls[0]![0]).toBe("C:\\synthetic\\control\\native-session-reserved");
  expect(f.stageWorker.mock.calls[0]![2]).toBe(10_000_000_000n);
  expect(f.start).not.toHaveBeenCalled();
  f.staged.resolve(); await original;
  expect((await resources.observeCall(original).binding).staging).toBe(f.staged.promise);
});

it("exposes immutable original control metadata without freezing mutable owner state", async () => {
  const f = await fixture(), input = config(), done = f.load(input);
  Object.assign(input, { controlFile: "C:\\changed\\main-bootstrap.bin" });
  f.packageGate.resolve(f.source); await turn(); f.workerGate.resolve(f.owner); const resources = await done;
  expect(resources.controlFile).toBe(control);
  expect(Object.getOwnPropertyDescriptor(resources, "controlFile")).toMatchObject({ writable: false, configurable: false });
  expect(Reflect.set(resources, "controlFile", "C:\\other\\main-bootstrap.bin")).toBe(false);
  expect(Object.isFrozen(resources)).toBe(false);
  await resources.prepareDirectory(10_000, f.controller.signal);
  await expect(resources.identity(10_000, f.controller.signal)).resolves.toEqual({ pid: process.pid, creationTime: 1n });
  expect(resources.status()).toMatchObject({ pending: false, failed: false });
});

it("loaded resources cannot bypass directory preparation", async () => {
  const f = await fixture(), loading = f.load(); f.packageGate.resolve(f.source); await turn(); f.workerGate.resolve(f.owner);
  const resources = await loading;
  await expect(resources.identity(10_000, f.controller.signal)).rejects.toMatchObject({ exitVerified: true, authorityCommitted: false });
  expect(f.verify).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(resources.status()).toMatchObject({ failed: true, directoryPrepared: false });
});
