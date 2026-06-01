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

import { signEvent, npubToHex, hexToNpub } from './keys'
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
 * Signed by the claimant (the living user adding this person).
 *
 * personId — UUID v4 for ancestors; session npub for the logged-in user.
 * The person_id tag carries the stable ID so receiving instances can
 * look up the correct person record regardless of who created it.
 */
export function buildIdentityAnchor(
  personId: string,
  claimedByNpub: string,
  claimedByNsec: string,
): ChronicleEvent {
  const unsigned = build(EventKind.IDENTITY_ANCHOR, claimedByNpub, [
    ['person_id', personId],
    ['claimed_by', claimedByNpub],
  ])
  return sign(unsigned, claimedByNsec)
}

// ─── Fact claim (kind 30081) ──────────────────────────────────────────────────

export interface FactClaimParams {
  claimantNpub: string
  claimantNsec: string
  /** Person ID: UUID for ancestors, npub for the living user. */
  subjectId: string
  field: FactField
  value: string
  evidence?: string
  tier?: PrivacyTier
}

export function buildFactClaim(params: FactClaimParams): ChronicleEvent {
  const tags: string[][] = [
    ['subject', params.subjectId],
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

/**
 * Publishes a same-person link event declaring that two person IDs refer to
 * the same real individual. Both instances record the other's ID as an alias.
 *
 * idA / idB — local person IDs (UUID for ancestors, npub for living user).
 * remoteIdA / remoteIdB — the corresponding IDs on the other instance (optional;
 * include when known so the receiving instance can register the alias directly).
 */
export function buildSamePersonLink(
  claimantNpub: string,
  claimantNsec: string,
  idA: string,
  idB: string,
  remoteIdA?: string,
  remoteIdB?: string,
): ChronicleEvent {
  const tags: string[][] = [
    ['subject_a', idA],
    ['subject_b', idB],
  ]
  if (remoteIdA) tags.push(['remote_a', remoteIdA])
  if (remoteIdB) tags.push(['remote_b', remoteIdB])
  const unsigned = build(EventKind.SAME_PERSON_LINK, claimantNpub, tags)
  return sign(unsigned, claimantNsec)
}

// ─── Relationship claim (kind 30079) ─────────────────────────────────────────

export interface RelationshipClaimParams {
  claimantNpub: string
  claimantNsec: string
  /** Person ID: UUID for ancestors, npub for the living user. */
  subjectId: string
  /** Person ID of the other person in the relationship. */
  relatedId: string
  relationship: RelationshipType
  relayUrl?: string
  sensitive?: boolean
  sensitiveSubtype?: SensitiveRelationshipSubtype
  tier?: PrivacyTier
}

export function buildRelationshipClaim(params: RelationshipClaimParams): ChronicleEvent {
  const tags: string[][] = [
    ['subject', params.subjectId],
    ['related', params.relatedId],   // the other person in the relationship
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

// ─── Join request (kind 30091) ────────────────────────────────────────────────

import {
  KIND_JOIN_REQUEST,
  KIND_JOIN_ACCEPT,
  buildJoinRequestTags,
  buildJoinAcceptTags,
} from './joinRequest'

/**
 * Build and sign a kind 30091 JOIN_REQUEST event.
 * Published by the joiner to the inviter's relay.
 */
export function buildJoinRequestEvent(
  requesterNpub: string,
  requesterNsec: string,
  targetNpub: string,
  requesterRelay: string,
  displayName: string,
): ChronicleEvent {
  const tags = buildJoinRequestTags(targetNpub, requesterRelay, displayName)
  const unsigned = {
    kind: KIND_JOIN_REQUEST,
    pubkey: npubToHex(requesterNpub),
    created_at: now(),
    tags,
    content: '',
  }
  return sign(unsigned as UnsignedEvent, requesterNsec)
}

/**
 * Build and sign a kind 30092 JOIN_ACCEPT event.
 * Published by the inviter back to the requester's relay.
 */
export function buildJoinAcceptEvent(
  acceptorNpub: string,
  acceptorNsec: string,
  requesterNpub: string,
  requestEventId: string,
  acceptorRelay: string,
): ChronicleEvent {
  const tags = buildJoinAcceptTags(requesterNpub, requestEventId, acceptorRelay)
  const unsigned = {
    kind: KIND_JOIN_ACCEPT,
    pubkey: npubToHex(acceptorNpub),
    created_at: now(),
    tags,
    content: '',
  }
  return sign(unsigned as UnsignedEvent, acceptorNsec)
}

// ─── Avatar (kind 30095 with type=avatar) ─────────────────────────────────────

import type { PersonAvatar, PersonStory } from '../types/chronicle'

/**
 * Build and sign a kind 30095 avatar event.
 * The image is stored as a data URL in the content field (base64, ≤200 KB).
 * Tags carry: person_id, type, mime_type, size.
 */
export function buildAvatarEvent(
  publisherNpub: string,
  publisherNsec: string,
  personId: string,
  dataUrl: string,
  mimeType: 'image/jpeg' | 'image/png',
  size: number,
): ChronicleEvent {
  const tags: string[][] = [
    ['person_id', personId],
    ['type', 'avatar'],
    ['mime_type', mimeType],
    ['size', String(size)],
    ['v', SCHEMA_VERSION],
  ]
  const unsigned = {
    kind: EventKind.BLOSSOM_REF as number,
    pubkey: npubToHex(publisherNpub),
    created_at: now(),
    tags,
    content: dataUrl,
  }
  return sign(unsigned as UnsignedEvent, publisherNsec)
}

/**
 * Parse a PersonAvatar from a raw kind 30095 event with type=avatar tag.
 * Returns null if the event is not an avatar event or is malformed.
 */
export function parseAvatarEvent(event: ChronicleEvent): PersonAvatar | null {
  if (event.kind !== EventKind.BLOSSOM_REF) return null
  const type = getTag(event, 'type')
  if (type !== 'avatar') return null
  const personId = getTag(event, 'person_id')
  if (!personId) return null
  const mimeType = getTag(event, 'mime_type') as 'image/jpeg' | 'image/png' | null
  if (!mimeType || (mimeType !== 'image/jpeg' && mimeType !== 'image/png')) return null
  const size = parseInt(getTag(event, 'size') ?? '0', 10)
  if (!event.content) return null
  return {
    personId,
    dataUrl: event.content,
    mimeType,
    size,
    createdAt: event.created_at,
    eventId: event.id,
  }
}

// ─── Story (kind 30096) ───────────────────────────────────────────────────────

/**
 * Build and sign a kind 30096 story event.
 * The story text is in the content field.
 * Tags carry: person_id, title.
 */
export function buildStoryEvent(
  authorNpub: string,
  authorNsec: string,
  personId: string,
  title: string,
  content: string,
): ChronicleEvent {
  const tags: string[][] = [
    ['person_id', personId],
    ['title', title],
    ['v', SCHEMA_VERSION],
  ]
  const unsigned = {
    kind: EventKind.STORY as number,
    pubkey: npubToHex(authorNpub),
    created_at: now(),
    tags,
    content,
  }
  return sign(unsigned as UnsignedEvent, authorNsec)
}

/**
 * Parse a PersonStory from a raw kind 30096 event.
 * Returns null if the event is malformed.
 */
export function parseStoryEvent(event: ChronicleEvent): PersonStory | null {
  if (event.kind !== EventKind.STORY) return null
  const personId = getTag(event, 'person_id')
  if (!personId) return null
  const title = getTag(event, 'title') ?? ''
  if (!event.content) return null
  return {
    eventId: event.id,
    personId,
    title,
    content: event.content,
    authorNpub: hexToNpub(event.pubkey),
    createdAt: event.created_at,
  }
}
