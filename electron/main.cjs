/**
 * Chronicle Electron Main Process
 *
 * Multi-instance: launch with --instance=2 to run a fully independent second
 * instance alongside the first. Each instance has its own userData directory,
 * relay port, single-instance lock, session partition, and window title.
 *
 * ORDERING IS CRITICAL:
 *   app.setPath('userData') must be called before app.requestSingleInstanceLock()
 *   which must be called before app.whenReady().
 *   storeDir is derived AFTER setPath so IPC handlers read/write the right directory.
 *
 *   app.setName() is intentionally NOT called on the primary instance — doing so
 *   can silently change the userData path if the packaged app name differs from
 *   the string passed. Only secondary instances use setName, and only to get a
 *   different lock key (Electron derives the lock from the app name on Windows).
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

// ─── Instance detection ───────────────────────────────────────────────────────
// Must happen before anything that touches userData or the single-instance lock.

const instanceArg = process.argv.find(a => a.startsWith('--instance='))
const instanceNum  = instanceArg ? Math.max(1, parseInt(instanceArg.split('=')[1], 10)) : 1
const isSecondary  = instanceNum > 1

const RELAY_PORT = 4869 + (instanceNum - 1)   // 4869, 4870, 4871 ...
const RELAY_HOST = '127.0.0.1'
const isDev      = process.env.NODE_ENV === 'development' || !app.isPackaged

// Secondary instances need a separate userData directory so each has its own
// identity, key material, and SQLite database.
// Primary instance: leave userData completely untouched — never call setPath or
// setName on it, so there is zero risk of disturbing existing data.
if (isSecondary) {
  // app.getPath('userData') at this point returns the default path for the
  // primary instance (e.g. C:\Users\Matt\AppData\Roaming\Chronicle).
  // We append -2, -3 etc. to get a sibling directory.
  const primaryUserData = app.getPath('userData')
  const secondaryUserData = `${primaryUserData}-${instanceNum}`
  app.setPath('userData', secondaryUserData)

  // Change the app name so Electron uses a different single-instance lock key.
  // We do this ONLY for secondary instances. On the primary instance we leave
  // the name alone — the packaged executable already has the correct name baked
  // in, and calling setName can silently shift the userData path on some builds.
  app.setName(`Chronicle-${instanceNum}`)
}

// ─── Single-instance lock ─────────────────────────────────────────────────────
// Primary instance:   lock key = default (app's packaged name)
// Secondary instance: lock key = "Chronicle-2" (set above via setName)
// Both can coexist because they hold different lock keys.

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

// ─── Auto-updater (production, primary instance only) ────────────────────────

let autoUpdater       = null
let currentUpdateInfo = null

function setupAutoUpdater(win) {
  if (isDev || isSecondary) return

  try {
    const { autoUpdater: au } = require('electron-updater')
    autoUpdater = au

    autoUpdater.autoDownload         = true
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

ipcMain.handle('get-version',   () => app.getVersion())
ipcMain.handle('get-relay-port', () => RELAY_PORT)
ipcMain.handle('get-instance',   () => instanceNum)

// Write pubkey directly to the allowlist file AND notify the running relay
// via HTTP. Writing the file directly handles the case where the relay isn't
// up yet — it will load the file on startup. The HTTP call handles the live
// case where we need the relay to accept events from this pubkey immediately.
ipcMain.handle('allowlist-add', async (_event, hexPubkey) => {
  relayLog(`[main] allowlist-add IPC called with: ${String(hexPubkey).slice(0, 16)}… length=${String(hexPubkey).length}`)
  if (typeof hexPubkey !== 'string' || hexPubkey.length !== 64) {
    relayLog(`[main] allowlist-add REJECTED: invalid pubkey (length=${String(hexPubkey).length})`)
    return { ok: false, error: 'invalid pubkey' }
  }
  // Write to file directly (relay reads this on startup)
  const allowlistPath = path.join(app.getPath('userData'), 'allowlist.json')
  relayLog(`[main] allowlist-add writing to: ${allowlistPath}`)
  try {
    let current = []
    if (fs.existsSync(allowlistPath)) {
      current = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
    }
    if (!current.includes(hexPubkey)) {
      current.push(hexPubkey)
      fs.writeFileSync(allowlistPath, JSON.stringify(current, null, 2))
      relayLog(`[main] allowlist: added ${hexPubkey.slice(0, 8)}… (file written)`)
    }
  } catch (e) {
    relayLog(`[main] allowlist file write failed: ${e.message}`)
  }
  // Also notify the running relay via HTTP so it takes effect immediately
  // without requiring a restart. Retry a few times to handle relay startup delay.
  const tryHttp = async (attempts) => {
    try {
      const http = require('http')
      await new Promise((resolve, reject) => {
        const body = JSON.stringify({ pubkey: hexPubkey })
        const req = http.request({
          hostname: '127.0.0.1', port: RELAY_PORT, path: '/allowlist/add',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          relayLog(`[main] allowlist HTTP response: ${res.statusCode}`)
          resolve(res.statusCode)
        })
        req.on('error', reject)
        req.write(body)
        req.end()
      })
    } catch (e) {
      if (attempts > 0) {
        await new Promise(r => setTimeout(r, 1000))
        await tryHttp(attempts - 1)
      } else {
        relayLog(`[main] allowlist HTTP failed after retries: ${e.message}`)
      }
    }
  }
  tryHttp(5)  // retry up to 5 times, 1 second apart
  return { ok: true }
})

ipcMain.handle('check-for-update', async () => {
  if (!autoUpdater) return { error: 'Updater not available' }
  try { await autoUpdater.checkForUpdates(); return { ok: true } }
  catch (e) { return { error: e.message } }
})

ipcMain.on('install-update', () => {
  if (autoUpdater) autoUpdater.quitAndInstall(false, true)
})

// ─── Persistent key-value store ───────────────────────────────────────────────
// storeDir is evaluated HERE — after setPath — so it resolves to the correct
// instance directory. Do not hoist this above the setPath call.

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

// Write relay diagnostics to a log file so we can inspect them without DevTools
const relayLogPath = path.join(app.getPath('userData'), 'relay.log')
function relayLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(relayLogPath, line) } catch {}
  console.log(msg)
}

// Expose relay log via IPC for the Settings page diagnostic display
ipcMain.handle('get-relay-log', () => {
  try {
    if (fs.existsSync(relayLogPath)) {
      return fs.readFileSync(relayLogPath, 'utf8').split('\n').slice(-50).join('\n')
    }
  } catch {}
  return ''
})

function startRelay() {
  // Clear old log on each start
  try { fs.writeFileSync(relayLogPath, '') } catch {}

  const relayScript = isDev
    ? path.join(__dirname, '..', 'relay', 'server.js')
    : path.join(process.resourcesPath, 'relay', 'server.js')

  relayLog(`[main] relay script path: ${relayScript}`)
  relayLog(`[main] relay script exists: ${fs.existsSync(relayScript)}`)
  relayLog(`[main] process.execPath: ${process.execPath}`)
  relayLog(`[main] process.resourcesPath: ${process.resourcesPath || 'N/A'}`)

  if (!fs.existsSync(relayScript)) {
    relayLog(`[main] ERROR: Relay script not found at ${relayScript}`)
    return
  }

  // Find Node.js. In a packaged Electron app on Windows, there is no separate
  // node.exe — Electron IS the Node runtime. We use Electron's own executable
  // with ELECTRON_RUN_AS_NODE=1 env var, which makes it behave as plain Node.
  const nodeBin = process.execPath
  relayLog(`[main] Using node bin: ${nodeBin}`)

  relayProcess = spawn(nodeBin, [relayScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',  // run Electron as plain Node for the relay
      PORT:           String(RELAY_PORT),
      HOST:           RELAY_HOST,
      DB_PATH:        path.join(app.getPath('userData'), 'chronicle.db'),
      ALLOWLIST_PATH: path.join(app.getPath('userData'), 'allowlist.json'),
      // Pass resourcesPath so the relay can find app node_modules in the asar
      RESOURCES_PATH: process.resourcesPath || path.join(__dirname, '..'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  relayProcess.stdout.on('data', d => relayLog(`[relay] ${d.toString().trim()}`))
  relayProcess.stderr.on('data', d => relayLog(`[relay:err] ${d.toString().trim()}`))
  relayProcess.on('exit',  (code, sig) => {
    relayLog(`[relay] exited code=${code} sig=${sig}`)
    relayProcess = null
  })
  relayProcess.on('error', err => relayLog(`[relay] failed to start: ${err.message}`))

  relayLog(`[main] Relay spawned PID: ${relayProcess.pid} port: ${RELAY_PORT}`)
}

function stopRelay() {
  if (relayProcess) { relayProcess.kill('SIGTERM'); relayProcess = null }
}

// ─── Browser window ───────────────────────────────────────────────────────────

let mainWindow = null

function createWindow() {
  const windowTitle      = isSecondary ? `Chronicle (Instance ${instanceNum})` : 'Chronicle'
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
    // Temporarily open DevTools in production to diagnose sync issues
    // TODO: remove before public release
    mainWindow.webContents.openDevTools()
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' } }
    return { action: 'allow' }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  return mainWindow
}
