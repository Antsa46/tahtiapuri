import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("tahtiapuri", {
  getStatus: () => ipcRenderer.invoke("tahtiapuri:runtime-status"),
});
contextBridge.exposeInMainWorld("probe", {
  flags: { sandbox: process.sandboxed, contextIsolation: process.contextIsolated },
  invoke: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:runtime-status", ...args),
});
