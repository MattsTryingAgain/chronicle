/**
 * relaySync.test.ts
 *
 * Tests for the fetch-on-connect sync module.
 * Uses a mock RelayClient to avoid real WebSocket connections.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ingestEvent, startSync, fetchOnConnect, type SyncResult } from './relaySync'
import { store, MemoryStore } from './storage'
import { EventKind } from '../types/chronicle'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ChronicleEvent> = {}): ChronicleEvent {
  return {
    id: Math.random().toString(16).slice(2).padEnd(64, '0'),
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    kind: EventKind.IDENTITY_ANCHOR,
    tags: [['v', '1']],
    content: '',
    sig: 'b'.repeat(128),
    ...overrides,
  }
}

function makeFactClaimEvent(subject: string, field: string, value: string, claimant = 'c'.repeat(64)): ChronicleEvent {
  return makeEvent({
    id: Math.random().toString(16).slice(2).padEnd(64, '0'),
    pubkey: claimant,
    kind: EventKind.FACT_CLAIM,
    tags: [
      ['subject', subject],
      ['field', field],
      ['value', value],
      ['v', '1'],
    ],
  })
}

function makeEndorsementEvent(claimEventId: string, endorser = 'd'.repeat(64)): ChronicleEvent {
  return makeEvent({
    id: Math.random().toString(16).slice(2).padEnd(64, '0'),
    pubkey: endorser,
    kind: EventKind.ENDORSEMENT,
    tags: [
      ['claim_event', claimEventId],
      ['agree', 'true'],
      ['proximity', 'grandchild'],
      ['v', '1'],
    ],
  })
}

function makeRetractionEvent(originalId: string, claimant = 'c'.repeat(64)): ChronicleEvent {
  return makeEvent({
    id: Math.random().toString(16).slice(2).padEnd(64, '0'),
    pubkey: claimant,
    kind: EventKind.CLAIM_RETRACTION,
    tags: [
      ['retracts', originalId],
      ['v', '1'],
    ],
  })
}

/** Minimal mock RelayClient for testing */
function makeMockClient() {
  type SubCallback = (event: ChronicleEvent) => void
  const subs: SubCallback[] = []
  const subscribeFilters: unknown[] = []

  return {
    subscribe: vi.fn((filters: unknown, callback: SubCallback) => {
      subscribeFilters.push(filters)
      subs.push(callback)
      return () => {}
    }),
    // Emit an event to all subscribers
    emit(event: ChronicleEvent) {
      for (const cb of subs) cb(event)
    },
    subscribeFilters,
  }
}

// ─── Reset store before each test ─────────────────────────────────────────────

beforeEach(() => {
  // Reset singleton store state
  ;(store as unknown as { persons: Map<unknown, unknown> }).persons = new Map()
  ;(store as unknown as { claims: Map<unknown, unknown> }).claims = new Map()
  ;(store as unknown as { endorsements: Map<unknown, unknown> }).endorsements = new Map()
  ;(store as unknown as { rawEvents: Map<unknown, unknown> }).rawEvents = new Map()
  ;(store as unknown as { identity: unknown }).identity = null
  ;(store as unknown as { recoveryContacts: Map<unknown, unknown> }).recoveryContacts = new Map()
})

// ─── ingestEvent ──────────────────────────────────────────────────────────────

describe('ingestEvent', () => {
  it('stores raw event on first ingest', () => {
    const event = makeEvent()
    const result = ingestEvent(event)
    expect(result).toBe(true)
    expect(store.getRawEvent(event.id)).toMatchObject({ id: event.id })
  })

  it('returns false and skips duplicate', () => {
    const event = makeEvent()
    ingestEvent(event)
    const result = ingestEvent(event)
    expect(result).toBe(false)
    // Still stored once
    expect(store.getRawEvent(event.id)).toBeDefined()
  })

  it('creates person stub from IDENTITY_ANCHOR', () => {
    const pubkey = 'f'.repeat(64)
    const event = makeEvent({
      pubkey,
      kind: EventKind.IDENTITY_ANCHOR,
      tags: [['claimed_by', 'a'.repeat(64)], ['v', '1']],
    })
    ingestEvent(event)
    const person = store.getPerson(pubkey)
    expect(person).toBeDefined()
    expect(person!.pubkey).toBe(pubkey)
    // claimedBy is stored on the raw event; Person type doesn't carry it
  })

  it('does not overwrite existing person from IDENTITY_ANCHOR', () => {
    const pubkey = 'e'.repeat(64)
    store.upsertPerson({ pubkey, displayName: 'Existing Name', isLiving: false, createdAt: 0 })
    const event = makeEvent({ pubkey, kind: EventKind.IDENTITY_ANCHOR })
    ingestEvent(event)
    expect(store.getPerson(pubkey)!.displayName).toBe('Existing Name')
  })

  it('ingests FACT_CLAIM and stores it', () => {
    const subject = '1'.repeat(64)
    const event = makeFactClaimEvent(subject, 'born', '1930')
    ingestEvent(event)
    const claims = store.getClaimsForPerson(subject)
    expect(claims).toHaveLength(1)
    expect(claims[0].field).toBe('born')
    expect(claims[0].value).toBe('1930')
  })

  it('FACT_CLAIM with field=name updates person displayName', () => {
    const subject = '2'.repeat(64)
    store.upsertPerson({ pubkey: subject, displayName: 'Unknown', isLiving: false, createdAt: 0 })
    const event = makeFactClaimEvent(subject, 'name', 'John Smith')
    ingestEvent(event)
    expect(store.getPerson(subject)!.displayName).toBe('John Smith')
  })

  it('skips FACT_CLAIM missing required tags', () => {
    const event = makeEvent({
      kind: EventKind.FACT_CLAIM,
      tags: [['subject', 'a'.repeat(64)], ['v', '1']], // missing field and value
    })
    ingestEvent(event)
    expect(store.getClaimsForPerson('a'.repeat(64))).toHaveLength(0)
  })

  it('ingests ENDORSEMENT and stores it', () => {
    const claimId = '9'.repeat(64)
    const event = makeEndorsementEvent(claimId)
    ingestEvent(event)
    const endorsements = store.getEndorsementsForClaim(claimId)
    expect(endorsements).toHaveLength(1)
    expect(endorsements[0].agree).toBe(true)
    expect(endorsements[0].proximity).toBe('grandchild')
  })

  it('skips ENDORSEMENT missing required tags', () => {
    const event = makeEvent({
      kind: EventKind.ENDORSEMENT,
      tags: [['v', '1']], // missing claim_event, agree, proximity
    })
    ingestEvent(event)
    // No crash, nothing stored
  })

  it('ingests CLAIM_RETRACTION and marks claim retracted', () => {
    const subject = '3'.repeat(64)
    const claimEvent = makeFactClaimEvent(subject, 'born', '1931')
    ingestEvent(claimEvent)
    expect(store.getClaimsForPerson(subject)[0].retracted).toBe(false)

    const retraction = makeRetractionEvent(claimEvent.id)
    ingestEvent(retraction)
    expect(store.getClaimsForPerson(subject)[0].retracted).toBe(true)
  })

  it('stores unknown kinds as raw events without crashing', () => {
    const event = makeEvent({ kind: 30085 as typeof EventKind.IDENTITY_ANCHOR }) // discovery event
    const result = ingestEvent(event)
    expect(result).toBe(true)
    expect(store.getRawEvent(event.id)).toBeDefined()
  })
})

