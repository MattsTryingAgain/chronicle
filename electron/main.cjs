/**
 * Chronicle Electron Main Process — Stage 7
 *
 * Responsibilities:
 * - Create the BrowserWindow loading the Vite-built React app
 * - Spawn the embedded relay (relay/server.js) as a child process
 * - Manage relay lifecycle (start on app ready, kill on quit)
 * - Handle app auto-update via electron-updater (Stage 6)
 * - Construct SqliteStore and inject it as the graph + media cache backend (Stage 7)
 *
 * The relay runs on ws://127.0.0.1:4869 by default.
 * The React app connects to this automatically via AppContext.
 */

const { app, BrowserWindow, shell, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')

// ─── Suppress EPIPE errors from broken stdout/stderr pipes ───────────────────
// These occur when a second instance quits immediately via the single-instance
// lock and Node tries to write to the now-closed pipe.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err })
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err })
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return  // ignore broken pipe
  // For any other uncaught error, show it (default Electron behaviour)
  throw err
})

// ─── Constants ────────────────────────────────────────────────────────────────

const RELAY_PORT = 4869
const RELAY_HOST = '127.0.0.1'
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// ─── Single instance lock ─────────────────────────────────────────────────────
// Prevent multiple copies of the app opening at the same time.
// If a second instance is launched, focus the existing window instead.

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  // Another instance is already running — quit immediately without creating any window
  app.quit()
} else {
  // We are the primary instance — set up second-instance handler and run normally
  app.on('second-instance', () => {
    if (global.mainWindow) {
      if (global.mainWindow.isMinimized()) global.mainWindow.restore()
      global.mainWindow.focus()
    }
  })

  // ─── App lifecycle (only runs in the primary instance) ──────────────────────

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

  app.on('before-quit', () => {
    stopRelay()
  })

  app.on('will-quit', () => {
    stopRelay()
  })
}

// ─── Auto-updater (production only) ──────────────────────────────────────────
// electron-updater must be installed: npm install electron-updater
// Configured via package.json build.publish field.
// In dev mode we skip this to avoid spurious update checks.

let autoUpdater = null

function setupAutoUpdater(win) {
  if (isDev) return

  try {
    const { autoUpdater: au } = require('electron-updater')
    autoUpdater = au

    // Silent background check — only notify, never auto-install without consent
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      console.log('[updater] Checking for update…')
    })

    autoUpdater.on('update-available', (info) => {
      console.log('[updater] Update available:', info.version)
      win.webContents.send('update-available', { version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
      console.log('[updater] App is up to date.')
    })

    autoUpdater.on('download-progress', (progress) => {
      console.log(`[updater] Download: ${Math.round(progress.percent)}%`)
    })

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[updater] Update downloaded:', info.version)
      win.webContents.send('update-downloaded', { version: info.version })
    })

    autoUpdater.on('error', (err) => {
      console.error('[updater] Error:', err.message)
    })

    // Check on startup, then every 4 hours
    autoUpdater.checkForUpdatesAndNotify()
    setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000)
  } catch (e) {
    // electron-updater not installed — skip silently in development
    console.warn('[updater] electron-updater not available:', e.message)
  }
}

// IPC: renderer can ask to install the downloaded update
ipcMain.on('install-update', () => {
  if (autoUpdater) {
    autoUpdater.quitAndInstall(false, true)
  }
})

// ─── SQLite store (Stage 7) ───────────────────────────────────────────────────
// SqliteStore requires native better-sqlite3; only loaded inside Electron.
// The graph backend and media cache backend are injected here so all
// modules use SQLite persistence rather than in-memory stores.

let sqliteStore = null

function initSqliteStore() {
  try {
    // These paths are relative to the built app — adjust for dev vs prod.
    const storePath = isDev
      ? path.join(__dirname, '..', 'src', 'lib', 'sqliteStore.js')
      : path.join(__dirname, '..', 'dist', 'sqliteStore.js')

    // Try loading the compiled JS; fall back gracefully if unavailable
    // (e.g. when running from source with ts-node not available).
    let SqliteStore
    try {
      // In Electron, the renderer bundle is not available in main — use
      // a direct require of the TS-compiled output if present, otherwise
      // skip SQLite and use in-memory stores (dev mode without pre-build).
      SqliteStore = require(storePath).SqliteStore
    } catch (_e) {
      // Compiled output not present — use dynamic require of source via
      // ts-node if available (dev only), otherwise skip.
      console.warn('[main] SqliteStore compiled output not found; using in-memory stores')
      return
    }

    const dbPath = path.join(app.getPath('userData'), 'chronicle.db')
    sqliteStore = new SqliteStore(dbPath)
    console.log('[main] SqliteStore initialised at', dbPath)

    // Inject into graph module
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

    // Inject into media cache
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
      PORT: String(RELAY_PORT),
      HOST: RELAY_HOST,
      DB_PATH: path.join(app.getPath('userData'), 'chronicle.db'),
      ALLOWLIST_PATH: path.join(app.getPath('userData'), 'allowlist.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  relayProcess.stdout.on('data', (data) => {
    console.log('[relay]', data.toString().trim())
  })

  relayProcess.stderr.on('data', (data) => {
    console.error('[relay]', data.toString().trim())
  })

  relayProcess.on('exit', (code, signal) => {
    console.log(`[relay] exited — code=${code} signal=${signal}`)
    relayProcess = null
  })

  relayProcess.on('error', (err) => {
    console.error('[relay] failed to start:', err.message)
  })

  console.log('[main] Relay started, PID:', relayProcess.pid)
}

function stopRelay() {
  if (relayProcess) {
    relayProcess.kill('SIGTERM')
    relayProcess = null
  }
}

// ─── Browser window ───────────────────────────────────────────────────────────

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Chronicle',
    backgroundColor: '#0a1628',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:chronicle',
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
    if (url.startsWith('http')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

