import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("tahtiapuri", {
  getStatus: () => ipcRenderer.invoke("tahtiapuri:runtime-status"),
});
contextBridge.exposeInMainWorld("probe", {
  development: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:development-enable", ...args),
  flags: { sandbox: process.sandboxed, contextIsolation: process.contextIsolated },
  invoke: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:runtime-status", ...args),
});
