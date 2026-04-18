/**
 * Tests for keyRecovery.ts — key supersession and revocation flows
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildSupersessionTags,
  parseSupersession,
  isValidSupersession,
  buildRevocationTags,
  parseRevocation,
  isValidRevocation,
  KeyRecoveryStore,
  SUPERSESSION_MIN_ATTESTATIONS,
  REVOCATION_MIN_ATTESTATIONS,
} from './keyRecovery'
import { generateUserKeyMaterial, signEvent, npubToHex } from './keys'
import { EventKind } from '../types/chronicle'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OLD_NPUB = 'npub1old0000000000000000000000000000000000000000000000000000000000'
const NEW_NPUB = 'npub1new0000000000000000000000000000000000000000000000000000000000'
const ATTESTORS = [
  'npub1att1000000000000000000000000000000000000000000000000000000001',
  'npub1att2000000000000000000000000000000000000000000000000000000002',
  'npub1att3000000000000000000000000000000000000000000000000000000003',
]
const NOW = Math.floor(Date.now() / 1000)

function makeEvent(
  kind: number,
  tags: string[][],
  km = generateUserKeyMaterial(),
): ChronicleEvent {
  const unsigned = {
    kind,
    pubkey: npubToHex(km.npub),
    created_at: NOW,
    tags: [...tags, ['v', '1']],
    content: '',
  }
  return signEvent(unsigned, km.nsec) as unknown as ChronicleEvent
}

// ─── buildSupersessionTags ────────────────────────────────────────────────────

describe('buildSupersessionTags', () => {
  it('builds correct tags', () => {
    const tags = buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS)
    expect(tags.find((t) => t[0] === 'supersedes')?.[1]).toBe(OLD_NPUB)
    expect(tags.find((t) => t[0] === 'new_pubkey')?.[1]).toBe(NEW_NPUB)
    const attested = tags.filter((t) => t[0] === 'attested_by').map((t) => t[1])
    expect(attested).toEqual(ATTESTORS)
  })

  it('throws with fewer than minimum attestations', () => {
    expect(() => buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS.slice(0, 2))).toThrow()
  })

  it(`requires exactly ${SUPERSESSION_MIN_ATTESTATIONS} minimum`, () => {
    expect(SUPERSESSION_MIN_ATTESTATIONS).toBe(3)
    // Exactly 3 should not throw
    expect(() => buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS)).not.toThrow()
  })

  it('allows more than 3 attestors', () => {
    const five = [...ATTESTORS, 'npub1att4', 'npub1att5']
    const tags = buildSupersessionTags(OLD_NPUB, NEW_NPUB, five)
    expect(tags.filter((t) => t[0] === 'attested_by')).toHaveLength(5)
  })
})

// ─── parseSupersession ────────────────────────────────────────────────────────

describe('parseSupersession', () => {
  it('parses a valid supersession event', () => {
    const tags = buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS)
    const event = makeEvent(EventKind.KEY_SUPERSESSION, tags)
    const parsed = parseSupersession(event)
    expect(parsed).not.toBeNull()
    expect(parsed!.oldNpub).toBe(OLD_NPUB)
    expect(parsed!.newNpub).toBe(NEW_NPUB)
    expect(parsed!.attestedBy).toEqual(ATTESTORS)
  })

  it('returns null for wrong kind', () => {
    const tags = buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS)
    const event = makeEvent(EventKind.FACT_CLAIM, tags)
    expect(parseSupersession(event)).toBeNull()
  })

  it('returns null if supersedes tag missing', () => {
    const tags = buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS).filter(
      (t) => t[0] !== 'supersedes',
    )
    const event = makeEvent(EventKind.KEY_SUPERSESSION, tags)
    expect(parseSupersession(event)).toBeNull()
  })

  it('returns null if new_pubkey tag missing', () => {
    const tags = buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS).filter(
      (t) => t[0] !== 'new_pubkey',
    )
    const event = makeEvent(EventKind.KEY_SUPERSESSION, tags)
    expect(parseSupersession(event)).toBeNull()
  })

  it('returns null if fewer than 3 attestations', () => {
    const tags = [
      ['supersedes', OLD_NPUB],
      ['new_pubkey', NEW_NPUB],
      ['attested_by', ATTESTORS[0]],
      ['attested_by', ATTESTORS[1]],
    ]
    const event = makeEvent(EventKind.KEY_SUPERSESSION, tags)
    expect(parseSupersession(event)).toBeNull()
  })
})

// ─── isValidSupersession ─────────────────────────────────────────────────────

describe('isValidSupersession', () => {
  it('returns true for a valid supersession', () => {
    const tags = buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS)
    const event = makeEvent(EventKind.KEY_SUPERSESSION, tags)
    expect(isValidSupersession(event)).toBe(true)
  })

  it('returns false if old and new npub are the same', () => {
    const tags = buildSupersessionTags(OLD_NPUB, OLD_NPUB, ATTESTORS)
    const event = makeEvent(EventKind.KEY_SUPERSESSION, tags)
    expect(isValidSupersession(event)).toBe(false)
  })

  it('returns false for wrong kind', () => {
    const tags = buildSupersessionTags(OLD_NPUB, NEW_NPUB, ATTESTORS)
    const event = makeEvent(EventKind.CLAIM_RETRACTION, tags)
    expect(isValidSupersession(event)).toBe(false)
  })
})

// ─── buildRevocationTags ─────────────────────────────────────────────────────

describe('buildRevocationTags', () => {
  it('builds correct tags', () => {
    const tags = buildRevocationTags(OLD_NPUB, NOW, ATTESTORS)
    expect(tags.find((t) => t[0] === 'revokes')?.[1]).toBe(OLD_NPUB)
    expect(tags.find((t) => t[0] === 'from_timestamp')?.[1]).toBe(String(NOW))
    const attested = tags.filter((t) => t[0] === 'attested_by').map((t) => t[1])
    expect(attested).toEqual(ATTESTORS)
  })

  it('throws with fewer than minimum attestations', () => {
    expect(() => buildRevocationTags(OLD_NPUB, NOW, ATTESTORS.slice(0, 1))).toThrow()
  })

  it('throws with invalid timestamp', () => {
    expect(() => buildRevocationTags(OLD_NPUB, 0, ATTESTORS)).toThrow()
    expect(() => buildRevocationTags(OLD_NPUB, -1, ATTESTORS)).toThrow()
  })

  it(`requires exactly ${REVOCATION_MIN_ATTESTATIONS} minimum`, () => {
    expect(REVOCATION_MIN_ATTESTATIONS).toBe(3)
  })
})

// ─── parseRevocation ─────────────────────────────────────────────────────────

describe('parseRevocation', () => {
  it('parses a valid revocation event', () => {
    const tags = buildRevocationTags(OLD_NPUB, NOW, ATTESTORS)
    const event = makeEvent(EventKind.KEY_REVOCATION, tags)
    const parsed = parseRevocation(event)
    expect(parsed).not.toBeNull()
    expect(parsed!.compromisedNpub).toBe(OLD_NPUB)
    expect(parsed!.fromTimestamp).toBe(NOW)
    expect(parsed!.attestedBy).toEqual(ATTESTORS)
  })

  it('returns null for wrong kind', () => {
    const tags = buildRevocationTags(OLD_NPUB, NOW, ATTESTORS)
    const event = makeEvent(EventKind.TRUST_REVOCATION, tags)
    expect(parseRevocation(event)).toBeNull()
  })

  it('returns null if revokes tag missing', () => {
    const tags = buildRevocationTags(OLD_NPUB, NOW, ATTESTORS).filter(
      (t) => t[0] !== 'revokes',
    )
    const event = makeEvent(EventKind.KEY_REVOCATION, tags)
    expect(parseRevocation(event)).toBeNull()
  })

  it('returns null if from_timestamp is invalid', () => {
    const tags = buildRevocationTags(OLD_NPUB, NOW, ATTESTORS).map((t) =>
      t[0] === 'from_timestamp' ? ['from_timestamp', 'not-a-number'] : t,
    )
    const event = makeEvent(EventKind.KEY_REVOCATION, tags)
    expect(parseRevocation(event)).toBeNull()
  })

  it('returns null with insufficient attestations', () => {
    const tags = [
      ['revokes', OLD_NPUB],
      ['from_timestamp', String(NOW)],
      ['attested_by', ATTESTORS[0]],
    ]
    const event = makeEvent(EventKind.KEY_REVOCATION, tags)
    expect(parseRevocation(event)).toBeNull()
  })
})

// ─── isValidRevocation ───────────────────────────────────────────────────────

describe('isValidRevocation', () => {
  it('returns true for valid revocation', () => {
    const tags = buildRevocationTags(OLD_NPUB, NOW, ATTESTORS)
    const event = makeEvent(EventKind.KEY_REVOCATION, tags)
    expect(isValidRevocation(event)).toBe(true)
  })

  it('returns false for wrong kind', () => {
    const tags = buildRevocationTags(OLD_NPUB, NOW, ATTESTORS)
    const event = makeEvent(EventKind.FACT_CLAIM, tags)
    expect(isValidRevocation(event)).toBe(false)
  })
})

// ─── KeyRecoveryStore ─────────────────────────────────────────────────────────

describe('KeyRecoveryStore', () => {
  let store: KeyRecoveryStore

  beforeEach(() => {
    store = new KeyRecoveryStore()
  })

  // supersession
  it('stores and retrieves a supersession', () => {
    store.addSupersession({ oldNpub: OLD_NPUB, newNpub: NEW_NPUB, attestedBy: ATTESTORS, createdAt: NOW })
    expect(store.getSupersession(OLD_NPUB)?.newNpub).toBe(NEW_NPUB)
  })

  it('resolveCurrentNpub returns same npub if no supersession', () => {
    expect(store.resolveCurrentNpub('npub1unknown')).toBe('npub1unknown')
  })

  it('resolveCurrentNpub follows a single supersession', () => {
    store.addSupersession({ oldNpub: OLD_NPUB, newNpub: NEW_NPUB, attestedBy: ATTESTORS, createdAt: NOW })
    expect(store.resolveCurrentNpub(OLD_NPUB)).toBe(NEW_NPUB)
  })

  it('resolveCurrentNpub follows chained supersessions', () => {
    const NEWER = 'npub1newer000'
    store.addSupersession({ oldNpub: OLD_NPUB, newNpub: NEW_NPUB, attestedBy: ATTESTORS, createdAt: NOW })
    store.addSupersession({ oldNpub: NEW_NPUB, newNpub: NEWER, attestedBy: ATTESTORS, createdAt: NOW + 1 })
    expect(store.resolveCurrentNpub(OLD_NPUB)).toBe(NEWER)
  })

  it('allSupersessions returns all entries', () => {
    store.addSupersession({ oldNpub: OLD_NPUB, newNpub: NEW_NPUB, attestedBy: ATTESTORS, createdAt: NOW })
    expect(store.allSupersessions()).toHaveLength(1)
  })

  // revocation
  it('stores and retrieves a revocation', () => {
    store.addRevocation({
      compromisedNpub: OLD_NPUB,
      fromTimestamp: NOW,
      attestedBy: ATTESTORS,
      revokedByNpub: ATTESTORS[0],
      createdAt: NOW,
    })
    expect(store.getRevocation(OLD_NPUB)).toBeDefined()
  })

  it('isRevoked returns true for events after fromTimestamp', () => {
    store.addRevocation({
      compromisedNpub: OLD_NPUB,
      fromTimestamp: NOW,
      attestedBy: ATTESTORS,
      revokedByNpub: ATTESTORS[0],
      createdAt: NOW,
    })
    expect(store.isRevoked(OLD_NPUB, NOW + 1)).toBe(true)
    expect(store.isRevoked(OLD_NPUB, NOW)).toBe(true)
  })

  it('isRevoked returns false for events before fromTimestamp', () => {
    store.addRevocation({
      compromisedNpub: OLD_NPUB,
      fromTimestamp: NOW,
      attestedBy: ATTESTORS,
      revokedByNpub: ATTESTORS[0],
      createdAt: NOW,
    })
    expect(store.isRevoked(OLD_NPUB, NOW - 1)).toBe(false)
  })

  it('isRevoked returns false for non-compromised key', () => {
    expect(store.isRevoked('npub1clean', NOW)).toBe(false)
  })

  it('isCompromised returns true for any revoked key', () => {
    store.addRevocation({
      compromisedNpub: OLD_NPUB,
      fromTimestamp: NOW,
      attestedBy: ATTESTORS,
      revokedByNpub: ATTESTORS[0],
      createdAt: NOW,
    })
    expect(store.isCompromised(OLD_NPUB)).toBe(true)
    expect(store.isCompromised(NEW_NPUB)).toBe(false)
  })

  it('allRevocations returns all entries', () => {
    store.addRevocation({
      compromisedNpub: OLD_NPUB,
      fromTimestamp: NOW,
      attestedBy: ATTESTORS,
      revokedByNpub: ATTESTORS[0],
      createdAt: NOW,
    })
    expect(store.allRevocations()).toHaveLength(1)
  })
})
