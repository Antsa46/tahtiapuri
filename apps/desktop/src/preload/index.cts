import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeBridge } from "@tahtiapuri/validation/public" with { "resolution-mode": "import" };
const bridge: RuntimeBridge = Object.freeze({
  assistant: Object.freeze({
    submit: (input: import("@tahtiapuri/validation/assistant", { with: { "resolution-mode": "import" } }).ModelInput) => ipcRenderer.invoke("tahtiapuri:model-submit", input),
    get: (id: string) => ipcRenderer.invoke("tahtiapuri:model-get", id),
    cancel: (id: string) => ipcRenderer.invoke("tahtiapuri:model-cancel", id),
  }),
  getStatus: () => ipcRenderer.invoke("tahtiapuri:runtime-status"),
});
contextBridge.exposeInMainWorld("tahtiapuri", bridge);
