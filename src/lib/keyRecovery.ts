/**
 * Chronicle Key Recovery — Supersession & Revocation
 *
 * Two distinct key recovery flows:
 *
 * 1. KEY LOSS — Supersession (kind 30084)
 *    User generates a new keypair and has pre-registered recovery contacts
 *    co-sign a supersession event. Threshold (default 3-of-5) must be met.
 *    Old claims remain valid and attributed; new identity goes forward.
 *
 * 2. KEY COMPROMISE — Revocation (kind 30086)
 *    Recovery contacts publish a revocation event against the compromised key.
 *    Events from the compromised key after fromTimestamp are ignored.
 *    Historical events are flagged as "from a later-compromised key."
 *    The compromised key CANNOT block its own revocation.
 *
 * Both flows require pre-registration of recovery contacts — post-hoc
 * contact choices are not valid.
 *
 * Design note: these functions build and parse the event TAGS only.
 * Actual event signing is done via eventBuilder.ts. The parser functions
 * here extract typed records from raw tag arrays for use in the UI and
 * store layer.
 */

import { EventKind } from '../types/chronicle'
import type { KeySupersession, KeyRevocation, ChronicleEvent } from '../types/chronicle'

// ─── Constants ────────────────────────────────────────────────────────────────

export const SUPERSESSION_MIN_ATTESTATIONS = 3
export const REVOCATION_MIN_ATTESTATIONS = 3

// ─── Key Supersession (kind 30084) ───────────────────────────────────────────

/**
 * Build tags for a key supersession event (kind 30084).
 * Published by the new keypair once enough recovery contacts have attested.
 *
 * @param oldNpub     The lost key's npub being superseded
 * @param newNpub     The new replacement npub
 * @param attestedBy  npubs of recovery contacts who co-sign (minimum 3)
 */
export function buildSupersessionTags(
  oldNpub: string,
  newNpub: string,
  attestedBy: string[],
): string[][] {
  if (attestedBy.length < SUPERSESSION_MIN_ATTESTATIONS) {
    throw new Error(
      `Supersession requires at least ${SUPERSESSION_MIN_ATTESTATIONS} attestations, got ${attestedBy.length}`,
    )
  }
  return [
    ['supersedes', oldNpub],
    ['new_pubkey', newNpub],
    ...attestedBy.map((npub) => ['attested_by', npub]),
  ]
}

/**
 * Parse a kind 30084 event into a KeySupersession record.
 * Returns null if required tags are missing or malformed.
 */
export function parseSupersession(event: ChronicleEvent): KeySupersession | null {
  if (event.kind !== EventKind.KEY_SUPERSESSION) return null

  const get = (key: string) => event.tags.find((t) => t[0] === key)?.[1]
  const getAll = (key: string) => event.tags.filter((t) => t[0] === key).map((t) => t[1])

  const oldNpub = get('supersedes')
  const newNpub = get('new_pubkey')
  const attestedBy = getAll('attested_by')

  if (!oldNpub || !newNpub) return null
  if (attestedBy.length < SUPERSESSION_MIN_ATTESTATIONS) return null

  return {
    oldNpub,
    newNpub,
    attestedBy,
    createdAt: event.created_at,
  }
}

/**
 * Check whether a supersession event is valid:
 * - correct kind
 * - required tags present
 * - enough attestations
 * - new pubkey is different from old
 */
export function isValidSupersession(event: ChronicleEvent): boolean {
  const parsed = parseSupersession(event)
  if (!parsed) return false
  return parsed.oldNpub !== parsed.newNpub
}

// ─── Key Revocation (kind 30086) ─────────────────────────────────────────────

/**
 * Build tags for a key revocation event (kind 30086).
 * Published by a recovery contact when a key is compromised.
 *
 * @param compromisedNpub  The compromised key's npub
 * @param fromTimestamp    Unix timestamp — events from compromised key after
 *                         this time are treated as invalid
 * @param attestedBy       npubs of co-signing recovery contacts (minimum 3)
 */
