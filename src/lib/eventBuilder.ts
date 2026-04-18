/**
 * Chronicle Event Builder
 *
 * Constructs and signs Nostr events for all custom Chronicle event kinds
 * (30078–30090). This is the canonical factory for all events that leave the
 * local store. Every event is signed with the claimant's nsec before use.
 *
 * Rules enforced here:
 * - Kind 0 is never touched
 * - Schema version tag ["v","1"] is always present
 * - All pubkeys are in npub1 bech32 format in tags; hex is used only for
 *   nostr-tools internals and converted back immediately
 */

import { signEvent, npubToHex } from './keys'
import { EventKind, SCHEMA_VERSION } from '../types/chronicle'
import type {
  ChronicleEvent,
  FactField,
  ProximityLevel,
  RelationshipType,
  SensitiveRelationshipSubtype,
  PrivacyTier,
} from '../types/chronicle'
import type { UnsignedEvent } from 'nostr-tools'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function now(): number {
  return Math.floor(Date.now() / 1000)
}

function vTag(): string[] {
  return ['v', SCHEMA_VERSION]
}

function build(
  kind: number,
  pubkeyNpub: string,
  tags: string[][],
  content = '',
): UnsignedEvent {
  return {
    kind,
    pubkey: npubToHex(pubkeyNpub),
    created_at: now(),
    tags: [...tags, vTag()],
    content,
  }
}

/** Sign an UnsignedEvent and return a ChronicleEvent (same shape, just typed). */
function sign(unsigned: UnsignedEvent, nsec: string): ChronicleEvent {
  const signed = signEvent(unsigned, nsec)
  return signed as unknown as ChronicleEvent
}

// ─── Identity anchor (kind 30078) ────────────────────────────────────────────

/**
 * Published once per person to establish their identity on the network.
 * Signed by the living descendant who is claiming / adding this person.
 */
export function buildIdentityAnchor(
  personNpub: string,
  claimedByNpub: string,
  claimedByNsec: string,
): ChronicleEvent {
  const unsigned = build(EventKind.IDENTITY_ANCHOR, personNpub, [
    ['claimed_by', claimedByNpub],
  ])
  // Identity anchor is signed by the person's own key in theory;
  // for ancestors whose key is held by the claimant, the claimant signs it.
  // We use the claimant's key for signing in Stage 2.
  return sign({ ...unsigned, pubkey: npubToHex(claimedByNpub) }, claimedByNsec)
}

// ─── Fact claim (kind 30081) ──────────────────────────────────────────────────

export interface FactClaimParams {
  claimantNpub: string
  claimantNsec: string
  subjectNpub: string
  field: FactField
  value: string
  evidence?: string
  tier?: PrivacyTier
}

export function buildFactClaim(params: FactClaimParams): ChronicleEvent {
  const tags: string[][] = [
    ['subject', params.subjectNpub],
    ['field', params.field],
    ['value', params.value],
  ]
  if (params.evidence) tags.push(['evidence', params.evidence])
  if (params.tier && params.tier !== 'public') tags.push(['tier', params.tier])

  const unsigned = build(EventKind.FACT_CLAIM, params.claimantNpub, tags)
  return sign(unsigned, params.claimantNsec)
}

// ─── Endorsement (kind 30082) ─────────────────────────────────────────────────

export interface EndorsementParams {
  endorserNpub: string
  endorserNsec: string
  claimEventId: string
  agree: boolean
  proximity: ProximityLevel
}

export function buildEndorsement(params: EndorsementParams): ChronicleEvent {
  const unsigned = build(EventKind.ENDORSEMENT, params.endorserNpub, [
    ['claim_event', params.claimEventId],
    ['agree', params.agree ? 'true' : 'false'],
    ['proximity', params.proximity],
  ])
  return sign(unsigned, params.endorserNsec)
}

// ─── Same-person link (kind 30083) ────────────────────────────────────────────

export function buildSamePersonLink(
  claimantNpub: string,
  claimantNsec: string,
  pubkeyA: string,
  pubkeyB: string,
): ChronicleEvent {
  const unsigned = build(EventKind.SAME_PERSON_LINK, claimantNpub, [
    ['subject_a', pubkeyA],
    ['subject_b', pubkeyB],
  ])
  return sign(unsigned, claimantNsec)
}

// ─── Relationship claim (kind 30079) ─────────────────────────────────────────

export interface RelationshipClaimParams {
  claimantNpub: string
  claimantNsec: string
  subjectNpub: string
  relationship: RelationshipType
  relayUrl?: string
  sensitive?: boolean
  sensitiveSubtype?: SensitiveRelationshipSubtype
  tier?: PrivacyTier
}

export function buildRelationshipClaim(params: RelationshipClaimParams): ChronicleEvent {
  const tags: string[][] = [
    ['subject', params.subjectNpub],
    ['relationship', params.relationship],
    ['sensitive', params.sensitive ? 'true' : 'false'],
  ]
  if (params.relayUrl) tags.push(['relay', params.relayUrl])
  if (params.sensitive && params.sensitiveSubtype) {
    tags.push(['sensitive_subtype', params.sensitiveSubtype])
  }
  if (params.tier && params.tier !== 'public') tags.push(['tier', params.tier])

  const unsigned = build(EventKind.RELATIONSHIP_CLAIM, params.claimantNpub, tags)
  return sign(unsigned, params.claimantNsec)
}

// ─── Acknowledgement (kind 30080) ─────────────────────────────────────────────

