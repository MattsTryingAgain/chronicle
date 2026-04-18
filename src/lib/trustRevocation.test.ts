import { describe, it, expect } from 'vitest'
import {
  KIND_TRUST_REVOCATION,
  buildTrustRevocationTags,
  parseTrustRevocation,
  computeRevocationVerdict,
  TrustRevocationStore,
  type TrustRevocation,
} from './trustRevocation.js'
import { generateAncestorKeyPair, npubToHex } from './keys.js'

function makeRaw(revokedNpub: string, reason = 'not a real family member', overrides: Record<string, unknown> = {}) {
  const kp = generateAncestorKeyPair()
  return {
    kind: KIND_TRUST_REVOCATION,
    pubkey: npubToHex(kp.npub),
    tags: buildTrustRevocationTags(revokedNpub, reason),
    created_at: 1_000_000,
    id: 'rev-' + Math.random().toString(36).slice(2),
    ...overrides,
  }
}

function makeRevocation(revokedNpub: string, endorsedBy: string[] = []): TrustRevocation {
  const kp = generateAncestorKeyPair()
  return {
    revokerNpub: kp.npub,
    revokedNpub,
    reason: 'test',
    createdAt: 1_000_000,
    eventId: 'rev-' + Math.random().toString(36).slice(2),
    endorsedBy,
  }
}

const BAD_ACTOR = 'npub1' + 'b'.repeat(58)
const ENDORSER  = 'npub1' + 'c'.repeat(58)

describe('buildTrustRevocationTags', () => {
  it('includes revokes_trust, reason, v', () => {
    const tags = buildTrustRevocationTags(BAD_ACTOR, 'fraud')
    expect(tags.find(t => t[0] === 'revokes_trust')?.[1]).toBe(BAD_ACTOR)
    expect(tags.find(t => t[0] === 'reason')?.[1]).toBe('fraud')
    expect(tags.find(t => t[0] === 'v')?.[1]).toBe('1')
  })
})

describe('parseTrustRevocation', () => {
  it('parses a valid revocation', () => {
    const raw = makeRaw(BAD_ACTOR, 'impersonator')
    const rev = parseTrustRevocation(raw)
    expect(rev).not.toBeNull()
    expect(rev!.revokedNpub).toBe(BAD_ACTOR)
    expect(rev!.reason).toBe('impersonator')
    expect(rev!.endorsedBy).toHaveLength(0)
  })

  it('returns null for wrong kind', () => {
    const raw = makeRaw(BAD_ACTOR, 'test', { kind: 30078 })
    expect(parseTrustRevocation(raw)).toBeNull()
  })

  it('returns null for missing revokes_trust tag', () => {
    const raw = makeRaw(BAD_ACTOR)
    raw.tags = raw.tags.filter(t => t[0] !== 'revokes_trust')
    expect(parseTrustRevocation(raw)).toBeNull()
  })

  it('returns null for missing reason tag', () => {
    const raw = makeRaw(BAD_ACTOR)
    raw.tags = raw.tags.filter(t => t[0] !== 'reason')
    expect(parseTrustRevocation(raw)).toBeNull()
  })

  it('returns null if revoked npub does not start with npub1', () => {
    const raw = makeRaw('hex1234567890', 'bad actor')
    expect(parseTrustRevocation(raw)).toBeNull()
  })

  it('sets revokerNpub from pubkey', () => {
    const kp = generateAncestorKeyPair()
    const raw = makeRaw(BAD_ACTOR, 'test', { pubkey: npubToHex(kp.npub) })
    const rev = parseTrustRevocation(raw)
    expect(rev!.revokerNpub).toBe(kp.npub)
  })
})

describe('computeRevocationVerdict', () => {
  it('pending when no endorsements', () => {
    const rev = makeRevocation(BAD_ACTOR, [])
    expect(computeRevocationVerdict(rev)).toBe('pending')
  })

  it('effective once threshold endorsements are met', () => {
    const rev = makeRevocation(BAD_ACTOR, [ENDORSER])
    expect(computeRevocationVerdict(rev, 1)).toBe('effective')
  })

  it('still pending if below threshold', () => {
    const rev = makeRevocation(BAD_ACTOR, [ENDORSER])
    expect(computeRevocationVerdict(rev, 2)).toBe('pending')
  })
})

describe('TrustRevocationStore', () => {
  it('starts empty', () => {
    const store = new TrustRevocationStore()
    expect(store.getAll()).toHaveLength(0)
    expect(store.size()).toBe(0)
  })

  it('adds revocations', () => {
    const store = new TrustRevocationStore()
    store.add(makeRevocation(BAD_ACTOR))
    expect(store.size()).toBe(1)
  })

  it('getForPubkey filters by revokedNpub', () => {
    const store = new TrustRevocationStore()
    const other = 'npub1' + 'd'.repeat(58)
    store.add(makeRevocation(BAD_ACTOR))
    store.add(makeRevocation(other))
    expect(store.getForPubkey(BAD_ACTOR)).toHaveLength(1)
  })

  it('isRevoked returns false when no effective revocation', () => {
    const store = new TrustRevocationStore()
    store.add(makeRevocation(BAD_ACTOR, []))
    expect(store.isRevoked(BAD_ACTOR)).toBe(false)
  })

  it('isRevoked returns true when endorsed', () => {
    const store = new TrustRevocationStore()
    const rev = makeRevocation(BAD_ACTOR, [ENDORSER])
    store.add(rev)
    expect(store.isRevoked(BAD_ACTOR, 1)).toBe(true)
  })

  it('addEndorsement increases endorsedBy', () => {
    const store = new TrustRevocationStore()
    const rev = makeRevocation(BAD_ACTOR, [])
    store.add(rev)
    store.addEndorsement(rev.eventId, ENDORSER)
    expect(store.get(rev.eventId)!.endorsedBy).toContain(ENDORSER)
  })

  it('addEndorsement deduplicates', () => {
    const store = new TrustRevocationStore()
    const rev = makeRevocation(BAD_ACTOR, [])
    store.add(rev)
    store.addEndorsement(rev.eventId, ENDORSER)
    store.addEndorsement(rev.eventId, ENDORSER)
    expect(store.get(rev.eventId)!.endorsedBy).toHaveLength(1)
  })

  it('dismiss makes verdict return dismissed', () => {
    const store = new TrustRevocationStore()
    const rev = makeRevocation(BAD_ACTOR, [ENDORSER])
    store.add(rev)
    store.dismiss(rev.eventId)
    expect(store.verdict(rev.eventId)).toBe('dismissed')
    expect(store.isRevoked(BAD_ACTOR)).toBe(false)
  })

  it('verdict returns effective for endorsed non-dismissed revocation', () => {
    const store = new TrustRevocationStore()
    const rev = makeRevocation(BAD_ACTOR, [ENDORSER])
    store.add(rev)
    expect(store.verdict(rev.eventId)).toBe('effective')
  })
})
