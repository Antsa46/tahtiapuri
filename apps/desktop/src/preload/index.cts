import { contextBridge, ipcRenderer } from "electron";
import type { RuntimeBridge } from "@tahtiapuri/validation/public" with { "resolution-mode": "import" };
const bridge: RuntimeBridge = Object.freeze({
  getStatus: () => ipcRenderer.invoke("tahtiapuri:runtime-status"),
});
contextBridge.exposeInMainWorld("tahtiapuri", bridge);
