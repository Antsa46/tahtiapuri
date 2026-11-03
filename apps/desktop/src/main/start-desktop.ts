import { app, BrowserWindow, ipcMain, protocol, session, utilityProcess } from "electron";
import { mkdirSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { STATUS_CHANNEL, type StatusResult } from "@tahtiapuri/validation/public";
import { BackendController } from "./backend-controller.js";
import { childEnvironment } from "./child-environment.js";
import { isTrustedSender } from "./sender-policy.js";
import { PAGE_URL, localPageResponse } from "./local-page.js";

export type DesktopPaths = { backendEntry: string; preload: string; renderer: string; data: string };
export function startDesktop(paths: DesktopPaths) {
  protocol.registerSchemesAsPrivileged([{ scheme: "tahtiapuri", privileges: { standard: true, secure: true } }]);
  mkdirSync(paths.data, { recursive: true });
  app.setPath("userData", paths.data);
  app.setPath("sessionData", paths.data);
  app.setPath("crashDumps", join(paths.data, "crash-dumps"));
  let window: BrowserWindow | undefined;
  let rendererTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const backend = new BackendController(
    () => utilityProcess.fork(paths.backendEntry, [], {
      serviceName: "Tahtiapuri Backend",
      env: childEnvironment(process.env), execArgv: [], cwd: paths.data, stdio: "ignore",
    }),
    () => { void shutdown(1); },
  );
  function shutdown(code: number): Promise<void> {
    shutdownPromise ??= (async () => {
      clearTimeout(rendererTimer);
      ipcMain.removeHandler(STATUS_CHANNEL);
      try { await backend.stop(); } catch { code = 1; }
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
    window.on("close", event => { event.preventDefault(); void shutdown(0); });
    await Promise.all([window.loadURL(PAGE_URL), rendererReady]);
    clearTimeout(rendererTimer);
    if (!shutdownPromise) window.show();
  }).catch(() => { console.error("Tähtiapurin käynnistys epäonnistui."); void shutdown(1); });
}
