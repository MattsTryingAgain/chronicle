/**
 * Chronicle Tree Linking
 *
 * Detects when two independent trees share a common ancestor, generates
 * confidence-scored match suggestions, and identifies candidate same-person links.
 *
 * The user always makes the final decision — this module only suggests.
 */

import type { FactClaim, FactField } from '../types/chronicle'
import type { SamePersonLink } from './graph'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MatchCandidate {
  pubkeyA: string         // person from tree A
  pubkeyB: string         // person from tree B (or same tree, different node)
  confidence: number      // 0–1
  reasons: MatchReason[]
}

export type MatchReason =
  | 'same-name'
  | 'similar-name'
  | 'same-birth-year'
  | 'same-birthplace'
  | 'shared-relative'
  | 'same-death-year'

// ─── Name normalisation ───────────────────────────────────────────────────────

/**
 * Normalises a name for comparison: lowercase, collapse whitespace, trim.
 */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Returns true if two names are an exact match after normalisation.
 */
export function namesMatch(a: string, b: string): boolean {
  return normaliseName(a) === normaliseName(b)
}

/**
 * Returns true if two names share a significant token overlap.
 * "John Patrick Smith" ≈ "John Smith" → true (2 of 3 tokens shared)
 */
export function namesSimilar(a: string, b: string): boolean {
  const tokensA = new Set(normaliseName(a).split(' ').filter(t => t.length > 1))
  const tokensB = new Set(normaliseName(b).split(' ').filter(t => t.length > 1))
  let shared = 0
  for (const t of tokensA) if (tokensB.has(t)) shared++
  const minSize = Math.min(tokensA.size, tokensB.size)
  if (minSize === 0) return false
  return shared / minSize >= 0.5
}

// ─── Year extraction ──────────────────────────────────────────────────────────

/**
 * Extracts a 4-digit year from a date string, or null if none found.
 * Handles formats: "1930", "1930-04-15", "ABT 1930", "BEF 1931", "AFT 1929"
 */
export function extractYear(value: string): number | null {
  const m = value.match(/\b(\d{4})\b/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Returns true if two year values are considered a match (exact or ±1).
 */
export function yearsMatch(a: string, b: string, tolerance = 1): boolean {
  const ya = extractYear(a)
  const yb = extractYear(b)
  if (ya === null || yb === null) return false
  return Math.abs(ya - yb) <= tolerance
}

// ─── Best-value helpers ───────────────────────────────────────────────────────

/**
 * Returns the best (highest-confidence, non-retracted) claim value for a field.
 */
export function bestClaimValue(
  claims: FactClaim[],
  subjectPubkey: string,
  field: FactField
): string | null {
  const relevant = claims
    .filter(c => c.subjectPubkey === subjectPubkey && c.field === field && !c.retracted)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
  return relevant[0]?.value ?? null
}

// ─── Match scoring ────────────────────────────────────────────────────────────

/**
 * Computes a confidence score and reasons for two persons being the same individual.
 *
 * Weights (sum to give 0–1 when all match):
 *   same-name       0.35
 *   similar-name    0.15  (only if not same-name)
 *   same-birth-year 0.25
 *   same-birthplace 0.20
 *   same-death-year 0.10
 *   shared-relative 0.25  (bonus — can push above 1.0 before capping)
 *
 * Result is capped at 1.0.
 */
export function scoreMatch(
  pubkeyA: string,
  pubkeyB: string,
  allClaims: FactClaim[],
  /** Shared known relative pubkeys between the two persons (graph-derived) */
  sharedRelativePubkeys: string[] = []
): MatchCandidate {
  const reasons: MatchReason[] = []
  let score = 0

  const nameA = bestClaimValue(allClaims, pubkeyA, 'name')
  const nameB = bestClaimValue(allClaims, pubkeyB, 'name')
  const bornA = bestClaimValue(allClaims, pubkeyA, 'born')
  const bornB = bestClaimValue(allClaims, pubkeyB, 'born')
  const birthplaceA = bestClaimValue(allClaims, pubkeyA, 'birthplace')
  const birthplaceB = bestClaimValue(allClaims, pubkeyB, 'birthplace')
  const diedA = bestClaimValue(allClaims, pubkeyA, 'died')
  const diedB = bestClaimValue(allClaims, pubkeyB, 'died')

  // Name
  if (nameA && nameB) {
    if (namesMatch(nameA, nameB)) {
      reasons.push('same-name')
      score += 0.35
    } else if (namesSimilar(nameA, nameB)) {
      reasons.push('similar-name')
      score += 0.15
    }
  }

  // Birth year
  if (bornA && bornB && yearsMatch(bornA, bornB)) {
    reasons.push('same-birth-year')
    score += 0.25
  }

  // Birthplace
  if (birthplaceA && birthplaceB) {
    if (normaliseName(birthplaceA) === normaliseName(birthplaceB)) {
      reasons.push('same-birthplace')
      score += 0.20
    }
  }

  // Death year
  if (diedA && diedB && yearsMatch(diedA, diedB)) {
    reasons.push('same-death-year')
    score += 0.10
  }

  // Shared relative bonus
  if (sharedRelativePubkeys.length > 0) {
    reasons.push('shared-relative')
    score += 0.25
  }

  return {
    pubkeyA,
    pubkeyB,
    confidence: Math.min(1, score),
    reasons,
  }
}

// ─── Candidate detection ──────────────────────────────────────────────────────

/**
 * Finds all candidate same-person matches across two sets of pubkeys.
 * Returns candidates sorted by confidence descending, filtered to >= minConfidence.
 *
 * This is O(|A| × |B|) — both sets should be bounded (max a few hundred).
 */
export function findMatchCandidates(
  pubkeysA: string[],
  pubkeysB: string[],
  allClaims: FactClaim[],
  options: {
    minConfidence?: number
    sharedRelativesFn?: (a: string, b: string) => string[]
  } = {}
): MatchCandidate[] {
  const minConfidence = options.minConfidence ?? 0.35
  const sharedRelativesFn = options.sharedRelativesFn ?? (() => [])

  const candidates: MatchCandidate[] = []

  for (const a of pubkeysA) {
    for (const b of pubkeysB) {
      if (a === b) continue
      const shared = sharedRelativesFn(a, b)
      const candidate = scoreMatch(a, b, allClaims, shared)
      if (candidate.confidence >= minConfidence) {
        candidates.push(candidate)
      }
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence)
  return candidates
}

// ─── Same-person link filtering ───────────────────────────────────────────────

/**
 * Given an existing same-person link and both person lists,
 * returns true if the link connects a person from set A with one from set B.
 */
export function linkConnectsTrees(
  link: SamePersonLink,
  pubkeysA: Set<string>,
  pubkeysB: Set<string>
): boolean {
  const aInA = pubkeysA.has(link.pubkeyA)
  const aInB = pubkeysB.has(link.pubkeyA)
  const bInA = pubkeysA.has(link.pubkeyB)
  const bInB = pubkeysB.has(link.pubkeyB)
  return (aInA && bInB) || (aInB && bInA)
}

/**
 * Checks whether two nodes are already linked by an existing (non-retracted)
 * same-person link.
 */
export function alreadyLinked(
  pubkeyA: string,
  pubkeyB: string,
  links: SamePersonLink[]
): boolean {
  return links.some(
    l =>
      !l.retracted &&
      ((l.pubkeyA === pubkeyA && l.pubkeyB === pubkeyB) ||
        (l.pubkeyA === pubkeyB && l.pubkeyB === pubkeyA))
  )
}
