/**
 * Tests for RelayClient and RelayPool
 *
 * Uses a mock WebSocket class injected via globalThis so no real network
 * connections are made. Tests cover the full connection lifecycle,
 * publish, subscribe, pending queue, and reconnection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RelayClient, RelayPool } from './relay'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  url: string
  sentMessages: string[] = []

  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  static instances: MockWebSocket[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  // Test helper — simulate receiving a message from the relay
  simulateMessage(msg: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  // Test helper — simulate connection open
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  // Test helper — simulate connection error then close
  simulateError() {
    this.onerror?.()
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  static reset() {
    MockWebSocket.instances = []
  }
}

const mockEvent: ChronicleEvent = {
  id: 'abc123',
  pubkey: 'deadbeef'.repeat(8),
  created_at: 1000,
  kind: 30081,
  tags: [['v', '1']],
  content: '',
  sig: 'sig'.repeat(32),
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.reset()
  // @ts-expect-error -- injecting mock into global
  globalThis.WebSocket = MockWebSocket
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function latestSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

// ─── RelayClient ──────────────────────────────────────────────────────────────

describe('RelayClient — connect lifecycle', () => {
  it('starts disconnected', () => {
    const client = new RelayClient('ws://localhost:7777')
    expect(client.getStatus()).toBe('disconnected')
  })

  it('moves to connecting then connected', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    expect(client.getStatus()).toBe('connecting')
    latestSocket().simulateOpen()
    expect(client.getStatus()).toBe('connected')
    client.destroy()
  })

  it('connect() is idempotent when already connected', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    latestSocket().simulateOpen()
    client.connect()
    expect(MockWebSocket.instances).toHaveLength(1)
    client.destroy()
  })

  it('fires status callbacks on change', () => {
    const client = new RelayClient('ws://localhost:7777')
    const statuses: string[] = []
    client.onStatusChange(s => statuses.push(s))
    client.connect()
    latestSocket().simulateOpen()
    client.destroy()
    expect(statuses).toContain('connecting')
    expect(statuses).toContain('connected')
  })

  it('unsubscribes status listener when returned fn is called', () => {
    const client = new RelayClient('ws://localhost:7777')
    const statuses: string[] = []
    const unsub = client.onStatusChange(s => statuses.push(s))
    unsub()
    client.connect()
    expect(statuses).toHaveLength(0)
    client.destroy()
  })
})

describe('RelayClient — publish', () => {
  it('sends EVENT message when connected', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    const sock = latestSocket()
    sock.simulateOpen()
    client.publish(mockEvent)
    const parsed = JSON.parse(sock.sentMessages.at(-1)!)
    expect(parsed[0]).toBe('EVENT')
    expect(parsed[1].id).toBe('abc123')
    client.destroy()
  })

  it('queues events when disconnected and flushes on connect', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.publish(mockEvent)
    // At this point a connect was initiated; socket not yet open
    const sock = latestSocket()
    sock.simulateOpen()
    // Should have flushed pending
    const eventMessages = sock.sentMessages.filter(m => {
      try { return JSON.parse(m)[0] === 'EVENT' } catch { return false }
    })
    expect(eventMessages).toHaveLength(1)
    client.destroy()
  })
})

describe('RelayClient — subscribe', () => {
  it('sends REQ when connected', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    latestSocket().simulateOpen()
    const unsub = client.subscribe([{ kinds: [30081] }], () => {})
    const req = latestSocket().sentMessages.find(m => {
      try { return JSON.parse(m)[0] === 'REQ' } catch { return false }
    })
    expect(req).toBeTruthy()
    unsub()
    client.destroy()
  })

  it('resubscribes all subs after reconnect', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    const sock = latestSocket()
    sock.simulateOpen()
    client.subscribe([{ kinds: [30081] }], () => {})

    // Simulate disconnect then reconnect
    sock.simulateError()
    vi.advanceTimersByTime(1500)
    const newSock = latestSocket()
    newSock.simulateOpen()

    const reqs = newSock.sentMessages.filter(m => {
      try { return JSON.parse(m)[0] === 'REQ' } catch { return false }
    })
    expect(reqs.length).toBeGreaterThan(0)
    client.destroy()
  })

  it('delivers EVENT messages to subscriber callback', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    const sock = latestSocket()
    sock.simulateOpen()

    const received: ChronicleEvent[] = []
    const unsub = client.subscribe([{ kinds: [30081] }], e => received.push(e))

    // Get the subscription id from the REQ message
    const reqMsg = sock.sentMessages.find(m => {
      try { return JSON.parse(m)[0] === 'REQ' } catch { return false }
    })!
    const subId = JSON.parse(reqMsg)[1] as string

    sock.simulateMessage(['EVENT', subId, mockEvent])
    expect(received).toHaveLength(1)
    expect(received[0].id).toBe('abc123')
    unsub()
    client.destroy()
  })

  it('sends CLOSE on unsubscribe', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    const sock = latestSocket()
    sock.simulateOpen()
    const unsub = client.subscribe([{ kinds: [30081] }], () => {})
    unsub()
    const closeMsg = sock.sentMessages.find(m => {
      try { return JSON.parse(m)[0] === 'CLOSE' } catch { return false }
    })
    expect(closeMsg).toBeTruthy()
    client.destroy()
  })
})

describe('RelayClient — reconnection', () => {
  it('schedules reconnect with backoff after disconnect', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    latestSocket().simulateError()
    expect(client.getStatus()).toBe('disconnected')
    // Should reconnect after delay
    vi.advanceTimersByTime(1500)
    expect(client.getStatus()).toBe('connecting')
    client.destroy()
  })

  it('does not reconnect after destroy()', () => {
    const client = new RelayClient('ws://localhost:7777')
    client.connect()
    client.destroy()
    vi.advanceTimersByTime(5000)
    // Should not have tried to reconnect
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})

// ─── RelayPool ────────────────────────────────────────────────────────────────

describe('RelayPool', () => {
  it('adds and connects to multiple relays', () => {
    const pool = new RelayPool()
    pool.add('ws://relay1:7777')
    pool.add('ws://relay2:7778')
    pool.connect()
    expect(MockWebSocket.instances).toHaveLength(2)
    pool.destroy()
  })

  it('add() is idempotent for the same URL', () => {
    const pool = new RelayPool()
    const c1 = pool.add('ws://relay1:7777')
    const c2 = pool.add('ws://relay1:7777')
    expect(c1).toBe(c2)
    pool.destroy()
  })

  it('publishes to all connected relays', () => {
    const pool = new RelayPool()
    pool.add('ws://relay1:7777')
    pool.add('ws://relay2:7778')
    pool.connect()
    MockWebSocket.instances.forEach(s => s.simulateOpen())
    pool.publish(mockEvent)
    const eventSends = MockWebSocket.instances.flatMap(s =>
      s.sentMessages.filter(m => {
        try { return JSON.parse(m)[0] === 'EVENT' } catch { return false }
      })
    )
    expect(eventSends).toHaveLength(2)
    pool.destroy()
  })

  it('getStatuses returns status per URL', () => {
    const pool = new RelayPool()
    pool.add('ws://relay1:7777')
    pool.add('ws://relay2:7778')
    pool.connect()
    const statuses = pool.getStatuses()
    expect(Object.keys(statuses)).toHaveLength(2)
    pool.destroy()
  })

  it('remove() destroys that relay client', () => {
    const pool = new RelayPool()
    pool.add('ws://relay1:7777')
    pool.connect()
    latestSocket().simulateOpen()
    pool.remove('ws://relay1:7777')
    expect(pool.getStatuses()).toEqual({})
  })
})
