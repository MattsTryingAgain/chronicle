/**
 * Chronicle Relay Client
 *
 * Handles the WebSocket connection to a Nostr relay (local embedded or remote).
 * Implements:
 * - Connect / disconnect lifecycle
 * - Publish events (REQ/EVENT)
 * - Subscribe with filters
 * - Automatic reconnection with exponential backoff
 * - Graceful failure — all errors are caught and surfaced as status, never thrown
 *
 * This module is protocol-level only. It knows nothing about Chronicle domain
 * logic; it just sends and receives Nostr wire messages.
 *
 * Note: The embedded relay (runs as a local Node process in Stage 2, as an
 * Electron background process in Stage 3) is accessed via ws://127.0.0.1:PORT.
 */

import type { ChronicleEvent } from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

export type RelayStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

export interface RelayFilter {
  kinds?: number[]
  authors?: string[]   // hex pubkeys
  ids?: string[]
  since?: number
  until?: number
  limit?: number
  '#e'?: string[]
  '#p'?: string[]
  [key: string]: unknown
}

export type RelayEventCallback = (event: ChronicleEvent) => void
export type RelayStatusCallback = (status: RelayStatus, url: string) => void

export type RelayEoseCallback = (subId: string) => void

interface Subscription {
  id: string
  filters: RelayFilter[]
  callback: RelayEventCallback
  onEose?: RelayEoseCallback
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000
const RECONNECT_BACKOFF_FACTOR = 2
const PING_INTERVAL_MS = 30_000

// ─── RelayClient ─────────────────────────────────────────────────────────────

export class RelayClient {
  private url: string
  private ws: WebSocket | null = null
  private status: RelayStatus = 'disconnected'
  private subscriptions: Map<string, Subscription> = new Map()
  private pendingPublish: ChronicleEvent[] = []
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private statusListeners: RelayStatusCallback[] = []
  private subCounter = 0
  private destroyed = false

  constructor(url: string) {
    this.url = url
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getStatus(): RelayStatus {
    return this.status
  }

  getUrl(): string {
    return this.url
  }

  onStatusChange(cb: RelayStatusCallback): () => void {
    this.statusListeners.push(cb)
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== cb)
    }
  }

  /** Connect to the relay. Idempotent — safe to call when already connected. */
  connect(): void {
    if (this.destroyed) return
    if (this.status === 'connected' || this.status === 'connecting') return
    this.openSocket()
  }

  /** Permanently disconnect and stop reconnecting. */
  destroy(): void {
    this.destroyed = true
    this.clearTimers()
    this.closeSocket()
    this.setStatus('disconnected')
  }

  /**
   * Publish an event to the relay.
   * If not connected, the event is queued and sent when the connection resumes.
   */
  publish(event: ChronicleEvent): void {
    if (this.status === 'connected' && this.ws) {
      this.send(['EVENT', event])
    } else {
      this.pendingPublish.push(event)
      this.connect()
    }
  }

