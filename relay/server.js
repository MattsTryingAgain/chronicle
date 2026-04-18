/**
 * Chronicle Embedded Relay — relay/server.js
 *
 * A lightweight NIP-01-compliant Nostr relay designed to run locally
 * alongside the Chronicle app.
 *
 * Key properties:
 * - Allowlist-only: only pubkeys in the allowlist can write events
 * - All Chronicle event kinds (30078–30090) are accepted from allowed pubkeys
 * - Full NIP-01 wire protocol: EVENT / REQ / CLOSE → OK / EVENT / EOSE / NOTICE
 * - Subscription filtering: kinds, authors, ids, since, until, limit
 * - SQLite-backed persistence via better-sqlite3
 * - In Stage 3 this process is spawned as an Electron background process
 *
 * Usage:
 *   node relay/server.js          # binds ws://127.0.0.1:4869
 *   PORT=9000 node relay/server.js
 *
 * Install dependencies (in relay/ directory):
 *   npm install
 */

'use strict'

const WebSocket = require('ws')
const path = require('path')
const fs = require('fs')

// ── Configuration ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '4869', 10)
const HOST = process.env.HOST || '127.0.0.1'
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'chronicle.db')
const ALLOWLIST_PATH = process.env.ALLOWLIST_PATH || path.join(__dirname, 'allowlist.json')

/** Chronicle event kinds — the relay only stores these */
const CHRONICLE_KINDS = new Set([
  30078, 30079, 30080, 30081, 30082, 30083,
  30084, 30085, 30086, 30087, 30088, 30089, 30090,
])

const MAX_FILTERS_PER_REQ = 10
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 100

// ── Allowlist ─────────────────────────────────────────────────────────────────

/**
 * Simple file-backed allowlist of hex pubkeys permitted to write events.
 * Reads on startup and provides hot-reload via add/remove helpers.
 * The main Chronicle app manages this list — it adds a pubkey when
 * a new identity is created or when a contact is trusted.
 */
const allowlist = {
  /** @type {Set<string>} */
  pubkeys: new Set(),

  load() {
    try {
      if (fs.existsSync(ALLOWLIST_PATH)) {
        const data = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
        this.pubkeys = new Set(Array.isArray(data) ? data : [])
        console.log(`[relay] Loaded ${this.pubkeys.size} allowed pubkeys`)
      } else {
        this.pubkeys = new Set()
        this.save()
      }
    } catch (err) {
      console.error('[relay] Failed to load allowlist:', err.message)
      this.pubkeys = new Set()
    }
  },

  save() {
    try {
      fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify([...this.pubkeys], null, 2))
    } catch (err) {
      console.error('[relay] Failed to save allowlist:', err.message)
    }
  },

  has(hexPubkey) {
    return this.pubkeys.has(hexPubkey)
  },

  add(hexPubkey) {
    this.pubkeys.add(hexPubkey)
    this.save()
  },

  remove(hexPubkey) {
    this.pubkeys.delete(hexPubkey)
    this.save()
  },
}

// ── Database ───────────────────────────────────────────────────────────────────

let db

function initDb() {
  const Database = require('better-sqlite3')
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      pubkey     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      kind       INTEGER NOT NULL,
      tags       TEXT NOT NULL,
      content    TEXT NOT NULL,
      sig        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_pubkey     ON events(pubkey);
    CREATE INDEX IF NOT EXISTS idx_events_kind       ON events(kind);
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
  `)

  console.log(`[relay] Database ready at ${DB_PATH}`)
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

function insertEvent(event) {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig)
      VALUES (@id, @pubkey, @created_at, @kind, @tags, @content, @sig)
    `)
    const result = stmt.run({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: JSON.stringify(event.tags || []),
      content: event.content || '',
      sig: event.sig,
    })
    return result.changes > 0
  } catch (err) {
    console.error('[relay] insertEvent error:', err.message)
    return false
  }
}

