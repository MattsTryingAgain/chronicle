import { describe, it, expect } from 'vitest'
import {
  categoriseEvent,
  summariseEvent,
  MergeQueue,
  type MergeItemCategory,
} from './syncMerge.js'
import type { ChronicleEvent } from '../types/chronicle.js'

function makeEvent(kind: number, tags: string[][] = [], id = 'ev-' + Math.random().toString(36).slice(2)): ChronicleEvent {
  return {
    id,
    kind,
    pubkey: 'a'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
    sig: 'sig',
  } as ChronicleEvent
}

const PEER = 'npub1' + 'a'.repeat(58)

describe('categoriseEvent', () => {
  const cases: [number, MergeItemCategory][] = [
    [30081, 'fact_claim'],
    [30082, 'endorsement'],
    [30079, 'relationship'],
    [30083, 'same_person'],
    [30089, 'retraction'],
    [30078, 'other'],
    [99999, 'other'],
  ]
  for (const [kind, expected] of cases) {
    it(`kind ${kind} → ${expected}`, () => {
      expect(categoriseEvent(makeEvent(kind))).toBe(expected)
    })
  }
})

describe('summariseEvent', () => {
  it('fact_claim with field+value', () => {
    const ev = makeEvent(30081, [['field', 'born'], ['value', '1930']])
    expect(summariseEvent(ev)).toContain('born')
    expect(summariseEvent(ev)).toContain('1930')
  })

  it('fact_claim without detail', () => {
    expect(summariseEvent(makeEvent(30081))).toBe('New fact claim')
  })

  it('endorsement', () => {
    expect(summariseEvent(makeEvent(30082))).toBe('Endorsement of a claim')
  })

  it('relationship', () => {
    expect(summariseEvent(makeEvent(30079))).toBe('Relationship claim')
  })

  it('unknown kind', () => {
    expect(summariseEvent(makeEvent(99999))).toContain('99999')
  })
})

describe('MergeQueue', () => {
  it('starts empty', () => {
    const q = new MergeQueue()
    expect(q.getAllSessions()).toHaveLength(0)
    expect(q.totalPending()).toBe(0)
  })

  it('creates a session on startSession', () => {
    const q = new MergeQueue()
    const s = q.startSession(PEER)
    expect(s.peerNpub).toBe(PEER)
    expect(s.items).toHaveLength(0)
    expect(s.dismissed).toBe(false)
  })

  it('addEvent adds items to the session', () => {
    const q = new MergeQueue()
    q.addEvent(PEER, makeEvent(30081))
    expect(q.getPendingItems(PEER)).toHaveLength(1)
    expect(q.totalPending()).toBe(1)
  })

  it('addEvent deduplicates by event id', () => {
    const q = new MergeQueue()
    const ev = makeEvent(30081, [], 'same-id')
    q.addEvent(PEER, ev)
    q.addEvent(PEER, ev)
    expect(q.getPendingItems(PEER)).toHaveLength(1)
  })

  it('acceptItem sets status to accepted', () => {
    const q = new MergeQueue()
    const ev = makeEvent(30081, [], 'ev-1')
    q.addEvent(PEER, ev)
    q.acceptItem(PEER, 'ev-1')
    expect(q.getPendingItems(PEER)).toHaveLength(0)
    expect(q.getSession(PEER)!.items[0].status).toBe('accepted')
  })

  it('skipItem sets status to skipped', () => {
    const q = new MergeQueue()
    const ev = makeEvent(30081, [], 'ev-1')
    q.addEvent(PEER, ev)
    q.skipItem(PEER, 'ev-1')
    expect(q.getSession(PEER)!.items[0].status).toBe('skipped')
  })

  it('acceptAll accepts all pending', () => {
    const q = new MergeQueue()
    q.addEvent(PEER, makeEvent(30081))
    q.addEvent(PEER, makeEvent(30082))
    q.acceptAll(PEER)
    expect(q.totalPending()).toBe(0)
  })

  it('skipAll skips all pending', () => {
    const q = new MergeQueue()
    q.addEvent(PEER, makeEvent(30081))
    q.addEvent(PEER, makeEvent(30082))
    q.skipAll(PEER)
    expect(q.totalPending()).toBe(0)
  })

  it('getActiveSessions excludes dismissed sessions', () => {
    const q = new MergeQueue()
    q.addEvent(PEER, makeEvent(30081))
    expect(q.getActiveSessions()).toHaveLength(1)
    q.dismiss(PEER)
    expect(q.getActiveSessions()).toHaveLength(0)
  })

  it('getActiveSessions excludes sessions with no pending items', () => {
    const q = new MergeQueue()
    const ev = makeEvent(30081, [], 'ev-1')
    q.addEvent(PEER, ev)
    q.acceptAll(PEER)
    expect(q.getActiveSessions()).toHaveLength(0)
  })

  it('clearSession removes the session', () => {
    const q = new MergeQueue()
    q.addEvent(PEER, makeEvent(30081))
    q.clearSession(PEER)
    expect(q.getSession(PEER)).toBeUndefined()
  })

  it('multiple peers tracked independently', () => {
    const q = new MergeQueue()
    const peer2 = 'npub1' + 'b'.repeat(58)
    q.addEvent(PEER, makeEvent(30081))
    q.addEvent(peer2, makeEvent(30082))
    q.addEvent(peer2, makeEvent(30083))
    expect(q.getPendingItems(PEER)).toHaveLength(1)
    expect(q.getPendingItems(peer2)).toHaveLength(2)
    expect(q.totalPending()).toBe(3)
  })
})
