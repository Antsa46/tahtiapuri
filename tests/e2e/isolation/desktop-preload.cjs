const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('probe:ready', {
  sandboxed: process.sandboxed, contextIsolated: process.contextIsolated, processType: process.type
}), { once: true });
