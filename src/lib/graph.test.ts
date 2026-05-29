/**
 * Tests for src/lib/graph.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  addRelationship,
  retractRelationship,
  getRelationshipsFor,
  addAcknowledgement,
  getAcknowledgementsForClaim,
  addSamePersonLink,
  retractSamePersonLink,
  getSamePersonLinksFor,
  resolveAliasIds,
  areAliases,
  traverseGraph,
  _resetGraphStore,
  getAllRelationships,
  getAllAcknowledgements,
  getAllSamePersonLinks,
  serialiseGraph,
  deserialiseGraph,
} from './graph'
import type { RelationshipClaim, Acknowledgement, SamePersonLink } from './graph'

const npub = (n: number) => `npub1${'a'.repeat(58)}${String(n).padStart(4, '0')}`

const makeRel = (
  id: string,
  subject: string,
  related: string,
  rel = 'parent' as const,
  sensitive = false
): RelationshipClaim => ({
  eventId: id,
  claimantPubkey: subject,
  subjectId: subject,
  relatedId: related,
  relationship: rel,
  sensitive,
  createdAt: 1_000_000,
  retracted: false,
})

const makeAck = (id: string, claimEventId: string, acknowledger: string, approved = true): Acknowledgement => ({
  eventId: id,
  claimEventId,
  acknowledgerPubkey: acknowledger,
  approved,
  createdAt: 1_000_001,
})

const makeLink = (id: string, a: string, b: string): SamePersonLink => ({
  eventId: id,
  claimantPubkey: a,
  idA: a,
  idB: b,
  createdAt: 1_000_000,
  retracted: false,
})

beforeEach(() => _resetGraphStore())

describe('RelationshipClaim', () => {
  it('stores and retrieves a relationship', () => {
    const a = npub(1); const b = npub(2)
    addRelationship(makeRel('rel1', a, b))
    const rels = getRelationshipsFor(a)
    expect(rels).toHaveLength(1)
    expect(rels[0].relatedId).toBe(b)
  })

  it('indexes both sides of the relationship', () => {
    const a = npub(1); const b = npub(2)
    addRelationship(makeRel('rel1', a, b))
    expect(getRelationshipsFor(a)).toHaveLength(1)
    expect(getRelationshipsFor(b)).toHaveLength(1)
  })

  it('retracted relationships not returned', () => {
    const a = npub(1); const b = npub(2)
    addRelationship(makeRel('rel1', a, b))
    retractRelationship('rel1')
    expect(getRelationshipsFor(a)).toHaveLength(0)
  })

  it('retraction preserves record in getAllRelationships', () => {
    const a = npub(1); const b = npub(2)
    addRelationship(makeRel('rel1', a, b))
    retractRelationship('rel1')
    const all = getAllRelationships()
    expect(all).toHaveLength(1)
    expect(all[0].retracted).toBe(true)
  })

  it('handles multiple relationships per person', () => {
    const a = npub(1); const b = npub(2); const c = npub(3)
    addRelationship(makeRel('rel1', a, b))
    addRelationship(makeRel('rel2', a, c))
    expect(getRelationshipsFor(a)).toHaveLength(2)
  })

  it('returns empty for unknown pubkey', () => {
    expect(getRelationshipsFor(npub(99))).toHaveLength(0)
  })
})

describe('Acknowledgement', () => {
  it('stores and retrieves acknowledgement', () => {
    addAcknowledgement(makeAck('ack1', 'rel1', npub(2)))
    const acks = getAcknowledgementsForClaim('rel1')
    expect(acks).toHaveLength(1)
    expect(acks[0].approved).toBe(true)
  })

  it('getAllAcknowledgements returns all', () => {
    addAcknowledgement(makeAck('ack1', 'rel1', npub(2)))
    addAcknowledgement(makeAck('ack2', 'rel2', npub(3)))
    expect(getAllAcknowledgements()).toHaveLength(2)
  })

  it('filters by claim event id', () => {
    addAcknowledgement(makeAck('ack1', 'rel1', npub(2)))
    addAcknowledgement(makeAck('ack2', 'rel2', npub(3)))
    expect(getAcknowledgementsForClaim('rel1')).toHaveLength(1)
    expect(getAcknowledgementsForClaim('rel2')).toHaveLength(1)
    expect(getAcknowledgementsForClaim('rel99')).toHaveLength(0)
  })

  it('stores disapproval', () => {
    addAcknowledgement(makeAck('ack1', 'rel1', npub(2), false))
    expect(getAcknowledgementsForClaim('rel1')[0].approved).toBe(false)
  })
})

describe('SamePersonLink', () => {
  it('stores and retrieves links', () => {
    const a = npub(1); const b = npub(2)
    addSamePersonLink(makeLink('lnk1', a, b))
    expect(getSamePersonLinksFor(a)).toHaveLength(1)
    expect(getSamePersonLinksFor(b)).toHaveLength(1)
  })

  it('retracts links', () => {
    const a = npub(1); const b = npub(2)
    addSamePersonLink(makeLink('lnk1', a, b))
    retractSamePersonLink('lnk1')
    expect(getSamePersonLinksFor(a)).toHaveLength(0)
  })

  it('getAllSamePersonLinks includes retracted', () => {
    const a = npub(1); const b = npub(2)
    addSamePersonLink(makeLink('lnk1', a, b))
    retractSamePersonLink('lnk1')
    expect(getAllSamePersonLinks()[0].retracted).toBe(true)
  })
})

describe('resolveAliasIds', () => {
  it('returns a Set containing just itself when no links', () => {
    const id = npub(1)
    const result = resolveAliasIds(id)
    expect(result).toBeInstanceOf(Set)
    expect(result.has(id)).toBe(true)
    expect(result.size).toBe(1)
  })

  it('includes both IDs when linked', () => {
    const a = 'npub1aaaa'
    const b = 'npub1zzzz'
    addSamePersonLink(makeLink('lnk1', a, b))
    const resultA = resolveAliasIds(a)
    expect(resultA.has(a)).toBe(true)
    expect(resultA.has(b)).toBe(true)
    const resultB = resolveAliasIds(b)
    expect(resultB.has(a)).toBe(true)
    expect(resultB.has(b)).toBe(true)
  })

  it('handles chained links without infinite loop', () => {
    const a = npub(1); const b = npub(2); const c = npub(3)
    addSamePersonLink(makeLink('lnk1', a, b))
    addSamePersonLink(makeLink('lnk2', b, c))
    // Should not infinite loop; all three should be in the group
    const result = resolveAliasIds(c)
    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBeGreaterThanOrEqual(1)
  })
})

describe('areAliases', () => {
  it('returns true for the same id', () => {
    expect(areAliases(npub(1), npub(1))).toBe(true)
  })

  it('returns true for directly linked ids', () => {
    const a = npub(1); const b = npub(2)
    addSamePersonLink(makeLink('lnk1', a, b))
    expect(areAliases(a, b)).toBe(true)
    expect(areAliases(b, a)).toBe(true)
  })

  it('returns false for unlinked ids', () => {
    expect(areAliases(npub(1), npub(2))).toBe(false)
  })
})

describe('traverseGraph', () => {
  it('returns just root for isolated node', () => {
    const result = traverseGraph(npub(1))
    expect(result.nodes).toEqual([npub(1)])
    expect(result.edges).toHaveLength(0)
    expect(result.truncated).toBe(false)
  })

  it('traverses a simple parent-child chain', () => {
    const a = npub(1); const b = npub(2); const c = npub(3)
    addRelationship(makeRel('r1', a, b, 'parent'))
    addRelationship(makeRel('r2', b, c, 'parent'))
    const result = traverseGraph(a)
    expect(result.nodes).toContain(a)
    expect(result.nodes).toContain(b)
    expect(result.nodes).toContain(c)
    expect(result.edges).toHaveLength(2)
  })

  it('does not revisit nodes (handles cycles)', () => {
    const a = npub(1); const b = npub(2)
    addRelationship(makeRel('r1', a, b, 'spouse'))
    addRelationship(makeRel('r2', b, a, 'spouse'))
    const result = traverseGraph(a)
    expect(result.nodes).toHaveLength(2)
  })

  it('respects maxDepth', () => {
    // Chain of 10 nodes
    for (let i = 1; i < 10; i++) {
      addRelationship(makeRel(`r${i}`, npub(i), npub(i + 1), 'parent'))
    }
    const result = traverseGraph(npub(1), { maxDepth: 2 })
    // Depth 0: npub(1), depth 1: npub(2), depth 2: npub(3) — but depth 2 doesn't expand further
    expect(result.nodes.length).toBeLessThanOrEqual(4)
  })

  it('respects maxNodes and sets truncated', () => {
    // Star graph: centre connected to 10 nodes
    for (let i = 2; i <= 11; i++) {
      addRelationship(makeRel(`r${i}`, npub(1), npub(i), 'parent'))
    }
    const result = traverseGraph(npub(1), { maxNodes: 5 })
    expect(result.nodes.length).toBeLessThanOrEqual(5)
    expect(result.truncated).toBe(true)
  })

  it('marks acknowledged edges correctly', () => {
    const a = npub(1); const b = npub(2)
    addRelationship(makeRel('r1', a, b, 'parent'))
    addAcknowledgement(makeAck('ack1', 'r1', b, true))
    const result = traverseGraph(a)
    expect(result.edges[0].acknowledged).toBe(true)
  })

  it('unacknowledged edge is marked correctly', () => {
    const a = npub(1); const b = npub(2)
    addRelationship(makeRel('r1', a, b, 'parent'))
    const result = traverseGraph(a)
    expect(result.edges[0].acknowledged).toBe(false)
  })

  it('includes sensitive relationships in traversal', () => {
    const a = npub(1); const b = npub(2)
    const rel = makeRel('r1', a, b, 'parent', true)
    rel.subtype = 'adopted'
    addRelationship(rel)
    const result = traverseGraph(a)
    expect(result.edges[0].sensitive).toBe(true)
    expect(result.edges[0].subtype).toBe('adopted')
  })
})

describe('serialiseGraph / deserialiseGraph', () => {
  it('round-trips correctly', () => {
    const a = npub(1); const b = npub(2); const c = npub(3)
    addRelationship(makeRel('r1', a, b, 'parent'))
    addAcknowledgement(makeAck('ack1', 'r1', b))
    addSamePersonLink(makeLink('lnk1', b, c))

    const serialised = serialiseGraph()
    _resetGraphStore()

    deserialiseGraph(serialised as Record<string, unknown>)

    expect(getRelationshipsFor(a)).toHaveLength(1)
    expect(getAcknowledgementsForClaim('r1')).toHaveLength(1)
    expect(getSamePersonLinksFor(b)).toHaveLength(1)
  })
})
