import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeBridge } from "@tahtiapuri/validation/public" with { "resolution-mode": "import" };
const bridge: RuntimeBridge = Object.freeze({
  sky: Object.freeze({
    snapshot: (input: import("@tahtiapuri/validation/sky", { with: { "resolution-mode": "import" } }).ObservationRequest) => ipcRenderer.invoke("tahtiapuri:sky-snapshot", input),
    select: (input: import("@tahtiapuri/validation/sky", { with: { "resolution-mode": "import" } }).SkySelectionRequest) => ipcRenderer.invoke("tahtiapuri:sky-select", input),
  }),
  assistant: Object.freeze({
    submit: (input: import("@tahtiapuri/validation/assistant", { with: { "resolution-mode": "import" } }).ModelInput) => ipcRenderer.invoke("tahtiapuri:model-submit", input),
    get: (id: string) => ipcRenderer.invoke("tahtiapuri:model-get", id),
    cancel: (id: string) => ipcRenderer.invoke("tahtiapuri:model-cancel", id),
  }),
  development: Object.freeze({
    getStatus: () => ipcRenderer.invoke("tahtiapuri:development-status"),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke("tahtiapuri:development-enable", enabled),
  }),
  getStatus: () => ipcRenderer.invoke("tahtiapuri:runtime-status"),
});
contextBridge.exposeInMainWorld("tahtiapuri", bridge);
