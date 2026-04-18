/**
 * Chronicle Confidence Scoring & Conflict Resolution
 *
 * Pure functions — no side effects, no I/O. Fully unit tested.
 *
 * The confidence score for a claim is computed from:
 *   - Number of supporters
 *   - Proximity of supporters to the ancestor (closer = more weight)
 *   - Whether the claim cites documentary evidence
 *
 * Retracted claims are excluded from all scoring.
 */

import type { FactClaim, Endorsement, ConflictState, FieldResolution, FactField, ProximityLevel } from '../types/chronicle'

// ─── Proximity weights ────────────────────────────────────────────────────────

const PROXIMITY_WEIGHT: Record<ProximityLevel, number> = {
  self: 5,
  child: 4,
  grandchild: 3,
  'great-grandchild': 2,
  other: 1,
}

// ─── Scoring thresholds ───────────────────────────────────────────────────────

const EVIDENCE_BONUS = 2
const SUPERMAJORITY_RATIO = 0.75  // >75% of total weight = resolved
const MAJORITY_RATIO = 0.5        // >50% = soft conflict (one winner)

// ─── Core scoring ─────────────────────────────────────────────────────────────

/**
 * Compute the weighted confidence score for a single claim.
 *
 * @param claim       The claim being scored
 * @param endorsements All endorsements in scope (will be filtered to this claim)
 * @returns           Numeric score ≥ 0
 */
export function computeClaimScore(
  claim: FactClaim,
  endorsements: Endorsement[],
): number {
  if (claim.retracted) return 0

  // The claimant themselves counts as an implicit supporter at 'other' weight
  let score = PROXIMITY_WEIGHT.other

  if (claim.evidence) {
    score += EVIDENCE_BONUS
  }

  const relevant = endorsements.filter(
    (e) => e.claimEventId === claim.eventId && e.agree,
  )

  for (const endorsement of relevant) {
    score += PROXIMITY_WEIGHT[endorsement.proximity] ?? PROXIMITY_WEIGHT.other
  }

  return score
}

/**
 * Attach computed confidence scores to a list of claims in place (returns new array).
 */
export function scoreAllClaims(
  claims: FactClaim[],
  endorsements: Endorsement[],
): FactClaim[] {
  return claims.map((claim) => ({
    ...claim,
    confidenceScore: computeClaimScore(claim, endorsements),
  }))
}

// ─── Conflict state ───────────────────────────────────────────────────────────

/**
 * Determine the conflict state for a set of scored claims for a single field.
 *
 * Rules:
 *   - 0 active claims  → 'none' (no data)
 *   - 1 active claim   → 'none' (no conflict)
 *   - Top claim has >75% of total weight → 'resolved'
 *   - Top claim has >50% of total weight → 'soft'
 *   - Otherwise        → 'hard'
 */
export function determineConflictState(scoredClaims: FactClaim[]): ConflictState {
  const active = scoredClaims.filter((c) => !c.retracted)

  if (active.length <= 1) return 'none'

  const totalScore = active.reduce((sum, c) => sum + c.confidenceScore, 0)
  if (totalScore === 0) return 'hard'

  const topScore = Math.max(...active.map((c) => c.confidenceScore))
  const topRatio = topScore / totalScore

  if (topRatio > SUPERMAJORITY_RATIO) return 'resolved'
  if (topRatio > MAJORITY_RATIO) return 'soft'
  return 'hard'
}

// ─── Field resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the winning claim for a single field given all claims and endorsements.
 *
 * Returns a FieldResolution containing:
 *   - The winning claim (highest score, or null if none)
 *   - All claims with scores attached
 *   - The conflict state
 */
export function resolveField(
  field: FactField,
  claims: FactClaim[],
  endorsements: Endorsement[],
): FieldResolution {
  const fieldClaims = claims.filter((c) => c.field === field)
  const scored = scoreAllClaims(fieldClaims, endorsements)
  const conflictState = determineConflictState(scored)

  const active = scored.filter((c) => !c.retracted)
  const winningClaim = active.length > 0
    ? active.reduce((best, c) => (c.confidenceScore > best.confidenceScore ? c : best))
    : null

  return {
    field,
    winningClaim,
    allClaims: scored,
    conflictState,
  }
}

/**
 * Resolve all fields for a subject, returning one FieldResolution per unique field
 * found in the claims array.
 */
export function resolveAllFields(
  claims: FactClaim[],
  endorsements: Endorsement[],
): FieldResolution[] {
  const fields = [...new Set(claims.map((c) => c.field))]
  return fields.map((field) => resolveField(field, claims, endorsements))
}
