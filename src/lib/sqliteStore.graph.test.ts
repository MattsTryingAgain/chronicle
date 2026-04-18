/**
 * SqliteStore — graph & media cache tests (Stage 7)
 *
 * Tests the new relationship, acknowledgement, same-person-link, and
 * media cache methods added to SqliteStore in Stage 7.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SqliteStore } from './sqliteStore'
import type { RelationshipClaim, Acknowledgement, SamePersonLink } from './graph'

let store: SqliteStore

beforeEach(() => {
  store = new SqliteStore(':memory:')
})

// ── Relationships ─────────────────────────────────────────────────────────────

describe('SqliteStore — relationships', () => {
  const rel: RelationshipClaim = {
    eventId: 'rel001',
    claimantPubkey: 'npub1claimer',
    subjectPubkey: 'npub1alice',
    relatedPubkey: 'npub1bob',
    relationship: 'parent',
    sensitive: false,
    createdAt: 1_000_000,
    retracted: false,
  }

  it('adds and retrieves a relationship by eventId', () => {
    store.addRelationship(rel)
    const r = store.getRelationship('rel001')
    expect(r?.subjectPubkey).toBe('npub1alice')
    expect(r?.relatedPubkey).toBe('npub1bob')
    expect(r?.relationship).toBe('parent')
    expect(r?.sensitive).toBe(false)
    expect(r?.retracted).toBe(false)
  })

  it('getRelationshipsFor returns rels where pubkey is subject or related', () => {
    store.addRelationship(rel)
    const bySubject = store.getRelationshipsFor('npub1alice')
    const byRelated = store.getRelationshipsFor('npub1bob')
    expect(bySubject).toHaveLength(1)
    expect(byRelated).toHaveLength(1)
    expect(store.getRelationshipsFor('npub1other')).toHaveLength(0)
  })

  it('returns undefined for unknown eventId', () => {
    expect(store.getRelationship('nope')).toBeUndefined()
  })

  it('deduplicates on add (ON CONFLICT DO NOTHING)', () => {
    store.addRelationship(rel)
    store.addRelationship(rel)
    expect(store.getAllRelationships()).toHaveLength(1)
  })

  it('retractRelationship marks retracted=true', () => {
    store.addRelationship(rel)
    store.retractRelationship('rel001')
    const r = store.getRelationship('rel001')
    expect(r?.retracted).toBe(true)
  })

  it('getRelationshipsFor excludes retracted', () => {
    store.addRelationship(rel)
    store.retractRelationship('rel001')
    expect(store.getRelationshipsFor('npub1alice')).toHaveLength(0)
  })

  it('getAllRelationships includes retracted', () => {
    store.addRelationship(rel)
    store.retractRelationship('rel001')
    expect(store.getAllRelationships()).toHaveLength(1)
    expect(store.getAllRelationships()[0].retracted).toBe(true)
  })

  it('stores optional subtype and relay fields', () => {
    const sensitive: RelationshipClaim = {
      ...rel, eventId: 'rel002', sensitive: true,
      subtype: 'adopted', relay: 'wss://example.com',
    }
    store.addRelationship(sensitive)
    const r = store.getRelationship('rel002')
    expect(r?.sensitive).toBe(true)
    expect(r?.subtype).toBe('adopted')
    expect(r?.relay).toBe('wss://example.com')
  })
})

// ── Acknowledgements ──────────────────────────────────────────────────────────

describe('SqliteStore — acknowledgements', () => {
  const ack: Acknowledgement = {
    eventId: 'ack001',
    claimEventId: 'rel001',
    acknowledgerPubkey: 'npub1bob',
    approved: true,
    createdAt: 1_000_001,
  }

  it('adds and retrieves acknowledgements for a claim', () => {
    store.addAcknowledgement(ack)
    const list = store.getAcknowledgementsForClaim('rel001')
    expect(list).toHaveLength(1)
    expect(list[0].acknowledgerPubkey).toBe('npub1bob')
    expect(list[0].approved).toBe(true)
  })

  it('returns empty for unknown claimEventId', () => {
    expect(store.getAcknowledgementsForClaim('nope')).toHaveLength(0)
  })

  it('getAllAcknowledgements returns all', () => {
    store.addAcknowledgement(ack)
    store.addAcknowledgement({ ...ack, eventId: 'ack002', claimEventId: 'rel002' })
    expect(store.getAllAcknowledgements()).toHaveLength(2)
  })

  it('deduplicates on add', () => {
    store.addAcknowledgement(ack)
    store.addAcknowledgement(ack)
    expect(store.getAllAcknowledgements()).toHaveLength(1)
  })

  it('stores approved=false', () => {
    store.addAcknowledgement({ ...ack, eventId: 'ack003', approved: false })
    const list = store.getAllAcknowledgements()
    expect(list[0].approved).toBe(false)
  })
})

// ── Same-Person Links ─────────────────────────────────────────────────────────

describe('SqliteStore — same-person links', () => {
  const link: SamePersonLink = {
    eventId: 'spl001',
    claimantPubkey: 'npub1claimer',
    pubkeyA: 'npub1alice',
    pubkeyB: 'npub1alice2',
    createdAt: 1_000_002,
    retracted: false,
  }

  it('adds and retrieves links for a pubkey', () => {
    store.addSamePersonLink(link)
    expect(store.getSamePersonLinksFor('npub1alice')).toHaveLength(1)
    expect(store.getSamePersonLinksFor('npub1alice2')).toHaveLength(1)
    expect(store.getSamePersonLinksFor('npub1other')).toHaveLength(0)
  })

  it('deduplicates on add', () => {
    store.addSamePersonLink(link)
    store.addSamePersonLink(link)
    expect(store.getAllSamePersonLinks()).toHaveLength(1)
  })

  it('retractSamePersonLink marks retracted=true', () => {
    store.addSamePersonLink(link)
    store.retractSamePersonLink('spl001')
    expect(store.getSamePersonLinksFor('npub1alice')).toHaveLength(0)
    expect(store.getAllSamePersonLinks()[0].retracted).toBe(true)
  })

  it('getAllSamePersonLinks returns all including retracted', () => {
    store.addSamePersonLink(link)
    store.addSamePersonLink({ ...link, eventId: 'spl002', pubkeyA: 'npub1bob', pubkeyB: 'npub1bob2' })
    expect(store.getAllSamePersonLinks()).toHaveLength(2)
  })
})

// ── Media Cache ───────────────────────────────────────────────────────────────

describe('SqliteStore — media cache', () => {
  const ref = {
    url: 'https://blossom.example/abc123',
    hash: 'deadbeef',
    mimeType: 'image/jpeg',
    size: 1024,
    tier: 'public' as const,
    subjectNpub: 'npub1alice',
  }

  it('upserts and retrieves a media cache entry', () => {
    store.upsertMediaCache(ref)
    const row = store.getMediaCache(ref.url)
    expect(row?.hash).toBe('deadbeef')
    expect(row?.fetch_status).toBe('pending')
    expect(row?.privacy_tier).toBe('public')
    expect(row?.local_path).toBeNull()
  })

  it('upsert with localPath stores it', () => {
    store.upsertMediaCache(ref, '/cache/abc123.jpg', 'cached')
    const row = store.getMediaCache(ref.url)
    expect(row?.local_path).toBe('/cache/abc123.jpg')
    expect(row?.fetch_status).toBe('cached')
  })

  it('upsert overwrites on duplicate url', () => {
    store.upsertMediaCache(ref)
    store.upsertMediaCache({ ...ref, hash: 'newHash' }, '/new/path', 'cached')
    const row = store.getMediaCache(ref.url)
    expect(row?.hash).toBe('newHash')
    expect(row?.fetch_status).toBe('cached')
  })

  it('updateMediaFetchStatus updates status and localPath', () => {
    store.upsertMediaCache(ref)
    store.updateMediaFetchStatus(ref.url, 'cached', '/cache/file.jpg')
    const row = store.getMediaCache(ref.url)
    expect(row?.fetch_status).toBe('cached')
    expect(row?.local_path).toBe('/cache/file.jpg')
  })

  it('returns undefined for unknown url', () => {
    expect(store.getMediaCache('https://nope')).toBeUndefined()
  })

  it('getAllMediaCache returns all entries', () => {
    store.upsertMediaCache(ref)
    store.upsertMediaCache({ ...ref, url: 'https://blossom.example/other', hash: 'other' })
    expect(store.getAllMediaCache()).toHaveLength(2)
  })
})
