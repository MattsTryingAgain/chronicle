/**
 * graph.ts — SQLite backend tests (Stage 7)
 *
 * Tests that graph.ts correctly delegates to a SqliteStore backend
 * when one is injected via setGraphBackend(), and reverts to in-memory
 * on reset.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  setGraphBackend, _resetGraphStore,
  addRelationship, getRelationshipsFor, retractRelationship,
  addAcknowledgement, getAcknowledgementsForClaim,
  addSamePersonLink, getSamePersonLinksFor, retractSamePersonLink,
  traverseGraph, resolveCanonicalPubkey,
  serialiseGraph, deserialiseGraph,
} from './graph'
import { SqliteStore } from './sqliteStore'
import type { RelationshipClaim, Acknowledgement, SamePersonLink } from './graph'

let sqliteStore: SqliteStore

beforeEach(() => {
  sqliteStore = new SqliteStore(':memory:')
  setGraphBackend(sqliteStore)
})

afterEach(() => {
  _resetGraphStore()
})

const makeRel = (id: string, subject: string, related: string): RelationshipClaim => ({
  eventId: id,
  claimantPubkey: 'npub1claimer',
  subjectPubkey: subject,
  relatedPubkey: related,
  relationship: 'parent',
  sensitive: false,
  createdAt: 1_000_000,
  retracted: false,
})

describe('graph — SQLite backend', () => {
  it('addRelationship / getRelationshipsFor delegates to SQLite', () => {
    addRelationship(makeRel('r1', 'npub1alice', 'npub1bob'))
    expect(getRelationshipsFor('npub1alice')).toHaveLength(1)
    expect(getRelationshipsFor('npub1bob')).toHaveLength(1)
    // Also verify directly in sqliteStore
    expect(sqliteStore.getAllRelationships()).toHaveLength(1)
  })

  it('retractRelationship marks retracted in SQLite', () => {
    addRelationship(makeRel('r1', 'npub1alice', 'npub1bob'))
    retractRelationship('r1')
    expect(getRelationshipsFor('npub1alice')).toHaveLength(0)
    expect(sqliteStore.getRelationship('r1')?.retracted).toBe(true)
  })

  it('addAcknowledgement / getAcknowledgementsForClaim delegates to SQLite', () => {
    const ack: Acknowledgement = {
      eventId: 'a1', claimEventId: 'r1',
      acknowledgerPubkey: 'npub1bob', approved: true, createdAt: 1_000_001,
    }
    addAcknowledgement(ack)
    expect(getAcknowledgementsForClaim('r1')).toHaveLength(1)
    expect(sqliteStore.getAllAcknowledgements()).toHaveLength(1)
  })

  it('addSamePersonLink / getSamePersonLinksFor delegates to SQLite', () => {
    const link: SamePersonLink = {
      eventId: 'l1', claimantPubkey: 'npub1claimer',
      pubkeyA: 'npub1alice', pubkeyB: 'npub1alice2',
      createdAt: 1_000_002, retracted: false,
    }
    addSamePersonLink(link)
    expect(getSamePersonLinksFor('npub1alice')).toHaveLength(1)
    expect(sqliteStore.getAllSamePersonLinks()).toHaveLength(1)
  })

  it('retractSamePersonLink works via SQLite', () => {
    const link: SamePersonLink = {
      eventId: 'l1', claimantPubkey: 'npub1claimer',
      pubkeyA: 'npub1alice', pubkeyB: 'npub1alice2',
      createdAt: 1_000_002, retracted: false,
    }
    addSamePersonLink(link)
    retractSamePersonLink('l1')
    expect(getSamePersonLinksFor('npub1alice')).toHaveLength(0)
  })

  it('traverseGraph works with SQLite backend', () => {
    addRelationship(makeRel('r1', 'npub1alice', 'npub1bob'))
    addRelationship(makeRel('r2', 'npub1bob', 'npub1carol'))
    const result = traverseGraph('npub1alice')
    expect(result.nodes).toContain('npub1alice')
    expect(result.nodes).toContain('npub1bob')
    expect(result.nodes).toContain('npub1carol')
    expect(result.edges).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  it('resolveCanonicalPubkey works with SQLite backend', () => {
    const link: SamePersonLink = {
      eventId: 'l1', claimantPubkey: 'npub1claimer',
      pubkeyA: 'npub1aaa', pubkeyB: 'npub1zzz',
      createdAt: 1_000_002, retracted: false,
    }
    addSamePersonLink(link)
    // 'npub1aaa' < 'npub1zzz' lexicographically → canonical is npub1aaa
    expect(resolveCanonicalPubkey('npub1zzz')).toBe('npub1aaa')
    expect(resolveCanonicalPubkey('npub1aaa')).toBe('npub1aaa')
  })

  it('_resetGraphStore reverts to in-memory backend', () => {
    addRelationship(makeRel('r1', 'npub1alice', 'npub1bob'))
    _resetGraphStore()
    // After reset, in-memory — SQLite store still has data but module uses fresh memory
    expect(getRelationshipsFor('npub1alice')).toHaveLength(0)
  })

  it('serialiseGraph / deserialiseGraph round-trips data', () => {
    addRelationship(makeRel('r1', 'npub1alice', 'npub1bob'))
    const serialised = serialiseGraph() as Record<string, unknown>
    _resetGraphStore()
    deserialiseGraph(serialised)
    expect(getRelationshipsFor('npub1alice')).toHaveLength(1)
  })
})
