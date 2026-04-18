/**
 * Chronicle Confidence Scoring — Unit Tests
 */

import { describe, it, expect } from 'vitest'
import {
  computeClaimScore,
  scoreAllClaims,
  determineConflictState,
  resolveField,
  resolveAllFields,
} from './confidence'
import type { FactClaim, Endorsement } from '../types/chronicle'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeClaim(overrides: Partial<FactClaim> = {}): FactClaim {
  return {
    eventId: 'evt-1',
    claimantPubkey: 'npub1alice',
    subjectPubkey: 'npub1grandad',
    field: 'born',
    value: '1930',
    evidence: undefined,
    createdAt: 1000000,
    retracted: false,
    confidenceScore: 0,
    ...overrides,
  }
}

function makeEndorsement(overrides: Partial<Endorsement> = {}): Endorsement {
  return {
    eventId: 'end-1',
    claimEventId: 'evt-1',
    endorserPubkey: 'npub1bob',
    proximity: 'grandchild',
    agree: true,
    createdAt: 1000001,
    ...overrides,
  }
}

// ─── computeClaimScore ────────────────────────────────────────────────────────

describe('computeClaimScore', () => {
  it('returns 0 for a retracted claim', () => {
    const claim = makeClaim({ retracted: true })
    expect(computeClaimScore(claim, [])).toBe(0)
  })

  it('returns base score (1) for a claim with no endorsements and no evidence', () => {
    const claim = makeClaim()
    expect(computeClaimScore(claim, [])).toBe(1)
  })

  it('adds evidence bonus', () => {
    const claim = makeClaim({ evidence: 'family bible' })
    expect(computeClaimScore(claim, [])).toBe(3) // 1 base + 2 evidence
  })

  it('adds proximity weight for each agreeing endorsement', () => {
    const claim = makeClaim()
    const endorsements = [
      makeEndorsement({ proximity: 'child' }),     // +4
      makeEndorsement({ eventId: 'end-2', endorserPubkey: 'npub1carol', proximity: 'other' }), // +1
    ]
    expect(computeClaimScore(claim, endorsements)).toBe(6) // 1 + 4 + 1
  })

  it('ignores disagreeing endorsements', () => {
    const claim = makeClaim()
    const endorsements = [
      makeEndorsement({ agree: false, proximity: 'child' }),
    ]
    expect(computeClaimScore(claim, endorsements)).toBe(1)
  })

  it('ignores endorsements for other claims', () => {
    const claim = makeClaim({ eventId: 'evt-mine' })
    const endorsements = [
      makeEndorsement({ claimEventId: 'evt-other', proximity: 'child' }),
    ]
    expect(computeClaimScore(claim, endorsements)).toBe(1)
  })

  it('child proximity outweighs grandchild', () => {
    const childEndorsement = makeEndorsement({ proximity: 'child' })
    const grandchildEndorsement = makeEndorsement({ proximity: 'grandchild' })
    const claim = makeClaim()
    const scoreWithChild = computeClaimScore(claim, [childEndorsement])
    const scoreWithGrandchild = computeClaimScore(claim, [grandchildEndorsement])
    expect(scoreWithChild).toBeGreaterThan(scoreWithGrandchild)
  })

  it('self proximity has highest weight', () => {
    const claim = makeClaim()
    const selfEndorsement = makeEndorsement({ proximity: 'self' })
    const score = computeClaimScore(claim, [selfEndorsement])
    expect(score).toBe(6) // 1 base + 5 self
  })
})

// ─── determineConflictState ───────────────────────────────────────────────────

