/**
 * Tests for Chronicle event builder
 *
 * Each test verifies:
 * - Correct kind number
 * - Required tags present
 * - Schema version tag present
 * - Event signature is valid
 * - Kind 0 is never used
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  buildIdentityAnchor,
  buildFactClaim,
  buildEndorsement,
  buildSamePersonLink,
  buildRelationshipClaim,
  buildAcknowledgement,
  buildKeySupersession,
  buildDiscoveryEvent,
  buildKeyRevocation,
  buildContentDispute,
  buildTrustRevocation,
  buildClaimRetraction,
  buildPrivateContactList,
  getTag,
  getTags,
} from './eventBuilder'
import { generateUserKeyMaterial } from './keys'
import { verifyEventSignature } from './keys'
import { EventKind, SCHEMA_VERSION } from '../types/chronicle'
import type { ChronicleEvent } from '../types/chronicle'

// ─── Test fixtures ────────────────────────────────────────────────────────────

let alice: { npub: string; nsec: string }
let bob: { npub: string; nsec: string }
let ancestor: { npub: string; nsec: string }

beforeAll(() => {
  const akm = generateUserKeyMaterial()
  alice = { npub: akm.npub, nsec: akm.nsec }
  const bkm = generateUserKeyMaterial()
  bob = { npub: bkm.npub, nsec: bkm.nsec }
  const ckm = generateUserKeyMaterial()
  ancestor = { npub: ckm.npub, nsec: ckm.nsec }
})

// ─── Shared assertions ────────────────────────────────────────────────────────

function assertBaseEvent(event: ChronicleEvent, expectedKind: number) {
  expect(event.kind).toBe(expectedKind)
  expect(event.id).toBeTruthy()
  expect(event.sig).toBeTruthy()
  expect(event.pubkey).toBeTruthy()
  expect(event.created_at).toBeGreaterThan(0)
  // Schema version tag always present
  const vTag = event.tags.find(t => t[0] === 'v')
  expect(vTag).toBeDefined()
  expect(vTag![1]).toBe(SCHEMA_VERSION)
  // Kind 0 never used
  expect(event.kind).not.toBe(0)
  // Signature valid
  expect(verifyEventSignature(event as never)).toBe(true)
}

// ─── Identity anchor ──────────────────────────────────────────────────────────

describe('buildIdentityAnchor', () => {
  it('produces a valid kind 30078 event', () => {
    const event = buildIdentityAnchor(ancestor.npub, alice.npub, alice.nsec)
    assertBaseEvent(event, EventKind.IDENTITY_ANCHOR)
    expect(getTag(event, 'claimed_by')).toBe(alice.npub)
  })
})

// ─── Fact claim ───────────────────────────────────────────────────────────────

describe('buildFactClaim', () => {
  it('produces a valid kind 30081 event', () => {
    const event = buildFactClaim({
      claimantNpub: alice.npub,
      claimantNsec: alice.nsec,
      subjectNpub: ancestor.npub,
      field: 'born',
      value: '1930',
    })
    assertBaseEvent(event, EventKind.FACT_CLAIM)
    expect(getTag(event, 'subject')).toBe(ancestor.npub)
    expect(getTag(event, 'field')).toBe('born')
    expect(getTag(event, 'value')).toBe('1930')
  })

  it('includes evidence tag when provided', () => {
    const event = buildFactClaim({
      claimantNpub: alice.npub,
      claimantNsec: alice.nsec,
      subjectNpub: ancestor.npub,
      field: 'born',
      value: '1930',
      evidence: 'family bible',
    })
    expect(getTag(event, 'evidence')).toBe('family bible')
  })

  it('includes tier tag for non-public tiers', () => {
    const event = buildFactClaim({
      claimantNpub: alice.npub,
      claimantNsec: alice.nsec,
      subjectNpub: ancestor.npub,
      field: 'bio',
      value: 'private notes',
      tier: 'family',
    })
    expect(getTag(event, 'tier')).toBe('family')
  })

  it('omits tier tag for public tier', () => {
    const event = buildFactClaim({
      claimantNpub: alice.npub,
      claimantNsec: alice.nsec,
      subjectNpub: ancestor.npub,
      field: 'born',
      value: '1930',
      tier: 'public',
    })
    expect(getTag(event, 'tier')).toBeUndefined()
  })

  it('all valid FactFields produce signed events', () => {
    const fields = ['name', 'born', 'died', 'birthplace', 'deathplace', 'occupation', 'bio'] as const
    for (const field of fields) {
      const event = buildFactClaim({
        claimantNpub: alice.npub,
        claimantNsec: alice.nsec,
        subjectNpub: ancestor.npub,
        field,
        value: 'test',
      })
      expect(verifyEventSignature(event as never)).toBe(true)
    }
  })
})

// ─── Endorsement ─────────────────────────────────────────────────────────────

describe('buildEndorsement', () => {
  it('produces a valid kind 30082 event', () => {
    const event = buildEndorsement({
      endorserNpub: bob.npub,
      endorserNsec: bob.nsec,
      claimEventId: 'abc123',
      agree: true,
      proximity: 'grandchild',
    })
    assertBaseEvent(event, EventKind.ENDORSEMENT)
    expect(getTag(event, 'claim_event')).toBe('abc123')
    expect(getTag(event, 'agree')).toBe('true')
    expect(getTag(event, 'proximity')).toBe('grandchild')
  })

  it('sets agree to false when disagreeing', () => {
    const event = buildEndorsement({
      endorserNpub: bob.npub,
      endorserNsec: bob.nsec,
      claimEventId: 'abc123',
      agree: false,
      proximity: 'other',
    })
    expect(getTag(event, 'agree')).toBe('false')
  })
})

// ─── Same-person link ─────────────────────────────────────────────────────────

describe('buildSamePersonLink', () => {
  it('produces a valid kind 30083 event', () => {
    const event = buildSamePersonLink(alice.npub, alice.nsec, ancestor.npub, bob.npub)
    assertBaseEvent(event, EventKind.SAME_PERSON_LINK)
    expect(getTag(event, 'subject_a')).toBe(ancestor.npub)
    expect(getTag(event, 'subject_b')).toBe(bob.npub)
  })
})

// ─── Relationship claim ───────────────────────────────────────────────────────

describe('buildRelationshipClaim', () => {
  it('produces a valid kind 30079 event', () => {
    const event = buildRelationshipClaim({
      claimantNpub: alice.npub,
      claimantNsec: alice.nsec,
      subjectNpub: ancestor.npub,
      relationship: 'grandchild',
      relayUrl: 'wss://relay.example',
    })
    assertBaseEvent(event, EventKind.RELATIONSHIP_CLAIM)
    expect(getTag(event, 'subject')).toBe(ancestor.npub)
    expect(getTag(event, 'relationship')).toBe('grandchild')
    expect(getTag(event, 'relay')).toBe('wss://relay.example')
    expect(getTag(event, 'sensitive')).toBe('false')
  })

  it('includes sensitive subtype when sensitive=true', () => {
    const event = buildRelationshipClaim({
      claimantNpub: alice.npub,
      claimantNsec: alice.nsec,
      subjectNpub: ancestor.npub,
      relationship: 'child',
      sensitive: true,
      sensitiveSubtype: 'adopted',
    })
    expect(getTag(event, 'sensitive')).toBe('true')
    expect(getTag(event, 'sensitive_subtype')).toBe('adopted')
  })
})

// ─── Acknowledgement ──────────────────────────────────────────────────────────

describe('buildAcknowledgement', () => {
  it('produces a valid kind 30080 event', () => {
    const event = buildAcknowledgement(ancestor.npub, ancestor.nsec, 'claim123', true)
    assertBaseEvent(event, EventKind.ACKNOWLEDGEMENT)
    expect(getTag(event, 'claim_event')).toBe('claim123')
    expect(getTag(event, 'approved')).toBe('true')
  })
})

// ─── Key supersession ─────────────────────────────────────────────────────────

describe('buildKeySupersession', () => {
  it('produces a valid kind 30084 event with attestors', () => {
    const newKm = generateUserKeyMaterial()
    const event = buildKeySupersession(
      newKm.npub, newKm.nsec,
      alice.npub,
      [bob.npub, ancestor.npub],
    )
    assertBaseEvent(event, EventKind.KEY_SUPERSESSION)
    expect(getTag(event, 'supersedes')).toBe(alice.npub)
    const attestors = getTags(event, 'attested_by')
    expect(attestors).toHaveLength(2)
    expect(attestors).toContain(bob.npub)
  })
})

// ─── Discovery event ──────────────────────────────────────────────────────────

describe('buildDiscoveryEvent', () => {
  it('produces a valid kind 30085 event', () => {
    const event = buildDiscoveryEvent(alice.npub, alice.nsec, 'OBrien', 'wss://relay.example')
    assertBaseEvent(event, EventKind.DISCOVERY)
    expect(getTag(event, 'name_fragment')).toBe('OBrien')
    expect(getTag(event, 'relay')).toBe('wss://relay.example')
  })
})

// ─── Key revocation ───────────────────────────────────────────────────────────

describe('buildKeyRevocation', () => {
  it('produces a valid kind 30086 event', () => {
    const ts = Math.floor(Date.now() / 1000)
    const event = buildKeyRevocation(bob.npub, bob.nsec, alice.npub, ts, [bob.npub])
    assertBaseEvent(event, EventKind.KEY_REVOCATION)
    expect(getTag(event, 'revokes')).toBe(alice.npub)
    expect(getTag(event, 'from_timestamp')).toBe(String(ts))
    expect(getTags(event, 'attested_by')).toContain(bob.npub)
  })
})

// ─── Content dispute ──────────────────────────────────────────────────────────

describe('buildContentDispute', () => {
  it('produces a valid kind 30087 event', () => {
    const event = buildContentDispute(alice.npub, alice.nsec, 'evtXYZ', 'incorrect information')
    assertBaseEvent(event, EventKind.CONTENT_DISPUTE)
    expect(getTag(event, 'disputed_event')).toBe('evtXYZ')
    expect(getTag(event, 'reason')).toBe('incorrect information')
  })
})

// ─── Trust revocation ─────────────────────────────────────────────────────────

describe('buildTrustRevocation', () => {
  it('produces a valid kind 30088 event', () => {
    const event = buildTrustRevocation(alice.npub, alice.nsec, bob.npub, 'not a family member')
    assertBaseEvent(event, EventKind.TRUST_REVOCATION)
    expect(getTag(event, 'revokes_trust')).toBe(bob.npub)
    expect(getTag(event, 'reason')).toBe('not a family member')
  })
})

// ─── Claim retraction ─────────────────────────────────────────────────────────

describe('buildClaimRetraction', () => {
  it('produces a valid kind 30089 event', () => {
    const event = buildClaimRetraction(alice.npub, alice.nsec, 'originalEvt123')
    assertBaseEvent(event, EventKind.CLAIM_RETRACTION)
    expect(getTag(event, 'retracts')).toBe('originalEvt123')
  })
})

// ─── Private contact list ─────────────────────────────────────────────────────

describe('buildPrivateContactList', () => {
  it('produces a valid kind 30090 event with encrypted content', () => {
    const event = buildPrivateContactList(alice.npub, alice.nsec, 'encrypted-blob-here')
    assertBaseEvent(event, EventKind.PRIVATE_CONTACT_LIST)
    expect(event.content).toBe('encrypted-blob-here')
  })
})

// ─── Tag helpers ──────────────────────────────────────────────────────────────

describe('getTag / getTags', () => {
  it('getTag returns undefined for missing tag', () => {
    const event = buildContentDispute(alice.npub, alice.nsec, 'x', 'y')
    expect(getTag(event, 'nonexistent')).toBeUndefined()
  })

  it('getTags returns all instances of a repeated tag', () => {
    const event = buildKeySupersession(alice.npub, alice.nsec, bob.npub, [bob.npub, ancestor.npub])
    expect(getTags(event, 'attested_by')).toHaveLength(2)
  })

  it('getTags returns empty array when tag absent', () => {
    const event = buildFactClaim({
      claimantNpub: alice.npub,
      claimantNsec: alice.nsec,
      subjectNpub: ancestor.npub,
      field: 'born',
      value: '1930',
    })
    expect(getTags(event, 'attested_by')).toEqual([])
  })
})
