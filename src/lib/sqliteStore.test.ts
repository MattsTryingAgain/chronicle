/**
 * Tests for sqliteStore.ts
 *
 * better-sqlite3 requires native compilation unavailable in CI.
 * vi.mock() intercepts the require('better-sqlite3') call inside SqliteStore's
 * constructor, substituting a pure-JS in-memory implementation that replicates
 * the synchronous better-sqlite3 API surface (prepare/run/get/all/exec/pragma).
 *
 * This exercises all of SqliteStore's data-mapping and SQL routing logic.
 * Integration tests against a real :memory: database run on the dev machine.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('better-sqlite3')

import { SqliteStore } from './sqliteStore'
import type { StoredIdentity } from './storage'
import { EventKind } from '../types/chronicle'
import type { Person, FactClaim, Endorsement, ChronicleEvent } from '../types/chronicle'

const NOW = Math.floor(Date.now() / 1000)

const IDENTITY: StoredIdentity = {
  npub: 'npub1user',
  displayName: 'Alice',
  encryptedNsec: { ciphertext: 'ct', nonce: 'nn', salt: 'ss' },
  createdAt: NOW,
}

const PERSON: Person = {
  pubkey: 'npub1person1',
  displayName: 'Bob Smith',
  isLiving: false,
  createdAt: NOW,
}

const CLAIM: FactClaim = {
  eventId: 'evt_claim_1',
  claimantPubkey: 'npub1user',
  subjectPubkey: 'npub1person1',
  field: 'born',
  value: '1930',
  evidence: 'family bible',
  createdAt: NOW,
  retracted: false,
  confidenceScore: 0.8,
}

const ENDORSEMENT: Endorsement = {
  eventId: 'evt_end_1',
  claimEventId: 'evt_claim_1',
  endorserPubkey: 'npub1other',
  proximity: 'grandchild',
  agree: true,
  createdAt: NOW,
}

const RAW_EVENT: ChronicleEvent = {
  id: 'rawevt1',
  pubkey: 'aabbcc',
  created_at: NOW,
  kind: EventKind.FACT_CLAIM,
  tags: [['subject', 'npub1person1'], ['v', '1']],
  content: '',
  sig: 'sig1',
}

// ─── Identity ─────────────────────────────────────────────────────────────────

describe('SqliteStore — identity', () => {
  let store: SqliteStore
  beforeEach(() => { store = new SqliteStore(':memory:') })

  it('starts with no identity', () => {
    expect(store.hasIdentity()).toBe(false)
    expect(store.getIdentity()).toBeNull()
  })

  it('sets and gets identity', () => {
    store.setIdentity(IDENTITY)
    expect(store.hasIdentity()).toBe(true)
    const id = store.getIdentity()!
    expect(id.npub).toBe('npub1user')
    expect(id.displayName).toBe('Alice')
    expect(id.encryptedNsec).toEqual(IDENTITY.encryptedNsec)
    expect(id.createdAt).toBe(NOW)
  })

  it('overwrites identity on second set', () => {
    store.setIdentity(IDENTITY)
    store.setIdentity({ ...IDENTITY, displayName: 'Alice2' })
    expect(store.getIdentity()!.displayName).toBe('Alice2')
  })

  it('clears identity', () => {
    store.setIdentity(IDENTITY)
    store.clearIdentity()
    expect(store.hasIdentity()).toBe(false)
  })
})

// ─── Ancestor Keys ────────────────────────────────────────────────────────────

describe('SqliteStore — ancestor keys', () => {
  let store: SqliteStore
  beforeEach(() => { store = new SqliteStore(':memory:') })

  it('stores and retrieves an ancestor key', () => {
    store.setAncestorKey('npub1anc', {
      npub: 'npub1anc',
      encryptedPrivkey: { ciphertext: 'c', nonce: 'n', salt: 's' },
    })
    const key = store.getAncestorKey('npub1anc')
    expect(key).toBeDefined()
    expect(key!.encryptedPrivkey.ciphertext).toBe('c')
  })

  it('returns undefined for unknown key', () => {
    expect(store.getAncestorKey('npub1unknown')).toBeUndefined()
  })

  it('updates an existing ancestor key', () => {
    store.setAncestorKey('npub1anc', { npub: 'npub1anc', encryptedPrivkey: { ciphertext: 'old', nonce: 'n', salt: 's' } })
    store.setAncestorKey('npub1anc', { npub: 'npub1anc', encryptedPrivkey: { ciphertext: 'new', nonce: 'n', salt: 's' } })
    expect(store.getAncestorKey('npub1anc')!.encryptedPrivkey.ciphertext).toBe('new')
  })
})

// ─── Persons ──────────────────────────────────────────────────────────────────

describe('SqliteStore — persons', () => {
  let store: SqliteStore
  beforeEach(() => { store = new SqliteStore(':memory:') })

  it('upserts and retrieves a person', () => {
    store.upsertPerson(PERSON)
    const p = store.getPerson('npub1person1')
    expect(p!.displayName).toBe('Bob Smith')
    expect(p!.isLiving).toBe(false)
  })

  it('getAllPersons returns all', () => {
    store.upsertPerson(PERSON)
    store.upsertPerson({ ...PERSON, pubkey: 'npub1person2', displayName: 'Carol' })
    expect(store.getAllPersons()).toHaveLength(2)
  })

  it('searchPersons returns matching persons', () => {
    store.upsertPerson(PERSON)
    store.upsertPerson({ ...PERSON, pubkey: 'npub1person2', displayName: 'Carol Jones' })
    expect(store.searchPersons('Bob')).toHaveLength(1)
    expect(store.searchPersons('Jones')).toHaveLength(1)
  })

  it('searchPersons returns all on empty query', () => {
    store.upsertPerson(PERSON)
    store.upsertPerson({ ...PERSON, pubkey: 'npub1person2', displayName: 'Carol' })
    expect(store.searchPersons('')).toHaveLength(2)
  })

  it('upsert updates displayName', () => {
    store.upsertPerson(PERSON)
    store.upsertPerson({ ...PERSON, displayName: 'Robert Smith' })
    expect(store.getPerson('npub1person1')!.displayName).toBe('Robert Smith')
  })

  it('getPerson returns undefined for unknown', () => {
    expect(store.getPerson('npub1nobody')).toBeUndefined()
  })

  it('preserves isLiving flag', () => {
    store.upsertPerson({ ...PERSON, isLiving: true })
    expect(store.getPerson('npub1person1')!.isLiving).toBe(true)
  })
})

// ─── Claims ───────────────────────────────────────────────────────────────────

describe('SqliteStore — claims', () => {
  let store: SqliteStore
  beforeEach(() => { store = new SqliteStore(':memory:') })

  it('adds and retrieves claims for person', () => {
    store.addClaim(CLAIM)
    const claims = store.getClaimsForPerson('npub1person1')
    expect(claims).toHaveLength(1)
    expect(claims[0].field).toBe('born')
    expect(claims[0].value).toBe('1930')
    expect(claims[0].evidence).toBe('family bible')
    expect(claims[0].retracted).toBe(false)
    expect(claims[0].confidenceScore).toBe(0.8)
  })

  it('ignores duplicate event IDs', () => {
    store.addClaim(CLAIM)
    store.addClaim(CLAIM)
    expect(store.getClaimsForPerson('npub1person1')).toHaveLength(1)
  })

  it('retracts a claim', () => {
    store.addClaim(CLAIM)
    store.retractClaim('evt_claim_1')
    expect(store.getClaimsForPerson('npub1person1')[0].retracted).toBe(true)
  })

  it('returns empty array for unknown person', () => {
    expect(store.getClaimsForPerson('npub1nobody')).toEqual([])
  })

  it('stores claim without evidence', () => {
    store.addClaim({ ...CLAIM, eventId: 'evt_no_ev', evidence: undefined })
    const claim = store.getClaimsForPerson('npub1person1').find(c => c.eventId === 'evt_no_ev')
    expect(claim?.evidence).toBeUndefined()
  })
})

// ─── Endorsements ─────────────────────────────────────────────────────────────

describe('SqliteStore — endorsements', () => {
  let store: SqliteStore
  beforeEach(() => { store = new SqliteStore(':memory:') })

  it('adds and retrieves endorsements for claim', () => {
    store.addEndorsement(ENDORSEMENT)
    const ends = store.getEndorsementsForClaim('evt_claim_1')
    expect(ends).toHaveLength(1)
    expect(ends[0].agree).toBe(true)
    expect(ends[0].proximity).toBe('grandchild')
  })

  it('getAllEndorsements returns all', () => {
    store.addEndorsement(ENDORSEMENT)
    store.addEndorsement({ ...ENDORSEMENT, eventId: 'evt_end_2', claimEventId: 'evt_claim_2' })
    expect(store.getAllEndorsements()).toHaveLength(2)
  })

  it('ignores duplicate event IDs', () => {
    store.addEndorsement(ENDORSEMENT)
    store.addEndorsement(ENDORSEMENT)
    expect(store.getAllEndorsements()).toHaveLength(1)
  })

  it('returns empty array for unknown claim', () => {
    expect(store.getEndorsementsForClaim('unknown')).toEqual([])
  })

  it('handles disagree endorsement', () => {
    store.addEndorsement({ ...ENDORSEMENT, agree: false })
    expect(store.getEndorsementsForClaim('evt_claim_1')[0].agree).toBe(false)
  })
})

// ─── Recovery Contacts ────────────────────────────────────────────────────────

describe('SqliteStore — recovery contacts', () => {
  let store: SqliteStore
  beforeEach(() => { store = new SqliteStore(':memory:') })

  it('adds and retrieves contacts', () => {
    store.addRecoveryContact({ pubkey: 'npub1rc1', displayName: 'Uncle Bob', addedAt: NOW })
    const contacts = store.getRecoveryContacts()
    expect(contacts).toHaveLength(1)
    expect(contacts[0].displayName).toBe('Uncle Bob')
    expect(contacts[0].addedAt).toBe(NOW)
  })

  it('removes a contact', () => {
    store.addRecoveryContact({ pubkey: 'npub1rc1', displayName: 'Uncle Bob', addedAt: NOW })
    store.removeRecoveryContact('npub1rc1')
    expect(store.getRecoveryContacts()).toHaveLength(0)
  })

  it('returns empty array with no contacts', () => {
    expect(store.getRecoveryContacts()).toEqual([])
  })
})

// ─── Raw Events ───────────────────────────────────────────────────────────────

describe('SqliteStore — raw events', () => {
  let store: SqliteStore
  beforeEach(() => { store = new SqliteStore(':memory:') })

  it('adds and retrieves a raw event', () => {
    store.addRawEvent(RAW_EVENT)
    const evt = store.getRawEvent('rawevt1')
    expect(evt).toBeDefined()
    expect(evt!.kind).toBe(EventKind.FACT_CLAIM)
    expect(evt!.tags).toEqual(RAW_EVENT.tags)
    expect(evt!.content).toBe('')
  })

  it('getAllRawEvents returns all events', () => {
    store.addRawEvent(RAW_EVENT)
    store.addRawEvent({ ...RAW_EVENT, id: 'rawevt2' })
    expect(store.getAllRawEvents()).toHaveLength(2)
  })

  it('ignores duplicate event IDs', () => {
    store.addRawEvent(RAW_EVENT)
    store.addRawEvent(RAW_EVENT)
    expect(store.getAllRawEvents()).toHaveLength(1)
  })

  it('returns undefined for unknown id', () => {
    expect(store.getRawEvent('notexist')).toBeUndefined()
  })
})

// ─── Serialise ────────────────────────────────────────────────────────────────

describe('SqliteStore — serialise', () => {
  it('serialise returns stub string', () => {
    const store = new SqliteStore(':memory:')
    expect(store.serialise()).toContain('SqliteStore')
  })
})
