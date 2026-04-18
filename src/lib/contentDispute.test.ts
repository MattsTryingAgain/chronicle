/**
 * Content Dispute module tests — Stage 6
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { DisputeStore, raiseDispute } from './contentDispute'
import { generateUserKeyMaterial } from './keys'
import { buildFactClaim } from './eventBuilder'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDisputeEvent(
  disputerNpub: string,
  disputerNsec: string,
  targetId: string,
  reason: string,
): ChronicleEvent {
  const { generateUserKeyMaterial: _ } = require('./keys')
  return raiseDispute({
    disputerNpub,
    disputerNsec,
    targetEventId: targetId,
    reason,
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DisputeStore', () => {
  let store: DisputeStore
  let alice: ReturnType<typeof generateUserKeyMaterial>
  let bob: ReturnType<typeof generateUserKeyMaterial>

  beforeEach(() => {
    store = new DisputeStore()
    alice = generateUserKeyMaterial()
    bob = generateUserKeyMaterial()
  })

  it('ingests a valid kind 30087 event', () => {
    const event = raiseDispute({
      disputerNpub: alice.npub,
      disputerNsec: alice.nsec,
      targetEventId: 'target001',
      reason: 'incorrect information',
      store,
    })
    expect(store.size).toBe(1)
    const dispute = store.getDispute(event.id)
    expect(dispute).toBeDefined()
    expect(dispute!.disputedEventId).toBe('target001')
    expect(dispute!.reason).toBe('incorrect information')
    expect(dispute!.disputerNpub).toBe(alice.npub)
  })

  it('ignores events of wrong kind', () => {
    const fakeEvent: ChronicleEvent = {
      id: 'abc',
      pubkey: alice.npub,
      created_at: Date.now() / 1000,
      kind: 30081 as any,
      tags: [['disputed_event', 'target001'], ['reason', 'test']],
      content: '',
      sig: '',
    }
    const result = store.ingestDisputeEvent(fakeEvent)
    expect(result).toBeNull()
    expect(store.size).toBe(0)
  })

  it('ignores events with missing disputed_event tag', () => {
    const fakeEvent: ChronicleEvent = {
      id: 'abc',
      pubkey: alice.npub,
      created_at: Date.now() / 1000,
      kind: 30087 as any,
      tags: [['reason', 'test']],
      content: '',
      sig: '',
    }
    const result = store.ingestDisputeEvent(fakeEvent)
    expect(result).toBeNull()
  })

  it('tracks multiple disputes against the same target', () => {
    raiseDispute({ disputerNpub: alice.npub, disputerNsec: alice.nsec, targetEventId: 'target001', reason: 'reason A', store })
    raiseDispute({ disputerNpub: bob.npub, disputerNsec: bob.nsec, targetEventId: 'target001', reason: 'reason B', store })
    expect(store.disputeCount('target001')).toBe(2)
    const disputes = store.getDisputesForEvent('target001')
    expect(disputes).toHaveLength(2)
    expect(disputes.map(d => d.reason)).toContain('reason A')
    expect(disputes.map(d => d.reason)).toContain('reason B')
  })

  it('isDisputed returns false for undisputed event', () => {
    expect(store.isDisputed('no-dispute-here')).toBe(false)
  })

  it('isDisputed returns true after a dispute is raised', () => {
    raiseDispute({ disputerNpub: alice.npub, disputerNsec: alice.nsec, targetEventId: 'claimed001', reason: 'wrong', store })
    expect(store.isDisputed('claimed001')).toBe(true)
  })

  it('getDisputesForEvent returns empty array for unknown target', () => {
    expect(store.getDisputesForEvent('unknown')).toEqual([])
  })

  it('getAllDisputes returns all ingested disputes', () => {
    raiseDispute({ disputerNpub: alice.npub, disputerNsec: alice.nsec, targetEventId: 'a', reason: 'r1', store })
    raiseDispute({ disputerNpub: bob.npub, disputerNsec: bob.nsec, targetEventId: 'b', reason: 'r2', store })
    expect(store.getAllDisputes()).toHaveLength(2)
  })

  it('disputes are sorted by createdAt ascending', () => {
    // Ingest in reverse order of timestamp
    const e1: ChronicleEvent = {
      id: 'e1', pubkey: alice.npub, created_at: 2000, kind: 30087 as any,
      tags: [['disputed_event', 'target'], ['reason', 'later']],
      content: '', sig: '',
    }
    const e2: ChronicleEvent = {
      id: 'e2', pubkey: bob.npub, created_at: 1000, kind: 30087 as any,
      tags: [['disputed_event', 'target'], ['reason', 'earlier']],
      content: '', sig: '',
    }
    store.ingestDisputeEvent(e1)
    store.ingestDisputeEvent(e2)
    const disputes = store.getDisputesForEvent('target')
    expect(disputes[0].reason).toBe('earlier')
    expect(disputes[1].reason).toBe('later')
  })

  it('hideDisputed defaults to false', () => {
    expect(store.hideDisputed).toBe(false)
  })

  it('setHideDisputed toggles the preference', () => {
    store.setHideDisputed(true)
    expect(store.hideDisputed).toBe(true)
    store.setHideDisputed(false)
    expect(store.hideDisputed).toBe(false)
  })

  it('_reset clears all state', () => {
    raiseDispute({ disputerNpub: alice.npub, disputerNsec: alice.nsec, targetEventId: 'x', reason: 'r', store })
    store.setHideDisputed(true)
    store._reset()
    expect(store.size).toBe(0)
    expect(store.hideDisputed).toBe(false)
  })

  it('disputeCount returns 0 for untargeted event', () => {
    expect(store.disputeCount('untargeted')).toBe(0)
  })

  it('raiseDispute returns a valid ChronicleEvent of kind 30087', () => {
    const event = raiseDispute({
      disputerNpub: alice.npub,
      disputerNsec: alice.nsec,
      targetEventId: 'target999',
      reason: 'factually wrong',
      store,
    })
    expect(event.kind).toBe(30087)
    expect(event.id).toBeTruthy()
    expect(event.sig).toBeTruthy()
    const targetTag = event.tags.find(t => t[0] === 'disputed_event')
    expect(targetTag?.[1]).toBe('target999')
  })

  it('same event id ingested twice is deduplicated', () => {
    const event = raiseDispute({
      disputerNpub: alice.npub,
      disputerNsec: alice.nsec,
      targetEventId: 'target-dup',
      reason: 'test',
      store,
    })
    // Ingest same event again
    store.ingestDisputeEvent(event)
    expect(store.disputeCount('target-dup')).toBe(1)
    expect(store.size).toBe(1)
  })

  it('can handle disputes targeting different events independently', () => {
    raiseDispute({ disputerNpub: alice.npub, disputerNsec: alice.nsec, targetEventId: 'event-A', reason: 'wrong name', store })
    raiseDispute({ disputerNpub: alice.npub, disputerNsec: alice.nsec, targetEventId: 'event-B', reason: 'wrong date', store })
    expect(store.isDisputed('event-A')).toBe(true)
    expect(store.isDisputed('event-B')).toBe(true)
    expect(store.disputeCount('event-A')).toBe(1)
    expect(store.disputeCount('event-B')).toBe(1)
  })

  it('reason defaults to empty string if tag missing', () => {
    const event: ChronicleEvent = {
      id: 'e-no-reason', pubkey: alice.npub, created_at: 1000, kind: 30087 as any,
      tags: [['disputed_event', 'target-x']],
      content: '', sig: '',
    }
    const dispute = store.ingestDisputeEvent(event)
    expect(dispute).not.toBeNull()
    expect(dispute!.reason).toBe('')
  })

  it('getDispute returns undefined for unknown id', () => {
    expect(store.getDispute('does-not-exist')).toBeUndefined()
  })
})
