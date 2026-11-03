import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("tahtiapuri", {
  observing: {
    read: () => ipcRenderer.invoke("tahtiapuri:places-read"),
    save: (input: unknown) => ipcRenderer.invoke("tahtiapuri:places-save", input),
    activate: (input: unknown) => ipcRenderer.invoke("tahtiapuri:places-activate", input),
    remove: (input: unknown) => ipcRenderer.invoke("tahtiapuri:places-remove", input),
  },
  sky: {
    snapshot: (input: unknown) => ipcRenderer.invoke("tahtiapuri:sky-snapshot", input),
    select: (input: unknown) => ipcRenderer.invoke("tahtiapuri:sky-select", input),
  },
  getStatus: () => ipcRenderer.invoke("tahtiapuri:runtime-status"),
});
contextBridge.exposeInMainWorld("probe", {
  placesRead: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:places-read", ...args),
  placesSave: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:places-save", ...args),
  placesRemove: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:places-remove", ...args),
  skySnapshot: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:sky-snapshot", ...args),
  skySelect: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:sky-select", ...args),
  development: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:development-enable", ...args),
  flags: { sandbox: process.sandboxed, contextIsolation: process.contextIsolated },
  invoke: (...args: unknown[]) => ipcRenderer.invoke("tahtiapuri:runtime-status", ...args),
});