export function buildRevocationTags(
  compromisedNpub: string,
  fromTimestamp: number,
  attestedBy: string[],
): string[][] {
  if (attestedBy.length < REVOCATION_MIN_ATTESTATIONS) {
    throw new Error(
      `Revocation requires at least ${REVOCATION_MIN_ATTESTATIONS} attestations, got ${attestedBy.length}`,
    )
  }
  if (fromTimestamp <= 0) {
    throw new Error('fromTimestamp must be a positive unix timestamp')
  }
  return [
    ['revokes', compromisedNpub],
    ['from_timestamp', String(fromTimestamp)],
    ...attestedBy.map((npub) => ['attested_by', npub]),
  ]
}

/**
 * Parse a kind 30086 event into a KeyRevocation record.
 * Returns null if required tags are missing or malformed.
 */
export function parseRevocation(event: ChronicleEvent): KeyRevocation | null {
  if (event.kind !== EventKind.KEY_REVOCATION) return null

  const get = (key: string) => event.tags.find((t) => t[0] === key)?.[1]
  const getAll = (key: string) => event.tags.filter((t) => t[0] === key).map((t) => t[1])

  const compromisedNpub = get('revokes')
  const fromTimestampStr = get('from_timestamp')
  const attestedBy = getAll('attested_by')

  if (!compromisedNpub || !fromTimestampStr) return null

  const fromTimestamp = parseInt(fromTimestampStr, 10)
  if (isNaN(fromTimestamp) || fromTimestamp <= 0) return null

  if (attestedBy.length < REVOCATION_MIN_ATTESTATIONS) return null

  return {
    compromisedNpub,
    fromTimestamp,
    attestedBy,
    revokedByNpub: event.pubkey,  // hex pubkey from the event — caller converts
    createdAt: event.created_at,
  }
}

/**
 * Check whether a revocation event is valid.
 */
export function isValidRevocation(event: ChronicleEvent): boolean {
  return parseRevocation(event) !== null
}

// ─── Revocation Store ─────────────────────────────────────────────────────────

/**
 * In-memory store tracking active key supersessions and revocations.
 * Used by the relay sync layer to filter and flag events from compromised keys.
 * Will be backed by SQLite in Stage 6.
 */
export class KeyRecoveryStore {
  private supersessions: Map<string, KeySupersession> = new Map() // oldNpub → record
  private revocations: Map<string, KeyRevocation> = new Map()     // compromisedNpub → record

  // ── Supersession ────────────────────────────────────────────────────────

  addSupersession(s: KeySupersession): void {
    this.supersessions.set(s.oldNpub, s)
  }

  getSupersession(oldNpub: string): KeySupersession | undefined {
    return this.supersessions.get(oldNpub)
  }

  /**
   * Resolve the canonical current npub for a given npub,
   * following the supersession chain (handles chained supersessions).
   */
  resolveCurrentNpub(npub: string, maxDepth = 10): string {
    let current = npub
    let depth = 0
    while (depth < maxDepth) {
      const s = this.supersessions.get(current)
      if (!s) break
      current = s.newNpub
      depth++
    }
    return current
  }

  allSupersessions(): KeySupersession[] {
    return Array.from(this.supersessions.values())
  }

  // ── Revocation ──────────────────────────────────────────────────────────

  addRevocation(r: KeyRevocation): void {
    this.revocations.set(r.compromisedNpub, r)
  }

  getRevocation(compromisedNpub: string): KeyRevocation | undefined {
    return this.revocations.get(compromisedNpub)
  }

  /**
   * Returns true if an event from `pubkeyNpub` at `eventTimestamp`
   * should be treated as invalid due to a revocation.
   */
  isRevoked(pubkeyNpub: string, eventTimestamp: number): boolean {
    const r = this.revocations.get(pubkeyNpub)
    if (!r) return false
    return eventTimestamp >= r.fromTimestamp
  }

  /**
   * Returns true if the key has been revoked at all (regardless of timestamp),
   * so historical events can be flagged in the UI.
   */
  isCompromised(npub: string): boolean {
    return this.revocations.has(npub)
  }

  allRevocations(): KeyRevocation[] {
    return Array.from(this.revocations.values())
  }
}

/** App-wide singleton. */
export const keyRecoveryStore = new KeyRecoveryStore()