function queryEvents(filters) {
  const results = new Map()

  for (const filter of filters) {
    const conditions = []
    const params = {}

    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map((_, i) => `@kind${i}`).join(',')
      filter.kinds.forEach((k, i) => { params[`kind${i}`] = k })
      conditions.push(`kind IN (${placeholders})`)
    }

    if (filter.authors && filter.authors.length > 0) {
      const placeholders = filter.authors.map((_, i) => `@author${i}`).join(',')
      filter.authors.forEach((a, i) => { params[`author${i}`] = a })
      conditions.push(`pubkey IN (${placeholders})`)
    }

    if (filter.ids && filter.ids.length > 0) {
      const placeholders = filter.ids.map((_, i) => `@id${i}`).join(',')
      filter.ids.forEach((id, i) => { params[`id${i}`] = id })
      conditions.push(`id IN (${placeholders})`)
    }

    if (filter.since != null) {
      conditions.push(`created_at >= @since`)
      params.since = filter.since
    }

    if (filter.until != null) {
      conditions.push(`created_at <= @until`)
      params.until = filter.until
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT)

    const sql = `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ${limit}`
    const stmt = db.prepare(sql)
    const rows = stmt.all(params)

    for (const row of rows) {
      if (!results.has(row.id)) {
        results.set(row.id, rowToEvent(row))
      }
    }
  }

  return [...results.values()]
}

function rowToEvent(row) {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags),
    content: row.content,
    sig: row.sig,
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Minimal structural validation — Chronicle client events are already
 * signed and verified before sending. We check structure only, not sig,
 * to avoid pulling in nostr-tools as a relay dependency.
 */
function validateEvent(event) {
  if (typeof event !== 'object' || event === null) return 'not an object'
  if (typeof event.id !== 'string' || event.id.length !== 64) return 'invalid id'
  if (typeof event.pubkey !== 'string' || event.pubkey.length !== 64) return 'invalid pubkey'
  if (typeof event.created_at !== 'number') return 'invalid created_at'
  if (typeof event.kind !== 'number') return 'invalid kind'
  if (!Array.isArray(event.tags)) return 'invalid tags'
  if (typeof event.content !== 'string') return 'invalid content'
  if (typeof event.sig !== 'string' || event.sig.length !== 128) return 'invalid sig'
  return null
}

// ── WebSocket server ──────────────────────────────────────────────────────────

/**
 * Per-connection subscription state.
 * @type {Map<string, { filters: object[], socket: WebSocket }>}
 */
const subscriptions = new Map() // subKey → { filters, socket }

function subKey(socketId, subId) {
  return `${socketId}:${subId}`
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)) } catch { /* ignore */ }
  }
}

function handleMessage(ws, socketId, raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    send(ws, ['NOTICE', 'error: invalid JSON'])
    return
  }

  if (!Array.isArray(msg) || msg.length < 2) {
    send(ws, ['NOTICE', 'error: expected array'])
    return
  }

  const [type, ...rest] = msg

  // ── EVENT ──────────────────────────────────────────────────────────────────
  if (type === 'EVENT') {
    const event = rest[0]
    const validationError = validateEvent(event)

    if (validationError) {
      send(ws, ['OK', event?.id ?? '', false, `invalid: ${validationError}`])
      return
    }

    // Allowlist check
    if (!allowlist.has(event.pubkey)) {
      send(ws, ['OK', event.id, false, 'blocked: pubkey not in allowlist'])
      return
    }

    // Kind check — relay only stores Chronicle kinds
    if (!CHRONICLE_KINDS.has(event.kind)) {
      send(ws, ['OK', event.id, false, `blocked: kind ${event.kind} not accepted`])
      return
    }

    const inserted = insertEvent(event)

    if (inserted) {
      // Fan out to active subscriptions
      for (const [, sub] of subscriptions) {
        if (sub.socket !== ws && matchesFilters(event, sub.filters)) {
          send(sub.socket, ['EVENT', sub.subId, event])
        }
      }
    }

    send(ws, ['OK', event.id, true, inserted ? '' : 'duplicate: already stored'])
    return
  }

  // ── REQ ────────────────────────────────────────────────────────────────────
  if (type === 'REQ') {
    const subId = rest[0]
    if (typeof subId !== 'string') {
      send(ws, ['NOTICE', 'error: REQ missing subscription id'])
      return
    }

    const filters = rest.slice(1)
    if (filters.length === 0) {
      send(ws, ['NOTICE', 'error: REQ requires at least one filter'])
      return
    }

    if (filters.length > MAX_FILTERS_PER_REQ) {
      send(ws, ['NOTICE', `error: max ${MAX_FILTERS_PER_REQ} filters per REQ`])
      return
    }

    // Register subscription (overwrite if same id re-used)
    const key = subKey(socketId, subId)
    subscriptions.set(key, { filters, socket: ws, subId })

    // Return stored events matching filters
    let events = []
    try {
      events = queryEvents(filters)
    } catch (err) {
      console.error('[relay] queryEvents error:', err.message)
    }

    for (const event of events) {
      send(ws, ['EVENT', subId, event])
    }
    send(ws, ['EOSE', subId])
    return
  }

  // ── CLOSE ──────────────────────────────────────────────────────────────────
  if (type === 'CLOSE') {
    const subId = rest[0]
    if (typeof subId === 'string') {
      subscriptions.delete(subKey(socketId, subId))
    }
    return
  }

  send(ws, ['NOTICE', `unknown message type: ${type}`])
}