// ─── startSync ────────────────────────────────────────────────────────────────

describe('startSync', () => {
  it('returns a cleanup function without subscribing when no pubkeys known', () => {
    const client = makeMockClient()
    const unsub = startSync(client as never)
    expect(typeof unsub).toBe('function')
    expect(client.subscribe).not.toHaveBeenCalled()
  })

  it('subscribes to all Chronicle kinds for known pubkeys', () => {
    const pubkey = '4'.repeat(64)
    store.upsertPerson({ pubkey, displayName: 'Alice', isLiving: false, createdAt: 0 })

    const client = makeMockClient()
    startSync(client as never)

    expect(client.subscribe).toHaveBeenCalledOnce()
    const [filters] = client.subscribe.mock.calls[0]
    expect(filters[0].kinds).toContain(EventKind.IDENTITY_ANCHOR)
    expect(filters[0].kinds).toContain(EventKind.FACT_CLAIM)
    expect(filters[0].authors).toContain(pubkey)
  })

  it('ingests events received via subscription', () => {
    const subject = '5'.repeat(64)
    store.upsertPerson({ pubkey: subject, displayName: 'Bob', isLiving: false, createdAt: 0 })

    const client = makeMockClient()
    startSync(client as never)

    const event = makeFactClaimEvent(subject, 'born', '1945')
    client.emit(event)

    expect(store.getClaimsForPerson(subject)).toHaveLength(1)
  })

  it('returned unsub cancels subscription', () => {
    const pubkey = '6'.repeat(64)
    store.upsertPerson({ pubkey, displayName: 'Carol', isLiving: false, createdAt: 0 })

    const unsubSpy = vi.fn()
    const client = makeMockClient()
    client.subscribe.mockReturnValue(unsubSpy)

    const unsub = startSync(client as never)
    unsub()
    expect(unsubSpy).toHaveBeenCalledOnce()
  })
})

// ─── fetchOnConnect ───────────────────────────────────────────────────────────

describe('fetchOnConnect', () => {
  it('resolves immediately with zero counts when no pubkeys known', async () => {
    const client = makeMockClient()
    const result = await fetchOnConnect(client as never)
    expect(result).toEqual<SyncResult>({ received: 0, ingested: 0, errors: 0 })
    expect(client.subscribe).not.toHaveBeenCalled()
  })

  it('counts received and ingested events', async () => {
    vi.useFakeTimers()
    const subject = '7'.repeat(64)
    store.upsertPerson({ pubkey: subject, displayName: 'Dave', isLiving: false, createdAt: 0 })

    const client = makeMockClient()
    const promise = fetchOnConnect(client as never)

    // Emit two events before timeout
    const e1 = makeFactClaimEvent(subject, 'born', '1920')
    const e2 = makeFactClaimEvent(subject, 'died', '1990')
    client.emit(e1)
    client.emit(e2)

    // Advance past the 10s timeout
    vi.advanceTimersByTime(11_000)
    const result = await promise

    expect(result.received).toBe(2)
    expect(result.ingested).toBe(2)
    expect(result.errors).toBe(0)

    vi.useRealTimers()
  })

  it('counts duplicate as received but not ingested', async () => {
    vi.useFakeTimers()
    const subject = '8'.repeat(64)
    store.upsertPerson({ pubkey: subject, displayName: 'Eve', isLiving: false, createdAt: 0 })

    const event = makeFactClaimEvent(subject, 'born', '1925')
    // Pre-store the event as if already known
    store.addRawEvent(event)

    const client = makeMockClient()
    const promise = fetchOnConnect(client as never)

    client.emit(event) // duplicate

    vi.advanceTimersByTime(11_000)
    const result = await promise

    expect(result.received).toBe(1)
    expect(result.ingested).toBe(0) // already present
    vi.useRealTimers()
  })
})
