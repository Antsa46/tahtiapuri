import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("tahtiapuri", {
  sky: {
    snapshot: (input: unknown) => ipcRenderer.invoke("tahtiapuri:sky-snapshot", input),
    select: (input: unknown) => ipcRenderer.invoke("tahtiapuri:sky-select", input),
  },
  getStatus: () => ipcRenderer.invoke("tahtiapuri:runtime-status"),
});
contextBridge.exposeInMainWorld("probe", {
  skySnapshot: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:sky-snapshot", ...args),
  skySelect: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:sky-select", ...args),
  development: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:development-enable", ...args),
  flags: { sandbox: process.sandboxed, contextIsolation: process.contextIsolated },
  invoke: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:runtime-status", ...args),
});