function matchesFilters(event, filters) {
  for (const filter of filters) {
    if (matchesFilter(event, filter)) return true
  }
  return false
}

function matchesFilter(event, filter) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.since != null && event.created_at < filter.since) return false
  if (filter.until != null && event.created_at > filter.until) return false
  return true
}

// ── HTTP upgrade handler (NIP-11 relay info) ──────────────────────────────────

function relayInfo() {
  return {
    name: 'Chronicle Embedded Relay',
    description: 'Private embedded relay for Chronicle genealogy app',
    supported_nips: [1],
    software: 'chronicle-relay',
    version: '1.0.0',
  }
}

// ── HTTP server (for NIP-11 and allowlist management API) ─────────────────────

const http = require('http')

const httpServer = http.createServer((req, res) => {
  // NIP-11: relay info document
  if (req.headers.accept?.includes('application/nostr+json')) {
    res.writeHead(200, { 'Content-Type': 'application/nostr+json' })
    res.end(JSON.stringify(relayInfo()))
    return
  }

  // Simple allowlist management API (localhost-only, no auth needed)
  // Used by the Chronicle app to add/remove pubkeys as users connect/disconnect.

  if (req.method === 'POST' && req.url === '/allowlist/add') {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      try {
        const { pubkey } = JSON.parse(body)
        if (typeof pubkey === 'string' && pubkey.length === 64) {
          allowlist.add(pubkey)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'invalid pubkey' }))
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }))
      }
    })
    return
  }

  if (req.method === 'POST' && req.url === '/allowlist/remove') {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      try {
        const { pubkey } = JSON.parse(body)
        if (typeof pubkey === 'string') {
          allowlist.remove(pubkey)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } else {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: 'invalid pubkey' }))
        }
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }))
      }
    })
    return
  }

  if (req.method === 'GET' && req.url === '/allowlist') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([...allowlist.pubkeys]))
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, connections: wss?.clients?.size ?? 0 }))
    return
  }

  res.writeHead(404)
  res.end()
})

// ── WebSocket server ──────────────────────────────────────────────────────────

let wss
let socketCounter = 0

function startServer() {
  allowlist.load()
  initDb()

  wss = new WebSocket.Server({ server: httpServer })

  wss.on('connection', (ws) => {
    const socketId = String(++socketCounter)

    ws.on('message', (data) => {
      try {
        handleMessage(ws, socketId, data.toString())
      } catch (err) {
        console.error('[relay] Unhandled message error:', err.message)
      }
    })

    ws.on('close', () => {
      // Clean up all subscriptions for this socket
      for (const key of [...subscriptions.keys()]) {
        if (key.startsWith(`${socketId}:`)) {
          subscriptions.delete(key)
        }
      }
    })

    ws.on('error', (err) => {
      console.error(`[relay] Socket error (${socketId}):`, err.message)
    })
  })

  httpServer.listen(PORT, HOST, () => {
    console.log(`[relay] Chronicle relay listening on ws://${HOST}:${PORT}`)
    console.log(`[relay] HTTP management API on http://${HOST}:${PORT}`)
    console.log(`[relay] DB: ${DB_PATH}`)
    console.log(`[relay] Allowlist: ${ALLOWLIST_PATH}`)
  })
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[relay] ${signal} received — shutting down`)
  try { db?.close() } catch { /* ignore */ }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

startServer()
