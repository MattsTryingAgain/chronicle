/**
 * Conflict Resolution module tests — Stage 6
 */

import { describe, it, expect } from 'vitest'
import {
  buildFieldConflictState,
  buildAllFieldConflictStates,
  buildVoteEvent,
  buildRetractEvent,
  isSupermajority,
  hasUserEndorsed,
  getUserEndorsement,
  describeConflictState,
  countActiveConflicts,
  type FieldConflictState,
} from './conflictResolution'
import { generateUserKeyMaterial } from './keys'
import type { FactClaim, Endorsement } from '../types/chronicle'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClaim(
  overrides: Partial<FactClaim> = {},
): FactClaim {
  return {
    eventId: `claim-${Math.random().toString(36).slice(2)}`,
    claimantPubkey: 'npub1alice',
    subjectPubkey: 'npub1ancestor',
    field: 'born',
    value: '1930',
    createdAt: 1000,
    retracted: false,
    confidenceScore: 0,
    ...overrides,
  }
}

function makeEndorsement(
  overrides: Partial<Endorsement> = {},
): Endorsement {
  return {
    eventId: `end-${Math.random().toString(36).slice(2)}`,
    claimEventId: 'claim-xxx',
    endorserPubkey: 'npub1bob',
    proximity: 'grandchild',
    agree: true,
    createdAt: 1001,
    ...overrides,
  }
}

// ─── buildFieldConflictState ──────────────────────────────────────────────────

describe('buildFieldConflictState', () => {
  it('returns none conflict state when only one claim exists', () => {
    const alice = generateUserKeyMaterial()
    const claim = makeClaim({ claimantPubkey: alice.npub })
    const state = buildFieldConflictState('born', [claim], [], alice.npub)
    expect(state.conflictState).toBe('none')
    expect(state.claims).toHaveLength(1)
    expect(state.activeClaimCount).toBe(1)
  })

  it('marks isWinner on highest-scoring active claim', () => {
    const alice = generateUserKeyMaterial()
    const bob = generateUserKeyMaterial()
    const c1 = makeClaim({ eventId: 'c1', claimantPubkey: alice.npub, value: '1930' })
    const c2 = makeClaim({ eventId: 'c2', claimantPubkey: bob.npub, value: '1931' })
    const endorsement = makeEndorsement({ claimEventId: 'c1', proximity: 'child' })
    const state = buildFieldConflictState('born', [c1, c2], [endorsement], alice.npub)
    const winner = state.claims.find(c => c.isWinner)
    expect(winner?.claim.eventId).toBe('c1')
  })

  it('marks isMine correctly', () => {
    const alice = generateUserKeyMaterial()
    const bob = generateUserKeyMaterial()
    const c1 = makeClaim({ eventId: 'c1', claimantPubkey: alice.npub })
    const c2 = makeClaim({ eventId: 'c2', claimantPubkey: bob.npub })
    const state = buildFieldConflictState('born', [c1, c2], [], alice.npub)
    expect(state.claims.find(c => c.claim.eventId === 'c1')?.isMine).toBe(true)
    expect(state.claims.find(c => c.claim.eventId === 'c2')?.isMine).toBe(false)
  })

  it('retracted claims have isRetracted=true and isWinner=false', () => {
    const alice = generateUserKeyMaterial()
    const c1 = makeClaim({ eventId: 'c1', retracted: true, claimantPubkey: alice.npub })
    const state = buildFieldConflictState('born', [c1], [], alice.npub)
    expect(state.claims[0].isRetracted).toBe(true)
    expect(state.claims[0].isWinner).toBe(false)
  })

  it('displayValue is null when all claims are retracted', () => {
    const alice = generateUserKeyMaterial()
    const c1 = makeClaim({ retracted: true, claimantPubkey: alice.npub })
    const state = buildFieldConflictState('born', [c1], [], alice.npub)
    expect(state.displayValue).toBeNull()
  })

  it('only includes claims for the requested field', () => {
    const alice = generateUserKeyMaterial()
    const born = makeClaim({ field: 'born', claimantPubkey: alice.npub })
    const died = makeClaim({ field: 'died', claimantPubkey: alice.npub })
    const state = buildFieldConflictState('born', [born, died], [], alice.npub)
    expect(state.claims).toHaveLength(1)
    expect(state.claims[0].claim.field).toBe('born')
  })

  it('attaches per-claim endorsements correctly', () => {
    const alice = generateUserKeyMaterial()
    const c1 = makeClaim({ eventId: 'c1', claimantPubkey: alice.npub })
    const e1 = makeEndorsement({ claimEventId: 'c1' })
    const e2 = makeEndorsement({ claimEventId: 'other-claim' })
    const state = buildFieldConflictState('born', [c1], [e1, e2], alice.npub)
    expect(state.claims[0].endorsements).toHaveLength(1)
    expect(state.claims[0].endorsements[0].eventId).toBe(e1.eventId)
  })
})

// ─── buildAllFieldConflictStates ──────────────────────────────────────────────

describe('buildAllFieldConflictStates', () => {
  it('produces one entry per unique field', () => {
    const alice = generateUserKeyMaterial()
    const claims = [
      makeClaim({ field: 'born', claimantPubkey: alice.npub }),
      makeClaim({ field: 'died', claimantPubkey: alice.npub }),
      makeClaim({ field: 'birthplace', claimantPubkey: alice.npub }),
    ]
    const states = buildAllFieldConflictStates(claims, [], alice.npub)
    expect(states).toHaveLength(3)
    expect(states.map(s => s.field).sort()).toEqual(['birthplace', 'born', 'died'])
  })

  it('returns empty array for empty claims', () => {
    const alice = generateUserKeyMaterial()
    expect(buildAllFieldConflictStates([], [], alice.npub)).toEqual([])
  })
})

