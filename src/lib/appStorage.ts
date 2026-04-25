/**
 * appStorage — cross-environment key-value persistence.
 *
 * In Electron (packaged or dev:electron): uses the main-process IPC bridge
 * which writes JSON files to app.getPath('userData'). This survives app
 * restarts and is unaffected by file:// origin quirks.
 *
 * In browser / Vite dev server (no Electron): falls back to localStorage.
 */

export interface UpdateStatus {
  type: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error'
  currentVersion?: string
  newVersion?: string
  percent?: number
  message?: string
}

declare global {
  interface Window {
    chronicleElectron?: {
      isElectron: boolean
      storeGet: (key: string) => Promise<string | null>
      storeSet: (key: string, value: string) => Promise<boolean>
      getVersion: () => Promise<string>
      platform: string
      openExternal: (url: string) => Promise<void>
      checkForUpdate: () => Promise<{ ok?: boolean; error?: string }>
      installUpdate: () => void
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
    }
  }
}

function isElectron(): boolean {
  return typeof window !== 'undefined' && window.chronicleElectron?.isElectron === true
}

export async function storageGet(key: string): Promise<string | null> {
  if (isElectron()) {
    return window.chronicleElectron!.storeGet(key)
  }
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export async function storageSet(key: string, value: string): Promise<void> {
  if (isElectron()) {
    await window.chronicleElectron!.storeSet(key, value)
    return
  }
  try {
    localStorage.setItem(key, value)
  } catch { /* silent */ }
}