describe('determineConflictState', () => {
  it('returns none for empty claims', () => {
    expect(determineConflictState([])).toBe('none')
  })

  it('returns none for a single uncontested claim', () => {
    const claim = makeClaim({ confidenceScore: 5 })
    expect(determineConflictState([claim])).toBe('none')
  })

  it('returns none for a single retracted claim', () => {
    const claim = makeClaim({ retracted: true, confidenceScore: 5 })
    expect(determineConflictState([claim])).toBe('none')
  })

  it('returns resolved when top claim has >75% of total weight', () => {
    const claims = [
      makeClaim({ eventId: 'a', confidenceScore: 10 }),
      makeClaim({ eventId: 'b', confidenceScore: 2 }),
    ]
    // 10/12 = 83% > 75%
    expect(determineConflictState(claims)).toBe('resolved')
  })

  it('returns soft when top claim has >50% but ≤75% of total weight', () => {
    const claims = [
      makeClaim({ eventId: 'a', confidenceScore: 6 }),
      makeClaim({ eventId: 'b', confidenceScore: 4 }),
    ]
    // 6/10 = 60%, between 50% and 75%
    expect(determineConflictState(claims)).toBe('soft')
  })

  it('returns hard when claims are roughly equal', () => {
    const claims = [
      makeClaim({ eventId: 'a', confidenceScore: 5 }),
      makeClaim({ eventId: 'b', confidenceScore: 5 }),
    ]
    // 5/10 = 50%, not > 50%
    expect(determineConflictState(claims)).toBe('hard')
  })

  it('ignores retracted claims in conflict detection', () => {
    const claims = [
      makeClaim({ eventId: 'a', confidenceScore: 5 }),
      makeClaim({ eventId: 'b', confidenceScore: 5, retracted: true }),
    ]
    // Only 1 active claim
    expect(determineConflictState(claims)).toBe('none')
  })
})

// ─── resolveField ─────────────────────────────────────────────────────────────

describe('resolveField', () => {
  it('returns null winning claim when no claims exist', () => {
    const result = resolveField('born', [], [])
    expect(result.winningClaim).toBeNull()
    expect(result.conflictState).toBe('none')
  })

  it('returns the only claim as winner with no conflict', () => {
    const claim = makeClaim({ field: 'born', value: '1930' })
    const result = resolveField('born', [claim], [])
    expect(result.winningClaim?.value).toBe('1930')
    expect(result.conflictState).toBe('none')
  })

  it('selects the higher-scored claim as winner', () => {
    const claimA = makeClaim({ eventId: 'a', field: 'born', value: '1930' })
    const claimB = makeClaim({ eventId: 'b', field: 'born', value: '1931' })
    const endorsement = makeEndorsement({ claimEventId: 'a', proximity: 'child' })

    const result = resolveField('born', [claimA, claimB], [endorsement])
    expect(result.winningClaim?.value).toBe('1930')
  })

  it('only includes claims for the requested field', () => {
    const bornClaim = makeClaim({ eventId: 'a', field: 'born', value: '1930' })
    const nameClaim = makeClaim({ eventId: 'b', field: 'name', value: 'Thomas' })

    const result = resolveField('born', [bornClaim, nameClaim], [])
    expect(result.allClaims).toHaveLength(1)
    expect(result.allClaims[0].field).toBe('born')
  })

  it('excludes retracted claims from winning consideration', () => {
    const active = makeClaim({ eventId: 'a', field: 'born', value: '1930' })
    const retracted = makeClaim({ eventId: 'b', field: 'born', value: '1931', retracted: true })

    const result = resolveField('born', [active, retracted], [])
    expect(result.winningClaim?.value).toBe('1930')
    expect(result.conflictState).toBe('none')
  })
})

// ─── resolveAllFields ─────────────────────────────────────────────────────────

describe('resolveAllFields', () => {
  it('returns one resolution per unique field', () => {
    const claims = [
      makeClaim({ field: 'born', value: '1930' }),
      makeClaim({ eventId: 'b', field: 'name', value: 'Thomas' }),
    ]
    const results = resolveAllFields(claims, [])
    expect(results).toHaveLength(2)
    const fields = results.map((r) => r.field).sort()
    expect(fields).toEqual(['born', 'name'])
  })

  it('handles empty claims gracefully', () => {
    expect(resolveAllFields([], [])).toEqual([])
  })

  it('pools multiple claims for the same field correctly', () => {
    const claims = [
      makeClaim({ eventId: 'a', field: 'born', value: '1930' }),
      makeClaim({ eventId: 'b', field: 'born', value: '1931' }),
    ]
    const results = resolveAllFields(claims, [])
    expect(results).toHaveLength(1) // one field: 'born'
    expect(results[0].conflictState).toBe('hard') // equal scores
  })
})
