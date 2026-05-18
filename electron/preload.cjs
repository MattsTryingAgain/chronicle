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

  /** Instance number (1 = primary, 2+ = secondary). Used to select relay port. */
  instanceNum: parseInt(
    (process.argv.find(a => a.startsWith('--instance=')) || '--instance=1').split('=')[1],
    10
  ),

  /** Relay port for this instance (4869 for primary, 4870 for instance 2, etc.) */
  relayPort: 4869 + parseInt(
    (process.argv.find(a => a.startsWith('--instance=')) || '--instance=1').split('=')[1],
    10
  ) - 1,

  /** Open a URL in the system browser */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /** Persistent key-value store backed by userData files (survives app restarts) */
  storeGet: (key) => ipcRenderer.invoke('store-get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),

  /** Manually trigger an update check */
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),

  /** Install a downloaded update (quits and relaunches) */
  installUpdate: () => ipcRenderer.send('install-update'),

  /**
   * Subscribe to update status events from main process.
   * Callback receives: { type, currentVersion?, newVersion?, percent?, message? }
   * type: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error'
   * Returns an unsubscribe function.
   */
  onUpdateStatus: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('update-status', handler)
    return () => ipcRenderer.removeListener('update-status', handler)
  },
})
