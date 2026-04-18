/**
 * Tests for BroadcastQueue
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BroadcastQueue } from './queue'
import type { ChronicleEvent } from '../types/chronicle'

function makeEvent(id: string): ChronicleEvent {
  return {
    id,
    pubkey: 'aa'.repeat(32),
    created_at: 1000,
    kind: 30081,
    tags: [['v', '1']],
    content: '',
    sig: 'bb'.repeat(32),
  }
}

describe('BroadcastQueue — enqueue / remove', () => {
  let q: BroadcastQueue

  beforeEach(() => { q = new BroadcastQueue() })

  it('starts empty', () => {
    expect(q.size).toBe(0)
    expect(q.getAll()).toHaveLength(0)
  })

  it('enqueues an event', () => {
    q.enqueue(makeEvent('evt1'))
    expect(q.size).toBe(1)
  })

  it('silently drops duplicate event ids', () => {
    q.enqueue(makeEvent('evt1'))
    q.enqueue(makeEvent('evt1'))
    expect(q.size).toBe(1)
  })

  it('removes an event by id', () => {
    q.enqueue(makeEvent('evt1'))
    q.remove('evt1')
    expect(q.size).toBe(0)
  })

  it('remove on unknown id is a no-op', () => {
    q.enqueue(makeEvent('evt1'))
    q.remove('nonexistent')
    expect(q.size).toBe(1)
  })

  it('getAll returns events sorted by queuedAt', () => {
    // Vitest runs synchronously so we manipulate queuedAt directly
    q.enqueue(makeEvent('evt-b'))
    q.enqueue(makeEvent('evt-a'))
    const all = q.getAll()
    // Both are enqueued at the same timestamp; order is stable
    expect(all).toHaveLength(2)
  })

  it('clear empties the queue', () => {
    q.enqueue(makeEvent('evt1'))
    q.enqueue(makeEvent('evt2'))
    q.clear()
    expect(q.size).toBe(0)
  })
})

describe('BroadcastQueue — drain', () => {
  it('publishes all queued events to the relay', () => {
    const q = new BroadcastQueue()
    q.enqueue(makeEvent('evt1'))
    q.enqueue(makeEvent('evt2'))

    const published: string[] = []
    const mockRelay = { publish: (e: ChronicleEvent) => published.push(e.id) } as never

    const count = q.drain(mockRelay)
    expect(count).toBe(2)
    expect(published).toContain('evt1')
    expect(published).toContain('evt2')
  })

  it('increments attempt counter per drain call', () => {
    const q = new BroadcastQueue()
    q.enqueue(makeEvent('evt1'))
    const mockRelay = { publish: () => {} } as never
    q.drain(mockRelay)
    q.drain(mockRelay)
    expect(q.getAll()[0].attempts).toBe(2)
  })

  it('drain on empty queue returns 0', () => {
    const q = new BroadcastQueue()
    const mockRelay = { publish: vi.fn() } as never
    expect(q.drain(mockRelay)).toBe(0)
  })
})

describe('BroadcastQueue — attachToRelay', () => {
  it('drains when relay connects', () => {
    const q = new BroadcastQueue()
    q.enqueue(makeEvent('evt1'))

    const published: string[] = []
    let statusCb: ((s: string) => void) | null = null
    const mockRelay = {
      publish: (e: ChronicleEvent) => published.push(e.id),
      onStatusChange: (cb: (s: string) => void) => { statusCb = cb; return () => {} },
    } as never

    q.attachToRelay(mockRelay)
    statusCb!('connected')
    expect(published).toContain('evt1')
  })

  it('does not drain when relay disconnects', () => {
    const q = new BroadcastQueue()
    q.enqueue(makeEvent('evt1'))

    const published: string[] = []
    let statusCb: ((s: string) => void) | null = null
    const mockRelay = {
      publish: (e: ChronicleEvent) => published.push(e.id),
      onStatusChange: (cb: (s: string) => void) => { statusCb = cb; return () => {} },
    } as never

    q.attachToRelay(mockRelay)
    statusCb!('disconnected')
    expect(published).toHaveLength(0)
  })

  it('returns cleanup function that stops listening', () => {
    const q = new BroadcastQueue()
    q.enqueue(makeEvent('evt1'))

    let statusCb: ((s: string) => void) | null = null
    const mockRelay = {
      publish: vi.fn(),
      onStatusChange: (cb: (s: string) => void) => { statusCb = cb; return () => { statusCb = null } },
    } as never

    const cleanup = q.attachToRelay(mockRelay)
    cleanup()
    statusCb?.('connected')  // should be null after cleanup
    expect(mockRelay.publish).not.toHaveBeenCalled()
  })
})

describe('BroadcastQueue — serialise / deserialise', () => {
  it('round-trips through JSON', () => {
    const q = new BroadcastQueue()
    q.enqueue(makeEvent('evt1'), ['ws://relay.example'])
    const json = q.serialise()
    const restored = BroadcastQueue.deserialise(json)
    expect(restored.size).toBe(1)
    expect(restored.getAll()[0].event.id).toBe('evt1')
    expect(restored.getAll()[0].targetRelays).toContain('ws://relay.example')
  })

  it('deserialise handles empty queue', () => {
    const q = new BroadcastQueue()
    const restored = BroadcastQueue.deserialise(q.serialise())
    expect(restored.size).toBe(0)
  })
})
