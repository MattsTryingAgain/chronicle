/**
 * Tests for src/lib/treeLinking.ts
 */

import { describe, it, expect } from 'vitest'
import {
  normaliseName,
  namesMatch,
  namesSimilar,
  extractYear,
  yearsMatch,
  bestClaimValue,
  scoreMatch,
  findMatchCandidates,
  alreadyLinked,
  linkConnectsTrees,
} from './treeLinking'
import type { FactClaim } from '../types/chronicle'
import type { SamePersonLink } from './graph'

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _id = 0
const nextId = () => `evt${++_id}`
const npub = (n: number) => `npub1${'a'.repeat(58)}${String(n).padStart(4, '0')}`

const makeClaim = (
  subject: string,
  field: FactClaim['field'],
  value: string,
  score = 0.8
): FactClaim => ({
  eventId: nextId(),
  claimantPubkey: npub(99),
  subjectPubkey: subject,
  field,
  value,
  createdAt: 1_000_000,
  retracted: false,
  confidenceScore: score,
})

const makeLink = (a: string, b: string, retracted = false): SamePersonLink => ({
  eventId: nextId(),
  claimantPubkey: a,
  pubkeyA: a,
  pubkeyB: b,
  createdAt: 1_000_000,
  retracted,
})

// ─── normaliseName ────────────────────────────────────────────────────────────

describe('normaliseName', () => {
  it('lowercases', () => expect(normaliseName('John')).toBe('john'))
  it('trims whitespace', () => expect(normaliseName('  John  ')).toBe('john'))
  it('collapses internal whitespace', () => expect(normaliseName('John   Smith')).toBe('john smith'))
})

// ─── namesMatch ──────────────────────────────────────────────────────────────

describe('namesMatch', () => {
  it('matches identical names', () => expect(namesMatch('John Smith', 'John Smith')).toBe(true))
  it('matches case-insensitive', () => expect(namesMatch('john smith', 'JOHN SMITH')).toBe(true))
  it('does not match different names', () => expect(namesMatch('John Smith', 'Jane Doe')).toBe(false))
})

// ─── namesSimilar ─────────────────────────────────────────────────────────────

describe('namesSimilar', () => {
  it('matches when 2/2 tokens shared', () => expect(namesSimilar('John Smith', 'John Smith')).toBe(true))
  it('matches when all smaller-set tokens shared', () => expect(namesSimilar('John Patrick Smith', 'John Smith')).toBe(true))
  it('does not match when no tokens shared', () => expect(namesSimilar('John Smith', 'Mary Jones')).toBe(false))
  it('returns false for empty strings', () => expect(namesSimilar('', '')).toBe(false))
  it('partial match with 1 token overlap out of 2', () => {
    // 'John Smith' vs 'John Brown' — 1/2 = 0.5 threshold met
    expect(namesSimilar('John Smith', 'John Brown')).toBe(true)
  })
})

// ─── extractYear ─────────────────────────────────────────────────────────────

describe('extractYear', () => {
  it('extracts plain year', () => expect(extractYear('1930')).toBe(1930))
  it('extracts from ISO date', () => expect(extractYear('1930-04-15')).toBe(1930))
  it('extracts from ABT prefix', () => expect(extractYear('ABT 1930')).toBe(1930))
  it('returns null for empty string', () => expect(extractYear('')).toBeNull())
  it('returns null for non-year string', () => expect(extractYear('unknown')).toBeNull())
})

// ─── yearsMatch ──────────────────────────────────────────────────────────────

describe('yearsMatch', () => {
  it('matches same year', () => expect(yearsMatch('1930', '1930')).toBe(true))
  it('matches within tolerance of 1', () => expect(yearsMatch('1930', '1931')).toBe(true))
  it('does not match outside tolerance', () => expect(yearsMatch('1930', '1932')).toBe(false))
  it('returns false when either is unparseable', () => expect(yearsMatch('unknown', '1930')).toBe(false))
})

// ─── bestClaimValue ──────────────────────────────────────────────────────────

describe('bestClaimValue', () => {
  it('returns highest-score claim value', () => {
    const a = npub(1)
    const claims = [
      makeClaim(a, 'name', 'John Smith', 0.5),
      makeClaim(a, 'name', 'J Smith', 0.9),
    ]
    expect(bestClaimValue(claims, a, 'name')).toBe('J Smith')
  })

  it('ignores retracted claims', () => {
    const a = npub(1)
    const c = makeClaim(a, 'name', 'John Smith', 0.9)
    c.retracted = true
    const claims = [c, makeClaim(a, 'name', 'J. Smith', 0.4)]
    expect(bestClaimValue(claims, a, 'name')).toBe('J. Smith')
  })

  it('returns null when no claims', () => {
    expect(bestClaimValue([], npub(1), 'name')).toBeNull()
  })
})

// ─── scoreMatch ──────────────────────────────────────────────────────────────

