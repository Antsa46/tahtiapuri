import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  events: new Map<string, (...args: unknown[]) => void>(), fatal: () => {},
  developmentStop: vi.fn<() => Promise<void>>(), backendStop: vi.fn<() => Promise<void>>(), modelStop: vi.fn<() => Promise<void>>(),
  exit: vi.fn(), actor: vi.fn(() => { throw new Error("Application actor forbidden in Main shutdown mocks"); }),
}));
vi.mock("electron", () => ({
  app: { setPath: vi.fn(), requestSingleInstanceLock: () => true,
    on: (name: string, callback: (...args: unknown[]) => void) => { state.events.set(name, callback); },
    whenReady: () => new Promise<void>(() => {}), exit: state.exit },
  protocol: { registerSchemesAsPrivileged: vi.fn() }, ipcMain: { removeHandler: vi.fn() },
  session: {}, BrowserWindow: state.actor, utilityProcess: { fork: state.actor },
}));
vi.mock("./owned-data-root.js", () => ({ prepareOwnedDataRoot: (path: string) => path }));
vi.mock("./development-host.js", () => ({ DevelopmentHost: class { stop() { return state.developmentStop(); } } }));
vi.mock("./backend-controller.js", () => ({ BackendController: class {
  constructor(_factory: unknown, fail: () => void) { state.fatal = fail; }
  stop() { return state.backendStop(); }
} }));
vi.mock("./native-model-host.js", () => ({ createNativeModelHost: () => ({ stop: state.modelStop }) }));
vi.mock("./native-backend-host.js", () => ({ createNativeBackendFactory: state.actor }));
vi.mock("./model-host.js", () => ({ ModelHost: state.actor }));
vi.mock("node:child_process", () => ({ spawn: state.actor, execFile: state.actor }));
vi.mock("node:worker_threads", () => ({ Worker: state.actor }));
import { startDesktop } from "./start-desktop.js";
const turn = async () => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const start = () => startDesktop({ backendEntry: "synthetic-backend", preload: "synthetic-preload", renderer: "synthetic-renderer",
  data: "C:\\synthetic\\data", model: { kind: "native-cpu", runtimeRoot: "C:\\synthetic\\runtime", workRoot: "C:\\synthetic\\scratch",
    profile: { file: "C:\\synthetic\\model.gguf", bytes: 1, sha256: "a".repeat(64), templateSha256: "b".repeat(64) } } });
const quit = () => state.events.get("before-quit")!({ preventDefault: vi.fn() });
beforeEach(() => {
  state.events.clear(); state.exit.mockReset(); state.actor.mockClear(); state.fatal = () => {};
  for (const stop of [state.developmentStop, state.backendStop, state.modelStop]) stop.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { expect(state.actor).not.toHaveBeenCalled(); });
it("graceful Main close waits for original service stops and exits once", async () => {
  const ending = gate(); state.modelStop.mockReturnValue(ending.promise); start(); quit(); await turn();
  expect(state.exit).not.toHaveBeenCalled(); ending.resolve(); await turn();
  expect(state.exit).toHaveBeenCalledExactlyOnceWith(0);
  for (const stop of [state.developmentStop, state.backendStop, state.modelStop]) expect(stop).toHaveBeenCalledOnce();
});
it("a later fatal callback upgrades an already pending graceful close to exit1", async () => {
  const ending = gate(); state.developmentStop.mockReturnValue(ending.promise); start(); quit(); await turn();
  state.fatal(); expect(state.exit).not.toHaveBeenCalled(); ending.resolve(); await turn();
  expect(state.exit).toHaveBeenCalledExactlyOnceWith(1); expect(state.developmentStop).toHaveBeenCalledOnce();
});
it("synchronous reentrant failure cannot start a second cleanup", async () => {
  state.developmentStop.mockImplementation(async () => { state.fatal(); }); start(); quit(); await turn();
  expect(state.exit).toHaveBeenCalledExactlyOnceWith(1);
  for (const stop of [state.developmentStop, state.backendStop, state.modelStop]) expect(stop).toHaveBeenCalledOnce();
});
it("a later graceful close never clears an earlier fatal exit", async () => {
  start(); state.fatal(); quit(); await turn(); expect(state.exit).toHaveBeenCalledExactlyOnceWith(1);
});
it("a backend stop failure still closes the model and preserves exit1", async () => {
  state.backendStop.mockRejectedValue(new Error("Synthetic backend stop failure")); start(); quit(); await turn();
  expect(state.modelStop).toHaveBeenCalledOnce(); expect(state.exit).toHaveBeenCalledExactlyOnceWith(1);
});
