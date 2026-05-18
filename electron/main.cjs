/**
 * Chronicle Electron Main Process
 *
 * Multi-instance: launch with --instance=2 to run a fully independent second
 * instance alongside the first. Each instance has its own userData directory,
 * relay port, single-instance lock, session partition, and window title.
 *
 * ORDERING IS CRITICAL:
 *   app.setPath('userData') and app.setName() must be called before
 *   app.requestSingleInstanceLock() — which itself must be called before
 *   app.whenReady(). storeDir is derived AFTER setPath so IPC handlers
 *   read from the correct directory.
 */

const { app, BrowserWindow, shell, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

// ─── Suppress EPIPE on broken pipes (second-instance fast-quit on Windows) ────
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err })
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err })
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})

// ─── Instance detection — must happen before anything touches userData ────────
//
// --instance=N gives each instance:
//   userData dir : Chronicle  / Chronicle-2  / Chronicle-3  …
//   relay port   : 4869       / 4870         / 4871         …
//   app name     : Chronicle  / Chronicle-2  / Chronicle-3  …  (drives lock key)
//   window title : Chronicle  / Chronicle (Instance 2)      …
//   partition    : persist:chronicle / persist:chronicle-2   …

const instanceArg = process.argv.find(a => a.startsWith('--instance='))
const instanceNum  = instanceArg ? Math.max(1, parseInt(instanceArg.split('=')[1], 10)) : 1
const isSecondary  = instanceNum > 1

const RELAY_PORT   = 4869 + (instanceNum - 1)
const RELAY_HOST   = '127.0.0.1'
const isDev        = process.env.NODE_ENV === 'development' || !app.isPackaged

// Set app name FIRST — Electron uses this as the single-instance lock key.
// Different name = different lock = both instances can run simultaneously.
const APP_NAME = isSecondary ? `Chronicle-${instanceNum}` : 'Chronicle'
app.setName(APP_NAME)

// Override userData BEFORE the lock (and before app.ready).
// This ensures every subsequent call to app.getPath('userData') returns the
// right directory — including inside the IPC store handlers below.
if (isSecondary) {
  // Default userData is e.g. C:\Users\Matt\AppData\Roaming\Chronicle
  // We want:                  C:\Users\Matt\AppData\Roaming\Chronicle-2
  const base = app.getPath('userData')          // still 'Chronicle' at this point
  const parent = path.dirname(base)
  app.setPath('userData', path.join(parent, APP_NAME))
}

// ─── Single-instance lock ─────────────────────────────────────────────────────
// Because app.setName() changed the app name, Electron uses a different lock
// file for each instance — no options object needed.

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (global.mainWindow) {
      if (global.mainWindow.isMinimized()) global.mainWindow.restore()
      global.mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    initSqliteStore()
    startRelay()
    const win = createWindow()
    setupAutoUpdater(win)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    stopRelay()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => { stopRelay() })
  app.on('will-quit',   () => { stopRelay() })
}

// ─── Auto-updater (production only) ──────────────────────────────────────────
// Only run on the primary instance — we don't want two update dialogs.

let autoUpdater      = null
let currentUpdateInfo = null

function setupAutoUpdater(win) {
  if (isDev || isSecondary) return

  try {
    const { autoUpdater: au } = require('electron-updater')
    autoUpdater = au

    autoUpdater.autoDownload        = true
    autoUpdater.autoInstallOnAppQuit = true

    const sendStatus = (type, payload = {}) => {
      if (win && !win.isDestroyed())
        win.webContents.send('update-status', { type, ...payload })
    }

    autoUpdater.on('checking-for-update',  ()     => { console.log('[updater] Checking…'); sendStatus('checking') })
    autoUpdater.on('update-available',     (info) => { console.log('[updater] Available:', info.version); currentUpdateInfo = info; sendStatus('available', { newVersion: info.version, currentVersion: app.getVersion() }) })
    autoUpdater.on('update-not-available', ()     => { console.log('[updater] Up to date.'); sendStatus('up-to-date', { currentVersion: app.getVersion() }) })
    autoUpdater.on('download-progress',    (p)    => { sendStatus('downloading', { percent: Math.round(p.percent) }) })
    autoUpdater.on('update-downloaded',    (info) => { console.log('[updater] Downloaded:', info.version); sendStatus('ready', { newVersion: info.version, currentVersion: app.getVersion() }) })
    autoUpdater.on('error',                (err)  => { console.error('[updater] Error:', err.message); sendStatus('error', { message: err.message }) })
  } catch (e) {
    console.warn('[updater] electron-updater not available:', e.message)
  }
}

