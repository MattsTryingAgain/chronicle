/**
 * trustRevocation.ts
 *
 * Trust revocation (kind 30088) — bad actor reporting.
 *
 * Any connected member can publish a revocation event against a pubkey.
 * The revocation is subject to endorsement — it is not unilaterally applied.
 * Revoked events are flagged in the UI, not deleted.
 *
 * Revocation events themselves require at least one supporting endorsement
 * before clients treat them as effective — prevents unilateral bad-faith revocations.
 */

import { hexToNpub } from './keys.js'

export const KIND_TRUST_REVOCATION = 30088

export interface TrustRevocation {
  /** npub of the person publishing the revocation */
  revokerNpub: string
  /** npub of the person being revoked */
  revokedNpub: string
  reason: string
  createdAt: number
  eventId: string
  /** npubs of peers who have endorsed this revocation */
  endorsedBy: string[]
}

export type RevocationVerdict = 'effective' | 'pending' | 'dismissed'

// ---------------------------------------------------------------------------
// Tag builders
// ---------------------------------------------------------------------------

export function buildTrustRevocationTags(
  revokedNpub: string,
  reason: string,
): string[][] {
  return [
    ['revokes_trust', revokedNpub],
    ['reason', reason],
    ['v', '1'],
  ]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseTrustRevocation(raw: {
  kind: number
  pubkey: string
  tags: string[][]
  created_at: number
  id: string
}): TrustRevocation | null {
  if (raw.kind !== KIND_TRUST_REVOCATION) return null
  const revokedTag = raw.tags.find(t => t[0] === 'revokes_trust')
  const reasonTag  = raw.tags.find(t => t[0] === 'reason')
  if (!revokedTag || !reasonTag) return null
  if (!revokedTag[1].startsWith('npub1')) return null
  return {
    revokerNpub: hexToNpub(raw.pubkey),
    revokedNpub: revokedTag[1],
    reason: reasonTag[1],
    createdAt: raw.created_at,
    eventId: raw.id,
    endorsedBy: [],
  }
}

// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a revocation is effective.
 * Requires at least one endorsing peer (not just the revoker's own assertion).
 * Returns 'effective' once threshold is met, 'pending' otherwise.
 * 'dismissed' is set explicitly by the store when users reject a revocation.
 */
export function computeRevocationVerdict(
  revocation: TrustRevocation,
  endorsementThreshold = 1,
): RevocationVerdict {
  return revocation.endorsedBy.length >= endorsementThreshold ? 'effective' : 'pending'
}

// ---------------------------------------------------------------------------
// In-memory revocation store
// ---------------------------------------------------------------------------

export class TrustRevocationStore {
  private revocations: Map<string, TrustRevocation> = new Map()
  /** Explicitly dismissed revocations (user chose to ignore) */
  private dismissed: Set<string> = new Set()

  add(rev: TrustRevocation): void {
    this.revocations.set(rev.eventId, rev)
  }

  addEndorsement(revocationEventId: string, endorserNpub: string): void {
    const rev = this.revocations.get(revocationEventId)
    if (rev && !rev.endorsedBy.includes(endorserNpub)) {
      rev.endorsedBy.push(endorserNpub)
    }
  }

  dismiss(revocationEventId: string): void {
    this.dismissed.add(revocationEventId)
  }

  getAll(): TrustRevocation[] {
    return Array.from(this.revocations.values())
  }

  get(eventId: string): TrustRevocation | undefined {
    return this.revocations.get(eventId)
  }

  /** Get all revocations targeting a given npub */
  getForPubkey(revokedNpub: string): TrustRevocation[] {
    return this.getAll().filter(r => r.revokedNpub === revokedNpub)
  }

  /** Is a given npub effectively revoked? */
  isRevoked(revokedNpub: string, threshold = 1): boolean {
    return this.getForPubkey(revokedNpub).some(r =>
      !this.dismissed.has(r.eventId) &&
      computeRevocationVerdict(r, threshold) === 'effective'
    )
  }

  /** Verdict for a specific revocation event */
  verdict(eventId: string, threshold = 1): RevocationVerdict {
    if (this.dismissed.has(eventId)) return 'dismissed'
    const rev = this.revocations.get(eventId)
    if (!rev) return 'dismissed'
    return computeRevocationVerdict(rev, threshold)
  }

  size(): number {
    return this.revocations.size
  }
}
