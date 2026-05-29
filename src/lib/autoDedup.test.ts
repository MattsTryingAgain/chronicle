/**
 * Tests for auto-deduplication logic.
 *
 * Covers the key scenarios Chronicle needs to handle:
 *  - scoreMatch: name-only, name+DoB, mismatched DoB
 *  - The reported bug: instance 1 has name+DoB, instance 2 has name only
 *  - findMatchCandidates with same-set comparison (all persons vs all persons)
 *  - resolveAliasIds-based dedup in the People list
 *  - alreadyLinked edge cases
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { _resetGraphStore, addSamePersonLink, resolveAliasIds } from './graph'
import { scoreMatch, findMatchCandidates, alreadyLinked } from './treeLinking'
import type { FactClaim } from '../types/chronicle'
import type { SamePersonLink } from './graph'

// ─── Helpers ──────────────────────────────────────────────────────────────────

let claimIdCounter = 0

function makeNameClaim(subjectId: string, name: string, claimantPubkey = 'claimant-a'): FactClaim {
  return {
    eventId: `evt-${++claimIdCounter}`,
    subjectId,
    claimantPubkey,
    field: 'name',
    value: name,
    createdAt: 1_000_000,
    retracted: false,
    confidenceScore: 0,
  }
}

function makeBornClaim(subjectId: string, year: string, claimantPubkey = 'claimant-a'): FactClaim {
  return {
    eventId: `evt-${++claimIdCounter}`,
    subjectId,
    claimantPubkey,
    field: 'born',
    value: year,
    createdAt: 1_000_000,
    retracted: false,
    confidenceScore: 0,
  }
}

function makeLink(idA: string, idB: string, eventId?: string): SamePersonLink {
  return {
    eventId: eventId ?? `link-${idA}-${idB}`,
    idA,
    idB,
    claimantPubkey: 'claimant-a',
    createdAt: 1_000_000,
    retracted: false,
  }
}

beforeEach(() => {
  _resetGraphStore()
  claimIdCounter = 0
})

// ─── scoreMatch — name only ───────────────────────────────────────────────────

describe('scoreMatch — exact name only', () => {
  it('scores 0.35 for same name with no other data', () => {
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', 'Alice Smith'),
      makeNameClaim('pub-b', 'Alice Smith', 'claimant-b'),
    ]
    const result = scoreMatch('pub-a', 'pub-b', claims)
    expect(result.confidence).toBeCloseTo(0.35)
    expect(result.reasons).toContain('same-name')
  })

  it('scores 0.15 for similar name (partial token overlap)', () => {
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', 'Alice Smith'),
      makeNameClaim('pub-b', 'Alice Jones', 'claimant-b'),
    ]
    const result = scoreMatch('pub-a', 'pub-b', claims)
    expect(result.confidence).toBeCloseTo(0.15)
    expect(result.reasons).toContain('similar-name')
  })

  it('scores 0 for completely different names', () => {
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', 'Alice Smith'),
      makeNameClaim('pub-b', 'Robert Johnson', 'claimant-b'),
    ]
    const result = scoreMatch('pub-a', 'pub-b', claims)
    expect(result.confidence).toBe(0)
  })
})

// ─── scoreMatch — name + birth year ──────────────────────────────────────────

describe('scoreMatch — name + birth year', () => {
  it('scores 0.60 for same name + same birth year', () => {
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', 'Alice Smith'),
      makeBornClaim('pub-a', '1980'),
      makeNameClaim('pub-b', 'Alice Smith', 'claimant-b'),
      makeBornClaim('pub-b', '1980', 'claimant-b'),
    ]
    const result = scoreMatch('pub-a', 'pub-b', claims)
    expect(result.confidence).toBeCloseTo(0.60)
    expect(result.reasons).toContain('same-name')
    expect(result.reasons).toContain('same-birth-year')
  })

  it('scores 0.35 for same name + birth years outside tolerance', () => {
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', 'Alice Smith'),
      makeBornClaim('pub-a', '1980'),
      makeNameClaim('pub-b', 'Alice Smith', 'claimant-b'),
      makeBornClaim('pub-b', '1990', 'claimant-b'),
    ]
    const result = scoreMatch('pub-a', 'pub-b', claims)
    expect(result.confidence).toBeCloseTo(0.35) // name only — birth years don't match
    expect(result.reasons).not.toContain('same-birth-year')
  })

  it('instance-1-has-DoB, instance-2-name-only: still meets 0.35 threshold', () => {
    // The reported bug scenario: instance 1 records "Matt O'Brien, b.1985";
    // instance 2 syncs in "Matt O'Brien" with no DoB. The pair must still be
    // surfaced as a dedup candidate (confidence ≥ 0.35).
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', "Matt O'Brien"),
      makeBornClaim('pub-a', '1985'),
      makeNameClaim('pub-b', "Matt O'Brien", 'claimant-b'), // no DoB on pub-b
    ]
    const result = scoreMatch('pub-a', 'pub-b', claims)
    expect(result.confidence).toBeGreaterThanOrEqual(0.35)
    expect(result.reasons).toContain('same-name')
  })
})

// ─── findMatchCandidates — same set vs same set ───────────────────────────────

describe('findMatchCandidates — same-set comparison', () => {
  it('finds a candidate when all persons are compared against each other', () => {
    // This is the key fix: we pass the same pubkey list for both A and B,
    // so we catch duplicates regardless of which instance created them.
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', 'Alice'),
      makeNameClaim('pub-b', 'Alice', 'claimant-b'),
      makeNameClaim('pub-c', 'Bob'),
    ]
    const pubkeys = ['pub-a', 'pub-b', 'pub-c']
    const results = findMatchCandidates(pubkeys, pubkeys, claims, { minConfidence: 0.3 })
    expect(results.length).toBeGreaterThan(0)
    const pair = [results[0].idA, results[0].idB].sort()
    expect(pair).toEqual(['pub-a', 'pub-b'])
  })

  it('excludes already-linked pairs', () => {
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', 'Alice'),
      makeNameClaim('pub-b', 'Alice', 'claimant-b'),
    ]
    const existingLinks: SamePersonLink[] = [makeLink('pub-a', 'pub-b')]
    const pubkeys = ['pub-a', 'pub-b']
    const raw = findMatchCandidates(pubkeys, pubkeys, claims, { minConfidence: 0.3 })
    const filtered = raw.filter(c => !alreadyLinked(c.idA, c.idB, existingLinks))
    expect(filtered.length).toBe(0)
  })

  it('does not suggest self-match', () => {
    const claims: FactClaim[] = [makeNameClaim('pub-a', 'Alice')]
    const pubkeys = ['pub-a']
    const results = findMatchCandidates(pubkeys, pubkeys, claims, { minConfidence: 0.3 })
    expect(results.length).toBe(0)
  })

  it('ranks higher-confidence matches first', () => {
    const claims: FactClaim[] = [
      makeNameClaim('pub-a', 'Alice'),
      makeBornClaim('pub-a', '1980'),
      makeNameClaim('pub-b', 'Alice', 'claimant-b'),        // name only
      makeBornClaim('pub-b', '1980', 'claimant-b'),          // + DoB
      makeNameClaim('pub-c', 'Alice', 'claimant-c'),          // name only, no DoB
    ]
    const pubkeys = ['pub-a', 'pub-b', 'pub-c']
    const results = findMatchCandidates(pubkeys, pubkeys, claims, { minConfidence: 0.3 })
    // a↔b should rank above a↔c (both have name, but a↔b also has same birth year)
    expect(results[0].confidence).toBeGreaterThanOrEqual(results[results.length - 1].confidence)
  })
})

// ─── resolveAliasIds — alias group resolution ─────────────────────────

describe('resolveAliasIds — People list dedup', () => {
  it('returns a Set with just itself when no link exists', () => {
    const result = resolveAliasIds('pub-a')
    expect(result).toBeInstanceOf(Set)
    expect(result.has('pub-a')).toBe(true)
    expect(result.size).toBe(1)
  })

  it('includes both IDs in the alias group when linked', () => {
    addSamePersonLink(makeLink('pub-a', 'pub-b'))
    const groupA = resolveAliasIds('pub-a')
    expect(groupA.has('pub-a')).toBe(true)
    expect(groupA.has('pub-b')).toBe(true)
    const groupB = resolveAliasIds('pub-b')
    expect(groupB.has('pub-a')).toBe(true)
    expect(groupB.has('pub-b')).toBe(true)
  })

  it('non-alias persons are correctly identified by group membership', () => {
    // Simulate: instance 1 → pub-a, instance 2 → pub-b, user confirms link
    addSamePersonLink(makeLink('pub-a', 'pub-b'))
    const persons = [
      { id: 'pub-a', displayName: 'Alice' },
      { id: 'pub-b', displayName: 'Alice' }, // alias of pub-a
      { id: 'pub-c', displayName: 'Bob' },
    ]
    // For UI hiding: hide persons whose ID is in another person's alias group
    // but is not their own local ID. Build a map of alias groups first.
    const aliasGroups = persons.map(p => ({ id: p.id, group: resolveAliasIds(p.id) }))
    // pub-a and pub-b are in each other's groups; both groups contain 2 IDs
    const groupA = aliasGroups.find(g => g.id === 'pub-a')!.group
    const groupB = aliasGroups.find(g => g.id === 'pub-b')!.group
    expect(groupA.has('pub-b')).toBe(true)
    expect(groupB.has('pub-a')).toBe(true)
    // pub-c is its own group
    const groupC = aliasGroups.find(g => g.id === 'pub-c')!.group
    expect(groupC.size).toBe(1)
  })

  it('handles chained links (A→B, B→C) without infinite loop', () => {
    addSamePersonLink(makeLink('pub-b', 'pub-a', 'link-1'))
    addSamePersonLink(makeLink('pub-c', 'pub-b', 'link-2'))
    expect(() => resolveAliasIds('pub-c')).not.toThrow()
    expect(() => resolveAliasIds('pub-a')).not.toThrow()
    // All three should be in each other's groups
    const group = resolveAliasIds('pub-c')
    expect(group.size).toBe(3)
  })
})

// ─── alreadyLinked ────────────────────────────────────────────────────────────

describe('alreadyLinked', () => {
  it('returns true when an active link exists (A→B direction)', () => {
    const links = [makeLink('pub-a', 'pub-b')]
    expect(alreadyLinked('pub-a', 'pub-b', links)).toBe(true)
  })

  it('returns true for the reverse direction (B→A)', () => {
    const links = [makeLink('pub-a', 'pub-b')]
    expect(alreadyLinked('pub-b', 'pub-a', links)).toBe(true)
  })

  it('returns false for a retracted link', () => {
    const links = [{ ...makeLink('pub-a', 'pub-b'), retracted: true }]
    expect(alreadyLinked('pub-a', 'pub-b', links)).toBe(false)
  })

  it('returns false when no matching link exists', () => {
    const links = [makeLink('pub-a', 'pub-c')]
    expect(alreadyLinked('pub-a', 'pub-b', links)).toBe(false)
  })
})
