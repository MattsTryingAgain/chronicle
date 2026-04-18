/**
 * Chronicle Offline Broadcast Queue
 *
 * Events created while offline (or before a relay connection is established)
 * are stored here. When a relay comes online, the queue drains automatically.
 *
 * The queue is backed by MemoryStore's relay_queue table (in-memory for Stage 2,
 * SQLite in Stage 3). Items are keyed by event id so duplicates are silently
 * dropped.
 *
 * This module is intentionally pure of React — it can be used from AppContext
 * or from a future Electron IPC handler.
 */

import type { ChronicleEvent } from '../types/chronicle'
import type { RelayClient, RelayPool } from './relay'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueuedEvent {
  event: ChronicleEvent
  /** Unix timestamp when this was enqueued */
  queuedAt: number
  /** Number of publish attempts made */
  attempts: number
  /** Target relay URLs. Empty = broadcast to all connected relays. */
  targetRelays: string[]
}

// ─── BroadcastQueue ───────────────────────────────────────────────────────────

export class BroadcastQueue {
  private queue: Map<string, QueuedEvent> = new Map()
  private draining = false

  // ── Enqueue ────────────────────────────────────────────────────────────────

  /**
   * Add an event to the queue.
   * Silently drops duplicates (same event.id).
   */
  enqueue(event: ChronicleEvent, targetRelays: string[] = []): void {
    if (this.queue.has(event.id)) return
    this.queue.set(event.id, {
      event,
      queuedAt: Math.floor(Date.now() / 1000),
      attempts: 0,
      targetRelays,
    })
  }

  /** Remove an event from the queue (called after confirmed publish). */
  remove(eventId: string): void {
    this.queue.delete(eventId)
  }

  /** Returns a snapshot of all queued events, oldest first. */
  getAll(): QueuedEvent[] {
    return [...this.queue.values()].sort((a, b) => a.queuedAt - b.queuedAt)
  }

  get size(): number {
    return this.queue.size
  }

  clear(): void {
    this.queue.clear()
  }

  // ── Drain ──────────────────────────────────────────────────────────────────

  /**
   * Attempt to publish all queued events to the given relay or pool.
   * Increments attempt counter per event. Does not retry automatically —
   * the caller should call drain() again when the relay reconnects.
   */
  drain(relay: RelayClient | RelayPool): number {
    if (this.draining) return 0
    this.draining = true
    let published = 0
    try {
      for (const item of this.getAll()) {
        item.attempts++
        relay.publish(item.event)
        published++
      }
    } finally {
      this.draining = false
    }
    return published
  }

  /**
   * Wire this queue to drain automatically when a RelayClient connects.
   * Returns a cleanup function.
   */
  attachToRelay(relay: RelayClient): () => void {
    return relay.onStatusChange((status) => {
      if (status === 'connected' && this.size > 0) {
        this.drain(relay)
      }
    })
  }

  // ── Serialisation (sessionStorage persistence) ────────────────────────────

  serialise(): string {
    return JSON.stringify([...this.queue.entries()])
  }

  static deserialise(json: string): BroadcastQueue {
    const q = new BroadcastQueue()
    const entries = JSON.parse(json) as [string, QueuedEvent][]
    for (const [id, item] of entries) {
      q.queue.set(id, item)
    }
    return q
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const broadcastQueue = new BroadcastQueue()