ipcMain.handle('get-version',      ()  => app.getVersion())
ipcMain.handle('check-for-update', async () => {
  if (!autoUpdater) return { error: 'Updater not available' }
  try { await autoUpdater.checkForUpdates(); return { ok: true } }
  catch (e) { return { error: e.message } }
})
ipcMain.on('install-update', () => { if (autoUpdater) autoUpdater.quitAndInstall(false, true) })

// ─── Persistent key-value store ───────────────────────────────────────────────
// Derived AFTER setPath so it points at the correct instance directory.
// DO NOT move this above the setPath call.

const storeDir = app.getPath('userData')

ipcMain.handle('store-get', (_event, key) => {
  try {
    const filePath = path.join(storeDir, `${key}.json`)
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    console.error('[store-get]', key, e.message)
    return null
  }
})

ipcMain.handle('store-set', (_event, key, value) => {
  try {
    fs.mkdirSync(storeDir, { recursive: true })
    const filePath = path.join(storeDir, `${key}.json`)
    fs.writeFileSync(filePath, value, 'utf8')
    return true
  } catch (e) {
    console.error('[store-set]', key, e.message)
    return false
  }
})

// ─── SQLite store (Stage 7) ───────────────────────────────────────────────────

let sqliteStore = null

function initSqliteStore() {
  try {
    const storePath = isDev
      ? path.join(__dirname, '..', 'src', 'lib', 'sqliteStore.js')
      : path.join(__dirname, '..', 'dist', 'sqliteStore.js')

    let SqliteStore
    try {
      SqliteStore = require(storePath).SqliteStore
    } catch (_e) {
      console.warn('[main] SqliteStore compiled output not found; using in-memory stores')
      return
    }

    const dbPath = path.join(app.getPath('userData'), 'chronicle.db')
    sqliteStore = new SqliteStore(dbPath)
    console.log('[main] SqliteStore initialised at', dbPath)

    try {
      const graphPath = isDev
        ? path.join(__dirname, '..', 'src', 'lib', 'graph.js')
        : path.join(__dirname, '..', 'dist', 'graph.js')
      const { setGraphBackend } = require(graphPath)
      setGraphBackend(sqliteStore)
      console.log('[main] Graph backend → SqliteStore')
    } catch (e) {
      console.warn('[main] Could not inject graph backend:', e.message)
    }

    try {
      const blossomPath = isDev
        ? path.join(__dirname, '..', 'src', 'lib', 'blossom.js')
        : path.join(__dirname, '..', 'dist', 'blossom.js')
      const { mediaCache } = require(blossomPath)
      mediaCache.setBackend(sqliteStore)
      console.log('[main] Media cache backend → SqliteStore')
    } catch (e) {
      console.warn('[main] Could not inject media cache backend:', e.message)
    }
  } catch (e) {
    console.error('[main] SqliteStore init failed:', e.message)
  }
}

// ─── Embedded relay ───────────────────────────────────────────────────────────

let relayProcess = null

function startRelay() {
  const relayScript = isDev
    ? path.join(__dirname, '..', 'relay', 'server.js')
    : path.join(process.resourcesPath, 'relay', 'server.js')

  if (!fs.existsSync(relayScript)) {
    console.error('[main] Relay script not found at', relayScript)
    return
  }

  relayProcess = spawn(process.execPath.replace('Electron', 'node') || 'node', [relayScript], {
    env: {
      ...process.env,
      PORT:          String(RELAY_PORT),
      HOST:          RELAY_HOST,
      DB_PATH:       path.join(app.getPath('userData'), 'chronicle.db'),
      ALLOWLIST_PATH: path.join(app.getPath('userData'), 'allowlist.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  relayProcess.stdout.on('data', d => console.log('[relay]', d.toString().trim()))
  relayProcess.stderr.on('data', d => console.error('[relay]', d.toString().trim()))
  relayProcess.on('exit',  (code, sig) => { console.log(`[relay] exited code=${code} sig=${sig}`); relayProcess = null })
  relayProcess.on('error', err => console.error('[relay] failed to start:', err.message))

  console.log(`[main] Relay started on port ${RELAY_PORT}, PID:`, relayProcess.pid)
}

function stopRelay() {
  if (relayProcess) { relayProcess.kill('SIGTERM'); relayProcess = null }
}

// ─── Browser window ───────────────────────────────────────────────────────────

let mainWindow = null

function createWindow() {
  const windowTitle    = isSecondary ? `Chronicle (Instance ${instanceNum})` : 'Chronicle'
  const sessionPartition = isSecondary ? `persist:chronicle-${instanceNum}` : 'persist:chronicle'

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: windowTitle,
    backgroundColor: '#0a1628',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: sessionPartition,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  })

  global.mainWindow = mainWindow

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' } }
    return { action: 'allow' }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  return mainWindow
}