// ─── buildVoteEvent ───────────────────────────────────────────────────────────

describe('buildVoteEvent', () => {
  it('produces a valid endorsement event', () => {
    const voter = generateUserKeyMaterial()
    const event = buildVoteEvent({
      claimEventId: 'claim-001',
      voterNpub: voter.npub,
      voterNsec: voter.nsec,
      agree: true,
      proximity: 'grandchild',
    })
    expect(event.kind).toBe(30082)
    expect(event.tags.find(t => t[0] === 'claim_event')?.[1]).toBe('claim-001')
    expect(event.tags.find(t => t[0] === 'agree')?.[1]).toBe('true')
    expect(event.tags.find(t => t[0] === 'proximity')?.[1]).toBe('grandchild')
    expect(event.sig).toBeTruthy()
  })

  it('can record a disagree vote', () => {
    const voter = generateUserKeyMaterial()
    const event = buildVoteEvent({
      claimEventId: 'claim-002',
      voterNpub: voter.npub,
      voterNsec: voter.nsec,
      agree: false,
      proximity: 'other',
    })
    expect(event.tags.find(t => t[0] === 'agree')?.[1]).toBe('false')
  })
})

// ─── buildRetractEvent ────────────────────────────────────────────────────────

describe('buildRetractEvent', () => {
  it('produces a valid retraction event', () => {
    const claimant = generateUserKeyMaterial()
    const event = buildRetractEvent({
      claimEventId: 'claim-abc',
      claimantNpub: claimant.npub,
      claimantNsec: claimant.nsec,
    })
    expect(event.kind).toBe(30089)
    expect(event.tags.find(t => t[0] === 'retracts')?.[1]).toBe('claim-abc')
    expect(event.sig).toBeTruthy()
  })
})

// ─── isSupermajority ──────────────────────────────────────────────────────────

describe('isSupermajority', () => {
  it('returns false for a single unendorsed claim', () => {
    const c1 = makeClaim()
    expect(isSupermajority([c1], [])).toBe(false)
  })

  it('returns false when two claims are roughly equal', () => {
    const c1 = makeClaim({ eventId: 'c1' })
    const c2 = makeClaim({ eventId: 'c2' })
    expect(isSupermajority([c1, c2], [])).toBe(false)
  })

  it('returns true when one claim has overwhelming endorsement', () => {
    const c1 = makeClaim({ eventId: 'c1' })
    const c2 = makeClaim({ eventId: 'c2' })
    // Give c1 many endorsements, c2 none
    const endorsements: Endorsement[] = Array.from({ length: 5 }, (_, i) => makeEndorsement({
      eventId: `e${i}`,
      claimEventId: 'c1',
      proximity: 'child',
    }))
    expect(isSupermajority([c1, c2], endorsements)).toBe(true)
  })
})

// ─── hasUserEndorsed ──────────────────────────────────────────────────────────

describe('hasUserEndorsed', () => {
  it('returns false when no endorsements exist', () => {
    expect(hasUserEndorsed('claim-1', 'npub1alice', [])).toBe(false)
  })

  it('returns true when user has endorsed the claim', () => {
    const e = makeEndorsement({ claimEventId: 'claim-1', endorserPubkey: 'npub1alice' })
    expect(hasUserEndorsed('claim-1', 'npub1alice', [e])).toBe(true)
  })

  it('returns false when someone else endorsed', () => {
    const e = makeEndorsement({ claimEventId: 'claim-1', endorserPubkey: 'npub1bob' })
    expect(hasUserEndorsed('claim-1', 'npub1alice', [e])).toBe(false)
  })
})

// ─── getUserEndorsement ───────────────────────────────────────────────────────

describe('getUserEndorsement', () => {
  it('returns undefined when user has not endorsed', () => {
    expect(getUserEndorsement('c1', 'npub1alice', [])).toBeUndefined()
  })

  it('returns the endorsement when found', () => {
    const e = makeEndorsement({ claimEventId: 'c1', endorserPubkey: 'npub1alice' })
    const result = getUserEndorsement('c1', 'npub1alice', [e])
    expect(result?.eventId).toBe(e.eventId)
  })
})

// ─── describeConflictState ────────────────────────────────────────────────────

describe('describeConflictState', () => {
  it('returns a non-empty string for each state', () => {
    for (const state of ['none', 'soft', 'hard', 'resolved'] as const) {
      expect(describeConflictState(state)).toBeTruthy()
    }
  })
})

// ─── countActiveConflicts ─────────────────────────────────────────────────────

describe('countActiveConflicts', () => {
  function makeState(conflictState: FieldConflictState['conflictState']): FieldConflictState {
    return {
      field: 'born', conflictState, claims: [], displayValue: null,
      totalClaimCount: 0, activeClaimCount: 0,
    }
  }

  it('returns 0 for all-none states', () => {
    expect(countActiveConflicts([makeState('none'), makeState('none')])).toBe(0)
  })

  it('counts soft and hard but not none/resolved', () => {
    const states = [
      makeState('none'),
      makeState('soft'),
      makeState('hard'),
      makeState('resolved'),
    ]
    expect(countActiveConflicts(states)).toBe(2)
  })
})