export function buildAcknowledgement(
  ancestorNpub: string,
  ancestorNsec: string,
  claimEventId: string,
  approved: boolean,
): ChronicleEvent {
  const unsigned = build(EventKind.ACKNOWLEDGEMENT, ancestorNpub, [
    ['claim_event', claimEventId],
    ['approved', approved ? 'true' : 'false'],
  ])
  return sign(unsigned, ancestorNsec)
}

// ─── Key supersession (kind 30084) ────────────────────────────────────────────

export function buildKeySupersession(
  newNpub: string,
  newNsec: string,
  oldNpub: string,
  attestorNpubs: string[],
): ChronicleEvent {
  const tags: string[][] = [['supersedes', oldNpub]]
  for (const pub of attestorNpubs) {
    tags.push(['attested_by', pub])
  }
  const unsigned = build(EventKind.KEY_SUPERSESSION, newNpub, tags)
  return sign(unsigned, newNsec)
}

// ─── Discovery event (kind 30085) ────────────────────────────────────────────

export function buildDiscoveryEvent(
  userNpub: string,
  userNsec: string,
  nameFragment: string,
  relayUrl: string,
): ChronicleEvent {
  const unsigned = build(EventKind.DISCOVERY, userNpub, [
    ['name_fragment', nameFragment],
    ['relay', relayUrl],
  ])
  return sign(unsigned, userNsec)
}

// ─── Key revocation (kind 30086) ─────────────────────────────────────────────

export function buildKeyRevocation(
  recoveryContactNpub: string,
  recoveryContactNsec: string,
  compromisedNpub: string,
  fromTimestamp: number,
  attestorNpubs: string[],
): ChronicleEvent {
  const tags: string[][] = [
    ['revokes', compromisedNpub],
    ['from_timestamp', String(fromTimestamp)],
  ]
  for (const pub of attestorNpubs) {
    tags.push(['attested_by', pub])
  }
  const unsigned = build(EventKind.KEY_REVOCATION, recoveryContactNpub, tags)
  return sign(unsigned, recoveryContactNsec)
}

// ─── Content dispute (kind 30087) ────────────────────────────────────────────

export function buildContentDispute(
  disputingNpub: string,
  disputingNsec: string,
  disputedEventId: string,
  reason: string,
): ChronicleEvent {
  const unsigned = build(EventKind.CONTENT_DISPUTE, disputingNpub, [
    ['disputed_event', disputedEventId],
    ['reason', reason],
  ])
  return sign(unsigned, disputingNsec)
}

// ─── Trust revocation (kind 30088) ───────────────────────────────────────────

export function buildTrustRevocation(
  revokingNpub: string,
  revokingNsec: string,
  badActorNpub: string,
  reason: string,
): ChronicleEvent {
  const unsigned = build(EventKind.TRUST_REVOCATION, revokingNpub, [
    ['revokes_trust', badActorNpub],
    ['reason', reason],
  ])
  return sign(unsigned, revokingNsec)
}

// ─── Claim retraction (kind 30089) ───────────────────────────────────────────

export function buildClaimRetraction(
  claimantNpub: string,
  claimantNsec: string,
  originalClaimEventId: string,
): ChronicleEvent {
  const unsigned = build(EventKind.CLAIM_RETRACTION, claimantNpub, [
    ['retracts', originalClaimEventId],
  ])
  return sign(unsigned, claimantNsec)
}

// ─── Private contact list (kind 30090) ────────────────────────────────────────

/**
 * Encrypts the contact list JSON and wraps it in a signed event.
 * The content is NaCl-secretbox encrypted to the user's own key — only they
 * can decrypt it. Never published to public relays.
 */
export function buildPrivateContactList(
  userNpub: string,
  userNsec: string,
  encryptedContent: string,
): ChronicleEvent {
  const unsigned = build(EventKind.PRIVATE_CONTACT_LIST, userNpub, [], encryptedContent)
  return sign(unsigned, userNsec)
}

// ─── Tag accessor helpers ─────────────────────────────────────────────────────

/** Extract a tag value by name from a ChronicleEvent */
export function getTag(event: ChronicleEvent, name: string): string | undefined {
  return event.tags.find(t => t[0] === name)?.[1]
}

/** Extract all values of a repeated tag (e.g. attested_by) */
export function getTags(event: ChronicleEvent, name: string): string[] {
  return event.tags.filter(t => t[0] === name).map(t => t[1])
}

// ─── Family key admission (kind 30094) ───────────────────────────────────────

/**
 * Publishes a family key admission record — the family key encrypted to a
 * new member's Curve25519 pubkey. Signed by the admitting member.
 */
export function buildFamilyKeyAdmission(
  senderNpub: string,
  senderNsec: string,
  admittedNpub: string,
  encryptedFamilyKey: string,
  nonce: string,
): ChronicleEvent {
  const unsigned = build(EventKind.FAMILY_KEY_ADMISSION, senderNpub, [
    ['admitted', admittedNpub],
    ['enc_key', encryptedFamilyKey],
    ['nonce', nonce],
  ])
  return sign(unsigned, senderNsec)
}

// ─── Blossom media reference (kind 30095) ────────────────────────────────────

import { blossomRefToTags } from './blossom'
import type { BlossomRef } from '../types/chronicle'

/**
 * Publishes a Blossom media reference event (kind 30095).
 * The tags encode URL, hash, MIME type, size, subject, and privacy tier.
 */
export function buildBlossomRefEvent(
  publisherNpub: string,
  publisherNsec: string,
  ref: BlossomRef,
): ChronicleEvent {
  const unsigned = build(EventKind.BLOSSOM_REF, publisherNpub, blossomRefToTags(ref))
  return sign(unsigned, publisherNsec)
}
