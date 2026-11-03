import { OBSERVING_CHANNELS, isObservingInput, type ObservingOperation } from "@tahtiapuri/validation/observing";
import { SKY_CHANNELS, isObservationRequest, isSkySelectionRequest } from "@tahtiapuri/validation/sky";
import { DevelopmentHost } from "./development-host.js";
import { DEVELOPMENT_CHANNELS } from "@tahtiapuri/validation/development";
import { ModelHost } from "./model-host.js";
import { ASSISTANT_CHANNELS, isModelInput, isJobId } from "@tahtiapuri/validation/assistant";
import type { ApprovedModel } from "@tahtiapuri/validation/model-wire";
import { app, BrowserWindow, ipcMain, protocol, session, utilityProcess } from "electron";
import { prepareOwnedDataRoot } from "./owned-data-root.js";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { STATUS_CHANNEL, type StatusResult } from "@tahtiapuri/validation/public";
import { BackendController } from "./backend-controller.js";
import { childEnvironment } from "./child-environment.js";
import { isTrustedSender } from "./sender-policy.js";
import { PAGE_URL, localPageResponse } from "./local-page.js";

export type DesktopPaths = { backendEntry: string; preload: string; renderer: string; data: string; model?: { entry: string; profile: ApprovedModel; cudaPaths: string[] } };
export function startDesktop(paths: DesktopPaths) {
  protocol.registerSchemesAsPrivileged([{ scheme: "tahtiapuri", privileges: { standard: true, secure: true } }]);
  try { paths = { ...paths, data: prepareOwnedDataRoot(paths.data) }; }
  catch { console.error("Tähtiapurin datahakemisto ei ole käytettävissä."); app.exit(1); return; }
  app.setPath("userData", paths.data);
  app.setPath("sessionData", paths.data);
  app.setPath("crashDumps", join(paths.data, "crash-dumps"));
  if (!app.requestSingleInstanceLock()) { app.exit(1); return; }
  let window: BrowserWindow | undefined;
  let skyPending = false;
  let observingPending = false;
  let rendererTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const model = paths.model ? new ModelHost(() => utilityProcess.fork(paths.model!.entry, [], {
    serviceName: "Tahtiapuri Model", execArgv: [], cwd: paths.data, stdio: "ignore",
    env: { ...childEnvironment(process.env), PATH: [...paths.model!.cudaPaths, join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(";") },
  }), paths.model.profile) : undefined;
  const backend = new BackendController(
    () => utilityProcess.fork(paths.backendEntry, [], {
      serviceName: "Tahtiapuri Backend",
      env: childEnvironment(process.env), execArgv: [], cwd: paths.data, stdio: "ignore",
    }),
    () => { void shutdown(1); },
    model,
  );
  const development = new DevelopmentHost(backend, join(paths.data, "mcp"));
  function shutdown(code: number): Promise<void> {
    shutdownPromise ??= (async () => {
      clearTimeout(rendererTimer);
      ipcMain.removeHandler(STATUS_CHANNEL);
      for (const channel of Object.values(OBSERVING_CHANNELS)) ipcMain.removeHandler(channel);
      for (const channel of Object.values(SKY_CHANNELS)) ipcMain.removeHandler(channel);
      for (const channel of Object.values(ASSISTANT_CHANNELS)) ipcMain.removeHandler(channel);
      for (const channel of Object.values(DEVELOPMENT_CHANNELS)) ipcMain.removeHandler(channel);
      try { await development.stop(); } catch { code = 1; }
      try { await backend.stop(); } catch { code = 1; }
      try { await model?.stop(); } catch { code = 1; }
      if (window && !window.isDestroyed()) window.destroy();
      app.exit(code);
    })();
    return shutdownPromise;
  }
  app.on("before-quit", event => { event.preventDefault(); void shutdown(0); });
  app.on("window-all-closed", () => { void shutdown(0); });
  app.whenReady().then(async () => {
    const isolatedSession = session.fromPartition("tahtiapuri-" + randomUUID());
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith("tahtiapuri://app/") });
    });
    isolatedSession.protocol.handle("tahtiapuri", request => localPageResponse(request, paths.renderer));
    await Promise.all([access(paths.preload), access(join(paths.renderer, "index.html"))]);
    await backend.start();
    if (shutdownPromise) return;
    window = new BrowserWindow({
      title: "Tähtiapuri", width: 1000, height: 720, minWidth: 640, minHeight: 480,
      backgroundColor: "#080e1c", show: false, autoHideMenuBar: true,
      webPreferences: {
        preload: paths.preload, session: isolatedSession, sandbox: true,
        contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false,
        devTools: false, navigateOnDragDrop: false,
      },
    });
    const owner = window.webContents;
    owner.on("render-process-gone", () => { void shutdown(1); });
    owner.setWindowOpenHandler(() => ({ action: "deny" }));
    owner.on("will-navigate", event => event.preventDefault());
    owner.on("will-attach-webview", event => event.preventDefault());
    let rendererIsReady: () => void = () => {};
    const rendererReady = new Promise<void>((resolve, reject) => {
      rendererIsReady = resolve;
      rendererTimer = setTimeout(() => reject(new Error("Renderer startup timed out.")), 5000);
    });
    ipcMain.handle(STATUS_CHANNEL, async (event, ...args): Promise<StatusResult> => {
      if (!isTrustedSender(event, owner, PAGE_URL) || args.length !== 0 || shutdownPromise)
        throw new Error("Request denied.");
      try {
        const status = await backend.getStatus();
        if (!isTrustedSender(event, owner, PAGE_URL) || shutdownPromise) return { ok: false, code: "UNAVAILABLE" };
        rendererIsReady();
        return { ok: true, status };
      } catch { return { ok: false, code: "UNAVAILABLE" }; }
    });
    for (const [name, channel] of Object.entries(OBSERVING_CHANNELS)) {
      ipcMain.handle(channel, async (event, ...args) => {
        const operation = ("observing." + name) as ObservingOperation;
        if (!isTrustedSender(event, owner, PAGE_URL) || shutdownPromise || args.length !== (name === "read" ? 0 : 1)
          || !isObservingInput(operation, args[0])) throw new Error("Request denied.");
        if (observingPending) return { ok: false, code: "BUSY" };
        observingPending = true;
        try {
          const result = await backend.observing(operation, args[0]);
          return isTrustedSender(event, owner, PAGE_URL) && !shutdownPromise ? result : { ok: false, code: "UNAVAILABLE" };
        } catch { return { ok: false, code: "UNAVAILABLE" }; }
        finally { observingPending = false; }
      });
    }
    for (const [name, channel] of Object.entries(SKY_CHANNELS)) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (!isTrustedSender(event, owner, PAGE_URL) || shutdownPromise || args.length !== 1
          || !(name === "snapshot" ? isObservationRequest(args[0]) : isSkySelectionRequest(args[0]))) throw new Error("Request denied.");
        if (skyPending) return { ok: false, code: "BUSY" };
        skyPending = true;
        try {
          const result = name === "snapshot" ? await backend.sky("sky.snapshot", args[0]) : await backend.sky("sky.select", args[0]);
          return isTrustedSender(event, owner, PAGE_URL) && !shutdownPromise ? result : { ok: false, code: "UNAVAILABLE" };
        } catch { return { ok: false, code: "UNAVAILABLE" }; }
        finally { skyPending = false; }
      });
    }
    for (const [name, channel] of Object.entries(ASSISTANT_CHANNELS)) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (!isTrustedSender(event, owner, PAGE_URL) || shutdownPromise || args.length !== 1
          || !(name === "submit" ? isModelInput(args[0]) : isJobId(args[0]))) throw new Error("Request denied.");
        const operation = ("assistant." + name) as "assistant.submit" | "assistant.get" | "assistant.cancel";
        try {
          const result = await backend.assistant(operation, args[0]);
          return isTrustedSender(event, owner, PAGE_URL) && !shutdownPromise ? result : { ok: false, code: "ENGINE_UNAVAILABLE" };
        } catch { return { ok: false, code: "ENGINE_UNAVAILABLE" }; }
      });
    }
    for (const [name, channel] of Object.entries(DEVELOPMENT_CHANNELS)) {
      ipcMain.handle(channel, async (event, ...args) => {
        if (!isTrustedSender(event, owner, PAGE_URL) || shutdownPromise
          || (name === "status" ? args.length !== 0 : args.length !== 1 || typeof args[0] !== "boolean")) throw new Error("Request denied.");
        try {
          const result = name === "status" ? await development.getStatus() : await development.setEnabled(args[0] as boolean);
          return isTrustedSender(event, owner, PAGE_URL) && !shutdownPromise ? result : { ok: false, code: "ENGINE_UNAVAILABLE" };
        } catch { if (name === "setEnabled") void shutdown(1); return { ok: false, code: "ENGINE_UNAVAILABLE" }; }
      });
    }
    window.on("close", event => { event.preventDefault(); void shutdown(0); });
    await Promise.all([window.loadURL(PAGE_URL), rendererReady]);
    clearTimeout(rendererTimer);
    if (!shutdownPromise) window.show();
  }).catch(() => { console.error("Tähtiapurin käynnistys epäonnistui."); void shutdown(1); });
}