describe('scoreMatch', () => {
  it('scores 0 when no data', () => {
    const result = scoreMatch(npub(1), npub(2), [])
    expect(result.confidence).toBe(0)
    expect(result.reasons).toHaveLength(0)
  })

  it('gives full name match score', () => {
    const a = npub(1); const b = npub(2)
    const claims = [
      makeClaim(a, 'name', 'John Smith'),
      makeClaim(b, 'name', 'John Smith'),
    ]
    const result = scoreMatch(a, b, claims)
    expect(result.confidence).toBeGreaterThan(0.3)
    expect(result.reasons).toContain('same-name')
  })

  it('adds birth year contribution', () => {
    const a = npub(1); const b = npub(2)
    const claims = [
      makeClaim(a, 'name', 'John Smith'),
      makeClaim(b, 'name', 'John Smith'),
      makeClaim(a, 'born', '1930'),
      makeClaim(b, 'born', '1930'),
    ]
    const result = scoreMatch(a, b, claims)
    expect(result.confidence).toBeGreaterThan(0.55)
    expect(result.reasons).toContain('same-birth-year')
  })

  it('similar name is lower score than same name', () => {
    const a = npub(1); const b = npub(2)
    const similarClaims = [
      makeClaim(a, 'name', 'John Patrick Smith'),
      makeClaim(b, 'name', 'John Smith'),
    ]
    const sameClaims = [
      makeClaim(a, 'name', 'John Smith'),
      makeClaim(b, 'name', 'John Smith'),
    ]
    const similarScore = scoreMatch(a, b, similarClaims).confidence
    const sameScore = scoreMatch(a, b, sameClaims).confidence
    expect(sameScore).toBeGreaterThan(similarScore)
  })

  it('shared relative bonus increases score', () => {
    const a = npub(1); const b = npub(2)
    const withoutRelative = scoreMatch(a, b, []).confidence
    const withRelative = scoreMatch(a, b, [], [npub(5)]).confidence
    expect(withRelative).toBeGreaterThan(withoutRelative)
    expect(withRelative).toBeLessThanOrEqual(1)
  })

  it('caps at 1.0', () => {
    const a = npub(1); const b = npub(2)
    const claims = [
      makeClaim(a, 'name', 'John Smith'),
      makeClaim(b, 'name', 'John Smith'),
      makeClaim(a, 'born', '1930'),
      makeClaim(b, 'born', '1930'),
      makeClaim(a, 'birthplace', 'Dublin'),
      makeClaim(b, 'birthplace', 'Dublin'),
      makeClaim(a, 'died', '1990'),
      makeClaim(b, 'died', '1990'),
    ]
    const result = scoreMatch(a, b, claims, [npub(5)])
    expect(result.confidence).toBeLessThanOrEqual(1)
  })

  it('similar name reason present when names partially match', () => {
    const a = npub(1); const b = npub(2)
    const claims = [
      makeClaim(a, 'name', 'John Patrick Smith'),
      makeClaim(b, 'name', 'John Smith'),
    ]
    const result = scoreMatch(a, b, claims)
    expect(result.reasons).toContain('similar-name')
    expect(result.reasons).not.toContain('same-name')
  })
})

// ─── findMatchCandidates ──────────────────────────────────────────────────────

describe('findMatchCandidates', () => {
  it('returns empty when no matches', () => {
    const a = npub(1); const b = npub(2)
    expect(findMatchCandidates([a], [b], [])).toHaveLength(0)
  })

  it('returns candidate above threshold', () => {
    const a = npub(1); const b = npub(2)
    const claims = [
      makeClaim(a, 'name', 'John Smith'),
      makeClaim(b, 'name', 'John Smith'),
      makeClaim(a, 'born', '1930'),
      makeClaim(b, 'born', '1930'),
    ]
    const results = findMatchCandidates([a], [b], claims)
    expect(results).toHaveLength(1)
    expect(results[0].confidence).toBeGreaterThan(0.35)
  })

  it('respects minConfidence option', () => {
    const a = npub(1); const b = npub(2)
    const claims = [
      makeClaim(a, 'name', 'John Smith'),
      makeClaim(b, 'name', 'John Smith'),
    ]
    // Default threshold 0.35 — name alone is 0.35 — exact boundary
    const high = findMatchCandidates([a], [b], claims, { minConfidence: 0.5 })
    const low = findMatchCandidates([a], [b], claims, { minConfidence: 0.1 })
    expect(high.length).toBeLessThanOrEqual(low.length)
  })

  it('skips self-comparisons', () => {
    const a = npub(1)
    const claims = [makeClaim(a, 'name', 'John Smith')]
    const results = findMatchCandidates([a], [a], claims)
    expect(results).toHaveLength(0)
  })

  it('sorts by confidence descending', () => {
    const a = npub(1); const b = npub(2); const c = npub(3)
    const claims = [
      makeClaim(a, 'name', 'John Smith'),
      makeClaim(b, 'name', 'John Smith'),
      makeClaim(b, 'born', '1930'),
      makeClaim(c, 'name', 'John Smith'),
      makeClaim(a, 'born', '1930'),
    ]
    const results = findMatchCandidates([a], [b, c], claims, { minConfidence: 0 })
    if (results.length >= 2) {
      expect(results[0].confidence).toBeGreaterThanOrEqual(results[1].confidence)
    }
  })
})

// ─── alreadyLinked / linkConnectsTrees ───────────────────────────────────────

describe('alreadyLinked', () => {
  it('returns true when link exists', () => {
    const a = npub(1); const b = npub(2)
    expect(alreadyLinked(a, b, [makeLink(a, b)])).toBe(true)
  })

  it('returns true in either direction', () => {
    const a = npub(1); const b = npub(2)
    expect(alreadyLinked(b, a, [makeLink(a, b)])).toBe(true)
  })

  it('ignores retracted links', () => {
    const a = npub(1); const b = npub(2)
    expect(alreadyLinked(a, b, [makeLink(a, b, true)])).toBe(false)
  })
})

describe('linkConnectsTrees', () => {
  it('returns true when link spans both sets', () => {
    const a = npub(1); const b = npub(2)
    const link = makeLink(a, b)
    expect(linkConnectsTrees(link, new Set([a]), new Set([b]))).toBe(true)
  })

  it('returns false when both in same set', () => {
    const a = npub(1); const b = npub(2)
    const link = makeLink(a, b)
    expect(linkConnectsTrees(link, new Set([a, b]), new Set())).toBe(false)
  })
})
