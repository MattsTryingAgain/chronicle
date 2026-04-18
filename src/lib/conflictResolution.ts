/**
 * Chronicle Conflict Resolution Module — Stage 6
 *
 * Manages the UI-facing conflict resolution workflow:
 *  - Full claim history for a field
 *  - Endorsement voting (agree/disagree)
 *  - Supermajority detection
 *  - Retraction of the current user's own claims
 *
 * This module is pure logic — no side effects. It composes on top of
 * confidence.ts (scoring) and storage (claims/endorsements).
 *
 * The eventBuilder is used to produce signed events; callers are responsible
 * for persisting/broadcasting them.
 */

import {
  scoreAllClaims,
  determineConflictState,
} from './confidence'
import { buildEndorsement, buildClaimRetraction } from './eventBuilder'
import type {
  FactClaim,
  Endorsement,
  ConflictState,
  FactField,
  ProximityLevel,
  ChronicleEvent,
} from '../types/chronicle'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClaimWithHistory {
  claim: FactClaim
  score: number
  endorsements: Endorsement[]
  isRetracted: boolean
  isWinner: boolean
  isMine: boolean
}

export interface FieldConflictState {
  field: FactField
  conflictState: ConflictState
  claims: ClaimWithHistory[]
  /** The current "display" value — winner or null */
  displayValue: string | null
  totalClaimCount: number
  activeClaimCount: number
}

export interface EndorseResult {
  event: ChronicleEvent
  updatedEndorsements: Endorsement[]
}

export interface RetractResult {
  event: ChronicleEvent
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Build a full conflict state view for a single field, enriched with
 * per-claim endorsement lists and isMine flags.
 */
export function buildFieldConflictState(
  field: FactField,
  allClaims: FactClaim[],
  allEndorsements: Endorsement[],
  myNpub: string,
): FieldConflictState {
  const fieldClaims = allClaims.filter(c => c.field === field)
  const scored = scoreAllClaims(fieldClaims, allEndorsements)
  const conflictState = determineConflictState(scored)

  const active = scored.filter(c => !c.retracted)
  const winnerScore = active.length > 0
    ? Math.max(...active.map(c => c.confidenceScore))
    : -1

  const claims: ClaimWithHistory[] = scored.map(claim => {
    const endorsements = allEndorsements.filter(e => e.claimEventId === claim.eventId)
    return {
      claim,
      score: claim.confidenceScore,
      endorsements,
      isRetracted: claim.retracted,
      isWinner: !claim.retracted && claim.confidenceScore === winnerScore && winnerScore >= 0,
      isMine: claim.claimantPubkey === myNpub,
    }
  })

  const winner = claims.find(c => c.isWinner)

  return {
    field,
    conflictState,
    claims,
    displayValue: winner?.claim.value ?? null,
    totalClaimCount: fieldClaims.length,
    activeClaimCount: active.length,
  }
}

/**
 * Build FieldConflictState for all fields present in the claims array.
 */
export function buildAllFieldConflictStates(
  allClaims: FactClaim[],
  allEndorsements: Endorsement[],
  myNpub: string,
): FieldConflictState[] {
  const fields = [...new Set(allClaims.map(c => c.field))]
  return fields.map(field =>
    buildFieldConflictState(field, allClaims, allEndorsements, myNpub)
  )
}

// ─── Vote ─────────────────────────────────────────────────────────────────────

export interface VoteParams {
  claimEventId: string
  voterNpub: string
  voterNsec: string
  agree: boolean
  proximity: ProximityLevel
}

/**
 * Build a signed endorsement event for a claim.
 * Returns the ChronicleEvent — caller must persist + broadcast.
 */
export function buildVoteEvent(params: VoteParams): ChronicleEvent {
  return buildEndorsement({
    endorserNpub: params.voterNpub,
    endorserNsec: params.voterNsec,
    claimEventId: params.claimEventId,
    agree: params.agree,
    proximity: params.proximity,
  })
}

// ─── Retract ──────────────────────────────────────────────────────────────────

export interface RetractParams {
  claimEventId: string
  claimantNpub: string
  claimantNsec: string
}

/**
 * Build a signed retraction event for one of the user's own claims.
 * Returns the ChronicleEvent — caller must persist + store.retractClaim() + broadcast.
 */
export function buildRetractEvent(params: RetractParams): ChronicleEvent {
  return buildClaimRetraction(
    params.claimantNpub,
    params.claimantNsec,
    params.claimEventId,
  )
}

// ─── Supermajority check ──────────────────────────────────────────────────────

/**
 * Returns true if a single claim has achieved supermajority (>75% of total
 * score), meaning the field is effectively resolved.
 */
export function isSupermajority(
  claims: FactClaim[],
  endorsements: Endorsement[],
): boolean {
  const scored = scoreAllClaims(claims, endorsements)
  return determineConflictState(scored) === 'resolved'
}

// ─── Already endorsed ────────────────────────────────────────────────────────

/**
 * Check whether a user has already endorsed a specific claim.
 */
export function hasUserEndorsed(
  claimEventId: string,
  userNpub: string,
  endorsements: Endorsement[],
): boolean {
  return endorsements.some(
    e => e.claimEventId === claimEventId && e.endorserPubkey === userNpub,
  )
}

/**
 * Get the user's existing endorsement for a claim, if any.
 */
export function getUserEndorsement(
  claimEventId: string,
  userNpub: string,
  endorsements: Endorsement[],
): Endorsement | undefined {
  return endorsements.find(
    e => e.claimEventId === claimEventId && e.endorserPubkey === userNpub,
  )
}

// ─── Summary helpers ──────────────────────────────────────────────────────────

/**
 * Returns a brief human-readable summary of a conflict state.
 */
export function describeConflictState(state: ConflictState): string {
  switch (state) {
    case 'none': return 'No conflict'
    case 'soft': return 'Mostly agreed — alternative records exist'
    case 'hard': return 'Disputed — input needed'
    case 'resolved': return 'Settled by supermajority'
  }
}

/**
 * Count how many fields for a person have an active conflict (soft or hard).
 */
export function countActiveConflicts(
  fieldStates: FieldConflictState[],
): number {
  return fieldStates.filter(
    f => f.conflictState === 'soft' || f.conflictState === 'hard',
  ).length
}
