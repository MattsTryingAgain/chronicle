/**
 * Chronicle Electron Preload
 *
 * Runs in the renderer process with contextIsolation.
 * Exposes a minimal, safe API to the React app via contextBridge.
 *
 * Everything exposed here is carefully considered — no raw Node/Electron
 * APIs are exposed directly.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chronicleElectron', {
  /** App version from package.json */
  getVersion: () => ipcRenderer.invoke('get-version'),

  /** Platform identifier */
  platform: process.platform,

  /** Whether running in Electron (vs browser) */
  isElectron: true,

  /** Open a URL in the system browser */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /** Persistent key-value store backed by userData files (survives app restarts) */
  storeGet: (key) => ipcRenderer.invoke('store-get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),
})