  /**
   * Subscribe to events matching the given filters.
   * Returns an unsubscribe function.
   */
  subscribe(filters: RelayFilter[], callback: RelayEventCallback, onEose?: RelayEoseCallback): () => void {
    const id = `sub${++this.subCounter}`
    const sub: Subscription = { id, filters, callback, onEose }
    this.subscriptions.set(id, sub)

    if (this.status === 'connected') {
      this.send(['REQ', id, ...filters])
    } else {
      this.connect()
    }

    return () => this.unsubscribe(id)
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private openSocket(): void {
    this.setStatus('connecting')
    try {
      const ws = new WebSocket(this.url)
      this.ws = ws

      ws.onopen = () => {
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS
        this.setStatus('connected')
        this.flushPending()
        this.resubscribeAll()
        this.startPing()
      }

      ws.onmessage = (ev: MessageEvent) => {
        this.handleMessage(ev.data as string)
      }

      ws.onerror = () => {
        this.setStatus('error')
      }

      ws.onclose = () => {
        this.ws = null
        this.clearPing()
        if (!this.destroyed) {
          this.setStatus('disconnected')
          this.scheduleReconnect()
        }
      }
    } catch {
      this.setStatus('error')
      this.scheduleReconnect()
    }
  }

  private closeSocket(): void {
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
  }

  private send(msg: unknown[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg))
      } catch {
        // Socket closed mid-send; will be requeued on reconnect
      }
    }
  }

  private handleMessage(raw: string): void {
    let msg: unknown[]
    try {
      msg = JSON.parse(raw) as unknown[]
    } catch {
      return
    }

    if (!Array.isArray(msg) || msg.length < 2) return

    const [type] = msg

    if (type === 'EVENT' && msg.length >= 3) {
      const subId = msg[1] as string
      const event = msg[2] as ChronicleEvent
      const sub = this.subscriptions.get(subId)
      if (sub) sub.callback(event)
      return
    }

    // EOSE (end of stored events) — notify subscriber if they registered a callback
    if (type === 'EOSE' && msg.length >= 2) {
      const subId = msg[1] as string
      const sub = this.subscriptions.get(subId)
      if (sub?.onEose) sub.onEose(subId)
      return
    }

    // NOTICE — relay info message, ignored
    // OK — publish acknowledgement, could be surfaced in future
  }

  private flushPending(): void {
    const queue = [...this.pendingPublish]
    this.pendingPublish = []
    for (const event of queue) {
      this.send(['EVENT', event])
    }
  }

  private resubscribeAll(): void {
    for (const sub of this.subscriptions.values()) {
      this.send(['REQ', sub.id, ...sub.filters])
    }
  }

  private unsubscribe(id: string): void {
    this.subscriptions.delete(id)
    if (this.status === 'connected') {
      this.send(['CLOSE', id])
    }
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) {
      try { listener(status, this.url) } catch { /* never crash on listener error */ }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    this.clearTimers()
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this.openSocket()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_FACTOR,
      MAX_RECONNECT_DELAY_MS,
    )
  }

  private startPing(): void {
    this.clearPing()
    this.pingTimer = setInterval(() => {
      // Send a lightweight REQ to keep the connection alive
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send(['REQ', 'ping', { kinds: [30078], limit: 0 }])
      }
    }, PING_INTERVAL_MS)
  }

  private clearPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.clearPing()
  }
}

// ─── Multi-relay pool ─────────────────────────────────────────────────────────

/**
 * RelayPool manages multiple relay connections.
 * Publishes to all connected relays; fan-out reads from all.
 */
export class RelayPool {
  private clients: Map<string, RelayClient> = new Map()

  add(url: string): RelayClient {
    if (this.clients.has(url)) return this.clients.get(url)!
    const client = new RelayClient(url)
    this.clients.set(url, client)
    return client
  }

  remove(url: string): void {
    const client = this.clients.get(url)
    if (client) { client.destroy(); this.clients.delete(url) }
  }

  connect(): void {
    for (const client of this.clients.values()) client.connect()
  }

  destroy(): void {
    for (const client of this.clients.values()) client.destroy()
    this.clients.clear()
  }

  publish(event: ChronicleEvent): void {
    for (const client of this.clients.values()) client.publish(event)
  }

  /** Subscribe across all relays; deduplication by event id is caller's responsibility */
  subscribe(filters: RelayFilter[], callback: RelayEventCallback, onEose?: RelayEoseCallback): () => void {
    const unsubs = Array.from(this.clients.values()).map(c => c.subscribe(filters, callback, onEose))
    return () => unsubs.forEach(u => u())
  }

  getStatuses(): Record<string, RelayStatus> {
    const out: Record<string, RelayStatus> = {}
    for (const [url, client] of this.clients) {
      out[url] = client.getStatus()
    }
    return out
  }
}
