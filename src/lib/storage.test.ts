/**
 * Tests for Chronicle storage module
 *
 * Covers: encrypt/decrypt round-trip, wrong password, MemoryStore CRUD.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  encryptWithPassword,
  decryptWithPassword,
  MemoryStore,
  type StoredIdentity,
  type RecoveryContact,
} from './storage'
import type { Person, FactClaim } from '../types/chronicle'

// ─── Encrypt / Decrypt ───────────────────────────────────────────────────────

describe('encryptWithPassword / decryptWithPassword', () => {
  it('round-trips a plaintext string', async () => {
    const payload = await encryptWithPassword('nsec1secret', 'password123')
    const result = await decryptWithPassword(payload, 'password123')
    expect(result).toBe('nsec1secret')
  })

  it('returns null for wrong password', async () => {
    const payload = await encryptWithPassword('nsec1secret', 'correctPassword')
    const result = await decryptWithPassword(payload, 'wrongPassword')
    expect(result).toBeNull()
  })

  it('returns null for tampered ciphertext', async () => {
    const payload = await encryptWithPassword('nsec1secret', 'password')
    const tampered = { ...payload, ciphertext: payload.ciphertext.slice(0, -4) + 'XXXX' }
    const result = await decryptWithPassword(tampered, 'password')
    expect(result).toBeNull()
  })

  it('produces different ciphertext each call (random nonce + salt)', async () => {
    const p1 = await encryptWithPassword('same', 'pass')
    const p2 = await encryptWithPassword('same', 'pass')
    expect(p1.ciphertext).not.toBe(p2.ciphertext)
    expect(p1.nonce).not.toBe(p2.nonce)
    expect(p1.salt).not.toBe(p2.salt)
  })

  it('round-trips a multi-word mnemonic', async () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    const payload = await encryptWithPassword(mnemonic, 'mypassword')
    const result = await decryptWithPassword(payload, 'mypassword')
    expect(result).toBe(mnemonic)
  })
})

// ─── MemoryStore — Identity ──────────────────────────────────────────────────

describe('MemoryStore — identity', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
  })

  const mockIdentity: StoredIdentity = {
    npub: 'npub1test',
    displayName: 'Alice',
    encryptedNsec: { ciphertext: 'abc', nonce: 'nnn', salt: 'sss' },
    createdAt: 1_000_000,
  }

  it('starts with no identity', () => {
    expect(store.hasIdentity()).toBe(false)
    expect(store.getIdentity()).toBeNull()
  })

  it('stores and retrieves identity', () => {
    store.setIdentity(mockIdentity)
    expect(store.hasIdentity()).toBe(true)
    expect(store.getIdentity()).toEqual(mockIdentity)
  })

  it('clears identity', () => {
    store.setIdentity(mockIdentity)
    store.clearIdentity()
    expect(store.hasIdentity()).toBe(false)
  })
})

// ─── MemoryStore — Persons ───────────────────────────────────────────────────

describe('MemoryStore — persons', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
  })

  const alice: Person = {
    pubkey: 'npub1alice',
    displayName: 'Alice O\'Brien',
    isLiving: true,
    createdAt: 1_000,
  }

  const thomas: Person = {
    pubkey: 'npub1thomas',
    displayName: 'Thomas O\'Brien',
    isLiving: false,
    createdAt: 900,
  }

  it('upserts and retrieves a person', () => {
    store.upsertPerson(alice)
    expect(store.getPerson('npub1alice')).toEqual(alice)
  })

  it('returns undefined for unknown pubkey', () => {
    expect(store.getPerson('npub1nobody')).toBeUndefined()
  })

  it('getAllPersons returns all stored persons', () => {
    store.upsertPerson(alice)
    store.upsertPerson(thomas)
    expect(store.getAllPersons()).toHaveLength(2)
  })

  it('upsert overwrites existing person', () => {
    store.upsertPerson(alice)
    store.upsertPerson({ ...alice, displayName: 'Alice Updated' })
    expect(store.getPerson('npub1alice')?.displayName).toBe('Alice Updated')
  })

  it('searchPersons returns matching persons case-insensitively', () => {
    store.upsertPerson(alice)
    store.upsertPerson(thomas)
    expect(store.searchPersons("o'brien")).toHaveLength(2)
    expect(store.searchPersons('alice')).toHaveLength(1)
    expect(store.searchPersons('nomatch')).toHaveLength(0)
  })

  it('searchPersons with empty query returns all', () => {
    store.upsertPerson(alice)
    store.upsertPerson(thomas)
    expect(store.searchPersons('')).toHaveLength(2)
  })
})

// ─── MemoryStore — Claims ────────────────────────────────────────────────────

describe('MemoryStore — claims', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
  })

  const claim: FactClaim = {
    eventId: 'evt001',
    claimantPubkey: 'npub1alice',
    subjectPubkey: 'npub1thomas',
    field: 'born',
    value: '1930',
    createdAt: 1_000,
    retracted: false,
    confidenceScore: 0,
  }

  it('adds and retrieves claims by subject pubkey', () => {
    store.addClaim(claim)
    const claims = store.getClaimsForPerson('npub1thomas')
    expect(claims).toHaveLength(1)
    expect(claims[0].value).toBe('1930')
  })

  it('getClaimsForPerson returns empty array for unknown pubkey', () => {
    expect(store.getClaimsForPerson('npub1nobody')).toHaveLength(0)
  })

  it('retractClaim marks claim as retracted', () => {
    store.addClaim(claim)
    store.retractClaim('evt001')
    expect(store.getClaimsForPerson('npub1thomas')[0].retracted).toBe(true)
  })

  it('retractClaim on unknown id is a no-op', () => {
    store.retractClaim('nonexistent')
    expect(store.getClaimsForPerson('npub1thomas')).toHaveLength(0)
  })
})

// ─── MemoryStore — Recovery Contacts ─────────────────────────────────────────

describe('MemoryStore — recovery contacts', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
  })

  const contact: RecoveryContact = {
    pubkey: 'npub1contact',
    displayName: 'Bob',
    addedAt: 1_000,
  }

  it('starts with no contacts', () => {
    expect(store.getRecoveryContacts()).toHaveLength(0)
  })

  it('adds and retrieves a recovery contact', () => {
    store.addRecoveryContact(contact)
    expect(store.getRecoveryContacts()).toHaveLength(1)
    expect(store.getRecoveryContacts()[0].displayName).toBe('Bob')
  })

  it('removes a recovery contact by pubkey', () => {
    store.addRecoveryContact(contact)
    store.removeRecoveryContact('npub1contact')
    expect(store.getRecoveryContacts()).toHaveLength(0)
  })

  it('contacts are returned sorted by addedAt', () => {
    store.addRecoveryContact({ pubkey: 'npub1b', displayName: 'B', addedAt: 2_000 })
    store.addRecoveryContact({ pubkey: 'npub1a', displayName: 'A', addedAt: 1_000 })
    const contacts = store.getRecoveryContacts()
    expect(contacts[0].displayName).toBe('A')
    expect(contacts[1].displayName).toBe('B')
  })
})

// ─── MemoryStore — Serialise / Deserialise ────────────────────────────────────

describe('MemoryStore — serialise / deserialise', () => {
  it('round-trips store state through JSON', () => {
    const store = new MemoryStore()
    const person: Person = {
      pubkey: 'npub1x',
      displayName: 'Test Person',
      isLiving: false,
      createdAt: 500,
    }
    store.upsertPerson(person)
    store.addRecoveryContact({ pubkey: 'npub1r', displayName: 'Recovery', addedAt: 100 })

    const json = store.serialise()
    const restored = MemoryStore.deserialise(json)

    expect(restored.getPerson('npub1x')?.displayName).toBe('Test Person')
    expect(restored.getRecoveryContacts()).toHaveLength(1)
  })
})
